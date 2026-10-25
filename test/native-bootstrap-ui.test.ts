import assert from 'node:assert/strict';
import test from 'node:test';
import { createContextStore } from '../src/core/context.ts';
import { createBridgeHost } from '../src/host/bridge.ts';
import { createNativeBootstrapMount, type NativeBootstrapMetadata } from '../src/host/native-bootstrap.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';
import { bootstrapDeclarationLabels, bootstrapLifecycleLabel, parseNativeBootstrapSummary } from '../web/lib/native-bootstrap-summary.ts';
import { bootstrapRuntimeRecord } from './fixtures/bootstrap-records.ts';

test('bootstrap summary distinguishes absent integration, unconfigured module and pre-start unread details', () => {
  assert.equal(parseNativeBootstrapSummary({ state: 'stopped' })?.availability, 'not-provided');
  assert.equal(parseNativeBootstrapSummary({ state: 'stopped', bootstrap: null })?.availability, 'not-configured');
  assert.equal(parseNativeBootstrapSummary({ state: 'running', bootstrap: null })?.availability, 'not-configured');
  const selected = parseNativeBootstrapSummary(bootstrapRuntimeRecord('not-started'));
  assert.equal(selected?.availability, 'configured');
  assert.equal(selected?.bootstrap?.state, 'not-started');
  assert.equal(selected?.bootstrap?.details, null);
  assert.equal(Object.hasOwn(selected?.bootstrap ?? {}, 'features'), false);
  assert.equal(parseNativeBootstrapSummary({}), null);
  assert.equal(parseNativeBootstrapSummary({ state: 'running', bootstrap: undefined }), null);
});

test('full bootstrap summary sanitizes the real metadata fields without retaining paths, raw exceptions or secrets', () => {
  const source = bootstrapRuntimeRecord();
  const parsed = parseNativeBootstrapSummary({ ...source, token: 'synthetic-unretained', bootstrap: {
    ...source.bootstrap, modulePath: '/isolated/private/bootstrap.ts', error: 'private-upstream-exception', apiKey: 'synthetic-never-retain',
  } });
  assert(parsed?.bootstrap?.details);
  assert.equal(parsed.bootstrap.details.features.length, 3);
  assert.equal(parsed.bootstrap.details.installedFeatureIds.length, 3);
  assert.equal(parsed.bootstrap.details.grantsCreatedByInstaller, false);
  assert.equal(parsed.bootstrap.sandboxed, false);
  assert.equal(parsed.bootstrap.requiresSeparateAuthorization, true);
  for (const text of ['private/bootstrap', 'private-upstream-exception', 'synthetic-never-retain', 'synthetic-unretained']) assert.equal(JSON.stringify(parsed).includes(text), false);
});

test('bootstrap metadata rejects unsafe trust claims, unknown versions, fingerprints and inconsistent pre-start details', () => {
  const source = bootstrapRuntimeRecord();
  for (const changed of [
    { trust: 'sandboxed-module' }, { sandboxed: true }, { requiresSeparateAuthorization: false },
    { grantsCreatedByInstaller: true }, { codeFingerprint: 'not-a-hash' }, { state: 'ready' },
    { manifest: { id: 'invalid:id', version: '1.2.3', apiVersion: 1 } },
    { manifest: { id: 'valid', version: 'latest', apiVersion: 1 } },
    { manifest: { id: 'valid', version: '1.2.3', apiVersion: 2 } },
    { pendingStart: null }, { pendingStop: undefined }, { mediaResolver: undefined }, { forwardConfigured: 'yes' },
  ]) assert.equal(parseNativeBootstrapSummary({ ...source, bootstrap: { ...source.bootstrap, ...changed } }), null, JSON.stringify(changed));
  const selected = bootstrapRuntimeRecord('not-started');
  assert.equal(parseNativeBootstrapSummary({ ...selected, bootstrap: { ...selected.bootstrap, features: [] } }), null);
});

test('bootstrap declarations and installed identities have bounded unique validated lists, with no unknown converted to zero', () => {
  const source = bootstrapRuntimeRecord();
  for (const changed of [
    { features: undefined }, { features: Array.from({ length: 65 }, (_, index) => ({ id: `feature-${index}`, version: '1.0.0', capabilities: [], subscriptions: [] })) },
    { features: [{ id: 'agent-relay', version: '1.0.0', capabilities: [], subscriptions: [] }] },
    { features: [{ id: 'same', version: '1.0.0', capabilities: [], subscriptions: [] }, { id: 'same', version: '1.0.0', capabilities: [], subscriptions: [] }] },
    { effectCapabilities: null }, { effectCapabilities: ['same', 'same'] }, { eventTypes: ['bad\nevent'] },
    { installedFeatureIds: ['not-declared'] }, { installedFeatureIds: null },
  ]) assert.equal(parseNativeBootstrapSummary({ ...source, bootstrap: { ...source.bootstrap, ...changed } }), null, JSON.stringify(changed));
  assert(parseNativeBootstrapSummary(bootstrapRuntimeRecord('running', 64))?.bootstrap?.details);
  const empty = parseNativeBootstrapSummary(bootstrapRuntimeRecord('running', 0));
  assert.equal(empty?.bootstrap?.details?.features.length, 0);
});

