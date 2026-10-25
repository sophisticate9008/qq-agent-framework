import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ApiClient } from './api.ts';
import { nativeCatalogOperation, type NativeCatalogSource } from './native-catalog-operation.ts';

export function useNativeCatalogOperation(api: ApiClient, source: NativeCatalogSource) {
  const owner = useRef({});
  const operation = useMemo(() => nativeCatalogOperation(api, source, owner.current), [api, source]);
  const snapshot = useSyncExternalStore(operation.store.subscribe, operation.store.getSnapshot, operation.store.getSnapshot);
  useEffect(() => () => operation.dispose(), [operation]);
  const block = snapshot[source];
  return { ...operation, block, blocked: block !== undefined, reviewed: block?.reviewedBy === owner.current };
}
