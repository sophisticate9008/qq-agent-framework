import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { PluginModelBackend } from '../src/contracts/plugin-model.ts';
import type { ImageGenerationService } from '../src/contracts/image-generation.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';
import { createNativePackages, type NativePackageDefinition } from '../src/host/native-packages.ts';
import { createBuiltinPackageContent } from '../src/host/native-package-content.ts';
import { createPackageConfigurationRegistry } from '../src/host/package-configuration.ts';
import { createPluginSchedulerService } from '../src/host/plugin-scheduler.ts';
import { createPluginToolDirectory } from '../src/host/plugin-tool-directory.ts';
import { createPluginModelService } from '../src/host/plugin-model-service.ts';
import { createPluginCapabilityService } from '../src/host/plugin-capability-service.ts';
import { createReloadableExtensionRegistry } from '../src/host/reloadable-extensions.ts';
import { IMAGE_GENERATION_SERVICE_CONTRACT } from '../src/host/framework-service-contracts.ts';
import { PLUGIN_RUNTIME_PACKAGE_ID, PLUGIN_MODELS_SERVICE_CONTRACT, PLUGIN_PROTOCOL_SERVICE_CONTRACT,
  PLUGIN_SCHEDULER_SERVICE_CONTRACT, PLUGIN_TOOLS_SERVICE_CONTRACT, PLUGIN_EXTENSIONS_SERVICE_CONTRACT } from '../src/host/plugin-service-contracts.ts';
import { serviceDeclaration } from '../src/host/service-contract.ts';
import { createQzoneDiaryPackage } from '../plugins/qzone-diary/index.ts';
import type { DiaryConfiguration } from '../plugins/qzone-diary/types.ts';

function fixture(context: TestContext) {
  const store = createSqliteStore({ filename: ':memory:' });
  const scheduler = createPluginSchedulerService({ store, intervalMs: 60_000 });
  const tools = createPluginToolDirectory({ store });
  const extensions = createReloadableExtensionRegistry();
  const calls = { models: 0, images: 0, protocol: 0, settings: [] as boolean[] };
  function unexpectedModel(): never { calls.models++; assert.fail('Package assembly must not call a model'); }
  const backend: PluginModelBackend = {
    models: async () => unexpectedModel(), inspect: async () => unexpectedModel(), create: async () => unexpectedModel(),
    start: async () => unexpectedModel(), follow: async () => unexpectedModel(), waitForIdle: async () => unexpectedModel(),
    inspectRun: async () => unexpectedModel(),
  };
  const models = createPluginModelService({ store, backend, withSessionLease: (_id, _signal, operation) => operation() });
  const capabilities = createPluginCapabilityService({ store, accountId: 'fixture-account', port: {
    async inspect() { calls.protocol++; assert.fail('Package assembly must not inspect the protocol'); },
    async call() { calls.protocol++; assert.fail('Package assembly must not dispatch a protocol action'); },
  } });
  let configuration: DiaryConfiguration = { enabled: true, publish: false, timeZone: 'Asia/Shanghai', persona: '测试角色',
    model: { provider: 'fixture', model: 'writer' }, visionModel: { provider: 'fixture', model: 'vision' },
    windows: [{ start: 9 * 60, end: 12 * 60 }, { start: 14 * 60, end: 17 * 60 }, { start: 19 * 60, end: 22 * 60 }] };
  const images: ImageGenerationService = { async generate() { calls.images++; assert.fail('Package assembly must not generate an image'); } };
  const diary = createQzoneDiaryPackage({ imagePackageId: 'fixture-images', store, configuration: () => configuration,
    media: { async save() { assert.fail('Assembly must not save image bytes'); } },
    async setEnabled(enabled) { calls.settings.push(enabled); configuration = { ...configuration, enabled }; } });
  const content = createBuiltinPackageContent(import.meta.url);
  const provider: NativePackageDefinition = {
    manifest: { schema: 1, id: 'fixture-images', version: '1.0.0', dependencies: [], requires: [],
      provides: [{ id: 'image-generation', version: 1 }], contributions: [] },
    start(context) { context.publish('image-generation', 1, images); },
  };
  const registry = createPackageConfigurationRegistry({ store: {
    async read() { assert.fail('No configuration documents are declared by this fixture'); },
    async compareAndSet() { assert.fail('No configuration document writes are needed'); },
  } });
  const managers: ReturnType<typeof createNativePackages>[] = [];
  function manager(packages: readonly NativePackageDefinition[] = [diary, provider]) {
    const result = createNativePackages({ packages, stateStore: store, configurationRegistry: registry,
      bootstrapContent: { ...content, packageIds: ['qzone-diary', 'fixture-images'] },
      runtimeServices(owner, lifetime, active) { return {
        scheduler: scheduler.forPlugin(owner, lifetime, active), tools: tools.forPlugin(owner, lifetime, active),
        models: models.forPlugin(owner, lifetime), capabilities: capabilities.forPlugin(owner, lifetime, active),
        extensions,
        sessions: { resolve() { assert.fail('Independent diary must not access QQ bindings'); },
          async bind() { assert.fail('Independent diary must not bind QQ sessions'); }, async unbind() { assert.fail('Independent diary must not unbind QQ sessions'); } },
      }; },
    });
    managers.push(result); return result;
  }
  context.after(async () => { for (const manager of managers) await manager.stop(); await scheduler.stop(); store.close(); });
  return { manager, diary, provider, tools, scheduler, extensions, calls,
    configure(changes: Partial<DiaryConfiguration>) { configuration = { ...configuration, ...changes }; } };
}

