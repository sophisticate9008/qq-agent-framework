import assert from 'node:assert/strict';
import test from 'node:test';
import { parseChatAuthorization } from '../web/lib/chat-runtime.ts';
import { authorizationMode, canEditCountedAuthorization, countedAuthorizationRequest, whitelistAuthorizationRequest } from '../web/lib/chat-authorization-mode.ts';

const grant = { conversationId: 'group:123', submitUses: 2, sendUses: 3, expiresAt: null };
const legacy = { revision: 'a'.repeat(64), version: 'old', grants: [grant] };
const counted = { ...legacy, mode: 'counted' as const, whitelistAvailable: true, modeSource: 'legacy-counted' as const,
  authorizationDocumentPresent: true, migrationRequired: false, taskDelegationAvailable: false };

test('mode DTO preserves explicit states and legacy omission without guessing a default', () => {
  for (const [mode, modeSource] of [['whitelist', 'new-default-whitelist'], ['whitelist', 'explicit'],
    ['counted', 'legacy-counted'], ['counted', 'missing-with-history']] as const) {
    const response = { ...counted, mode, modeSource, grants: mode === 'whitelist' ? [] : counted.grants,
      authorizationDocumentPresent: modeSource === 'explicit' || modeSource === 'legacy-counted', migrationRequired: modeSource === 'missing-with-history' };
    const parsed = parseChatAuthorization(response);
    assert.deepEqual(parsed, response);
    assert.equal(authorizationMode(parsed!), mode);
  }
  assert.deepEqual(parseChatAuthorization(legacy), legacy);
  assert.equal(authorizationMode(legacy), 'unconfirmed');
  assert.equal(authorizationMode({ ...counted, mode: 'whitelist', whitelistAvailable: false }), 'unconfirmed');
  assert.equal(authorizationMode({ ...counted, mode: 'whitelist', whitelistAvailable: undefined }), 'unconfirmed');
  for (const key of ['modeSource', 'authorizationDocumentPresent', 'migrationRequired', 'taskDelegationAvailable']) {
    assert.equal(authorizationMode({ ...counted, [key]: undefined }), 'unconfirmed');
  }
});

test('unknown mode, malformed support flags and numeric null quotas fail parsing', () => {
  for (const mode of [null, '', 'default', 1, true]) assert.equal(parseChatAuthorization({ ...counted, mode }), null);
  for (const modeSource of [null, '', 'unknown', 1, {}, ['explicit']]) assert.equal(parseChatAuthorization({ ...counted, modeSource }), null);
  for (const key of ['whitelistAvailable', 'authorizationDocumentPresent', 'migrationRequired', 'taskDelegationAvailable']) {
    for (const value of [null, 1, 'true']) assert.equal(parseChatAuthorization({ ...counted, [key]: value }), null);
  }
  for (const key of ['submitUses', 'sendUses', 'cancelUses', 'toolDelegationUses']) {
    assert.equal(parseChatAuthorization({ ...counted, grants: [{ ...grant, [key]: null }] }), null);
  }
});

test('contradictory mode evidence cannot become whitelist-ready or editable counted mode', () => {
  for (const state of [
    { ...counted, mode: 'whitelist' as const, modeSource: 'missing-with-history' as const },
    { ...counted, mode: 'whitelist' as const, migrationRequired: true },
    { ...counted, modeSource: 'new-default-whitelist' as const },
    { ...counted, mode: 'whitelist' as const, modeSource: 'explicit' as const },
  ]) {
    assert.equal(authorizationMode(state), 'unconfirmed');
    assert.equal(canEditCountedAuthorization(state), false);
    assert.equal(whitelistAuthorizationRequest(state, 'new'), null);
  }
});

test('whitelist migration uses snapshot CAS and a new version without rewriting old grants', () => {
  const before = JSON.stringify(counted);
  assert.deepEqual(whitelistAuthorizationRequest(counted, 'new'), {
    revision: counted.revision, version: 'new', mode: 'whitelist', grants: [],
  });
  assert.equal(JSON.stringify(counted), before);
  assert.equal(whitelistAuthorizationRequest(counted, counted.version), null);
  assert.equal(whitelistAuthorizationRequest(legacy, 'new'), null);
  assert.equal(whitelistAuthorizationRequest({ ...counted, whitelistAvailable: false }, 'new'), null);
  assert.equal(whitelistAuthorizationRequest({ ...counted, mode: 'whitelist', modeSource: 'explicit', grants: [] }, 'new'), null);
});

test('legacy counted edits preserve omitted mode and optional grant fields', () => {
  assert.deepEqual(countedAuthorizationRequest(legacy, 'new', [grant]), { revision: legacy.revision, version: 'new', grants: [grant] });
  assert.deepEqual(countedAuthorizationRequest(counted, 'new', [grant]), { revision: counted.revision, version: 'new', mode: 'counted', grants: [grant] });
  assert.equal(countedAuthorizationRequest(counted, counted.version, [grant]), null);
  assert.equal(canEditCountedAuthorization({ ...counted, whitelistAvailable: false }), true);
  assert.deepEqual(countedAuthorizationRequest({ ...legacy, whitelistAvailable: false }, 'new', [grant]), {
    revision: legacy.revision, version: 'new', grants: [grant],
  });
  const missing = { ...counted, modeSource: 'missing-with-history' as const, migrationRequired: true, authorizationDocumentPresent: false };
  assert.equal(canEditCountedAuthorization(missing), false);
  assert.equal(countedAuthorizationRequest(missing, 'new', []), null);
  assert.notEqual(whitelistAuthorizationRequest(missing, 'new'), null);
});
