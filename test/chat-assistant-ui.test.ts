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
  assert.equal(assistantAvailabilityMessage(snapshot), '助手执行待接入');
});

test('assistant parser accepts a future verified available response without rejecting its saved configuration', () => {
  const snapshot = parseChatAssistant({ ...current, executionAvailable: true, missingReasons: [] });
  assert(snapshot);
  assert.equal(snapshot.state, 'available');
  assert.equal(snapshot.executionAvailable, true);
  assert.deepEqual(snapshot.configuration, current.configuration);
  assert.equal(assistantAvailabilityMessage(snapshot), '助手执行已就绪');
});

test('future bounded unavailable reason codes remain visible and contradictory or malformed states are rejected', () => {
  const snapshot = parseChatAssistant({ ...current, missingReasons: ['future_backend_condition', 'model.unavailable'] });
  assert(snapshot);
  assert.equal(snapshot.state, 'unavailable');
  assert.match(assistantAvailabilityMessage(snapshot), /future_backend_condition/);
  for (const input of [
    { ...current, executionAvailable: true }, { ...current, missingReasons: [] },
    { ...current, executionAvailable: 'true' }, { ...current, missingReasons: [null] },
    { ...current, missingReasons: [''] }, { ...current, missingReasons: ['future', 'future'] },
    { ...current, missingReasons: ['x'.repeat(129)] },
    { ...current, missingReasons: Array.from({ length: 33 }, (_, index) => `reason_${index}`) },
  ]) assert.equal(parseChatAssistant(input), null);
});
