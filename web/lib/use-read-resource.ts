import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ApiClient } from './api.ts';
import { readResource, readResourceSnapshot, subscribeReadResource } from './resource-reader.ts';

export function useReadResource<Value>(api: ApiClient, path: string, connected: boolean, parse: (value: unknown) => Value | null,
  options: { readonly intervalMs?: number; readonly pollWhen?: () => boolean } = {}) {
  const getSnapshot = useCallback(() => readResourceSnapshot(api, path), [api, path]);
  const subscribe = useCallback((listener: () => void) => subscribeReadResource(api, path, listener), [api, path]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [reload, setReload] = useState(0);
  const policy = useRef(options);
  policy.current = options;
  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController();
    const read = (initial = false) => {
      if (!initial && (document.visibilityState === 'hidden' || policy.current.pollWhen?.() === false)) return;
      void readResource(api, path, controller.signal, initial ? reload === 0 ? 1_000 : 0 : Math.min(options.intervalMs ?? 0, 250)).catch(() => undefined);
    };
    read(true);
    const timer = options.intervalMs === undefined ? undefined : setInterval(read, options.intervalMs);
    const visible = () => { if (document.visibilityState === 'visible' && options.intervalMs !== undefined) read(); };
    document.addEventListener('visibilitychange', visible);
    return () => { controller.abort(); if (timer !== undefined) clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [api, path, connected, reload, options.intervalMs]);
  const value = useMemo(() => connected && snapshot.hasValue ? parse(snapshot.value) : null, [connected, snapshot.hasValue, snapshot.value, parse]);
  const error = useMemo(() => connected ? snapshot.error ?? (snapshot.hasValue && value === null ? new Error('invalid_read_resource') : null) : null,
    [connected, snapshot.error, snapshot.hasValue, value]);
  return { snapshot: value, loading: connected && (snapshot.loading || !snapshot.hasValue && snapshot.error === null),
    error,
    refresh: () => setReload(value => value + 1), updatedAt: snapshot.updatedAt };
}
