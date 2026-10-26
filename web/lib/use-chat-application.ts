import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { parseNativeApplicationEnvelope } from '../../src/contracts/native-application.ts';
import type { ApiClient } from './api.ts';
import { chatApplicationPath, chatApplicationStore } from './chat-application.ts';
import { useReadResource } from './use-read-resource.ts';

export function useChatApplication(api: ApiClient, connected: boolean) {
  const application = useMemo(() => chatApplicationStore(api), [api]);
  const state = useSyncExternalStore(application.subscribe, application.getSnapshot, application.getSnapshot);
  const operationId = state.kind === 'application' && (state.busy || state.blocked) ? state.operationId : null;
  const resource = useReadResource(api, chatApplicationPath(operationId), connected, parseNativeApplicationEnvelope, { intervalMs: 2_000 });
  useEffect(() => { if (resource.snapshot?.operation) application.observe(resource.snapshot.operation); }, [application, resource.snapshot]);
  return { application, state, observationError: resource.error, initialLoading: resource.loading && resource.snapshot === null, refresh: resource.refresh };
}
