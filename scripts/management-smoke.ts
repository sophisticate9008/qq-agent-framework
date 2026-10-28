import { accountsFixture } from './management-accounts-smoke.ts';
import { exerciseProtocolConnectionDiagnostics } from './management-protocol-status-smoke.ts';
import { exerciseModelReasoningCapabilities } from './management-model-capabilities-smoke.ts';
import { exercisePlanUpdate } from './management-plan-update-smoke.ts';
import { exerciseDshRestart } from './management-dsh-restart-smoke.ts';
import { createNativeChatRuntime } from '../src/host/native-chat-runtime.ts';
import { readNativeChatConfiguration } from '../src/admin/native-configuration-repository.ts';
import { usageMaintenanceFixture, exerciseUsageMaintenance, exerciseExecutionRecovery, exerciseCapacityRecommendations, exerciseMediaAndInteractions } from './management-recovery-smoke.ts';
import { recommendChatCapacity } from '../src/contracts/chat-capacity.ts';
import { createDefaultPackageConfigurationRegistry } from '../src/host/chat-input-configuration.ts';
import { createPackageConfigurationFileStore } from '../src/storage/package-configuration.ts';
import { NATIVE_OUTPUT_CONFIGURATION } from '../src/host/native-output.ts';
import type { PackageConfigurationContribution } from '../src/host/package-configuration.ts';
import assert from 'node:assert/strict';
import { navigateConsolePage } from './browser-navigation-smoke.ts';
import type { PageId } from '../web/lib/page-registry.ts';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';

import { createNativeRuntimeRoutes } from '../src/admin/runtime.ts';
import { createAdminServer, type AdminRoute } from '../src/admin/server.ts';
import { createNativeReminderRoutes } from '../src/admin/native-reminders.ts';
import { createNativeToolPermissionRoutes } from '../src/admin/native-tool-permissions.ts';
import { createNativeMemoryRoutes } from '../src/admin/native-memory.ts';
import { createNativeMemoryService } from '../src/host/native-memory.ts';
import { createNativeReminderService } from '../src/host/native-reminders.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';
import { createContextStore } from '../src/core/context.ts';
import { createEngine } from '../src/core/engine.ts';
import { createPolicy } from '../src/core/policy.ts';

const outputDirectory = new URL('../runtime/management-smoke/', import.meta.url);
const administratorToken = 'management-smoke-administrator-token-1234567890';
const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const xssText = '<img src="/management-smoke-xss" onerror="globalThis.__managementSmokeXss=true">';
const fixtureAdapterCredential = 'fixture-only-adapter-value-1234567890';
const fixtureProviderCredential = 'fixture-only-provider-value-1234567890';
const fixtureWebSocketCredential = 'fixture-only-websocket-value-1234567890';
const fixtureProviders = [
  {
    id: 'fixture-provider', name: 'Fixture Provider', type: 'openai', baseUrl: 'https://provider.invalid/v1', enabled: true,
    models: [{ id: 'fixture-model', name: 'Fixture Model' }, { id: 'fixture-model-v2', name: 'Fixture Model V2' }],
  },
  {
    id: 'fixture-provider-v2', name: 'Fixture Provider V2', type: 'anthropic', baseUrl: 'https://provider-v2.invalid', enabled: true,
    models: [{ id: 'fixture-model-v2', name: 'Fixture Model V2' }],
  },
];

interface RequestRecord {
  readonly method: string;
  readonly pathname: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertAdapterCredentialsRedacted(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertAdapterCredentialsRedacted(item);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    assert(!['secret', 'auth', 'token', 'hmac'].includes(key), `Adapter response exposed credential field ${key}.`);
    assertAdapterCredentialsRedacted(nested);
  }
}

function assertProviderCredentialsRedacted(value: unknown): void {
  assert(!JSON.stringify(value).includes(fixtureProviderCredential), 'Provider response exposed a fixture credential.');
  assert(isRecord(value) && Array.isArray(value.providers));
  for (const provider of value.providers) {
    assert(isRecord(provider));
    assert.equal(Object.hasOwn(provider, 'apiKey'), false);
    assert.equal(Object.hasOwn(provider, 'clearApiKey'), false);
    assert.equal(typeof provider.apiKeyConfigured, 'boolean');
  }
}

