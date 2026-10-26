import { NATIVE_DSH_RESTART_PATH, parseNativeDshRestartSnapshot, type NativeDshRestartSnapshot } from '../../src/contracts/native-dsh-restart.ts';
import { isNativeConfigurationRevisions } from '../../src/contracts/native-revisions.ts';
import { ApiError, asRecord, errorMessage, type ApiClient } from './api.ts';
import { newChatApplicationId } from './chat-application.ts';
import { writeResource } from './resource-reader.ts';

export interface DshRestartState {
  readonly snapshot: NativeDshRestartSnapshot | null;
  readonly operationId: string | null;
  readonly requestActive: boolean;
  readonly uncertain: boolean;
  readonly error: string;
}
function createStore() {
  let state: DshRestartState = { snapshot: null, operationId: null, requestActive: false, uncertain: false, error: '' };
  const listeners = new Set<() => void>();
  const update = (next: DshRestartState) => { state = next; for (const listener of listeners) listener(); };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    begin() { if (state.requestActive) return false; update({ ...state, requestActive: true, error: '' }); return true; },
    identify(operationId: string) { update({ ...state, operationId, uncertain: true, snapshot: state.snapshot ? { ...state.snapshot, operation: null } : null }); },
    observe(snapshot: NativeDshRestartSnapshot, explicit = false): boolean {
      const next = snapshot.operation;
      const previous = state.snapshot?.operation;
      if (state.operationId && (state.requestActive || state.uncertain || previous?.state === 'running' || previous?.state === 'unknown')
        && next?.id !== state.operationId) return false;
      if (previous && next && previous.id === next.id && (next.createdAt !== previous.createdAt || next.updatedAt < previous.updatedAt
        || previous.state === 'completed' && next.state !== 'completed'
        || (previous.state === 'unknown' || previous.state === 'blocked') && next.state === 'running' && !explicit)) return false;
      update({ ...state, snapshot, operationId: next?.id ?? null, uncertain: next?.state === 'unknown', error: '' });
      return true;
    },
    fail(error: unknown, uncertain: boolean, rejected = false) {
      update({ ...state, requestActive: false, uncertain: uncertain || state.uncertain && !rejected,
        ...(rejected ? { operationId: null, snapshot: state.snapshot ? { ...state.snapshot, operation: null } : null } : {}),
        error: error instanceof ApiError && error.code === 'dsh_restart_not_received'
          ? '原重启请求未被受理，未执行重启；可以重新点击“重启 DSH”。' : errorMessage(error) });
    },
    finish() { update({ ...state, requestActive: false }); },
  };
}
const stores = new WeakMap<ApiClient, ReturnType<typeof createStore>>();
export function dshRestartStore(api: ApiClient): ReturnType<typeof createStore> {
  let store = stores.get(api);
  if (!store) { store = createStore(); stores.set(api, store); }
  return store;
}
export function dshRestartPending(state: DshRestartState): boolean {
  return state.requestActive || state.uncertain || state.snapshot?.operation?.state === 'running' || state.snapshot?.operation?.state === 'unknown';
}
export function dshRestartReadPath(state: DshRestartState): string {
  return dshRestartPending(state) && state.operationId ? `${NATIVE_DSH_RESTART_PATH}?id=${encodeURIComponent(state.operationId)}` : NATIVE_DSH_RESTART_PATH;
}

/** A restart is one server-owned operation. Missing acknowledgements only permit reads or explicit reconciliation of its id. */
export async function requestDshRestart(api: ApiClient, reconcile = false): Promise<void> {
  const store = dshRestartStore(api);
  const original = store.getSnapshot();
  if (original.requestActive || !reconcile && dshRestartPending(original) || reconcile && !original.operationId || !store.begin()) return;
  let wrote = false;
  try {
    let operationId = original.operationId;
    let body: unknown;
    if (reconcile) body = { operationId };
    else {
      const available = parseNativeDshRestartSnapshot(await api.get(NATIVE_DSH_RESTART_PATH));
      if (!available?.available) throw new ApiError('local_dsh_restart_unavailable', 409);
      if (available.operation && ['running', 'unknown'].includes(available.operation.state)) { store.observe(available); return; }
      const runtime = asRecord(await api.get('/api/chat/runtime'));
      if (!isNativeConfigurationRevisions(runtime.revisions)) throw new ApiError('runtime_status_unavailable', 503);
      operationId = newChatApplicationId(); body = { operationId, revisions: runtime.revisions };
      store.identify(operationId);
    }
    wrote = true;
    const response = parseNativeDshRestartSnapshot(await writeResource(api,
      reconcile ? `${NATIVE_DSH_RESTART_PATH}/reconcile` : NATIVE_DSH_RESTART_PATH, body));
    if (!response?.operation || response.operation.id !== operationId) throw new ApiError('dsh_restart_result_unknown', 504);
    if (!store.observe(response, reconcile)) {
      const latest = store.getSnapshot().snapshot?.operation;
      if (latest?.id !== operationId || latest.state !== 'completed') throw new ApiError('dsh_restart_result_unknown', 504);
    }
  } catch (error) {
    const rejected = error instanceof ApiError && (reconcile ? error.status === 409 && error.code === 'dsh_restart_not_received'
      : error.status >= 400 && error.status < 500 && !/unknown/i.test(error.code));
    store.fail(error, wrote && !rejected, rejected);
  } finally { store.finish(); }
}
