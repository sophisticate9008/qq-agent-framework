import type { ChatAuthorization, ChatGrant } from './chat-runtime.ts';

export function authorizationMode(authorization: ChatAuthorization): 'whitelist' | 'counted' | 'unconfirmed' {
  if (authorization.whitelistAvailable !== true || authorization.mode === undefined || authorization.modeSource === undefined
    || authorization.authorizationDocumentPresent === undefined || authorization.migrationRequired === undefined
    || authorization.taskDelegationAvailable === undefined) return 'unconfirmed';
  const { mode, modeSource, authorizationDocumentPresent: present, migrationRequired: migration } = authorization;
  if (mode === 'whitelist' && (migration || authorization.grants.length !== 0)) return 'unconfirmed';
  if (modeSource === 'explicit' && (!present || migration)
    || modeSource === 'legacy-counted' && (mode !== 'counted' || !present || migration)
    || modeSource === 'new-default-whitelist' && (mode !== 'whitelist' || present || migration)
    || modeSource === 'missing-with-history' && (mode !== 'counted' || present || !migration)) return 'unconfirmed';
  return authorization.mode;
}

export function canEditCountedAuthorization(authorization: ChatAuthorization): boolean {
  return authorization.migrationRequired !== true && authorization.modeSource !== 'missing-with-history'
    && authorization.modeSource !== 'new-default-whitelist' && (authorization.mode === undefined || authorization.mode === 'counted');
}

export function whitelistAuthorizationRequest(authorization: ChatAuthorization, version: string) {
  if (authorizationMode(authorization) !== 'counted' || version === authorization.version) return null;
  return { revision: authorization.revision, version, mode: 'whitelist' as const, grants: [] };
}

export function countedAuthorizationRequest(authorization: ChatAuthorization, version: string, grants: readonly ChatGrant[]) {
  if (!canEditCountedAuthorization(authorization) || version === authorization.version) return null;
  return { revision: authorization.revision, version,
    ...(authorization.mode === undefined ? {} : { mode: 'counted' as const }), grants };
}

export function forwardAuthorizationRequest(authorization: ChatAuthorization, version: string, forwardAllow: readonly string[]) {
  if (authorizationMode(authorization) !== 'whitelist' || version === authorization.version
    || forwardAllow.length > 1024 || new Set(forwardAllow).size !== forwardAllow.length
    || !forwardAllow.every(scope => /^(group|private):[1-9][0-9]{0,15}$/.test(scope) && Number.isSafeInteger(Number(scope.split(':')[1])))) return null;
  return { revision: authorization.revision, version, mode: 'whitelist' as const, grants: [], forwardAllow: [...forwardAllow] };
}