async function exerciseAssistantAndReadOnlyWork(page: Page, requests: readonly RequestRecord[]): Promise<void> {
  const assistant = await apiJson(page, '/api/chat/assistant'); assert(isRecord(assistant.value));
  const providers = await apiJson(page, '/api/chat/providers'); assert(isRecord(providers.value) && Array.isArray(providers.value.providers));
  const provider = providers.value.providers.find(item => isRecord(item) && item.enabled === true && Array.isArray(item.models) && item.models.length > 0);
  assert(isRecord(provider) && Array.isArray(provider.models) && isRecord(provider.models[0]));
  const saved = await apiJson(page, '/api/chat/assistant', { method: 'POST', body: { revision: assistant.value.revision,
    configuration: { schema: 1, mode: 'chat-assistant', provider: provider.id, model: provider.models[0].id, nickname: 'Browser Assistant', reasoningEffort: null } } });
  assert.equal(saved.status, 200); assert(isRecord(saved.value) && typeof saved.value.revision === 'string');
  const savedAssistant = saved.value;
  await page.route('**/api/chat/assistant', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ json: { ...savedAssistant, executionAvailable: true, missingReasons: [] } });
  });
  const record = { id: 'browser-work-record', childId: 'browser-child', parentSessionId: 'browser-parent', conversationId: 'group:456001',
    generation: 1, createdAt: 1000, deadlineAt: 2000, status: 'completed', result: { stopReason: 'completed', output: [{ type: 'text', text: 'Browser readonly work result' }, { type: 'file', name: 'report.txt', assetId: 'browser-output-asset' }] },
    lateResult: null, delivery: 'confirmed', lastError: null, resultId: 'browser-result', deliveryId: 'browser-delivery', deliveryMessageId: 'browser-qq-receipt', deliveryError: null, deliveryFileId: 'browser-file-receipt' };
  await page.route('**/api/chat/work?*', async route => {
    assert.equal(route.request().method(), 'GET'); const query = new URL(route.request().url()).searchParams;
    await route.fulfill({ json: query.has('id') ? { schema: 1, record } : { schema: 1, records: query.get('conversationId') === 'group:999' ? [] : [record], next: null } });
  });
  await navigate(page, '聊天方案', 'model', '聊天方案');
  await page.locator('#chat-assistant').getByText('助手已启用', { exact: true }).waitFor();
  const works = page.locator('#native-work-records');
  await works.getByRole('button', { name: /browser-work-record/ }).click();
  await works.getByText('Browser readonly work result', { exact: false }).waitFor();
  await works.getByText('QQ 消息回执：browser-qq-receipt', { exact: true }).locator('xpath=ancestor::details').locator('summary').click();
  await works.getByText('文件上传回执：browser-file-receipt', { exact: true }).waitFor();
  await works.getByRole('textbox', { name: '工作所属会话筛选', exact: true }).fill('group:999');
  await works.getByRole('button', { name: '筛选工作记录', exact: true }).click();
  await works.getByText('当前筛选下没有工作记录。', { exact: true }).waitFor();
  assert.equal(requests.filter(request => request.method === 'POST' && request.pathname.startsWith('/api/chat/work')).length, 0);
}

async function writePrivateJson(filename: string, value: unknown): Promise<void> {
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function readJson(filename: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(filename, 'utf8'));
  assert(isRecord(value));
  return value;
}

async function assertStoredProviderKey(directory: string, providerId: string, expected: string): Promise<void> {
  const document = await readJson(join(directory, 'chat-providers.json'));
  assert(Array.isArray(document.providers));
  const provider: unknown = document.providers.find(candidate => isRecord(candidate) && candidate.id === providerId);
  assert(isRecord(provider));
  assert(provider.apiKey === expected, 'Stored provider credential does not match the expected keep/clear action.');
}

async function listen(server: Server): Promise<AddressInfo> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const reject = (error: Error): void => rejectPromise(error);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolvePromise();
    });
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return address;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (server === undefined || !server.listening) return;
  server.closeAllConnections();
  await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
}

function section(page: Page, title: string): Locator {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).first();
}

function field(page: Page | Locator, label: string): Locator {
  if (label === '身份定义') return page.locator('#chat-persona-identity').locator('..');
  if (label === '表达风格') return page.locator('#chat-persona-style').locator('..');
  return page.getByText(label, { exact: true }).locator('xpath=ancestor::label[1]').first();
}

async function navigate(page: Page, label: string, pageId: string, heading: string): Promise<void> {
  await navigateConsolePage(page, pageId as PageId);
  await page.locator(`[data-page="${pageId === 'access' || pageId === 'settings' ? 'security' : pageId}"]`).waitFor();
  await page.getByRole('heading', { name: pageId === 'access' || pageId === 'settings' ? '访问与设置' : pageId === 'model' ? '聊天方案与助手' : pageId === 'providers' ? '模型服务' : pageId === 'adapters' ? '连接' : pageId === 'usage' ? '用量与费用' : heading, exact: true, level: 1 }).waitFor();
}

async function connect(page: Page): Promise<void> {
  await page.locator('#token').fill(administratorToken);
  await page.locator('#connect').click();
  await page.getByRole('button', { name: '断开连接', exact: true }).waitFor();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
}

async function apiJson(page: Page, pathname: string, init?: { readonly method: 'POST'; readonly body: unknown }): Promise<{
  readonly status: number;
  readonly value: unknown;
}> {
  return page.evaluate(async ({ target, request }) => {
    const response = await fetch(target, request === undefined ? undefined : {
      method: request.method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request.body),
    });
    return { status: response.status, value: await response.json() as unknown };
  }, { target: pathname, request: init });
}

async function screenshot(page: Page, name: string): Promise<void> {
  const filename = new URL(`${name}-${runId}.png`, outputDirectory).pathname;
  await page.screenshot({ path: filename, fullPage: true, animations: 'disabled' });
  await chmod(filename, 0o600);
}

