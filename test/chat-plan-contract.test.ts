import assert from 'node:assert/strict';
import test from 'node:test';
import { CHAT_PLAN_LIMITS, CHAT_PLAN_REASONING_EFFORTS, DEFAULT_CHAT_CONTEXT_LIMITS, isChatPlan, validateChatPlan } from '../src/contracts/chat-plans.ts';
import { parsePlan, parsePlanCatalog } from '../web/lib/chat-plans.ts';

const plan = { id: 'daily', name: '日常聊天', description: '', instructions: '回复当前会话', personaId: 'companion',
  provider: 'local', model: 'vendor/model', reasoningEffort: 'medium' };
const revision = 'a'.repeat(64);

test('browser and host accept the same plan boundaries and normalize omitted context defaults', () => {
  for (const reasoningEffort of CHAT_PLAN_REASONING_EFFORTS) {
    const input = { ...plan, reasoningEffort, description: '长'.repeat(CHAT_PLAN_LIMITS.description),
      instructions: '指'.repeat(CHAT_PLAN_LIMITS.instructions) };
    assert(isChatPlan(input));
    assert.deepEqual(parsePlan(input), validateChatPlan(input));
    assert.deepEqual(parsePlan(input)?.contextLimits, DEFAULT_CHAT_CONTEXT_LIMITS);
  }
  for (const contextLimits of [{ group: 1, private: CHAT_PLAN_LIMITS.contextMaximum }, { group: 200_000, private: 64_000 }]) {
    assert.deepEqual(parsePlan({ ...plan, contextLimits })?.contextLimits, contextLimits);
  }
});

test('browser and host reject malformed fields, unknown enums, secrets and oversized descriptions consistently', () => {
  for (const input of [
    { ...plan, description: 'x'.repeat(CHAT_PLAN_LIMITS.description + 1) },
    { ...plan, instructions: 'x'.repeat(CHAT_PLAN_LIMITS.instructions + 1) },
    { ...plan, name: 'x'.repeat(CHAT_PLAN_LIMITS.name + 1) },
    { ...plan, reasoningEffort: 'future' }, { ...plan, reasoningEffort: '' },
    { ...plan, provider: '../private' }, { ...plan, id: 'a/b' },
    { ...plan, contextLimits: { group: 1, private: 0 } },
    { ...plan, contextLimits: { group: 1, private: 1, inferred: true } },
    { ...plan, capabilitySelection: { schema: 1, presetId: 'work', revision: 'latest' } },
    { ...plan, apiKey: 'synthetic-private-value' },
  ]) {
    assert.equal(isChatPlan(input), false);
    assert.equal(parsePlan(input), null);
    assert.throws(() => validateChatPlan(input), TypeError);
  }
});

test('public plan catalog keeps revisions separate and rejects dangling selection and duplicate ids', () => {
  const catalog = { revision, activePlanId: plan.id, plans: [plan] };
  assert.equal(parsePlanCatalog(catalog)?.plans[0]?.reasoningEffort, 'medium');
  for (const input of [{ ...catalog, revision: 'latest' }, { ...catalog, activePlanId: 'missing' },
    { ...catalog, plans: [plan, plan] }, { ...catalog, secret: 'synthetic-private-value' }]) assert.equal(parsePlanCatalog(input), null);
});
