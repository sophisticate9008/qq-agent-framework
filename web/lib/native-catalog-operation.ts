import { ApiError, type ApiClient } from './api.ts';
import { createConfigurationOperationLedger } from './configuration-operation-recovery.ts';

export type NativeCatalogSource = 'plans' | 'personas' | 'providers' | 'adapters' | 'access' | 'assistant' | 'authorization' | 'execution' | 'chat-input' | 'reminders' | 'tool-permissions' | 'memory' | 'pricing' | 'appearance' | 'package-configuration' | 'accounts';
export type CatalogFailureState = 'idle' | 'busy' | 'conflict' | 'unknown';
export function catalogFailureState(error: unknown): CatalogFailureState {
  if (!(error instanceof ApiError)) return 'unknown';
  if (error.status === 423 || error.status === 429 || /busy|running/.test(error.code)) return 'busy';
  if (/^assistant_reasoning_(unsupported|unavailable)$/.test(error.code)) return 'idle';
  if (error.code === 'appearance_in_use' || error.code === 'persona_in_use_by_appearance') return 'idle';
  if (error.code === 'reminder_unknown_requires_reconciliation') return 'idle';
  if (error.code === 'provider_model_in_use' || error.code === 'assistant_target_in_use' || error.code === 'persona_in_use_or_missing') return 'idle';
  if (error.status === 409 || /conflict|stale|revision/.test(error.code)) return 'conflict';
  return error.status >= 500 || /unknown/.test(error.code) ? 'unknown' : 'idle';
}
const createStore = () => createConfigurationOperationLedger<NativeCatalogSource>(['plans', 'personas', 'providers', 'adapters', 'access', 'assistant', 'authorization', 'execution', 'chat-input', 'reminders', 'tool-permissions', 'memory', 'pricing', 'appearance', 'package-configuration', 'accounts']);
const stores = new WeakMap<ApiClient, ReturnType<typeof createStore>>();
export function nativeCatalogOperationStore(api: ApiClient): ReturnType<typeof createStore> {
  let store = stores.get(api);
  if (!store) { store = createStore(); stores.set(api, store); }
  return store;
}

/** Metadata only: drafts, request bodies and credentials never enter the operation ledger. */
export function nativeCatalogOperation(api: ApiClient, source: NativeCatalogSource, owner: object) {
  const store = nativeCatalogOperationStore(api);
  const cleanups = new Map<object, () => void>();
  const cleanup = (token: object) => { cleanups.get(token)?.(); cleanups.delete(token); };
  return {
    store,
    begin(revision: string, signal: AbortSignal): object | null {
      if (signal.aborted) return null;
      const token = store.begin(source, revision, 'save');
      if (!token) return null;
      const abort = () => { store.block(source, token, 'unknown'); cleanup(token); };
      signal.addEventListener('abort', abort, { once: true });
      cleanups.set(token, () => signal.removeEventListener('abort', abort));
      return token;
    },
    complete(token: object) { cleanup(token); return store.complete(source, token); },
    fail(token: object, error: unknown) {
      cleanup(token);
      const state = catalogFailureState(error);
      if (state === 'idle') store.complete(source, token);
      else store.block(source, token, state);
      return state;
    },
    review() { const block = store.getSnapshot()[source]; if (block?.phase === 'blocked') store.review(source, block.token, owner); },
    release() { const block = store.getSnapshot()[source]; return block ? store.release(source, block.token, owner) : false; },
    dispose() {
      for (const token of cleanups.keys()) { cleanup(token); store.block(source, token, 'unknown'); }
      store.invalidateReviews(owner);
    },
  };
}
