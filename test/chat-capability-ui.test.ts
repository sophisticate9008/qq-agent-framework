import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilityRevisions, isCapabilitySelection, parseCapabilityPreview, parseCapabilitySnapshot, sameCapabilitySelection } from '../web/lib/chat-capability-ui.ts';
import { nativeFormMetadata, nativeFormSearchTargets } from '../web/lib/native-form-metadata.ts';

const revision = 'a'.repeat(64);
const source = { schema: 1 as const, presetId: 'work.source', revision };
const revisions = Object.fromEntries(['plans', 'personas', 'access', 'adapters', 'providers', 'authorization', 'deployment', 'execution'].map(key => [key, revision]));
const boundary = { mounted: false, effectiveToolScopeVerified: false, externalToolAuthorizationVerified: false, requiresSeparateExternalToolAuthorization: true };
const snapshot = { revisions, activePlanId: 'daily', selection: source, textOnly: false, approval: null, approvalState: 'none',
  catalog: { ...boundary, available: false, presets: [] } };

test('capability selection is explicit, versioned and never coerces missing/null into a work source', () => {
  assert(isCapabilitySelection(source));
  for (const value of [null, undefined, { ...source, schema: '1' }, { ...source, revision: 'latest' }, { ...source, permission: true }]) assert.equal(isCapabilitySelection(value), false);
  assert.equal(sameCapabilitySelection(undefined, null), false);
  assert.equal(sameCapabilitySelection(source, { ...source }), true);
  assert.equal(sameCapabilitySelection(source, { ...source, revision: 'b'.repeat(64) }), false);
});

test('catalog unavailability preserves locally saved source and revisions without implying absence or grants', () => {
  const parsed = parseCapabilitySnapshot(snapshot);
  assert(parsed);
  assert.deepEqual(parsed.selection, source);
  assert.equal(parsed.available, false);
  assert.equal(parsed.approval, null);
  assert.equal(parseCapabilitySnapshot({ ...snapshot, textOnly: true }), null);
  assert.equal(parseCapabilitySnapshot({ ...snapshot, catalog: { ...snapshot.catalog, externalToolAuthorizationVerified: true } }), null);
  assert.equal(parseCapabilitySnapshot({ ...snapshot, approvalState: 'saved' }), null);
});

test('composition approval defaults to the legacy requirement and only an explicit boolean disables it', () => {
  assert.equal(parseCapabilitySnapshot(snapshot)?.compositionApprovalRequired, true);
  assert.equal(parseCapabilitySnapshot({ ...snapshot, compositionApprovalRequired: true })?.compositionApprovalRequired, true);
  const whitelist = parseCapabilitySnapshot({ ...snapshot, compositionApprovalRequired: false });
  assert(whitelist);
  assert.equal(whitelist.compositionApprovalRequired, false);
  assert.deepEqual(whitelist.selection, source);
  assert.equal(whitelist.approval, null);
  for (const value of [null, 'false', 0, 1, [], {}]) {
    assert.equal(parseCapabilitySnapshot({ ...snapshot, compositionApprovalRequired: value }), null);
  }
  assert.equal(parseCapabilitySnapshot({ ...snapshot, compositionApprovalRequired: false,
    catalog: { ...snapshot.catalog, externalToolAuthorizationVerified: true } }), null);
});

test('catalog supports named versions and refuses malformed or ambiguous entries', () => {
  const preset = { presetId: source.presetId, revision, name: '工作包', description: '合成用途', composable: true, packages: ['work.fixture'], missingReasons: [] };
  const value = { ...snapshot, catalog: { ...boundary, available: true, presets: [preset] } };
  assert.equal(parseCapabilitySnapshot(value)?.presets[0]?.name, '工作包');
  for (const presets of [[preset, preset], [{ ...preset, revision: 1 }], [{ ...preset, composable: 'true' }], [{ ...preset, packages: [null] }]]) {
    assert.equal(parseCapabilitySnapshot({ ...value, catalog: { ...value.catalog, presets } }), null);
  }
});

test('preview accepts only read-only current-source composition with explicit unverified external authorization', () => {
  const request = { schema: 1, source, compositionRevision: revision, target: { profilePath: '/synthetic/profile', credentialsPath: '/synthetic/credentials', layerPaths: [], schemaVersion: '0.2.1-rc.2' } };
  const summary = { ready: true, capabilityComposition: { schema: 1, source, revision, externalToolAuthorizationVerified: false }, selectablePresets: [{ conversationKind: 'group', contextWindow: 128000 }, { conversationKind: 'private', contextWindow: 64000 }] };
  const value = { revisions, selection: source, textOnly: false, readOnly: true, externalMutation: false, approvalMatchesPreview: false,
    preparation: { state: 'prepared', targetRevision: revision, summary, capabilityApprovalRequest: request } };
  assert.equal(parseCapabilityPreview(value)?.routes.length, 2);
  assert.equal(parseCapabilityPreview({ ...value, externalMutation: true }), null);
  assert.equal(parseCapabilityPreview({ ...value, preparation: { ...value.preparation, summary: { ...summary, capabilityComposition: { ...summary.capabilityComposition, externalToolAuthorizationVerified: true } } } }), null);
  assert.equal(parseCapabilityPreview({ ...value, selection: { ...source, revision: 'b'.repeat(64) } }), null);
});

test('capability revisions require all eight keys and metadata includes only public static labels', () => {
  assert.deepEqual(capabilityRevisions(revisions), revisions);
  assert.equal(capabilityRevisions({ ...revisions, authorization: 'latest' }), null);
  assert.equal(capabilityRevisions({ ...revisions, grant: revision }), null);
  assert(nativeFormSearchTargets().some(target => target.title === nativeFormMetadata.capabilities.fields.selection));
  assert(!nativeFormSearchTargets().some(target => target.title === '工具委派尝试次数（按轮）'));
  assert.equal(JSON.stringify(nativeFormSearchTargets()).includes('/synthetic/credentials'), false);
});
