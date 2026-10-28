import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createThrottledTransport } from '../src/adapters/throttle.ts';
import type { SendRequest } from '../src/core/types.ts';

function request(id: string, signal = new AbortController().signal): SendRequest {
  return { conversationId: 'room:1', idempotencyKey: id, content: [{ type: 'text', text: 'fixture' }], signal };
}

test('transport throttle preserves FIFO and exact minimum spacing on a controlled monotonic clock', async context => {
  let monotonic = 0;
  context.mock.method(performance, 'now', () => monotonic);
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const starts: number[] = [];
  const ids: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const transport = createThrottledTransport({ maxPending: 2, minIntervalMs: 20, transport: { async send(input) {
    starts.push(performance.now()); ids.push(input.idempotencyKey);
    if (ids.length === 1) await gate;
    return { status: 'confirmed', messageId: `message:${ids.length}` };
  } } });
  try {
    const first = transport.send(request('first'));
    const second = transport.send(request('second'));
    assert.equal((await transport.send(request('overflow'))).status, 'rejected');
    release();
    assert.equal((await first).status, 'confirmed');
    assert.deepEqual(ids, ['first']);
    monotonic = 19;
    context.mock.timers.tick(19);
    await nextTurn();
    assert.deepEqual(ids, ['first']);
    monotonic = 20;
    context.mock.timers.tick(1);
    assert.equal((await second).status, 'confirmed');
    assert.deepEqual(ids, ['first', 'second']);
    assert.deepEqual(starts, [0, 20]);
    assert.equal(transport.metrics().queued, 0);
  } finally { release(); await transport.stop(); }
});

test('queued cancellation is rejected without dispatch and stop drains active unknown work', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const transport = createThrottledTransport({ transport: { async send(input) {
    calls++; await gate;
    assert.equal(input.signal.aborted, true);
    throw new Error('unconfirmed external work');
  } } });
  try {
    const first = transport.send(request('active'));
    const controller = new AbortController();
    const queued = transport.send(request('cancelled', controller.signal));
    controller.abort();
    assert.equal((await queued).status, 'rejected');
    const abandoned = transport.send(request('stopped'));
    const stopping = transport.stop();
    assert.equal(transport.stop(), stopping);
    assert.equal((await abandoned).status, 'rejected');
    let drained = false;
    void stopping.then(() => { drained = true; });
    await nextTurn();
    assert.equal(drained, false);
    release();
    assert.equal((await first).status, 'unknown');
    await stopping;
    assert.equal(calls, 1);
    assert.equal((await transport.send(request('late'))).status, 'rejected');
  } finally { release(); await transport.stop(); }
});
