import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePlanCatalog } from '../web/lib/chat-plans.ts';
import { parseChatAssistant } from '../web/lib/chat-assistant.ts';
import { providerReferences } from '../web/lib/provider-references.ts';
import { isCatalogIdentifier, newCatalogIdentifier } from '../web/lib/catalog-identifier.ts';

test('provider consumers include inactive plans and preserved assistant targets while excluding unrelated providers', () => {
  const base = { name: '常用聊天', description: '', instructions: '回复当前会话', personaId: 'companion', provider: 'local', model: 'old', reasoningEffort: 'medium' };
  const plans = parsePlanCatalog({ revision: 'a'.repeat(64), activePlanId: 'active',
    plans: [{ ...base, id: 'active' }, { ...base, id: 'inactive', model: 'another' }, { ...base, id: 'external', provider: 'remote' }] });
  assert(plans);
  const assistant = parseChatAssistant({ revision: 'b'.repeat(64), executionAvailable: false, missingReasons: ['assistant_backend_not_connected'],
    configuration: { schema: 1, mode: 'chat-only', provider: 'local', model: 'old' } });
  assert(assistant);
  assert.deepEqual(providerReferences('local', plans, assistant).map(reference => [reference.kind, reference.id, reference.model]),
    [['plan', 'active', 'old'], ['plan', 'inactive', 'another'], ['assistant', 'assistant', 'old']]);
  assert.deepEqual(providerReferences('missing', plans, assistant), []);
  assert.equal(providerReferences('local', null, assistant).length, 1);
});

test('automatic catalog ids remain valid and unique when randomUUID is unavailable', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: crypto.getRandomValues.bind(crypto) } });
  try {
    const ids = Array.from({ length: 16 }, (_, index) => newCatalogIdentifier(index % 2 === 0 ? 'persona' : 'plan'));
    assert(ids.every(isCatalogIdentifier));
    assert.equal(new Set(ids).size, ids.length);
    assert.match(ids[0] ?? '', /^persona-/);
    assert.match(ids[1] ?? '', /^plan-/);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
  }
});
