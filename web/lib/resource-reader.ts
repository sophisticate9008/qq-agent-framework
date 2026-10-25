import type { ApiClient } from './api.ts';

export interface ReadResourceSnapshot {
  readonly value: unknown;
  readonly hasValue: boolean;
  readonly loading: boolean;
  readonly error: unknown;
  readonly updatedAt: number;
}
interface Waiter { resolve(value: unknown): void; reject(reason: unknown): void; cleanup(): void }
interface PendingRead { readonly controller: AbortController; readonly waiters: Set<Waiter> }
interface Resource {
  snapshot: ReadResourceSnapshot;
  pending: PendingRead | null;
  readonly listeners: Set<() => void>;
}
const empty: ReadResourceSnapshot = Object.freeze({ value: undefined, hasValue: false, loading: false, error: null, updatedAt: 0 });
const stores = new WeakMap<ApiClient, Map<string, Resource>>();
const maximumResources = 128;

function resources(api: ApiClient): Map<string, Resource> {
  let store = stores.get(api);
  if (!store) { store = new Map(); stores.set(api, store); }
  return store;
}
function resource(api: ApiClient, key: string): Resource {
  const store = resources(api);
  let entry = store.get(key);
  if (!entry) {
    if (store.size >= maximumResources) {
      const candidate = [...store].find(([, value]) => value.pending === null && value.listeners.size === 0);
      if (candidate) store.delete(candidate[0]);
    }
    entry = { snapshot: empty, pending: null, listeners: new Set() };
    store.set(key, entry);
  }
  return entry;
}
function publish(entry: Resource, snapshot: ReadResourceSnapshot): void {
  entry.snapshot = snapshot;
  for (const listener of entry.listeners) listener();
}
function cancel(entry: Resource, pending: PendingRead): void {
  if (entry.pending !== pending) return;
  entry.pending = null;
  pending.controller.abort();
  for (const waiter of pending.waiters) { waiter.cleanup(); waiter.reject(new DOMException('Read cancelled', 'AbortError')); }
  pending.waiters.clear();
  publish(entry, { ...entry.snapshot, loading: false });
}

/** Consumers share transport, but each owns its cancellation and receives its own result. */
export function readResource(api: ApiClient, key: string, signal?: AbortSignal, maximumAgeMs = 0): Promise<unknown> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Read cancelled', 'AbortError'));
  const entry = resource(api, key);
  if (!entry.pending && entry.snapshot.hasValue && entry.snapshot.error === null && maximumAgeMs > 0
    && Date.now() - entry.snapshot.updatedAt < maximumAgeMs) return Promise.resolve(entry.snapshot.value);
  let pending = entry.pending;
  const start = pending === null;
  if (!pending) {
    pending = { controller: new AbortController(), waiters: new Set() };
    entry.pending = pending;
    publish(entry, { ...entry.snapshot, loading: true, error: null });
  }
  const operation = pending;
  const promise = new Promise<unknown>((resolve, reject) => {
    const abort = () => {
      if (!operation.waiters.delete(waiter)) return;
      waiter.cleanup();
      reject(signal?.reason ?? new DOMException('Read cancelled', 'AbortError'));
      if (operation.waiters.size === 0) cancel(entry, operation);
    };
    const waiter: Waiter = { resolve, reject, cleanup: () => signal?.removeEventListener('abort', abort) };
    operation.waiters.add(waiter);
    signal?.addEventListener('abort', abort, { once: true });
  });
  if (start) {
    void Promise.resolve().then(() => api.get(key, operation.controller.signal)).then(value => {
      if (entry.pending !== operation) return;
      entry.pending = null;
      publish(entry, { value, hasValue: true, loading: false, error: null, updatedAt: Date.now() });
      for (const waiter of operation.waiters) { waiter.cleanup(); waiter.resolve(value); }
      operation.waiters.clear();
    }, error => {
      if (entry.pending !== operation) return;
      entry.pending = null;
      publish(entry, { ...entry.snapshot, loading: false, error });
      for (const waiter of operation.waiters) { waiter.cleanup(); waiter.reject(error); }
      operation.waiters.clear();
    });
  }
  return promise;
}

export function readResourceSnapshot(api: ApiClient, key: string): ReadResourceSnapshot {
  return resource(api, key).snapshot;
}
export function subscribeReadResource(api: ApiClient, key: string, listener: () => void): () => void {
  const entry = resource(api, key);
  entry.listeners.add(listener);
  return () => { entry.listeners.delete(listener); };
}
export function invalidateReadResources(api: ApiClient, keys?: readonly string[]): void {
  for (const [key, entry] of resources(api)) {
    if (keys && !keys.includes(key)) continue;
    if (entry.pending) cancel(entry, entry.pending);
    publish(entry, { ...entry.snapshot, updatedAt: 0 });
  }
}
export function clearReadResources(api: ApiClient): void {
  const store = resources(api);
  for (const [key, entry] of store) {
    if (entry.pending) cancel(entry, entry.pending);
    publish(entry, empty);
    if (entry.listeners.size === 0) store.delete(key);
  }
}
export async function writeResource(api: ApiClient, path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  try { return await api.post(path, body, signal); }
  finally { invalidateReadResources(api); }
}
