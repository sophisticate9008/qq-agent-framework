import type { ApiClient } from './api.ts';

export type ConfigurationOperationSource = 'gateway' | 'admin';
export type ConfigurationOperationReason = 'unknown' | 'conflict' | 'accepted' | 'busy';
export type ConfigurationOperationAction = 'save' | 'apply';

export interface ConfigurationOperationBlock {
  readonly token: object;
  readonly revision: string;
  readonly action: ConfigurationOperationAction;
  readonly phase: 'pending' | 'blocked';
  readonly reason: ConfigurationOperationReason;
  readonly reviewedBy: object | null;
}

export function createConfigurationOperationLedger<Source extends string>(sources: readonly Source[]) {
  type Snapshot = Readonly<Partial<Record<Source, ConfigurationOperationBlock>>>;
  let snapshot: Snapshot = {} as Snapshot;
  const listeners = new Set<() => void>();
  const publish = (next: Snapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const replace = (source: Source, token: object, update: (block: ConfigurationOperationBlock) => ConfigurationOperationBlock | null): boolean => {
    const block = snapshot[source];
    if (!block || block.token !== token) return false;
    const next: Partial<Record<Source, ConfigurationOperationBlock>> = { ...snapshot };
    const updated = update(block);
    if (updated) next[source] = updated;
    else delete next[source];
    publish(next);
    return true;
  };
  const release = (source: Source, token: object, owner: object): boolean => {
    const block = snapshot[source];
    if (!block || block.phase !== 'blocked' || block.reviewedBy !== owner) return false;
    return replace(source, token, () => null);
  };
  return {
    getSnapshot: (): Snapshot => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    begin(source: Source, revision: string, action: ConfigurationOperationAction = 'apply'): object | null {
      if (!sources.includes(source)) throw new TypeError('Unsupported configuration source.');
      if (snapshot[source]) return null;
      const token = {};
      publish({ ...snapshot, [source]: { token, revision, action, phase: 'pending', reason: 'unknown', reviewedBy: null } });
      return token;
    },
    block(source: Source, token: object, reason: ConfigurationOperationReason): boolean {
      return replace(source, token, block => ({ ...block, phase: 'blocked', reason, reviewedBy: null }));
    },
    complete(source: Source, token: object): boolean {
      if (snapshot[source]?.phase !== 'pending') return false;
      return replace(source, token, () => null);
    },
    review(source: Source, token: object, owner: object | null): boolean {
      if (snapshot[source]?.phase !== 'blocked') return false;
      return replace(source, token, block => ({ ...block, reviewedBy: owner }));
    },
    release,
    acknowledge: release,
    invalidateReviews(owner?: object): void {
      for (const source of sources) {
        const block = snapshot[source];
        if (block?.reviewedBy && (owner === undefined || block.reviewedBy === owner)) {
          replace(source, block.token, current => ({ ...current, reviewedBy: null }));
        }
      }
    },
  };
}

const createStore = () => createConfigurationOperationLedger(['gateway', 'admin'] as const);

const stores = new WeakMap<ApiClient, ReturnType<typeof createStore>>();

export function configurationOperationStore(api: ApiClient): ReturnType<typeof createStore> {
  let store = stores.get(api);
  if (!store) {
    store = createStore();
    stores.set(api, store);
  }
  return store;
}
