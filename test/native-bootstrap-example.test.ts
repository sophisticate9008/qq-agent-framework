import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { loadNativeBootstrap } from '../scripts/bootstrap-loader.ts';
import { createOneBotTransport } from '../src/adapters/onebot.ts';
import { createContextStore } from '../src/core/context.ts';
import { assertRequiredEventOutcomes } from '../src/core/event-reports.ts';
import { createBridgeHost } from '../src/host/bridge.ts';
import { createNativeBootstrapMount, type LoadedNativeBootstrap } from '../src/host/native-bootstrap.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';
import { createNativeExtensionExample } from './fixtures/native-bootstrap-example.ts';

async function fixture(bootstrap: LoadedNativeBootstrap, clock = Date.now) {
  await mkdir(new URL('../runtime/', import.meta.url), { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(new URL('../runtime/native-bootstrap-example-', import.meta.url).pathname);
  const store = createSqliteStore({ filename: join(directory, 'state.sqlite'), clock });
  const context = createContextStore({ clock });
  const persona = context.registerPersona({ id: 'example', version: '1', name: 'Example', identity: {}, style: {} });
  const controller = new AbortController();
  const capabilities = ['example.work.schedule', 'presentation.prepare', 'messaging.send', 'messaging.forward'];
  await writeFile(join(directory, 'extension-grants.json'), JSON.stringify({ grants: [{ id: 'explicit-operator-approval',
    featureId: 'operator-example', conversationId: 'group:7001', capabilities,
    maxUses: Object.fromEntries(capabilities.map(capability => [capability, 10])), expiresAt: null }] }), { mode: 0o600 });
  const mount = await createNativeBootstrapMount({ bootstrap, context: { directory, store, context, persona, signal: controller.signal } });
  const wire: unknown[] = [];
  const transport = createOneBotTransport({ endpoint: 'http://127.0.0.1:1/', ...mount.onebotOptions, fetch: async (_url, options) => {
    wire.push(JSON.parse(String(options?.body)) as unknown);
    return Response.json({ status: 'ok', retcode: 0, data: { message_id: wire.length } });
  } });
  let submits = 0;
  const host = createBridgeHost({ store, context, persona, transport, clock, authorizeIncoming: () => true, ...mount.bridgeOptions,
    agent: { async createSession() { return { sessionId: 'test-session' }; }, async submit() { submits++; return { status: 'accepted' }; },
      async follow() { return () => {}; } } });
  await mount.install(host);
  return { store, host, context, mount, wire, transport, submits: () => submits,
    async cleanup() { controller.abort(); await mount.stop(host); await host.stop(); store.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('loaded bootstrap separates grants while routing source work, forward documents and contextual notices', async context => {
  const runtime = new URL('../runtime/', import.meta.url);
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(new URL('native-bootstrap-entry-', runtime).pathname);
  context.after(() => rm(directory, { recursive: true, force: true }));
  const extension = import.meta.url.endsWith('.js') ? '.js' : '.ts';
  const target = new URL(`./fixtures/native-bootstrap-example${extension}`, import.meta.url);
  assert((await lstat(target)).isFile());
  const entry = join(directory, 'operator.ts');
  await writeFile(entry, `export { default } from ${JSON.stringify(target.href)};\n`, { mode: 0o600 });
  const bootstrap = await loadNativeBootstrap(entry);
  const setup = await fixture(bootstrap);
  try {
    assert.equal(setup.host.policy.describe().grants.length, 0);
    const denied = await setup.host.engine.emit({ id: 'before-start', type: 'example.context-ready', conversationId: 'group:7001',
      data: { kind: 'operator-example', permissions: ['messaging.send'] } });
    assert.equal(denied.outcomes.find(outcome => outcome.featureId === 'operator-example')?.errorCode, 'POLICY_DENIED');
    await setup.host.start();
    await setup.mount.start(setup.host);
    const forged = await setup.host.engine.emit({ id: 'no-source', type: 'message.received', conversationId: 'group:7001',
      data: { text: 'invented', directed: true, isSelf: false, routing: { route: 'work' } } });
    assert.equal(forged.outcomes.find(outcome => outcome.featureId === 'operator-example')?.errorCode, 'EXAMPLE_SOURCE_DENIED');
    assert.equal(setup.host.tasks.list().length, 0);
    const receipt = await setup.host.receive({ id: '501', conversationId: 'group:7001', userId: '42', directed: true, isSelf: false,
      receivedAt: Date.now(), content: [{ type: 'text', text: '/后台整理 同意: # 我的文档' }] });
    assert.equal(receipt.status, 'accepted');
    const deadline = Date.now() + 2000;
    while (setup.wire.length === 0 && Date.now() < deadline) await delay(10);
    assert.equal(setup.wire.length, 1);
    assert.match(JSON.stringify(setup.wire[0]), /我的文档/);
    assert.match(JSON.stringify(setup.wire[0]), /"group_id":7001/);
    assert.equal(setup.submits(), 0);
    assert.equal(setup.host.tasks.list()[0].status, 'completed');
    const forward = await setup.host.engine.emit({ id: 'long-document', type: 'example.work-ready', conversationId: 'group:7001', data: { body: '文'.repeat(9000) } });
    assertRequiredEventOutcomes(forward, ['operator-example']);
    assert.match(JSON.stringify(setup.wire.at(-1)), /可信扩展示例/);
    setup.context.setPreferences({ id: 'confirmed-style', scope: { kind: 'conversation', id: 'group:7001' }, source: 'confirmed-user',
      values: { noticeText: '独立偏好', permissions: ['made.up'] } });
    assertRequiredEventOutcomes(await setup.host.engine.emit({ id: 'context-ready', type: 'example.context-ready', conversationId: 'group:7001',
      data: { kind: 'operator-example' } }), ['operator-example']);
    assert.match(JSON.stringify(setup.wire.at(-1)), /独立偏好/);
    const sendsBeforeDeniedResource = setup.wire.length;
    assert.equal((await setup.transport.send({ conversationId: 'group:7001', content: [{ type: 'image', assetId: '/etc/passwd' }],
      signal: new AbortController().signal, idempotencyKey: 'unregistered', scope: { persona: { id: 'example', version: '1' } } })).status, 'rejected');
    assert.equal(setup.wire.length, sendsBeforeDeniedResource);
    assert.equal(setup.host.policy.describe().grants.length, 1);
    assert.equal(setup.host.policy.describe().grants[0].used['messaging.send'], 3);
  } finally { await setup.cleanup(); }
});

test('calendar timer fires once and stops without emitting again', async () => {
  let now = Date.UTC(2030, 0, 1, 0, 59);
  const definition = createNativeExtensionExample({ clock: () => now, tickMs: 10 });
  const setup = await fixture({ metadata: { manifest: definition.manifest, codeFingerprint: 'b'.repeat(64),
    trust: 'trusted-operator-code', sandboxed: false, requiresSeparateAuthorization: true }, create: definition.create }, () => now);
  try {
    await setup.host.start();
    await setup.mount.start(setup.host);
    now += 60000;
    const deadline = Date.now() + 2000;
    while (setup.wire.length === 0 && Date.now() < deadline) await delay(10);
    assert.equal(setup.wire.length, 1);
    await setup.mount.stop(setup.host);
    now += 86400000;
    await delay(30);
    assert.equal(setup.wire.length, 1);
    assert.equal(setup.mount.metadata().state, 'stopped');
  } finally { await setup.cleanup(); }
});