test('pending or unknown lifecycle never becomes tool readiness or permission success', () => {
  const source = bootstrapRuntimeRecord();
  for (const state of ['prepared', 'installed', 'starting', 'running', 'stopping', 'stopped', 'failed', 'unknown'] as const) {
    const parsed = parseNativeBootstrapSummary(bootstrapRuntimeRecord(state));
    assert(parsed?.bootstrap);
    assert.equal(bootstrapLifecycleLabel(parsed.bootstrap).includes('已授权'), false);
    assert.equal(bootstrapLifecycleLabel(parsed.bootstrap).includes('工具就绪'), false);
  }
  for (const [pendingStart, pendingStop, text] of [[true, false, '启动仍待确认'], [false, true, '停止仍待确认'], [true, true, '启动与停止仍待确认']] as const) {
    const parsed = parseNativeBootstrapSummary({ ...source, bootstrap: { ...source.bootstrap, pendingStart, pendingStop } });
    assert(parsed?.bootstrap);
    assert.equal(bootstrapLifecycleLabel(parsed.bootstrap), text);
  }
});

test('unsettled creation can report only base metadata without fabricating empty mount details or a clean stop', () => {
  const selected = bootstrapRuntimeRecord('not-started');
  const partial = parseNativeBootstrapSummary({ state: 'error', bootstrap: { ...selected.bootstrap, state: 'unknown', unsettledLifecycle: true } });
  assert(partial?.bootstrap);
  assert.equal(partial.bootstrap.details, null);
  assert.equal(partial.bootstrap.unsettledLifecycle, true);
  assert.match(bootstrapLifecycleLabel(partial.bootstrap), /仍未结束.*未知/);
  assert.equal(parseNativeBootstrapSummary({ ...selected, bootstrap: { ...selected.bootstrap, unsettledLifecycle: true } }), null);
  assert.equal(parseNativeBootstrapSummary({ ...selected, bootstrap: { ...selected.bootstrap, state: 'unknown' } }), null);
});

test('human declaration labels do not invent meanings for custom capabilities or expose their raw identifiers', () => {
  assert.deepEqual(bootstrapDeclarationLabels(['messaging.send', 'operator.private-action'], 'capabilities'), ['发送消息', '1 项自定义动作声明（标识见详情）']);
  assert.deepEqual(bootstrapDeclarationLabels(['message.received', 'operator.private-event'], 'subscriptions'), ['收到消息', '1 项自定义事件声明（标识见详情）']);
  assert.deepEqual(bootstrapDeclarationLabels([], 'capabilities'), []);
});

test('actual native mount metadata parses through preparation, installation and stop without ever creating grants', async () => {
  const store = createSqliteStore({ filename: ':memory:' });
  const context = createContextStore();
  const persona = context.registerPersona({ id: 'bootstrap-ui', version: '1', name: 'UI fixture', identity: {}, style: {} });
  const signal = new AbortController();
  const metadata: NativeBootstrapMetadata = { manifest: { id: 'bootstrap-ui', version: '1.0.0', apiVersion: 1 },
    codeFingerprint: 'c'.repeat(64), trust: 'trusted-operator-code', sandboxed: false, requiresSeparateAuthorization: true };
  const host = createBridgeHost({ store, context, persona, authorizeIncoming: () => false, transport: { send: () => { throw new Error('fixture_must_not_send'); } },
    agent: { async createSession() { throw new Error('fixture_must_not_create_session'); }, async submit() { throw new Error('fixture_must_not_submit'); }, async follow() { return () => {}; } } });
  const mount = await createNativeBootstrapMount({ bootstrap: { metadata, create: () => ({ features: [{ id: 'bootstrap-ui-feature', version: '1.0.0', apiVersion: 1,
    capabilities: ['messaging.send'], subscriptions: ['message.received'], setup(services) { services.on('message.received', () => {}); } }] }) }, context: { directory: '/isolated/bootstrap-ui-fixture', store, context, persona, signal: signal.signal } });
  try {
    const prepared = parseNativeBootstrapSummary({ state: 'stopped', bootstrap: mount.metadata() });
    assert.equal(prepared?.bootstrap?.state, 'prepared');
    assert.equal(prepared?.bootstrap?.details?.installedFeatureIds.length, 0);
    await mount.install(host);
    const installed = parseNativeBootstrapSummary({ state: 'starting', bootstrap: mount.metadata() });
    assert.equal(installed?.bootstrap?.details?.installedFeatureIds.length, 1);
    assert.equal(host.policy.describe().grants.length, 0);
    await host.start();
    await mount.start(host);
    assert.equal(parseNativeBootstrapSummary({ state: 'running', bootstrap: mount.metadata() })?.bootstrap?.state, 'running');
    await mount.stop(host);
    const stopped = parseNativeBootstrapSummary({ state: 'stopped', bootstrap: mount.metadata() });
    assert.equal(stopped?.bootstrap?.state, 'stopped');
    assert.equal(stopped?.bootstrap?.details?.installedFeatureIds.length, 1);
    assert.equal(host.policy.describe().grants.length, 0);
    assert.equal(stopped?.bootstrap?.details?.grantsCreatedByInstaller, false);
  } finally { await mount.stop(host); await host.stop(); store.close(); }
});
