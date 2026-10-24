import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import type { DeliveryReceipt, TransportAdapter } from '../src/core/types.ts';
import { FrameworkError } from '../src/core/values.ts';
import {
  bridgeTimeouts,
  createBoundedAgent,
  createBoundedTransport,
  withDeadline
} from '../src/host/deadlines.ts';
import type { AgentAdapter, AgentEvent } from '../src/host/types.ts';

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise: ((value: Value) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  if (!resolvePromise || !rejectPromise) throw new Error('Deferred promise was not initialized.');
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function immediate(): Promise<void> {
  return new Promise(resolvePromise => setImmediate(resolvePromise));
}

function errorHasCode(code: string): (error: unknown) => boolean {
  return error => error instanceof FrameworkError && error.code === code;
}

function timeouts(milliseconds = 20) {
  return bridgeTimeouts({
    createSessionMs: milliseconds,
    followMs: milliseconds,
    submitMs: milliseconds,
    sendMs: milliseconds,
    authorizeMs: milliseconds,
    startMs: milliseconds
  });
}

function agent(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  return {
    async createSession() { return { sessionId: 'session:1' }; },
    async submit() { return { status: 'accepted' }; },
    async follow() { return () => undefined; },
    async cancel() {},
    ...overrides
  };
}

function submitRequest(index: number) {
  return {
    sessionId: 'session:1',
    requestId: `request:${index}`,
    content: [{ type: 'text' as const, text: 'hello' }],
    signal: new AbortController().signal
  };
}

function sendRequest(index: number) {
  return {
    conversationId: 'room:1',
    idempotencyKey: `send:${index}`,
    content: [{ type: 'text' as const, text: 'hello' }],
    signal: new AbortController().signal
  };
}

test('withDeadline respects parent abort before and after start', async () => {
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  let starts = 0;
  await assert.rejects(withDeadline({
    signal: alreadyAborted.signal,
    timeoutMs: 20,
    code: 'TEST_TIMEOUT_UNKNOWN',
    run() {
      starts += 1;
      return 'unreachable';
    }
  }), errorHasCode('OPERATION_ABORTED_UNKNOWN'));
  assert.equal(starts, 0);

  const parent = new AbortController();
  let childSignal: AbortSignal | undefined;
  const pending = withDeadline({
    signal: parent.signal,
    timeoutMs: 100,
    code: 'TEST_TIMEOUT_UNKNOWN',
    run(signal) {
      starts += 1;
      childSignal = signal;
      return new Promise<string>(() => undefined);
    }
  });
  parent.abort();
  await assert.rejects(pending, errorHasCode('OPERATION_ABORTED_UNKNOWN'));
  assert.equal(starts, 1);
  assert.equal(childSignal?.aborted, true);
});

test('withDeadline aborts on timeout and consumes a late rejection', async () => {
  const operation = deferred<string>();
  let operationSignal: AbortSignal | undefined;
  const pending = withDeadline({
    signal: new AbortController().signal,
    timeoutMs: 20,
    code: 'TEST_TIMEOUT_UNKNOWN',
    run(signal) {
      operationSignal = signal;
      return operation.promise;
    }
  });
  await assert.rejects(pending, errorHasCode('TEST_TIMEOUT_UNKNOWN'));
  assert.equal(operationSignal?.aborted, true);
  operation.reject(new Error('late private failure'));
  await immediate();
});

test('late follow setup isolates frames and disposes the late subscription', async () => {
  const setup = deferred<() => void>();
  let setupSignal: AbortSignal | undefined;
  let deliver: ((event: AgentEvent) => void | Promise<void>) | undefined;
  let frames = 0;
  let disposals = 0;
  const bounded = createBoundedAgent({
    agent: agent({
      follow(request) {
        setupSignal = request.signal;
        deliver = request.onEvent;
        return setup.promise;
      }
    }),
    timeouts: timeouts()
  });
  const follow = bounded.follow({
    sessionId: 'session:1',
    signal: new AbortController().signal,
    onEvent() { frames += 1; }
  });

  await assert.rejects(follow, errorHasCode('AGENT_FOLLOW_TIMEOUT_UNKNOWN'));
  assert.equal(setupSignal?.aborted, true);
  if (!deliver) throw new Error('Follow callback was not captured.');
  await deliver({ id: 'event:1', sessionId: 'session:1', type: 'completed' });
  assert.equal(frames, 0);

  setup.resolve(() => { disposals += 1; });
  await immediate();
  assert.equal(disposals, 1);
  await deliver({ id: 'event:2', sessionId: 'session:1', type: 'completed' });
  assert.equal(frames, 0);
});

test('follow disposer and cancel remain bounded when underlying work hangs', async () => {
  const disposeGate = deferred<void>();
  const cancelGate = deferred<void>();
  const faults: string[] = [];
  let disposeCalls = 0;
  let cancelCalls = 0;
  const bounded = createBoundedAgent({
    agent: agent({
      async follow() {
        return () => {
          disposeCalls += 1;
          return disposeGate.promise;
        };
      },
      cancel() {
        cancelCalls += 1;
        return cancelGate.promise;
      }
    }),
    timeouts: timeouts(),
    maxPendingOperations: 2,
    onFault: code => faults.push(code)
  });

  const dispose = await bounded.follow({
    sessionId: 'session:1',
    signal: new AbortController().signal,
    onEvent() {}
  });
  const disposeStarted = performance.now();
  await dispose();
  assert.ok(performance.now() - disposeStarted < 250);
  await dispose();
  assert.equal(disposeCalls, 1);
  assert.ok(faults.includes('AGENT_DISPOSE_TIMEOUT_UNKNOWN'));

  if (!bounded.cancel) throw new Error('Bounded agent did not expose cancellation.');
  const cancelStarted = performance.now();
  await assert.rejects(bounded.cancel({
    sessionId: 'session:1',
    signal: new AbortController().signal
  }), errorHasCode('AGENT_CANCEL_TIMEOUT_UNKNOWN'));
  assert.ok(performance.now() - cancelStarted < 250);
  assert.equal(cancelCalls, 1);

  await assert.rejects(bounded.cancel({
    sessionId: 'session:1',
    signal: new AbortController().signal
  }), errorHasCode('AGENT_BACKPRESSURE_UNKNOWN'));
  assert.equal(cancelCalls, 1);
  disposeGate.resolve();
  cancelGate.resolve();
});

test('healthy follow subscriptions do not occupy an operation slot', async () => {
  let submitCalls = 0;
  const bounded = createBoundedAgent({
    agent: agent({
      async follow() { return () => undefined; },
      async submit() {
        submitCalls += 1;
        return { status: 'accepted' };
      }
    }),
    timeouts: timeouts(),
    maxPendingOperations: 1
  });
  const dispose = await bounded.follow({
    sessionId: 'session:1',
    signal: new AbortController().signal,
    onEvent() {}
  });
  assert.deepEqual(await bounded.submit(submitRequest(1)), { status: 'accepted' });
  assert.equal(submitCalls, 1);
  await dispose();
});

test('bounded agent caps unresolved work and recovers only after underlying settlement', async () => {
  const pending: Array<Deferred<{ status: 'accepted' }>> = [];
  const faults: string[] = [];
  let submitCalls = 0;
  let blocking = true;
  const bounded = createBoundedAgent({
    agent: agent({
      submit() {
        submitCalls += 1;
        if (!blocking) return Promise.resolve({ status: 'accepted' });
        const operation = deferred<{ status: 'accepted' }>();
        pending.push(operation);
        return operation.promise;
      }
    }),
    timeouts: timeouts(),
    onFault: code => faults.push(code)
  });

  const receipts = await Promise.all(Array.from({ length: 20 }, (_, index) => bounded.submit(submitRequest(index))));
  assert.ok(receipts.every(receipt => receipt.status === 'unknown'));
  assert.equal(submitCalls, 16);
  assert.ok(faults.includes('AGENT_BACKPRESSURE_UNKNOWN'));

  const backpressureStarted = performance.now();
  assert.deepEqual(await bounded.submit(submitRequest(21)), { status: 'unknown' });
  assert.ok(performance.now() - backpressureStarted < 100);
  assert.equal(submitCalls, 16);

  blocking = false;
  for (const operation of pending) operation.resolve({ status: 'accepted' });
  await immediate();
  assert.equal(submitCalls, 16);
  assert.deepEqual(await bounded.submit(submitRequest(22)), { status: 'accepted' });
  assert.equal(submitCalls, 17);
});

test('bounded transport caps unresolved sends and resumes after slots release', async () => {
  const pending: Array<Deferred<DeliveryReceipt>> = [];
  const faults: string[] = [];
  let sendCalls = 0;
  let blocking = true;
  const transport: TransportAdapter = {
    send() {
      sendCalls += 1;
      if (!blocking) return { status: 'confirmed', messageId: `message:${sendCalls}` };
      const operation = deferred<DeliveryReceipt>();
      pending.push(operation);
      return operation.promise;
    }
  };
  const bounded = createBoundedTransport({
    transport,
    timeoutMs: 20,
    onFault: code => faults.push(code)
  });

  const receipts = await Promise.all(Array.from({ length: 20 }, (_, index) => bounded.send(sendRequest(index))));
  assert.ok(receipts.every(receipt => receipt.status === 'unknown'));
  assert.equal(sendCalls, 16);
  assert.ok(faults.includes('TRANSPORT_BACKPRESSURE_UNKNOWN'));

  const backpressureStarted = performance.now();
  assert.deepEqual(await bounded.send(sendRequest(21)), { status: 'unknown' });
  assert.ok(performance.now() - backpressureStarted < 100);
  assert.equal(sendCalls, 16);

  blocking = false;
  for (const operation of pending) operation.resolve({ status: 'confirmed', messageId: 'late' });
  await immediate();
  assert.equal(sendCalls, 16);
  assert.deepEqual(await bounded.send(sendRequest(22)), { status: 'confirmed', messageId: 'message:17' });
  assert.equal(sendCalls, 17);
});

test('bounded adapters validate pending operation limits', () => {
  for (const maxPendingOperations of [0, 257, 1.5]) {
    assert.throws(() => createBoundedAgent({ agent: agent(), timeouts: timeouts(), maxPendingOperations }),
      errorHasCode('INVALID_OPERATION_LIMIT'));
    assert.throws(() => createBoundedTransport({
      transport: { send: () => ({ status: 'unknown' }) },
      timeoutMs: 20,
      maxPendingOperations
    }), errorHasCode('INVALID_OPERATION_LIMIT'));
  }
});
