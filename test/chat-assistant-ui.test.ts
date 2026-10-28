import assert from 'node:assert/strict';
import test from 'node:test';
import { chatAssistantConfigurationResponse, DEFAULT_CHAT_ASSISTANT_CONFIGURATION } from '../src/host/chat-assistant-configuration.ts';
import { assistantAvailabilityMessage, parseChatAssistant } from '../web/lib/chat-assistant.ts';

const current = chatAssistantConfigurationResponse('a'.repeat(64), DEFAULT_CHAT_ASSISTANT_CONFIGURATION);

test('current unconnected assistant response stays unavailable independently from saved configuration', () => {
  const snapshot = parseChatAssistant(current);
  assert(snapshot);
  assert.equal(snapshot.state, 'unavailable');
  assert.equal(snapshot.executionAvailable, false);
  assert.deepEqual(snapshot.missingReasons, ['assistant_backend_not_connected']);
  assert.equal(assistantAvailabilityMessage(snapshot), '助手已关闭');
});

test('assistant parser accepts a future verified available response without rejecting its saved configuration', () => {
  const snapshot = parseChatAssistant({ ...current, executionAvailable: true, missingReasons: [] });
  assert(snapshot);
  assert.equal(snapshot.state, 'available');
  assert.equal(snapshot.executionAvailable, true);
  assert.deepEqual(snapshot.configuration, current.configuration);
  assert.equal(assistantAvailabilityMessage(snapshot), '助手已关闭');
});

test('future bounded unavailable reason codes remain available in details and contradictory or malformed states are rejected', () => {
  const snapshot = parseChatAssistant({ ...current, missingReasons: ['future_backend_condition', 'model.unavailable'] });
  assert(snapshot);
  assert.equal(snapshot.state, 'unavailable');
  assert.deepEqual(snapshot.missingReasons, ['future_backend_condition', 'model.unavailable']);
  for (const input of [
    { ...current, executionAvailable: true }, { ...current, missingReasons: [] },
    { ...current, executionAvailable: 'true' }, { ...current, missingReasons: [null] },
    { ...current, missingReasons: [''] }, { ...current, missingReasons: ['future', 'future'] },
    { ...current, missingReasons: ['x'.repeat(129)] },
    { ...current, missingReasons: Array.from({ length: 33 }, (_, index) => `reason_${index}`) },
  ]) assert.equal(parseChatAssistant(input), null);
});


test('saved assistant settings distinguish unchecked readiness from a failed assistant', () => {
  const value = { ...current, statusSource: 'configuration', executionAvailable: null, missingReasons: [],
    configuration: { ...current.configuration, mode: 'chat-assistant', provider: 'local', model: 'worker' } };
  const parsed = parseChatAssistant(value);
  assert(parsed);
  assert.equal(parsed.state, 'configured');
  assert.equal(parsed.executionAvailable, null);
  assert.equal(assistantAvailabilityMessage(parsed), '助手已开启');
  assert.equal(parseChatAssistant({ ...value, missingReasons: ['failed'] }), null);
  assert.equal(parseChatAssistant({ ...value, statusSource: undefined }), null);
  assert.equal(parseChatAssistant({ ...value, executionAvailable: true }), null);
});