async function assertBoundedLongText(sectionLocator: Locator, textarea: Locator, value: string): Promise<void> {
  const boundedCardSelector = '[data-bounded-card]';
  const card = sectionLocator.locator(boundedCardSelector).first();
  const footer = sectionLocator.locator('.panel-footer');
  await card.waitFor();
  const before = await sectionLocator.evaluate((sectionElement, selector) => {
    const cardElement = sectionElement.querySelector(selector);
    const footerElement = sectionElement.querySelector('.panel-footer');
    if (!(cardElement instanceof HTMLElement) || !(footerElement instanceof HTMLElement)) {
      throw new Error('Bounded management card or independent footer is missing.');
    }
    return {
      sectionHeight: sectionElement.getBoundingClientRect().height,
      cardHeight: cardElement.getBoundingClientRect().height,
    };
  }, boundedCardSelector);
  await textarea.fill(value);
  const textOverflow = await textarea.evaluate(element => {
    element.scrollTop = Math.min(96, element.scrollHeight - element.clientHeight);
    const style = getComputedStyle(element);
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
      overflowY: style.overflowY,
    };
  });
  assert(textOverflow.scrollHeight > textOverflow.clientHeight, `Long textarea did not overflow internally: ${JSON.stringify(textOverflow)}.`);
  assert(textOverflow.scrollTop > 0 && ['auto', 'scroll'].includes(textOverflow.overflowY),
    `Long textarea is not internally scrollable: ${JSON.stringify(textOverflow)}.`);
  const after = await sectionLocator.evaluate((sectionElement, selector) => {
    const cardElement = sectionElement.querySelector(selector);
    const footerElement = sectionElement.querySelector('.panel-footer');
    if (!(cardElement instanceof HTMLElement) || !(footerElement instanceof HTMLElement)) {
      throw new Error('Bounded management card or independent footer is missing.');
    }
    cardElement.scrollTop = Math.min(96, cardElement.scrollHeight - cardElement.clientHeight);
    const cardBounds = cardElement.getBoundingClientRect();
    const footerBounds = footerElement.getBoundingClientRect();
    return {
      sectionHeight: sectionElement.getBoundingClientRect().height,
      cardHeight: cardBounds.height,
      cardClientHeight: cardElement.clientHeight,
      cardScrollHeight: cardElement.scrollHeight,
      cardScrollTop: cardElement.scrollTop,
      overflowY: getComputedStyle(cardElement).overflowY,
      footerAfterCard: footerBounds.top >= cardBounds.bottom - 1,
      footerDisplay: getComputedStyle(footerElement).display,
    };
  }, boundedCardSelector);
  assert(Math.abs(after.sectionHeight - before.sectionHeight) <= 2,
    `Long input changed section height: ${JSON.stringify({ before, after })}.`);
  assert(Math.abs(after.cardHeight - before.cardHeight) <= 2,
    `Long input changed bounded card height: ${JSON.stringify({ before, after })}.`);
  assert(after.cardScrollHeight > after.cardClientHeight && after.cardScrollTop > 0
    && ['auto', 'scroll'].includes(after.overflowY), `Bounded card did not scroll internally: ${JSON.stringify(after)}.`);
  assert(after.footerAfterCard && after.footerDisplay !== 'none' && await footer.isVisible(),
    `Management footer is not independently visible: ${JSON.stringify(after)}.`);
}

async function tokenIsAbsentFromStorage(page: Page): Promise<boolean> {
  return page.evaluate(async expected => {
    const storage = `${JSON.stringify(localStorage)}${JSON.stringify(sessionStorage)}${document.cookie}${location.href}`;
    const databases = indexedDB.databases === undefined ? [] : await indexedDB.databases();
    const cacheNames = 'caches' in globalThis ? await caches.keys() : [];
    return !storage.includes(expected)
      && !JSON.stringify(databases).includes(expected)
      && !JSON.stringify(cacheNames).includes(expected);
  }, administratorToken);
}

async function exerciseBuiltinDraft(page: Page, runtimeDirectory: string, requests: readonly RequestRecord[], options: {
  readonly pageId: 'persona' | 'model';
  readonly pageLabel: string;
  readonly builtinLabel: string;
  readonly nameLabel: string;
  readonly originalName: string;
  readonly originalId: string;
  readonly filename: string;
}): Promise<void> {
  const savedBefore = await readFile(join(runtimeDirectory, options.filename), 'utf8');
  const postsBefore = requests.filter(request => request.method === 'POST' && request.pathname.startsWith('/api/chat/')).length;
  await navigate(page, options.pageLabel, options.pageId, options.pageLabel);
  const name = field(page, options.nameLabel).locator('input');
  await name.waitFor();
  assert.equal(await name.inputValue(), options.originalName);
  const builtin = page.getByRole('button', { name: options.builtinLabel, exact: true });
  await name.fill('UNSAVED_BUILTIN_GUARD');
  assert.equal(await builtin.isDisabled(), true);
  await page.getByRole('button', { name: '撤销更改', exact: true }).click();
  await builtin.click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: options.pageId === 'persona' ? '新建人设' : '新建聊天方案', exact: true }) });
  await dialog.waitFor();
  assert.notEqual(await name.inputValue(), options.originalName);
  const identifier = page.locator(options.pageId === 'persona' ? '#chat-persona-id' : '#chat-plan-id');
  assert.notEqual(await identifier.inputValue(), options.originalId);
  if (options.pageId === 'persona') {
    assert.equal(await name.inputValue(), '小鲸鱼');
    assert((await field(page, '身份定义').locator('textarea').inputValue()).length > 0);
    assert((await field(page, '表达风格').locator('textarea').inputValue()).length > 0);
  }
  await name.fill('Editable Unsaved Builtin Draft');
  await dialog.getByRole('button', { name: '返回编辑', exact: true }).click();
  await page.getByRole('button', { name: '撤销更改', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(options.originalName) }).first().click();
  assert.equal(await name.inputValue(), options.originalName);
  assert.equal(await readFile(join(runtimeDirectory, options.filename), 'utf8'), savedBefore);
  assert.equal(requests.filter(request => request.method === 'POST' && request.pathname.startsWith('/api/chat/')).length, postsBefore);
}

