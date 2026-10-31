import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CHAT_INPUT_CONFIGURATION } from '../src/contracts/chat-input-configuration.ts';
import { chatInputConfiguration, chatInputForm, parseChatInputSnapshot } from '../web/lib/chat-input-ui.ts';

test('trigger form preserves domain defaults and converts seconds without broadening conversation scopes', () => {
  const form = chatInputForm(DEFAULT_CHAT_INPUT_CONFIGURATION);
  assert.deepEqual(chatInputConfiguration(form), DEFAULT_CHAT_INPUT_CONFIGURATION);
  const parsed = chatInputConfiguration({ ...form, nicknames: '鲸鲸\n小鲸鱼', continuationSeconds: '0.001', include: 'group:123', exclude: 'private:456' });
  assert.equal(parsed?.continuationMs, 1); assert.deepEqual(parsed?.scopes.include, ['group:123']); assert.deepEqual(parsed?.scopes.exclude, ['private:456']);
  assert.equal(chatInputConfiguration({ ...form, groupWakeProbabilityPercent: '0' })?.groupWakeProbabilityPercent, 0);
  for (const patch of [{ continuationSeconds: '301' }, { continuationSeconds: '1e2' }, { nicknames: 'Name\nname' }, { include: '123' },
    { groupWakeProbabilityPercent: '101' }, { groupWakeProbabilityPercent: '0.5' }, { groupWakeProbabilityPercent: '' }]) {
    assert.equal(chatInputConfiguration({ ...form, ...patch }), null);
  }
});

test('trigger snapshot decoder requires the installed package identity, CAS and declared live application contract', () => {
  const value = { schema: 1, id: 'chat-input', revision: 'a'.repeat(64), schemaVersion: 1, source: 'default', application: 'live', configuration: DEFAULT_CHAT_INPUT_CONFIGURATION };
  assert.deepEqual(parseChatInputSnapshot(value), value);
  for (const patch of [{ id: 'unknown-package' }, { revision: 'latest' }, { application: 'restart' }, { configuration: { ...DEFAULT_CHAT_INPUT_CONFIGURATION, enabled: 'true' } }]) assert.equal(parseChatInputSnapshot({ ...value, ...patch }), null);
});
