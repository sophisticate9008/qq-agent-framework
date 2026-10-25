import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizationDrafts, authorizationValues } from '../web/lib/chat-authorization-draft.ts';
import { parseChatAuthorization } from '../web/lib/chat-runtime.ts';

const grant = { conversationId: 'group:123', submitUses: 3, sendUses: 4, expiresAt: null };
const root = { revision: 'a'.repeat(64), version: 'legacy', grants: [grant] };

test('legacy four/five-field authorization round trips preserve omission even when runtime supports delegation', () => {
  for (const original of [grant, { ...grant, cancelUses: 2 }]) {
    const parsed = parseChatAuthorization({ ...root, toolDelegationAvailable: true, grants: [original] });
    assert(parsed);
    const result = authorizationValues(authorizationDrafts(parsed.grants));
    assert.deepEqual(result, [original]);
    assert.equal(Object.hasOwn(result![0]!, 'toolDelegationUses'), false);
  }
});

test('delegation is an independent optional bounded integer, not an implicit cancel or submit grant', () => {
  for (const amount of [0, 1, 1_000_000]) {
    const saved = { ...grant, toolDelegationUses: amount };
    assert.deepEqual(authorizationValues(authorizationDrafts([saved])), [saved]);
  }
  for (const amount of [-1, '1', 1.5, 1_000_001, null]) assert.equal(parseChatAuthorization({ ...root, grants: [{ ...grant, toolDelegationUses: amount }] }), null);
  for (const available of [null, 1, 'true']) assert.equal(parseChatAuthorization({ ...root, toolDelegationAvailable: available }), null);
});

test('only explicit enable writes a zero field, disable removes it, malformed quota prevents submission', () => {
  const [entry] = authorizationDrafts([grant]);
  assert(entry);
  assert.deepEqual(authorizationValues([{ ...entry, sendUses: '8' }]), [{ ...grant, sendUses: 8 }]);
  assert.deepEqual(authorizationValues([{ ...entry, toolDelegationUses: '0' }]), [{ ...grant, toolDelegationUses: 0 }]);
  assert.deepEqual(authorizationValues([{ ...entry, toolDelegationUses: undefined }]), [grant]);
  for (const quota of ['', '-1', '1.5', '1e2', '1000001']) assert.equal(authorizationValues([{ ...entry, toolDelegationUses: quota }]), null);
});
