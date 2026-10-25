import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfigurationDraft } from '../web/lib/configuration-drafts.ts';

test('configuration drafts distinguish an explicit inherited null from an absent key', () => {
  const drafts: Readonly<Record<string, number | null>> = { 'admin:accessSessionTtlMs': null };
  assert.equal(readConfigurationDraft(drafts, 'admin:accessSessionTtlMs', 900_000), null);
  assert.equal(readConfigurationDraft(drafts, 'missing', 900_000), 900_000);
});

test('configuration drafts preserve falsy values and ignore inherited object properties', () => {
  const drafts: Readonly<Record<string, string | number | boolean | null>> = { text: '', count: 0, enabled: false, inherited: null };
  assert.equal(readConfigurationDraft(drafts, 'text', 'fallback'), '');
  assert.equal(readConfigurationDraft(drafts, 'count', 10), 0);
  assert.equal(readConfigurationDraft(drafts, 'enabled', true), false);
  assert.equal(readConfigurationDraft(drafts, 'inherited', 'fallback'), null);
  for (const key of ['constructor', 'toString', '__proto__']) assert.equal(readConfigurationDraft(drafts, key, 'fallback'), 'fallback');
});
