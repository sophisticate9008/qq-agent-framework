import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePackageConfigurationDescriptor, parsePackageConfigurationList, parsePackageConfigurationSnapshot, type PackageConfigurationDescriptor } from '../src/contracts/package-configuration.ts';
import { packageConfigurationChanges, packageConfigurationDraft } from '../web/lib/package-configuration-ui.ts';
import { NATIVE_OUTPUT_CONFIGURATION } from '../src/host/native-output.ts';
import { DEFAULT_NATIVE_OUTPUT } from '../src/contracts/native-output.ts';
import { parseChatAuthorization } from '../web/lib/chat-runtime.ts';
import { authorizationDrafts, authorizationValues } from '../web/lib/chat-authorization-draft.ts';
import { forwardAuthorizationRequest } from '../web/lib/chat-authorization-mode.ts';

const descriptor: PackageConfigurationDescriptor = { id: 'fixture-settings', owner: 'fixture-package', schemaVersion: 2, title: '受控设置', description: '', application: 'restart', fields: [
  { id: 'enabled', path: ['nested', 'enabled'], label: '开启', description: '', kind: 'boolean' },
  { id: 'limit', path: ['limit'], label: '期限', description: '', kind: 'integer', minimum: 1, maximum: 12 },
  { id: 'names', path: ['names'], label: '别名', description: '', kind: 'string-list', maximumEntries: 2, maximumLength: 4 },
] };
test('package fields retain unknown configuration values, apply declared paths and reject invalid controlled input', () => {
  const original = { schema: 2, nested: { enabled: false, untouched: 'keep' }, limit: 4, names: ['one'], privateState: { untouched: true } };
  const draft = packageConfigurationDraft(descriptor, original); assert(draft);
  const next = packageConfigurationChanges(descriptor, original, { ...draft, enabled: true, limit: '12', names: 'one\ntwo' });
  assert.deepEqual(next, { ...original, nested: { enabled: true, untouched: 'keep' }, limit: 12, names: ['one', 'two'] });
  assert.equal(original.nested.enabled, false);
  assert.throws(() => packageConfigurationChanges(descriptor, original, { ...draft, limit: '13' }));
  assert.throws(() => packageConfigurationChanges(descriptor, original, { ...draft, names: 'one\ntwo\nthree' }));
  assert.throws(() => packageConfigurationChanges(descriptor, original, { ...draft, names: 'oversized' }));
  assert.equal(packageConfigurationDraft(descriptor, { limit: 1 }), null);
});

test('package runtime decoders reject unsafe descriptors, malformed states and implicit schema coercion', () => {
  assert(parsePackageConfigurationDescriptor(descriptor));
  assert.equal(parsePackageConfigurationDescriptor({ ...descriptor, fields: [{ ...descriptor.fields[0], path: ['__proto__', 'polluted'] }] }), null);
  assert.equal(parsePackageConfigurationDescriptor({ ...descriptor, fields: [...descriptor.fields, descriptor.fields[0]] }), null);
  assert.equal(parsePackageConfigurationDescriptor({ ...descriptor, fields: [{ ...descriptor.fields[1], minimum: 13 }] }), null);
  const ready = { descriptor, state: 'ready', revision: 'a'.repeat(64), source: 'stored', errorCode: null };
  assert(parsePackageConfigurationList({ schema: 1, packages: [ready] }));
  assert.equal(parsePackageConfigurationList({ schema: 1, packages: [{ ...ready, revision: null, source: null }] }), null);
  assert(parsePackageConfigurationList({ schema: 1, packages: [{ ...ready, state: 'unavailable', errorCode: 'PACKAGE_CONFIGURATION_MIGRATION_REQUIRED' }] }));
  assert.equal(parsePackageConfigurationSnapshot({ schema: 1, id: 'fixture-settings', revision: 'a'.repeat(64), schemaVersion: '2', source: 'stored', application: 'live', configuration: {} }), null);
  const output = packageConfigurationDraft(NATIVE_OUTPUT_CONFIGURATION.descriptor, DEFAULT_NATIVE_OUTPUT); assert(output);
  const changed = packageConfigurationChanges(NATIVE_OUTPUT_CONFIGURATION.descriptor, DEFAULT_NATIVE_OUTPUT, { ...output, 'long-forward': true, 'long-threshold': '4000' });
  assert.deepEqual(changed, { ...DEFAULT_NATIVE_OUTPUT, longTextAsForward: true, longTextThreshold: 4000 });
  assert.equal(Object.hasOwn(changed as object, 'forwardAllow'), false);
});

test('forward authorization remains independent and exact through whitelist requests and counted draft round trips', () => {
  const base = { revision: 'a'.repeat(64), version: 'original', grants: [], mode: 'whitelist', whitelistAvailable: true, modeSource: 'explicit', authorizationDocumentPresent: true, migrationRequired: false, taskDelegationAvailable: true };
  const authorization = parseChatAuthorization({ ...base, forwardAllow: ['group:123'] }); assert(authorization);
  assert.deepEqual(authorization.forwardAllow, ['group:123']);
  assert.deepEqual(forwardAuthorizationRequest(authorization, 'next', ['private:456']), { revision: base.revision, version: 'next', mode: 'whitelist', grants: [], forwardAllow: ['private:456'] });
  assert.equal(forwardAuthorizationRequest(authorization, 'original', []), null);
  assert.equal(forwardAuthorizationRequest(authorization, 'next', ['group:123', 'group:123']), null);
  assert.equal(parseChatAuthorization({ ...base, mode: 'counted', forwardAllow: ['group:123'] }), null);
  assert.equal(parseChatAuthorization({ ...base, forwardAllow: ['group:9999999999999999'] }), null);
  const counted = parseChatAuthorization({ revision: base.revision, version: 'counted', grants: [{ conversationId: 'group:123', submitUses: 2, sendUses: 3, forwardUses: 1, expiresAt: null }] }); assert(counted);
  assert.deepEqual(authorizationValues(authorizationDrafts(counted.grants)), counted.grants);
  assert.equal(authorizationValues([{ ...authorizationDrafts(counted.grants)[0]!, forwardUses: '-1' }]), null);
});
