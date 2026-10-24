import assert from 'node:assert/strict';
import test from 'node:test';
import { isChatPersona, isChatPlan } from '../src/host/chat-plans.ts';
import { isCatalogIdentifier } from '../web/lib/catalog-identifier.ts';

test('browser catalog identifiers accept imported colon IDs accepted by backend persona and plan validators', () => {
  for (const id of ['persona:imported', 'plan:daily-v2.1_test', 'A', `A${'b'.repeat(127)}`]) {
    assert.equal(isCatalogIdentifier(id), true);
    assert.equal(isChatPersona({ id, name: '合成人设', identity: '身份', style: '表达' }), true);
    assert.equal(isChatPlan({ id, name: '合成方案', description: '', instructions: '指令', personaId: id, provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'low' }), true);
  }
});

test('browser catalog identifiers still reject invalid characters, initial punctuation, whitespace and excessive length', () => {
  for (const id of ['', ':first', '-first', '.first', '_first', 'a/b', 'a b', 'a?b', '中文', 'a\n', 'a\0', `A${'b'.repeat(128)}`, null, 1]) {
    assert.equal(isCatalogIdentifier(id), false, String(id));
  }
});
