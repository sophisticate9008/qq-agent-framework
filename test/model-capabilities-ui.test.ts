import assert from 'node:assert/strict';
import test from 'node:test';
import { modelCapabilitiesUnavailableMessage, modelReasoningEffortOptions, parseModelCapabilities } from '../web/lib/model-capabilities.ts';

test('unavailable model metadata preserves the selected effort visibly without offering unverified choices', () => {
  const unavailable = parseModelCapabilities({ provider: 'fixture', model: 'model', state: 'unavailable', reasoningEfforts: [], missingReasons: ['model_metadata_not_observed'] });
  assert(unavailable);
  assert.deepEqual(modelReasoningEffortOptions(unavailable, 'high'), [
    { value: 'high', label: 'high（当前值，支持待核验）', disabled: true },
  ]);
  assert.deepEqual(modelReasoningEffortOptions(null, 'high'), modelReasoningEffortOptions(unavailable, 'high'));
  assert.deepEqual(modelReasoningEffortOptions(unavailable, ''), []);
});

test('restored real metadata unlocks only declared efforts and retains an unsupported draft value', () => {
  const available = parseModelCapabilities({ provider: 'fixture', model: 'model', state: 'available', reasoningEfforts: ['off', 'high'], missingReasons: [] });
  assert(available);
  assert.deepEqual(modelReasoningEffortOptions(available, 'high'), [
    { value: 'off', label: 'off', disabled: false }, { value: 'high', label: 'high', disabled: false },
  ]);
  const options = modelReasoningEffortOptions(available, 'medium');
  assert.deepEqual(options[0], { value: 'medium', label: 'medium（当前值，未在支持列表中）', disabled: true });
  assert.deepEqual(options.filter(option => !option.disabled).map(option => option.value), ['off', 'high']);
  assert.deepEqual(available.reasoningEfforts, ['off', 'high']);
});

test('missing model capabilities explain actionable bounded reasons without exposing raw diagnostics', () => {
  assert.match(modelCapabilitiesUnavailableMessage(['model_metadata_not_observed']), /供应商.*能力声明/);
  assert.match(modelCapabilitiesUnavailableMessage(['local_dsh_connection_required']), /自动连接/);
  const unknown = modelCapabilitiesUnavailableMessage(['unknown-private-path:/private/secret', '__proto__']);
  assert.match(unknown, /模型能力缓存/);
  assert.doesNotMatch(unknown, /private|secret|__proto__/);
  const bounded = modelCapabilitiesUnavailableMessage(['model_capabilities_timeout', 'model_capabilities_timeout', 'model_metadata_conflict', 'model_not_configured']);
  assert.match(bounded, /超时/);
  assert.match(bounded, /不一致/);
  assert.doesNotMatch(bounded, /尚未登记/);
});
