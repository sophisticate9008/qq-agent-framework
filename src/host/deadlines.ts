import { FrameworkError, assert, errorCode } from '../core/values.ts';
import type { TransportAdapter } from '../core/types.ts';
import type { AgentAdapter } from './types.ts';

export interface BridgeTimeouts {
  createSessionMs: number;
  followMs: number;
  submitMs: number;
  sendMs: number;
  authorizeMs: number;
  startMs: number;
}

export function bridgeTimeouts(input: Partial<BridgeTimeouts> = {}): Readonly<BridgeTimeouts> {
  const defaults: BridgeTimeouts = { createSessionMs: 10000, followMs: 10000, submitMs: 10000,
    sendMs: 10000, authorizeMs: 3000, startMs: 15000 };
  assert(input && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).every(key => Object.hasOwn(defaults, key)), 'INVALID_TIMEOUT', 'Timeout settings are invalid.');
  const result = { ...defaults, ...input };
  assert(Object.values(result).every(value => Number.isSafeInteger(value) && value >= 10 && value <= 300000),
    'INVALID_TIMEOUT', 'Operation deadlines must be between 10ms and 5 minutes.');
  return Object.freeze(result);
}

export function withDeadline<Value>({ run, signal, timeoutMs, code, onLate }:
  { run(signal: AbortSignal): Value | Promise<Value>; signal: AbortSignal; timeoutMs: number; code: string;
    onLate?(value: Value): void | Promise<void> }): Promise<Value> {
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 300000,
    'INVALID_TIMEOUT', 'A finite operation deadline is required.');
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function cleanup() {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
    }
    function fail(failure: string) {
      if (settled) return;
      settled = true;
      cleanup();
      const error = new FrameworkError(failure, 'The operation did not finish within its active deadline.');
      controller.abort(error);
      reject(error);
    }
    function aborted() { fail('OPERATION_ABORTED_UNKNOWN'); }
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => fail(code), timeoutMs);
    let result: Value | Promise<Value>;
    try { result = run(controller.signal); }
    catch (error) { settled = true; cleanup(); reject(error); return; }
    Promise.resolve(result).then(value => {
      if (settled) {
        if (onLate) {
          try { void Promise.resolve(onLate(value)).catch(() => {}); } catch {}
        }
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

interface OperationLimiter {
  run<Value>(operation: () => Value | Promise<Value>): Promise<Value>;
}

function createOperationLimiter(maxPendingOperations: number, code: string): OperationLimiter {
  assert(Number.isSafeInteger(maxPendingOperations)
    && maxPendingOperations >= 1
    && maxPendingOperations <= 256,
  'INVALID_OPERATION_LIMIT', 'Pending operation limit must be between 1 and 256.');
  let pending = 0;
  return Object.freeze({
    run<Value>(operation: () => Value | Promise<Value>): Promise<Value> {
      if (pending >= maxPendingOperations) {
        return Promise.reject(new FrameworkError(code, 'The adapter has too many unresolved operations.'));
      }
      pending += 1;
      let result: Value | Promise<Value>;
      try {
        result = operation();
      } catch (error) {
        pending -= 1;
        throw error;
      }
      return Promise.resolve(result).then(value => {
        pending -= 1;
        return value;
      }, error => {
        pending -= 1;
        throw error;
      });
    }
  });
}

export function createBoundedAgent({ agent, timeouts, onFault = () => {}, maxPendingOperations = 16 }:
  { agent: AgentAdapter; timeouts: BridgeTimeouts; onFault?(code: string): void;
    maxPendingOperations?: number }): AgentAdapter {
  const fault = (error: unknown) => { try { onFault(errorCode(error, 'AGENT_UNKNOWN')); } catch {} };
  const operations = createOperationLimiter(maxPendingOperations, 'AGENT_BACKPRESSURE_UNKNOWN');
  const disposeFollow = async (dispose: () => void | Promise<void>): Promise<void> => {
    try {
      await withDeadline({ signal: new AbortController().signal, timeoutMs: timeouts.followMs,
        code: 'AGENT_DISPOSE_TIMEOUT_UNKNOWN', run: () => operations.run(dispose) });
    } catch (error) { fault(error); }
  };
  return Object.freeze({
    async createSession(request) {
      try {
        return await withDeadline({ signal: request.signal, timeoutMs: timeouts.createSessionMs, code: 'AGENT_CREATE_TIMEOUT_UNKNOWN',
          run: signal => operations.run(() => agent.createSession({ ...request, signal })) });
      } catch (error) {
        fault(error);
        throw new FrameworkError(errorCode(error, 'AGENT_CREATE_UNKNOWN'), 'Agent session creation is unresolved.');
      }
    },
    async submit(request) {
      try {
        return await withDeadline({ signal: request.signal, timeoutMs: timeouts.submitMs, code: 'AGENT_SUBMIT_TIMEOUT_UNKNOWN',
          run: signal => operations.run(() => agent.submit({ ...request, signal })) });
      } catch (error) { fault(error); return { status: 'unknown' as const }; }
    },
    async follow(request) {
      const controller = new AbortController();
      const aborted = () => controller.abort();
      request.signal.addEventListener('abort', aborted, { once: true });
      let dispose: (() => void | Promise<void>);
      try {
        dispose = await withDeadline({ signal: request.signal, timeoutMs: timeouts.followMs, code: 'AGENT_FOLLOW_TIMEOUT_UNKNOWN',
          run: deadline => {
            const signal = AbortSignal.any([deadline, controller.signal]);
            return operations.run(() => agent.follow({ sessionId: request.sessionId, signal, onEvent: event => {
              if (!signal.aborted && !request.signal.aborted) return request.onEvent(event);
            } }));
          }, onLate: disposeFollow });
      } catch (error) {
        controller.abort();
        request.signal.removeEventListener('abort', aborted);
        fault(error);
        throw new FrameworkError(errorCode(error, 'AGENT_FOLLOW_UNKNOWN'), 'Agent follow is unresolved.');
      }
      let disposing: Promise<void> | null = null;
      return () => {
        if (disposing) return disposing;
        controller.abort();
        request.signal.removeEventListener('abort', aborted);
        disposing = disposeFollow(dispose);
        return disposing;
      };
    },
    async cancel(request) {
      if (!agent.cancel) return;
      try {
        await withDeadline({ signal: request.signal, timeoutMs: timeouts.submitMs, code: 'AGENT_CANCEL_TIMEOUT_UNKNOWN',
          run: signal => operations.run(() => agent.cancel!({ ...request, signal })) });
      } catch (error) {
        fault(error);
        throw new FrameworkError(errorCode(error, 'AGENT_CANCEL_UNKNOWN'), 'Agent cancellation is unresolved.');
      }
    },
  } satisfies AgentAdapter);
}

export function createBoundedTransport({ transport, timeoutMs, onFault = () => {}, maxPendingOperations = 16 }:
  { transport: TransportAdapter; timeoutMs: number; onFault?(code: string): void;
    maxPendingOperations?: number }): TransportAdapter {
  const operations = createOperationLimiter(maxPendingOperations, 'TRANSPORT_BACKPRESSURE_UNKNOWN');
  return Object.freeze({ async send(request) {
    try {
      return await withDeadline({ signal: request.signal, timeoutMs, code: 'TRANSPORT_TIMEOUT_UNKNOWN',
        run: signal => operations.run(() => transport.send({ ...request, signal })) });
    } catch (error) {
      try { onFault(errorCode(error, 'TRANSPORT_UNKNOWN')); } catch {}
      return { status: 'unknown' as const };
    }
  } } satisfies TransportAdapter);
}