test('public diary package starts under the real package manager with declared services, owned resources and extension tools', async context => {
  const f = fixture(context);
  assert.deepEqual(f.diary.manifest.dependencies, ['fixture-images', PLUGIN_RUNTIME_PACKAGE_ID]);
  assert.deepEqual(f.diary.manifest.requires, [serviceDeclaration(IMAGE_GENERATION_SERVICE_CONTRACT), serviceDeclaration(PLUGIN_MODELS_SERVICE_CONTRACT),
    serviceDeclaration(PLUGIN_PROTOCOL_SERVICE_CONTRACT), serviceDeclaration(PLUGIN_SCHEDULER_SERVICE_CONTRACT),
    serviceDeclaration(PLUGIN_TOOLS_SERVICE_CONTRACT), serviceDeclaration(PLUGIN_EXTENSIONS_SERVICE_CONTRACT)]);
  const manager = f.manager();
  assert.equal(f.tools.entries().length, 0); assert.equal(f.scheduler.status().handlers, 0);
  const started = await manager.start();
  assert.deepEqual(started.map(entry => [entry.id, entry.state]), [[PLUGIN_RUNTIME_PACKAGE_ID, 'running'], ['fixture-images', 'running'], ['qzone-diary', 'running']]);
  const diary = started.find(entry => entry.id === 'qzone-diary')!;
  assert.deepEqual(diary.resources.map(entry => [entry.kind, entry.id, entry.state]), [
    ['task', 'workflow', 'active'], ['subscription', 'workflow-reload', 'active'], ['subscription', 'workflow-handlers', 'active'],
    ['subscription', 'status', 'active'], ['subscription', 'plan', 'active'], ['subscription', 'set-enabled', 'active'],
  ]);
  assert.deepEqual(f.extensions.list().map(entry => entry.id), ['qzone-diary']);
  const entries = f.tools.entries();
  assert.deepEqual(entries.map(entry => entry.tool.definition.name), ['status', 'plan', 'set-enabled'].map(id => 'extension.qzone-diary.' + id));
  assert.deepEqual(f.diary.manifest.toolNames, entries.map(entry => entry.tool.definition.name));
  for (const entry of entries) {
    assert.equal(entry.permission, 'owner'); assert.equal(entry.category, 'extensions');
    assert.deepEqual(entry.tool.definition.registrationSource, { origin: 'extension', ownerId: 'qzone-diary', ownerName: 'qzone-diary', transport: 'native' });
  }
  assert.equal(f.scheduler.status().handlers, 2);
  assert.equal(f.scheduler.status().running, false, 'The host controls timer startup after packages are mounted');
  assert.deepEqual({ models: f.calls.models, images: f.calls.images, protocol: f.calls.protocol }, { models: 0, images: 0, protocol: 0 });
  const request = { input: {}, signal: new AbortController().signal,
    scope: { eventId: 'package-status', conversationId: 'private:123', featureId: 'framework-tools', version: '1.0.0' } };
  const status = entries.find(entry => entry.tool.definition.name.endsWith('.status'))!;
  const result = await status.effect.execute(request);
  assert(result && typeof result === 'object' && !Array.isArray(result));
  assert.equal(result.publish, false); assert(Array.isArray(result.slots));
  const plan = entries.find(entry => entry.tool.definition.name.endsWith('.plan'))!;
  await plan.effect.execute({ ...request, scope: { ...request.scope, eventId: 'package-plan' } });
  const enabled = entries.find(entry => entry.tool.definition.name.endsWith('.set-enabled'))!;
  await enabled.effect.execute({ ...request, input: { enabled: false }, scope: { ...request.scope, eventId: 'package-disable' } });
  assert.deepEqual(f.calls.settings, [false]);
  assert.deepEqual({ models: f.calls.models, images: f.calls.images, protocol: f.calls.protocol }, { models: 0, images: 0, protocol: 0 });
  const stopped = await manager.stop();
  assert(stopped.every(entry => entry.state === 'stopped' && entry.resources.every(resource => resource.state === 'disposed')));
  assert.equal(f.tools.entries().length, 0); assert.equal(f.scheduler.status().handlers, 0);
  assert.equal(f.extensions.list().length, 0);
  await manager.stop(); assert.equal(f.tools.entries().length, 0);
  await assert.rejects(async () => status.effect.execute(request), { name: 'AbortError' });
});

