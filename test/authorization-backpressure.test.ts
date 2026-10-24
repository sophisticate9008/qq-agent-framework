import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createContextStore } from '../src/core/context.ts';
import { createBridgeHost } from '../src/host/bridge.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';
import type { InboundMessage } from '../src/host/types.ts';

test('timed-out authorizers cannot accumulate unlimited underlying work', { timeout: 5000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'authorization-bound-'));
  const store = createSqliteStore({ filename: join(directory, 'state.sqlite') });
  const context = createContextStore();
  const persona = context.registerPersona({ id: 'fixture', version: '1.0.0', name: 'Fixture', identity: {}, style: {} });
  const releases: Array<(allowed: boolean) => void> = [];
  let healthy = false;
  const host = createBridgeHost({ store, context, persona, timeouts: { authorizeMs: 30 },
    authorizeIncoming: () => healthy ? false : new Promise<boolean>(resolve => { releases.push(resolve); }),
    agent: { async createSession() { assert.fail('Unauthorized messages cannot create sessions.'); },
      async submit() { assert.fail('Unauthorized messages cannot submit work.'); }, async follow() { return () => {}; } },
    transport: { send() { assert.fail('Unauthorized messages cannot send.'); } } });
  const message = (ordinal: number): InboundMessage => ({ id: `fixture:${ordinal}`, conversationId: 'room:1', userId: 'user:1',
    directed: true, isSelf: false, receivedAt: Date.now(), content: [{ type: 'text', text: 'fixture' }] });
  try {
    const requests = Array.from({ length: 257 }, (_, ordinal) => host.receive(message(ordinal)));
    assert.equal((await requests[256]).errorCode, 'INBOUND_BACKPRESSURE');
    const receipts = await Promise.all(requests.slice(0, 256));
    assert(receipts.every(receipt => receipt.errorCode === 'INBOUND_AUTH_TIMEOUT'));
    assert.equal(releases.length, 256);
    assert.equal(host.metrics().unsettledAuthorizations, 256);
    assert.equal((await host.receive(message(258))).errorCode, 'INBOUND_BACKPRESSURE');
    healthy = true;
    for (const release of releases) release(false);
    await nextTurn();
    assert.equal(host.metrics().unsettledAuthorizations, 0);
    assert.equal((await host.receive(message(259))).errorCode, 'INBOUND_DENIED');
  } finally { for (const release of releases) release(false); await host.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
