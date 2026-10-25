import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createContextStore } from '../src/core/context.ts';
import type { FeatureDefinition } from '../src/core/types.ts';
import { createBridgeHost } from '../src/host/bridge.ts';
import { createNativeBootstrapMount, defineNativeBootstrap, type LoadedNativeBootstrap, type NativeBootstrapExtension } from '../src/host/native-bootstrap.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';
import { drainNativeRun, type NativePreparedRunResources } from '../src/host/native-run-resources.ts';

async function fixture() {
  await mkdir(new URL('../runtime/', import.meta.url), { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(new URL('../runtime/native-bootstrap-mount-', import.meta.url).pathname);
  const store = createSqliteStore({ filename: join(directory, 'state.sqlite') });
  const context = createContextStore();
  const persona = context.registerPersona({ id: 'test-bootstrap', version: '1', name: 'Test', identity: {}, style: {} });
  const controller = new AbortController();
  let sends = 0;
  const options = { directory, store, context, persona, signal: controller.signal };
  const hostOptions = { store, context, persona, authorizeIncoming: () => true,
    transport: { send() { sends++; return { status: 'confirmed' as const, messageId: String(sends) }; } },
    agent: { async createSession() { return { sessionId: 'test-session' }; }, async submit() { return { status: 'accepted' as const }; },
      async follow() { return () => {}; } } };
  return { options, hostOptions, controller, sends: () => sends,
    async cleanup() { store.close(); await rm(directory, { recursive: true, force: true }); } };
}

function loaded(create: LoadedNativeBootstrap['create']): LoadedNativeBootstrap {
  return { metadata: { manifest: { id: 'test-bootstrap', version: '1.0.0', apiVersion: 1 }, codeFingerprint: 'a'.repeat(64),
    trust: 'trusted-operator-code', sandboxed: false, requiresSeparateAuthorization: true }, create };
}

const notice: FeatureDefinition = { id: 'bootstrap-notice', version: '1.0.0', apiVersion: 1,
  capabilities: ['messaging.send'], subscriptions: ['trigger.fired'], setup(services) {
    services.on('trigger.fired', async execution => { await execution.send([{ type: 'text', text: 'test notice' }]); });
  } };

test('mount installs features and hooks without granting permissions and aborts captured lifecycle signals', async () => {
  const setup = await fixture();
  let capturedSignal: AbortSignal | undefined;
  let capturedStartSignal: AbortSignal | undefined;
  let stops = 0;
  const mount = await createNativeBootstrapMount({ bootstrap: loaded(context => {
    capturedSignal = context.signal;
    return { features: [notice], effectAdapters: { 'test.inspect': { execute: () => ({ ok: true }) } },
      eventValidators: { 'test.ready': () => true }, onebot: { resolveAsset: () => ({ file: 'controlled-resource' }) },
      start(_host, signal) { capturedStartSignal = signal; },
      stop() { stops++; } };
  }), context: setup.options });
  const host = createBridgeHost({ ...setup.hostOptions, ...mount.bridgeOptions });
  try {
    await mount.install(host);
    assert.throws(() => mount.abandonPrepared(), { code: 'NATIVE_BOOTSTRAP_ABANDON_DENIED' });
    assert.equal(host.policy.describe().grants.length, 0);
    const report = await host.engine.emit({ id: 'denied', type: 'trigger.fired', conversationId: 'group:7001', data: { kind: 'notice' } });
    assert.equal(report.outcomes.find(outcome => outcome.featureId === notice.id)?.errorCode, 'POLICY_DENIED');
    assert.equal(setup.sends(), 0);
    await host.start();
    await mount.start(host);
    assert.equal(capturedStartSignal?.aborted, false);
    assert.equal(mount.metadata().state, 'running');
    assert.equal(mount.metadata().grantsCreatedByInstaller, false);
    assert.equal(mount.metadata().mediaResolver, true);
    assert.deepEqual(mount.metadata().effectCapabilities, ['test.inspect']);
    await mount.stop(host);
    assert(capturedSignal?.aborted);
    assert(capturedStartSignal?.aborted);
    assert.equal(stops, 1);
    await mount.stop(host);
    assert.equal(stops, 1);
    assert.throws(() => mount.start(host), { code: 'NATIVE_BOOTSTRAP_START_DENIED' });
  } finally { await mount.stop(host); await host.stop(); await setup.cleanup(); }
});

test('pre-installation failure abandons the prepared mount with no host or an earlier host and permits a fresh mount', async () => {
  for (const hasEarlierHost of [false, true]) {
    const setup = await fixture();
    let capturedSignal: AbortSignal | undefined;
    let stops = 0;
    const definition = loaded(context => {
      capturedSignal = context.signal;
      return { features: [notice], stop() { stops++; } };
    });
    const mount = await createNativeBootstrapMount({ bootstrap: definition, context: setup.options });
    const earlierHost = hasEarlierHost ? createBridgeHost(setup.hostOptions) : undefined;
    try {
      await assert.rejects(createNativeBootstrapMount({ bootstrap: definition, context: setup.options }),
        { code: 'NATIVE_BOOTSTRAP_PENDING_UNKNOWN' });
      const resources: NativePreparedRunResources = { lifetime: setup.controller, host: earlierHost,
        bootstrap: mount, dsh: undefined, work: undefined, claims: undefined, executions: undefined,
        tools: undefined, packages: undefined, inbox: undefined, quotedContext: undefined, claimTimer: undefined,
        reminders: { async stop() {} }, memory: { stop() {} }, releaseInteractions: undefined,
        closeInteractions: undefined, clearIngress() {}, async drainConfiguration() {}, async drainPolicy() {} };
      const result = await drainNativeRun(resources);
      assert.deepEqual(result.errors, []);
      assert.equal(result.bootstrapUnknown, false);
      assert.equal(mount.metadata().state, 'stopped');
      assert.deepEqual(mount.metadata().installedFeatureIds, []);
      assert.equal(capturedSignal?.aborted, true);
      assert.equal(stops, 0);
      assert.equal(setup.sends(), 0);
      assert.deepEqual((await drainNativeRun(resources)).errors, []);
      const retry = await createNativeBootstrapMount({ bootstrap: definition,
        context: { ...setup.options, signal: new AbortController().signal } });
      assert.equal(retry.metadata().state, 'prepared');
      retry.abandonPrepared();
      assert.equal(retry.metadata().state, 'stopped');
    } finally { await earlierHost?.stop(); await setup.cleanup(); }
  }
});

test('mount rejects reserved registries and rolls back only its own installed features', async () => {
  const setup = await fixture();
  const host = createBridgeHost(setup.hostOptions);
  try {
    await assert.rejects(createNativeBootstrapMount({ bootstrap: loaded(() => ({ effectAdapters: { 'agent.submit': { execute: () => null } } })),
      context: setup.options }), { code: 'INVALID_NATIVE_BOOTSTRAP' });
    await assert.rejects(createNativeBootstrapMount({ bootstrap: loaded(() => ({ eventValidators: { 'message.received': () => true } })),
      context: setup.options }), { code: 'INVALID_NATIVE_BOOTSTRAP' });
    const broken: FeatureDefinition = { ...notice, id: 'bootstrap-broken', setup() { throw new Error('synthetic-hidden'); } };
    const mount = await createNativeBootstrapMount({ bootstrap: loaded(() => ({ features: [notice, broken] })), context: setup.options });
    await assert.rejects(mount.install(host));
    assert.equal(host.engine.describe().features.find(feature => feature.id === notice.id)?.status, 'stopped');
    assert.equal(host.engine.describe().features.find(feature => feature.id === 'agent-relay')?.status, 'active');
    await mount.stop(host);
  } finally { await host.stop(); await setup.cleanup(); }
});

test('mount bounds unresolved create, start and stop hooks and denies overlapping creation', async () => {
  const setup = await fixture();
  let releaseCreate: ((extension: NativeBootstrapExtension) => void) | undefined;
  const pending = loaded(() => new Promise(resolve => { releaseCreate = resolve; }));
  await assert.rejects(createNativeBootstrapMount({ bootstrap: pending, context: setup.options, timeoutMs: 10 }),
    { code: 'NATIVE_BOOTSTRAP_CREATE_TIMEOUT_UNKNOWN' });
  await assert.rejects(createNativeBootstrapMount({ bootstrap: pending, context: setup.options, timeoutMs: 10 }),
    { code: 'NATIVE_BOOTSTRAP_PENDING_UNKNOWN' });
  assert(releaseCreate);
  releaseCreate({});
  await delay(0);
  let releaseStart: (() => void) | undefined;
  const definition = loaded(() => ({ start() { return new Promise(resolve => { releaseStart = resolve; }); } }));
  const mount = await createNativeBootstrapMount({ bootstrap: definition, context: setup.options, timeoutMs: 10 });
  const host = createBridgeHost({ ...setup.hostOptions, ...mount.bridgeOptions });
  try {
    await mount.install(host);
    await assert.rejects(mount.start(host), { code: 'NATIVE_BOOTSTRAP_START_TIMEOUT_UNKNOWN' });
    assert.throws(() => mount.abandonPrepared(), { code: 'NATIVE_BOOTSTRAP_ABANDON_DENIED' });
    assert.equal(mount.metadata().pendingStart, true);
    await assert.rejects(createNativeBootstrapMount({ bootstrap: definition, context: setup.options }), { code: 'NATIVE_BOOTSTRAP_PENDING_UNKNOWN' });
    await assert.rejects(mount.stop(host), { code: 'NATIVE_BOOTSTRAP_STOP_TIMEOUT_UNKNOWN' });
    assert.equal(mount.metadata().pendingStop, true);
    assert(releaseStart);
    releaseStart();
    await delay(0);
    assert.equal(mount.metadata().pendingStart, false);
    assert.equal(mount.metadata().pendingStop, false);
    assert.equal(mount.metadata().state, 'unknown');
    assert.throws(() => mount.abandonPrepared(), { code: 'NATIVE_BOOTSTRAP_ABANDON_DENIED' });
  } finally { releaseStart?.(); await host.stop(); await setup.cleanup(); }
});

test('bootstrap declaration rejects accessor metadata without invoking it', () => {
  let reads = 0;
  assert.throws(() => defineNativeBootstrap({ get manifest() { reads++; return { id: 'test', version: '1.0.0', apiVersion: 1 as const }; }, create: () => ({}) }),
    { code: 'INVALID_NATIVE_BOOTSTRAP' });
  assert.equal(reads, 0);
});
