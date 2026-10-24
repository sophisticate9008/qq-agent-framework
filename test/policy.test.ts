import test from 'node:test';
import assert from 'node:assert/strict';
import { createPolicy } from '../src/core/policy.ts';

function fixture() {
  let now = 100;
  const policy = createPolicy({ clock: () => now });
  const grant = { id: 'grant', featureId: 'sample', conversationId: 'demo:room',
    capabilities: ['messaging.send'], maxUses: { 'messaging.send': 1 }, expiresAt: 200 };
  const request = { featureId: 'sample', conversationId: 'demo:room', capability: 'messaging.send' };
  return { policy, grant, request, advance: (value: number) => { now = value; } };
}

test('capability declarations, preferences and claims cannot create a grant', () => {
  const { policy, request } = fixture();
  const claimed = { ...request, authorized: true, preferences: { allowSend: true } };
  assert.throws(() => policy.reserve(claimed), { code: 'POLICY_DENIED' });
});

test('budgets reserve synchronously and scopes never broaden', () => {
  const { policy, grant, request } = fixture();
  policy.grant(grant);
  for (const changed of [{ conversationId: 'demo:other' }, { featureId: 'other' }, { capability: 'model.respond' }]) {
    assert.throws(() => policy.reserve({ ...request, ...changed }), { code: 'POLICY_DENIED' });
  }
  const held = policy.reserve(request);
  assert.throws(() => policy.reserve(request), { code: 'BUDGET_EXHAUSTED' });
  policy.begin(held);
  assert.throws(() => policy.begin(held), { code: 'INVALID_RESERVATION' });
  assert.equal(policy.describe().grants[0].used['messaging.send'], 1);
});

test('authorization requires an exact feature conversation capability index match', () => {
  const { policy, request } = fixture();
  for (const [id, featureId, conversationId, capability] of [
    ['feature-mismatch', 'other', request.conversationId, request.capability],
    ['conversation-mismatch', request.featureId, 'demo:other', request.capability],
    ['capability-mismatch', request.featureId, request.conversationId, 'model.respond'],
  ]) {
    policy.grant({ id, featureId, conversationId, capabilities: [capability], maxUses: { [capability]: 1 } });
  }
  assert.throws(() => policy.reserve(request), { code: 'POLICY_DENIED' });
});

test('duplicate grant budgets are consumed in grant insertion order', () => {
  const { policy, grant, request } = fixture();
  policy.grant({ ...grant, id: 'first', maxUses: { 'messaging.send': 2 } });
  policy.grant({ ...grant, id: 'second', maxUses: { 'messaging.send': 2 } });
  for (let index = 0; index < 3; index++) policy.begin(policy.reserve(request));
  const grants = policy.describe().grants;
  assert.equal(grants.find(value => value.id === 'first')?.used['messaging.send'], 2);
  assert.equal(grants.find(value => value.id === 'second')?.used['messaging.send'], 1);
});

test('reservations authenticate only by their original frozen object', () => {
  const { policy, grant, request } = fixture();
  policy.grant(grant);
  const held = policy.reserve(request);
  assert.throws(() => policy.begin({ ...held }), { code: 'INVALID_RESERVATION' });
  policy.begin(held);
});

test('pause, expiry and revocation are rechecked immediately before effects', () => {
  for (const change of ['pause', 'expire', 'revoke']) {
    const { policy, grant, request, advance } = fixture();
    policy.grant(grant);
    const held = policy.reserve(request);
    if (change === 'pause') policy.setPaused(true);
    if (change === 'expire') advance(200);
    if (change === 'revoke') policy.revoke(grant.id);
    assert.throws(() => policy.begin(held), { code: { pause: 'POLICY_PAUSED', expire: 'GRANT_EXPIRED', revoke: 'GRANT_REVOKED' }[change] });
  }
});

test('grants require explicit finite budgets and immutable ids', () => {
  const { policy, grant } = fixture();
  for (const maxUses of [{}, { 'messaging.send': -1 }, { 'messaging.send': 1.5 }, { 'messaging.send': Infinity }]) {
    assert.throws(() => policy.grant({ ...grant, maxUses }));
  }
  policy.grant(grant);
  assert.throws(() => policy.grant(grant), { code: 'GRANT_EXISTS' });
  assert(Object.isFrozen(policy.describe().grants[0].used));
});
