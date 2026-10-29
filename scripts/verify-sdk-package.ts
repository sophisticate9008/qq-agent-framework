import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'qqbf-sdk-consumer-'));
try {
  execFileSync(process.execPath, ['scripts/build-sdk.ts'], { cwd: root, stdio: 'inherit' });
  const result: unknown = JSON.parse(execFileSync('npm', ['pack', './packages/framework-sdk', '--ignore-scripts', '--json',
    '--pack-destination', directory], { cwd: root, encoding: 'utf8' }));
  assert(Array.isArray(result) && result.length === 1);
  const packed: unknown = result[0];
  assert(packed && typeof packed === 'object' && 'filename' in packed && typeof packed.filename === 'string'
    && /^[a-z0-9.-]+\.tgz$/.test(packed.filename) && 'files' in packed && Array.isArray(packed.files));
  for (const file of packed.files) {
    assert(file && typeof file === 'object' && 'path' in file && typeof file.path === 'string');
    assert(['package.json', 'LICENSE', 'NOTICE.md', 'README.md'].includes(file.path) || /^dist\/[a-z0-9./-]+\.(?:js|d\.ts)$/.test(file.path),
      `Unexpected SDK archive member: ${file.path}`);
    assert(!/(?:^|\/)(?:runtime|test|admin|web|scripts)(?:\/|$)/.test(file.path));
  }
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'external-sdk-consumer', private: true, type: 'module' }));
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', join(directory, packed.filename)],
    { cwd: directory, stdio: 'pipe' });
  await writeFile(join(directory, 'index.ts'), `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createContextStore, defineNativeBootstrap, type FeatureDefinition } from '@qq-bridge-framework/sdk';
import { createBridgeHost, createNativeBootstrapMount, createNativeEventObserver, createNativePackageState, createNativeAccounts, type NativeAccountProtocol, type NativeAccountRuntime, type LoadedNativeBootstrap } from '@qq-bridge-framework/sdk/host';
import { createSqliteStore, assertAccountStore } from '@qq-bridge-framework/sdk/storage';
import { isNativeEventPage, parseAccountScope, parseNativeAccountsSnapshot, type JsonValue, type DurableStore, type AccountScope } from '@qq-bridge-framework/sdk/contracts';
const feature: FeatureDefinition = { id: 'external-feature', version: '1.0.0', apiVersion: 1,
  capabilities: ['messaging.send'], subscriptions: ['trigger.fired'], setup(context) {
    context.on('trigger.fired', async execution => { await execution.send([{ type: 'text', text: 'external-package-ok' }]); });
  } };
const bootstrap = defineNativeBootstrap({ manifest: { id: 'external-bootstrap', version: '1.0.0', apiVersion: 1 },
  create() { return { features: [feature] }; } });
const loaded: LoadedNativeBootstrap = { ...bootstrap, metadata: { manifest: bootstrap.manifest, codeFingerprint: 'a'.repeat(64),
  trust: 'trusted-operator-code', sandboxed: false, requiresSeparateAuthorization: true } };
const context = createContextStore();
const persona = context.registerPersona({ id: 'external-persona', version: '1.0.0', name: 'Example', identity: {}, style: {} });
const store: DurableStore = createSqliteStore({ filename: join(process.cwd(), 'consumer.sqlite') });
const controller = new AbortController();
let sends = 0;
const host = createBridgeHost({ store, context, persona, authorizeIncoming: () => false,
  transport: { async send() { sends++; return { status: 'confirmed', messageId: 'external-message' }; } },
  agent: { async createSession() { return { sessionId: 'external-session' }; },
    async submit() { return { status: 'accepted' }; }, async follow() { return () => {}; } } });
const mount = await createNativeBootstrapMount({ bootstrap: loaded,
  context: { directory: process.cwd(), store, context, persona, signal: controller.signal } });
await mount.install(host);
await host.start(); await mount.start(host, controller.signal);
const data: JsonValue = {};
const denied = await host.engine.emit({ id: 'denied', type: 'trigger.fired', conversationId: 'private:123', data });
assert.equal(denied.outcomes.find(item => item.featureId === feature.id)?.status, 'failed');
assert.equal(sends, 0);
host.policy.grant({ id: 'external-explicit-grant', featureId: feature.id, conversationId: 'private:123',
  capabilities: ['messaging.send'], maxUses: { 'messaging.send': 1 } });
await host.engine.emit({ id: 'allowed', type: 'trigger.fired', conversationId: 'private:123', data });
assert.equal(sends, 1);
await mount.stop(host); await host.stop(); controller.abort(); store.close();
// Exercise the actual installed exports, including declaration inference outside this repository.
const observer = createNativeEventObserver({ capacity: 4 });
observer.record({ source: 'host', kind: 'work', status: 'started', correlation: { accountId: 'one', workId: 'job' } });
observer.record({ source: 'host', kind: 'work', status: 'started', correlation: { accountId: 'two', workId: 'other' } });
const page = observer.read({ filter: { accountId: 'one', kinds: ['work'] } });
assert(isNativeEventPage(page)); assert.equal(page.events.length, 1);
const subscriptionLifetime = new AbortController();
const subscription = observer.subscribe({ signal: subscriptionLifetime.signal, filter: { accountId: 'one' } });
const observed = subscription.next();
observer.record({ source: 'host', kind: 'work', status: 'completed', correlation: { accountId: 'one', workId: 'job' } });
assert.equal((await observed).value?.type, 'event');
const cancelled = subscription.next(); subscriptionLifetime.abort();
await assert.rejects(cancelled, { code: 'EVENT_SUBSCRIPTION_ABORTED' });
assert.equal(observer.metrics().subscribers, 0); observer.close();
const stateStore = createSqliteStore({ filename: join(process.cwd(), 'owned-state.sqlite') });
const contentFingerprint = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
const ownedState = createNativePackageState({ owner: 'external-state', store: stateStore,
  identity: { packageVersion: '1.0.0', stateSchemaVersion: 1, contentFingerprint },
  async verifyIdentity(identity) { assert.equal(createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'), identity.contentFingerprint); } });
await ownedState.initialize(controller.signal.aborted ? new AbortController().signal : controller.signal);
const liveSignal = new AbortController().signal;
const first = await ownedState.compareAndSet('stable-key', null, { count: 1 }, liveSignal);
await assert.rejects(ownedState.compareAndSet('stable-key', null, { count: 99 }, liveSignal), { code: 'STORE_CONFLICT' });
assert.deepEqual(ownedState.read('stable-key')?.value, { count: 1 });
await ownedState.compareAndSet('stable-key', first.revision, { count: 2 }, liveSignal);
stateStore.close();
const reopened = createSqliteStore({ filename: join(process.cwd(), 'owned-state.sqlite'), requireExisting: true });
assert.equal(reopened.list('package.external-state.state').length, 1); reopened.close();
type ConstructedRuntime = ReturnType<NativeAccountProtocol['create']>;
const synchronousFactoryContract: (runtime: ConstructedRuntime) => NativeAccountRuntime = runtime => runtime;
const accountHosts = new Map<string, ReturnType<typeof createBridgeHost>>();
const accounts = createNativeAccounts({ directory: process.cwd(), protocols: [{ id: 'external', create(options) {
  const scopedStore = createSqliteStore({ filename: join(options.directory, 'account.sqlite') });
  const scopedContext = createContextStore();
  const scopedPersona = scopedContext.registerPersona({ id: 'external', version: '1', name: 'External', identity: {}, style: {} });
  const scopedHost = createBridgeHost({ store: scopedStore, accountScope: options.accountScope, persona: scopedPersona,
    context: scopedContext, authorizeIncoming: () => false, transport: { send() { return { status: 'rejected' }; } },
    agent: { async createSession() { return { sessionId: 'same-external-session' }; }, async submit() { return { status: 'accepted' }; }, async follow() { return () => {}; } } });
  accountHosts.set(options.accountScope.accountId, scopedHost);
  assertAccountStore(scopedStore, options.accountScope);
  return synchronousFactoryContract({ async start() { await scopedHost.start(); }, async stop() { await scopedHost.stop(); }, async close() { await scopedHost.stop(); scopedStore.close(); } });
} }] });
const scopeOne: AccountScope = { protocolId: 'external', accountId: 'one' };
const scopeTwo: AccountScope = { protocolId: 'external', accountId: 'two' };
assert.deepEqual(parseAccountScope(scopeOne), scopeOne);
let accountSnapshot = await accounts.read();
accountSnapshot = await accounts.create({ revision: accountSnapshot.revision, label: 'One', accountScope: scopeOne }, liveSignal);
accountSnapshot = await accounts.create({ revision: accountSnapshot.revision, label: 'Two', accountScope: scopeTwo }, liveSignal);
assert(parseNativeAccountsSnapshot(accountSnapshot));
await Promise.all(accountSnapshot.accounts.map(account => accounts.start(account.id, liveSignal)));
for (const [accountId, scopedHost] of accountHosts) {
  const binding = await scopedHost.sessions.resolve('same-conversation', liveSignal);
  assert.equal(binding.accountScope?.accountId, accountId);
  scopedHost.policy.grant({ id: 'same-id', accountScope: scopedHost.accountScope, featureId: 'external-feature', conversationId: 'same-conversation', capabilities: ['messaging.send'], maxUses: { 'messaging.send': 1 } });
}
assert.throws(() => accountHosts.get('one')!.policy.reserve({ featureId: 'external-feature', conversationId: 'same-conversation', capability: 'messaging.send', accountScope: scopeTwo }), { code: 'ACCOUNT_SCOPE_MISMATCH' });
assert.equal(accountHosts.get('two')!.policy.describe().grants[0]?.used['messaging.send'], 0);
await accounts.close();
const require = createRequire(import.meta.url);
assert.throws(() => require.resolve('@qq-bridge-framework/sdk/dist/core/engine.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
console.log('External SDK feature/bootstrap, filtered cancellable events, owned-state CAS and isolated accounts compiled and executed.');
`);
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), 'index.ts', '--strict', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', '--target', 'ES2023', '--outDir', 'out', '--skipLibCheck', 'false'], { cwd: directory, stdio: 'inherit' });
  execFileSync(process.execPath, ['out/index.js'], { cwd: directory, stdio: 'inherit' });
  const installed = JSON.parse(await readFile(join(directory, 'node_modules/@qq-bridge-framework/sdk/package.json'), 'utf8')) as { name: string };
  assert.equal(installed.name, '@qq-bridge-framework/sdk');
} finally { await rm(directory, { recursive: true, force: true }); }