function objectProvider(value: unknown): Record<string, unknown> {
  assert(isRecord(value));
  return value;
}
async function untilBrowser(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('管理页面保存未在期限内确认。');
}

async function run(): Promise<void> {
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await chmod(outputDirectory, 0o700);
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'management-smoke-'));
  const runtimeDirectory = join(fixtureDirectory, 'runtime');
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const packageRegistry = createDefaultPackageConfigurationRegistry(runtimeDirectory);
  if (!packageRegistry.descriptors().some(descriptor => descriptor.id === 'chat-output')) packageRegistry.register(NATIVE_OUTPUT_CONFIGURATION);
  const extension: PackageConfigurationContribution = { descriptor: { id: 'browser-settings', owner: 'browser-package', schemaVersion: 2, title: '浏览器扩展设置', description: 'Synthetic controlled package fields', application: 'restart', fields: [
    { id: 'enabled', path: ['enabled'], kind: 'boolean', label: '启用测试扩展', description: '' },
    { id: 'limit', path: ['limit'], kind: 'integer', label: '测试扩展期限', description: '', minimum: 1, maximum: 12, unit: '秒' },
    { id: 'names', path: ['names'], kind: 'string-list', label: '测试扩展别名', description: '', maximumEntries: 4, maximumLength: 32 },
  ] }, defaults: { enabled: false, limit: 4, names: ['seed'] }, validate(value) {
    assert(isRecord(value) && typeof value.enabled === 'boolean' && typeof value.limit === 'number' && Number.isSafeInteger(value.limit) && value.limit >= 1 && value.limit <= 12 && Array.isArray(value.names));
    const names: string[] = []; for (const name of value.names) { assert.equal(typeof name, 'string'); assert(typeof name === 'string'); names.push(name); }
    return { enabled: value.enabled, limit: value.limit, names };
  }, migrate(value, fromVersion) { assert.equal(fromVersion, 1); assert(isRecord(value)); return this.validate({ ...value, enabled: false }); } };
  const packageStore = createPackageConfigurationFileStore(runtimeDirectory);
  const oldPackage = { schema: 1 as const, id: 'browser-settings', schemaVersion: 1, configuration: { limit: 4, names: ['seed'] } };
  const originalPackage = await packageStore.read('browser-settings', oldPackage);
  await packageStore.compareAndSet('browser-settings', originalPackage.revision, oldPackage, oldPackage, new AbortController().signal);
  packageRegistry.register(extension);
  const maintenance = usageMaintenanceFixture();
  const accounts = accountsFixture(runtimeDirectory);
  const nativeRoutes = createNativeRuntimeRoutes({ directory: runtimeDirectory, packageConfigurationRegistry: packageRegistry });
  const authorizationRuntime = createNativeChatRuntime({ directory: runtimeDirectory, loadConfiguration: () => readNativeChatConfiguration(runtimeDirectory), resolveDeployment: async () => ({ missingReasons: ['browser_fixture_readonly'], presetBindings: [] }) });
  const authorizationRoutes = createNativeRuntimeRoutes({ directory: runtimeDirectory, chatRuntime: authorizationRuntime, packageConfigurationRegistry: packageRegistry }).filter(route => route.pathname === '/api/chat/authorization');
  let reminderNow = Date.now();
  let reminderSends = 0;
  const reminderStore = createSqliteStore({ filename: join(runtimeDirectory, 'browser-reminders.sqlite') });
  const reminderContext = createContextStore();
  const reminderPersona = reminderContext.registerPersona({ id: 'reminder-browser', version: '1.0.0', name: 'Reminder', identity: {}, style: {} });
  const reminderPolicy = createPolicy({ clock: () => reminderNow });
  let reminderEngine: ReturnType<typeof createEngine>;
  const reminderService = createNativeReminderService({ store: reminderStore, clock: () => reminderNow, intervalMs: 60_000,
    authorizeConfiguration() {}, guard() {},
    async dispatch(event, signal) { await reminderEngine.emit(event, { signal }); return { status: 'accepted' }; } });
  reminderEngine = createEngine({ context: reminderContext, persona: reminderPersona, policy: reminderPolicy,
    clock: () => reminderNow, eventValidators: reminderService.eventValidators,
    transport: { async send() { reminderSends++; return { status: 'confirmed', messageId: `browser-reminder-${reminderSends}` }; } } });
  reminderEngine.install(reminderService.feature);
  reminderPolicy.grant({ id: 'browser-explicit-reminder-grant', featureId: 'reminder', conversationId: 'group:456001', capabilities: ['messaging.send'], maxUses: { 'messaging.send': 10 } });
  await reminderService.start();
  const reminderRoutes = createNativeReminderRoutes({ read: options => reminderService.list(options), history: options => reminderService.history(options), service: () => reminderService });
  const toolPermissionRoutes = createNativeToolPermissionRoutes({ directory: runtimeDirectory,
    runtime: () => ({ state: 'not-running', appliedRevision: null }), onChanged: () => ({ state: 'not-running', appliedRevision: null }) });
  const memoryService = createNativeMemoryService({ store: reminderStore, clock: () => reminderNow, authorizeSource() {}, authorizeOwner() {}, authorizeRead() {} });
  const memoryProposal = await memoryService.propose({ scope: { kind: 'group', conversationId: 'group:456001' }, kind: 'preference', content: 'Browser proposed preference', tags: [], expiresAt: null },
    { kind: 'model-inference', conversationId: 'group:456001', userId: '123001', messageId: 'browser-synthetic-source' }, new AbortController().signal);
  const memoryRoutes = createNativeMemoryRoutes({ read: options => memoryService.list(options), entry: id => memoryService.read(id), service: () => memoryService });
  const readProviders = nativeRoutes.find(route => route.method === 'GET' && route.pathname === '/api/chat/providers');
  const writeProviders = nativeRoutes.find(route => route.method === 'POST' && route.pathname === '/api/chat/providers');
  assert(readProviders && writeProviders, 'Native provider routes are required for management fixtures.');
  const providersBefore: unknown = await readProviders.handle({ query: new URLSearchParams(), body: null, signal: new AbortController().signal });
  assert(isRecord(providersBefore) && typeof providersBefore.revision === 'string');
  await writeProviders.handle({
    query: new URLSearchParams(),
    body: { revision: providersBefore.revision, providers: fixtureProviders },
    signal: new AbortController().signal,
  });
  await writePrivateJson(join(runtimeDirectory, 'chat-personas.json'), {
    schema: 1,
    personas: [
      { id: 'fixture-persona', name: 'Fixture Persona', identity: xssText, style: 'Calm and precise.' },
      { id: 'whale', name: 'Existing Custom Whale', identity: 'Operator-managed existing identity.', style: 'Preserve this custom style.' },
    ],
  });
  await writePrivateJson(join(runtimeDirectory, 'chat-plans.json'), {
    schema: 1,
    activePlanId: 'fixture-plan',
    plans: [
      {
        id: 'fixture-plan', name: 'Fixture Plan', description: 'Independent native plan.',
        instructions: 'Answer concisely.', personaId: 'fixture-persona', provider: 'fixture-provider',
        model: 'fixture-model', reasoningEffort: 'medium',
      },
      {
        id: 'legacy-plan', name: 'Legacy Plan', description: 'Unchanged missing bindings remain editable.',
        instructions: 'Preserve this inactive legacy plan.', personaId: 'fixture-persona', provider: 'legacy-provider',
        model: 'legacy-model', reasoningEffort: 'medium',
      },
      {
        id: 'daily-chat', name: 'Existing Custom Daily Plan', description: 'Built-in ID collision fixture.',
        instructions: 'Preserve this custom plan.', personaId: 'whale', provider: 'fixture-provider',
        model: 'fixture-model', reasoningEffort: 'medium',
      },
    ],
  });
  await writePrivateJson(join(runtimeDirectory, 'chat-access.json'), {
    schema: 1, allow: [], deny: [], owner: null,
  });

  const requests: RequestRecord[] = [];
  const pageErrors: string[] = [];
  const externalRequests: string[] = [];
  let xssRequests = 0;
  let server: Server | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  const restartUnavailable: AdminRoute = { method: 'GET', pathname: '/api/chat/dsh/restart', handle: () => ({ schema: 1, available: false, missingReasons: ['LOCAL_DSH_RESTART_NOT_CONFIGURED'], operation: null }) };

  try {
    server = createAdminServer({
      token: administratorToken,
      snapshot: () => ({
        mode: 'gateway-live',
        integrations: { nativeRuntimeResources: true, nativeChatRuntime: false },
        overview: {
          online: true,
          gatewayHealthy: true,
          metrics: { writes: 0, pending: 0, rejected: 0, unknown: 0, recoveredUnknown: 0 },
        },
        fixtureOnly: true,
      }),
      routes: [restartUnavailable, ...nativeRoutes.filter(route => route.pathname !== '/api/chat/dsh/restart' && !route.pathname.startsWith('/api/chat/reminders') && !route.pathname.startsWith('/api/chat/tool-permissions') && !route.pathname.startsWith('/api/chat/memory')), ...reminderRoutes, ...toolPermissionRoutes, ...memoryRoutes, ...maintenance.routes, ...authorizationRoutes, ...accounts.routes].map(route => route.method === 'GET' && route.pathname === '/api/chat/model-capabilities'
        ? { ...route, handle: ({ query }: Parameters<typeof route.handle>[0]) => ({
          provider: query.get('provider'), model: query.get('model'), state: 'available',
          reasoningEfforts: ['off', 'low', 'medium', 'high', 'max'], missingReasons: [], capacity: recommendChatCapacity({ contextWindow: 262144, maxTokens: 32768 })
        }) } : route),
      handlerTimeoutMs: 5_000,
    });
    const address = await listen(server);
    const origin = `http://127.0.0.1:${address.port}`;

    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROMIUM_EXECUTABLE === undefined ? {} : { executablePath: process.env.CHROMIUM_EXECUTABLE }),
    });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
    page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === origin) requests.push({ method: request.method(), pathname: url.pathname });
      if (url.pathname === '/management-smoke-xss') xssRequests += 1;
    });
    await context.route('**/*', route => {
      const requested = new URL(route.request().url());
      if ((requested.protocol === 'http:' || requested.protocol === 'https:') && requested.origin !== origin) {
        externalRequests.push(requested.href);
        return route.abort();
      }
      return route.continue();
    });

    await page.goto(origin);
    await connect(page);
    const cookies = await context.cookies(`${origin}/api/auth/session`);
    assert(cookies.some(cookie => cookie.httpOnly && cookie.sameSite === 'Strict' && cookie.path === '/api'));

    await exerciseBuiltinDraft(page, runtimeDirectory, requests, {
      pageId: 'persona', pageLabel: '人设与唤醒', builtinLabel: '使用内置人设', nameLabel: '显示名称',
      originalName: 'Fixture Persona', originalId: 'fixture-persona', filename: 'chat-personas.json',
    });
    await exerciseBuiltinDraft(page, runtimeDirectory, requests, {
      pageId: 'model', pageLabel: '聊天方案', builtinLabel: '使用内置方案', nameLabel: '方案名称',
      originalName: 'Fixture Plan', originalId: 'fixture-plan', filename: 'chat-plans.json',
    });

    const providerCatalog = await apiJson(page, '/api/chat/providers');
    assert.equal(providerCatalog.status, 200);
    assert(isRecord(providerCatalog.value) && typeof providerCatalog.value.revision === 'string');
    assertProviderCredentialsRedacted(providerCatalog.value);
    assert.deepEqual(providerCatalog.value.providers, fixtureProviders.map(provider => ({ ...provider, apiKeyConfigured: false })));
    const providersWithKey = await apiJson(page, '/api/chat/providers', {
      method: 'POST',
      body: {
        revision: providerCatalog.value.revision,
        providers: fixtureProviders.map(provider => provider.id === 'fixture-provider-v2'
          ? { ...provider, apiKey: fixtureProviderCredential } : provider),
      },
    });
    assert.equal(providersWithKey.status, 200);
    assert(isRecord(providersWithKey.value) && typeof providersWithKey.value.revision === 'string');
    assertProviderCredentialsRedacted(providersWithKey.value);
    await assertStoredProviderKey(runtimeDirectory, 'fixture-provider-v2', fixtureProviderCredential);
    const providersKept = await apiJson(page, '/api/chat/providers', {
      method: 'POST',
      body: { revision: providersWithKey.value.revision, providers: fixtureProviders },
    });
    assert.equal(providersKept.status, 200);
    assert(isRecord(providersKept.value) && typeof providersKept.value.revision === 'string');
    assertProviderCredentialsRedacted(providersKept.value);
    await assertStoredProviderKey(runtimeDirectory, 'fixture-provider-v2', fixtureProviderCredential);
    const providersKeptEmpty = await apiJson(page, '/api/chat/providers', {
      method: 'POST',
      body: {
        revision: providersKept.value.revision,
        providers: fixtureProviders.map(provider => ({ ...provider, apiKey: '' })),
      },
    });
    assert.equal(providersKeptEmpty.status, 200);
    assert(isRecord(providersKeptEmpty.value) && typeof providersKeptEmpty.value.revision === 'string');
    assertProviderCredentialsRedacted(providersKeptEmpty.value);
    await assertStoredProviderKey(runtimeDirectory, 'fixture-provider-v2', fixtureProviderCredential);
    const providersCleared = await apiJson(page, '/api/chat/providers', {
      method: 'POST',
      body: {
        revision: providersKeptEmpty.value.revision,
        providers: fixtureProviders.map(provider => ({ ...provider, clearApiKey: true })),
      },
    });
    assert.equal(providersCleared.status, 200);
    assert(isRecord(providersCleared.value) && typeof providersCleared.value.revision === 'string');
    assertProviderCredentialsRedacted(providersCleared.value);
    await assertStoredProviderKey(runtimeDirectory, 'fixture-provider-v2', '');
    const staleProviders = await apiJson(page, '/api/chat/providers', {
      method: 'POST',
      body: { revision: providersWithKey.value.revision, providers: fixtureProviders },
    });
    assert.deepEqual(staleProviders, { status: 409, value: { error: 'chat_revision_conflict' } });
    for (const providers of [
      fixtureProviders.filter(provider => provider.id !== 'fixture-provider'),
      fixtureProviders.map(provider => provider.id === 'fixture-provider' ? { ...provider, models: [] } : provider),
      fixtureProviders.map(provider => provider.id === 'fixture-provider' ? { ...provider, enabled: false } : provider),
    ]) {
      const rejected = await apiJson(page, '/api/chat/providers', {
        method: 'POST', body: { revision: providersCleared.value.revision, providers },
      });
      assert.deepEqual(rejected, { status: 409, value: { error: 'provider_model_in_use' } });
    }
    const providerCatalogAfterRejections = await apiJson(page, '/api/chat/providers');
    assert.deepEqual(providerCatalogAfterRejections, providersCleared);

    await navigate(page, '模型服务', 'providers', '模型服务');
    const providerName = page.locator('#provider-name');
    await providerName.fill('Fixture Provider Updated');
    await page.locator('#provider-base-url').fill('https://provider.invalid/v2');
    await page.locator('#provider-api-key').fill(fixtureProviderCredential);
    await page.getByRole('group', { name: '可用模型列表', exact: true }).locator('tbody tr').first().getByRole('button', { name: '编辑', exact: true }).click();
    await page.locator('#provider-model-name').fill('Fixture Model Updated');
    await page.getByRole('button', { name: '更新服务草稿', exact: true }).click();
    await navigate(page, '概览', 'overview', '连接与概览');
    await navigate(page, '模型服务', 'providers', '模型服务');
    assert.equal(await providerName.inputValue(), 'Fixture Provider Updated');
    assert.equal(await page.locator('#provider-api-key').inputValue(), '');
    await page.getByRole('group', { name: '可用模型列表', exact: true }).getByText('Fixture Model Updated', { exact: true }).waitFor();
    await page.locator('#provider-api-key').fill(fixtureProviderCredential);
    const providerSaved = page.waitForResponse(response => response.url().endsWith('/api/chat/providers') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '保存提供方', exact: true }).click();
    assert.equal((await providerSaved).status(), 200);
    assert.equal(await page.locator('#provider-api-key').inputValue(), '');
    await assertStoredProviderKey(runtimeDirectory, 'fixture-provider', fixtureProviderCredential);
    const catalog = await apiJson(page, '/api/chat/providers');
    assertProviderCredentialsRedacted(catalog.value);
    assert(isRecord(catalog.value) && Array.isArray(catalog.value.providers));
    const currentProviders = catalog.value.providers.map(item => { const { apiKeyConfigured, ...provider } = objectProvider(item); return provider; });
    const keep = await apiJson(page, '/api/chat/providers', { method: 'POST', body: { revision: catalog.value.revision, providers: currentProviders } });
    assert.equal(keep.status, 200);
    await assertStoredProviderKey(runtimeDirectory, 'fixture-provider', fixtureProviderCredential);
    assert.equal((await apiJson(page, '/api/chat/providers', { method: 'POST', body: { revision: providersBefore.revision, providers: currentProviders.map(item => ({ ...objectProvider(item), name: `${objectProvider(item).name} stale` })) } })).status, 409);
    assert(isRecord(keep.value));
    const referenced = await apiJson(page, '/api/chat/providers', { method: 'POST', body: { revision: keep.value.revision, providers: currentProviders.filter(item => objectProvider(item).id !== 'fixture-provider') } });
    assert.equal(referenced.status, 409);
    await page.getByRole('checkbox', { name: '保存时清除已保存密钥', exact: true }).check();
    await page.getByRole('button', { name: '保存提供方', exact: true }).click();
    await untilBrowser(async () => { const value = await apiJson(page!, '/api/chat/providers'); return isRecord(value.value) && Array.isArray(value.value.providers) && objectProvider(value.value.providers[0]).apiKeyConfigured === false; });
    await assertStoredProviderKey(runtimeDirectory, 'fixture-provider', '');
    const postsBeforeCancel = requests.filter(request => request.method === 'POST' && request.pathname === '/api/chat/providers').length;
    await page.getByRole('button', { name: '删除服务', exact: true }).click();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(requests.filter(request => request.method === 'POST' && request.pathname === '/api/chat/providers').length, postsBeforeCancel);

    await navigate(page, '聊天方案', 'model', '聊天方案与助手');
    await page.locator('#chat-plan-name').fill('Fixture Plan Updated');
    await page.locator('#chat-plan-provider').selectOption('fixture-provider-v2');
    await page.locator('#chat-plan-model').selectOption('fixture-model-v2');
    const groupLimit = field(page, '群聊上下文').locator('input');
    const privateLimit = field(page, '私聊上下文').locator('input');
    await groupLimit.fill('0');
    const beforeInvalid = requests.filter(request => request.method === 'POST' && request.pathname === '/api/chat/plans').length;
    await page.getByRole('button', { name: '保存聊天方案', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '群聊和私聊上下文分别填写' }).waitFor();
    assert.equal(requests.filter(request => request.method === 'POST' && request.pathname === '/api/chat/plans').length, beforeInvalid);
    await groupLimit.fill('172000');
    await privateLimit.fill('384000');
    const planSaved = page.waitForResponse(response => response.url().endsWith('/api/chat/plans') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '保存聊天方案', exact: true }).click();
    assert.equal((await planSaved).status(), 200);
    const plans = await apiJson(page, '/api/chat/plans');
    assert(isRecord(plans.value) && Array.isArray(plans.value.plans));
    const activePlan = objectProvider(plans.value.plans[0]);
    assert.equal(activePlan.provider, 'fixture-provider-v2');
    assert.equal(activePlan.model, 'fixture-model-v2');
    assert.deepEqual(activePlan.contextLimits, { group: 172000, private: 384000 });
    assert.equal((await apiJson(page, '/api/chat/plans', { method: 'POST', body: { revision: plans.value.revision, activePlanId: 'legacy-plan', plans: plans.value.plans } })).status, 409);
    await navigate(page, '人设与唤醒', 'persona', '人设与唤醒');
    assert.equal(await field(page, '身份定义').locator('textarea').inputValue(), xssText);
    const personaStyle = '温和直接；根据实际证据回答，不编造发送结果。';
    await field(page, '表达风格').locator('textarea').fill(personaStyle);
    const personaSaved = page.waitForResponse(response => response.url().endsWith('/api/chat/personas') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '保存人设', exact: true }).click();
    assert.equal((await personaSaved).status(), 200);

    await navigate(page, '访问与设置', 'security', '访问与设置');
    await page.getByRole('button', { name: '编辑名单', exact: true }).click();
    const allow = field(page, '群聊白名单').locator('textarea');
    const privateAllow = field(page, '私聊白名单').locator('textarea');
    await field(page, '主人账号').locator('input').fill('123001');
    await allow.fill('456001, 456001');
    const accessPosts = requests.filter(request => request.method === 'POST' && request.pathname === '/api/chat/access').length;
    await page.getByRole('button', { name: '保存名单', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '同一份名单中不能重复填写群号' }).waitFor();
    assert.equal(requests.filter(request => request.method === 'POST' && request.pathname === '/api/chat/access').length, accessPosts);
    await allow.fill('456001, 456002');
    await privateAllow.fill('123001，123002');
    const accessSaved = page.waitForResponse(response => response.url().endsWith('/api/chat/access') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '保存名单', exact: true }).click();
    assert.equal((await accessSaved).status(), 200);
    await page.getByRole('dialog', { name: '主人与白名单', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
    const access = await apiJson(page, '/api/chat/access');
    assert(isRecord(access.value));
    assert.deepEqual(access.value.allow, ['group:456001', 'group:456002', 'private:123001', 'private:123002']);
    assert.equal(access.value.owner, '123001');
    assert.equal(await page.locator('#native-tool-permissions, #forward-authorization').count(), 0);

    const adapters = await apiJson(page, '/api/chat/adapters');
    assert(isRecord(adapters.value));
    assertAdapterCredentialsRedacted(adapters.value);
    const savedAdapters = await apiJson(page, '/api/chat/adapters', { method: 'POST', body: { revision: adapters.value.revision,
      adapters: { onebotHttp: { enabled: true, endpoint: 'http://127.0.0.1:3000', secret: fixtureAdapterCredential } } } });
    assert.equal(savedAdapters.status, 200);
    assert(isRecord(savedAdapters.value));
    assertAdapterCredentialsRedacted(savedAdapters.value);
    await navigate(page, '连接', 'adapters', '连接');
    await page.getByRole('heading', { name: 'QQ 消息连接', exact: true }).waitFor();
    assert(!(await page.locator('body').innerText()).includes(fixtureAdapterCredential));
    assert.equal((await apiJson(page, '/api/chat/adapters/connect', { method: 'POST', body: { revision: savedAdapters.value.revision } })).status, 503);
    for (const pathname of ['/api/chat/sessions', '/api/chat/usage']) assert.equal((await apiJson(page, pathname)).status, 503);
    for (const pathname of ['/api/chat/memory', '/api/chat/reminders']) {
      // The fixture explicitly installs optional services; the console has no write entry points for them.
      assert.equal(requests.some(request => request.method === 'POST' && request.pathname.startsWith(pathname)), false);
    }
    for (const filename of ['chat-plans.json', 'chat-personas.json', 'chat-access.json', 'chat-adapters.json', 'chat-providers.json']) {
      assert.equal((await stat(join(runtimeDirectory, filename))).mode & 0o777, 0o600);
    }
    assert.equal((await stat(runtimeDirectory)).mode & 0o777, 0o700);

    await screenshot(page, 'desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot(page, 'mobile');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    assert.equal(await tokenIsAbsentFromStorage(page), true);
    assert.equal(await page.evaluate(() => globalThis.__managementSmokeXss === true), false);
    assert.equal(xssRequests, 0);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(externalRequests, []);

    await writePrivateJson(new URL(`result-${runId}.json`, outputDirectory).pathname, {
      checkedAt: new Date().toISOString(),
      nativeRuntimeRoutes: true,
      builtinDraftsWithoutAutomaticSave: true,
      providerEditorAndSecretKeepClear: true,
      staleAndReferencedProviderChangesRejected: true,
      planModelAndContextSaved: true,
      invalidContextAndLegacyActivationRejected: true,
      personaSavedAndXssInert: true,
      whitelistValidationAndOwnerSaved: true,
      adapterSecretRedactedAndUnavailableConnectionHonest: true,
      privateRuntimePermissions: true,
      tokenStoredByBrowserScript: false,
      pageErrors: 0,
      externalRequests: 0,
    });
    console.log(`Management smoke passed. Results: runtime/management-smoke/result-${runId}.json`);
  } catch (error: unknown) {
    if (page !== undefined && !page.isClosed()) await screenshot(page, 'failure').catch(() => undefined);
    await writePrivateJson(new URL(`failure-${runId}.json`, outputDirectory).pathname, {
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
      body: await page?.locator('body').innerText().catch(() => 'unavailable'),
      requests,
      pageErrors,
      externalRequests,
    });
    throw error;
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await closeServer(server);
    await reminderService.stop();
    await reminderEngine.stop();
    reminderStore.close();
    maintenance.store.close();
    await authorizationRuntime.close();
    await accounts.accounts.close();
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
}

declare global {
  var __managementSmokeXss: boolean | undefined;
}

await run();
