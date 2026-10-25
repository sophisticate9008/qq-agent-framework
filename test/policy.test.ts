import test from 'node:test';
import assert from 'node:assert/strict';
import { createPolicy } from '../src/core/policy.ts';
import { incrementPolicyUsage } from '../src/core/policy-limits.ts';

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

test('grants require explicit finite or null limits and immutable ids', () => {
  const { policy, grant } = fixture();
  for (const maxUses of [{}, { 'messaging.send': -1 }, { 'messaging.send': 1.5 }, { 'messaging.send': Infinity }]) {
    assert.throws(() => policy.grant({ ...grant, maxUses }));
  }
  policy.grant(grant);
  assert.throws(() => policy.grant(grant), { code: 'GRANT_EXISTS' });
  assert(Object.isFrozen(policy.describe().grants[0].used));
});

test('explicit null is unmetered independently of finite and zero capability budgets', () => {
  const { policy, grant, request } = fixture();
  policy.grant({ ...grant, capabilities: ['messaging.send', 'model.respond', 'agent.tools.delegate'],
    maxUses: { 'messaging.send': null, 'model.respond': 1, 'agent.tools.delegate': 0 } });
  for (let attempt = 0; attempt < 256; attempt++) policy.begin(policy.reserve(request));
  policy.begin(policy.reserve({ ...request, capability: 'model.respond' }));
  assert.throws(() => policy.reserve({ ...request, capability: 'model.respond' }), { code: 'BUDGET_EXHAUSTED' });
  assert.throws(() => policy.reserve({ ...request, capability: 'agent.tools.delegate' }), { code: 'BUDGET_EXHAUSTED' });
  assert.deepEqual(policy.describe().grants[0].maxUses, { 'messaging.send': null, 'model.respond': 1, 'agent.tools.delegate': 0 });
  assert.deepEqual(policy.describe().grants[0].used, { 'messaging.send': 256, 'model.respond': 1, 'agent.tools.delegate': 0 });
});

test('unmetered reservations retain exact scope, trusted identity and single-use semantics', () => {
  const { policy, grant, request } = fixture();
  policy.grant({ ...grant, maxUses: { 'messaging.send': null } });
  for (const changed of [{ conversationId: 'demo:other' }, { featureId: 'other' }, { capability: 'model.respond' }]) {
    assert.throws(() => policy.reserve({ ...request, ...changed }), { code: 'POLICY_DENIED' });
  }
  const held = policy.reserve(request);
  assert(Object.isFrozen(held));
  assert.throws(() => policy.begin({ ...held }), { code: 'INVALID_RESERVATION' });
  const other = createPolicy();
  assert.throws(() => other.begin(held), { code: 'INVALID_RESERVATION' });
  policy.begin(held);
  assert.throws(() => policy.begin(held), { code: 'INVALID_RESERVATION' });
});

test('unmetered does not bypass pause, revocation or expiry at reserve or begin', () => {
  for (const change of ['pause', 'expire', 'revoke'] as const) {
    const { policy, grant, request, advance } = fixture();
    policy.grant({ ...grant, maxUses: { 'messaging.send': null } });
    const held = policy.reserve(request);
    if (change === 'pause') policy.setPaused(true);
    if (change === 'expire') advance(200);
    if (change === 'revoke') policy.revoke(grant.id);
    assert.throws(() => policy.begin(held), { code: { pause: 'POLICY_PAUSED', expire: 'GRANT_EXPIRED', revoke: 'GRANT_REVOKED' }[change] });
    assert.throws(() => policy.reserve(request), { code: change === 'pause' ? 'POLICY_PAUSED' : 'POLICY_DENIED' });
    assert.equal(policy.describe().grants[0].used['messaging.send'], 1);
  }
});

test('unmetered grants preserve insertion order and require explicit exact limit entries', () => {
  const { policy, grant, request } = fixture();
  for (const maxUses of [null, {}, { 'messaging.send': 'null' }, { 'messaging.send': false },
    { 'messaging.send': null, 'model.respond': null }]) assert.throws(() => policy.grant({ ...grant, maxUses }));
  policy.grant({ ...grant, id: 'finite-first' });
  policy.grant({ ...grant, id: 'unmetered-second', maxUses: { 'messaging.send': null } });
  for (let attempt = 0; attempt < 4; attempt++) policy.begin(policy.reserve(request));
  assert.deepEqual(policy.describe().grants.map(value => value.used['messaging.send']), [1, 3]);
  assert.throws(() => policy.grant({ ...grant, id: 'unmetered-second' }), { code: 'GRANT_EXISTS' });
});

test('shared audit increment saturates without wrapping or representing an attempt quota', () => {
  assert.equal(incrementPolicyUsage(0), 1);
  assert.equal(incrementPolicyUsage(Number.MAX_SAFE_INTEGER - 1), Number.MAX_SAFE_INTEGER);
  assert.equal(incrementPolicyUsage(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
});

test('same-process prototype modification cannot supply a missing own capability limit', () => {
  const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'agent.submit');
  try {
    for (const inherited of [null, 1]) {
      const { policy, grant, request } = fixture();
      const malformed = { ...grant, capabilities: ['agent.submit'], maxUses: { unrelated: null } };
      assert.throws(() => policy.grant(malformed), { code: 'INVALID_GRANT' });
      Object.defineProperty(Object.prototype, 'agent.submit', { value: inherited, configurable: true, writable: true });
      assert.throws(() => policy.grant(malformed), { code: 'INVALID_GRANT' });
      assert.throws(() => policy.reserve({ ...request, capability: 'agent.submit' }), { code: 'POLICY_DENIED' });
      policy.grant({ ...malformed, id: 'explicit-own-null', maxUses: { 'agent.submit': null } });
      policy.begin(policy.reserve({ ...request, capability: 'agent.submit' }));
      assert.equal(policy.describe().grants[0].maxUses['agent.submit'], null);
      assert(Object.hasOwn(policy.describe().grants[0].maxUses, 'agent.submit'));
      Reflect.deleteProperty(Object.prototype, 'agent.submit');
    }
  } finally {
    if (descriptor) Object.defineProperty(Object.prototype, 'agent.submit', descriptor);
    else Reflect.deleteProperty(Object.prototype, 'agent.submit');
  }
});
