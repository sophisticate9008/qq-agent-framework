import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { parseNativeDshRestartSnapshot } from '../../src/contracts/native-dsh-restart.ts';
import type { ApiClient } from './api.ts';
import { dshRestartPending, dshRestartReadPath, dshRestartStore } from './dsh-restart.ts';
import { useReadResource } from './use-read-resource.ts';

export function useDshRestart(api: ApiClient, connected: boolean) {
  const store = useMemo(() => dshRestartStore(api), [api]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const resource = useReadResource(api, dshRestartReadPath(state), connected, parseNativeDshRestartSnapshot, { intervalMs: dshRestartPending(state) ? 2_000 : 10_000 });
  useEffect(() => { if (resource.snapshot) store.observe(resource.snapshot); }, [store, resource.snapshot]);
  return { state, pending: dshRestartPending(state), resource };
}