test('public package dependency and image-service versions are checked before lifecycle side effects', context => {
  const f = fixture(context);
  assert.throws(() => f.manager([f.diary]), { code: 'NATIVE_PACKAGE_DEPENDENCY_MISSING' });
  const wrong = { ...f.provider, manifest: { ...f.provider.manifest, provides: [{ id: 'image-generation', version: 2 }] } };
  assert.throws(() => f.manager([f.diary, wrong]), { code: 'NATIVE_PACKAGE_SERVICE_VERSION_UNAVAILABLE' });
  assert.equal(f.tools.entries().length, 0); assert.equal(f.scheduler.status().handlers, 0);
  assert.equal(f.calls.models + f.calls.images + f.calls.protocol, 0);
});

test('an invalid image service fails package startup without leaking tools or task subscriptions', async context => {
  const f = fixture(context);
  const provider = { ...f.provider, start(context: Parameters<NonNullable<NativePackageDefinition['start']>>[0]) { context.publish('image-generation', 1, {}); } };
  const manager = f.manager([f.diary, provider]);
  const started = await manager.start();
  const diary = started.find(entry => entry.id === 'qzone-diary')!;
  assert.equal(diary.state, 'failed'); assert.equal(diary.reason, 'SERVICE_IMPLEMENTATION_INVALID');
  assert.equal(f.tools.entries().length, 0); assert.equal(f.scheduler.status().handlers, 0);
  assert.equal(f.calls.models + f.calls.images + f.calls.protocol, 0);
});

test('a workflow startup failure rolls back already registered owned tools and scheduler handlers', async context => {
  const f = fixture(context);
  f.configure({ windows: [] });
  const manager = f.manager();
  const diary = (await manager.start()).find(entry => entry.id === 'qzone-diary')!;
  assert.equal(diary.state, 'failed'); assert.equal(diary.reason, 'DIARY_CONFIGURATION_INVALID');
  assert.equal(diary.resources.length, 2);
  assert(diary.resources.every(resource => resource.state === 'disposed'));
  assert.equal(f.tools.entries().length, 0); assert.equal(f.scheduler.status().handlers, 0);
  assert.equal(f.calls.models + f.calls.images + f.calls.protocol, 0);
});
