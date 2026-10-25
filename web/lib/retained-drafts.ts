import type { ApiClient } from './api.ts';
export interface DraftKey<Value> { readonly id: symbol; readonly label: string; readonly valueType?: (value: Value) => Value }
const labels = new Map<symbol, { readonly label: string; readonly kind: 'draft' | 'state' }>();
export function createDraftKey<Value>(label: string, options: { readonly kind?: 'draft' | 'state' } = {}): DraftKey<Value> { const id = Symbol(label); labels.set(id, { label, kind: options.kind ?? 'draft' }); return { id, label }; }
interface DraftStore { readonly entries: Map<symbol, unknown>; readonly listeners: Set<() => void> }
const stores = new WeakMap<ApiClient, DraftStore>();
function store(api: ApiClient): DraftStore { let value = stores.get(api); if (!value) { value = { entries: new Map(), listeners: new Set() }; stores.set(api, value); } return value; }
export function retainedDraft<Value>(api: ApiClient, key: DraftKey<Value>): Value | undefined { return store(api).entries.get(key.id) as Value | undefined; }
/** Callers retain only editable public fields; credential inputs stay with their mounted form. */
export function retainDraft<Value>(api: ApiClient, key: DraftKey<Value>, value: Value | null): void {
  const current = store(api);
  if (value === null) { if (!current.entries.delete(key.id)) return; }
  else { if (current.entries.get(key.id) === value) return; current.entries.set(key.id, value); }
  for (const listener of current.listeners) listener();
}
export function retainedDraftCount(api: ApiClient): number { return [...store(api).entries.keys()].filter(id => labels.get(id)?.kind !== 'state').length; }
export function subscribeRetainedDrafts(api: ApiClient, listener: () => void): () => void { const current = store(api); current.listeners.add(listener); return () => { current.listeners.delete(listener); }; }
export function clearRetainedDrafts(api: ApiClient): void { const current = store(api); current.entries.clear(); for (const listener of current.listeners) listener(); }

export function retainedDraftScopes(api: ApiClient): readonly string[] { return [...store(api).entries.keys()].flatMap(id => { const entry = labels.get(id); return entry?.kind === 'draft' ? [entry.label] : []; }); }
