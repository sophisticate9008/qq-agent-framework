import { accountsFixture, exerciseAccountWorkspace } from './management-accounts-smoke.ts';
import { exerciseProtocolConnectionDiagnostics } from './management-protocol-status-smoke.ts';
import { exerciseModelReasoningCapabilities } from './management-model-capabilities-smoke.ts';
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
import { createAdminServer } from '../src/admin/server.ts';
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
  let target = { schema: 1, state: 'blocked', assistantRevision: savedAssistant.revision, configurationRevision: 'a'.repeat(64),
    targetRevision: 'b'.repeat(64), operationRevision: 'c'.repeat(64), provider: provider.id, model: provider.models[0].id,
    agentPreset: 'browser-assistant', externalProvider: 'browser-provider', fullAccess: false, missingReasons: ['assistant_target_unavailable'] };
  let applies = 0; let reconciles = 0;
  await page.route('**/api/chat/assistant', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ json: { ...savedAssistant, executionAvailable: target.state === 'verified', missingReasons: target.state === 'verified' ? [] : ['assistant_target_unavailable'] } });
  });
  await page.route('**/api/chat/assistant/deployment**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'POST') {
      const body: unknown = route.request().postDataJSON(); assert(isRecord(body));
      assert.equal(body.assistantRevision, savedAssistant.revision);
      if (path.endsWith('/prepare')) { assert.deepEqual(Object.keys(body), ['assistantRevision']); target = { ...target, state: 'prepared', missingReasons: [] }; }
      else if (path.endsWith('/apply')) { applies++; assert.equal(body.targetRevision, target.targetRevision); assert.equal(body.operationRevision, target.operationRevision); target = { ...target, state: 'unknown', missingReasons: ['assistant_deployment_result_unknown'] }; }
      else if (path.endsWith('/reconcile')) { reconciles++; assert.equal(Object.hasOwn(body, 'targetRevision'), false); target = { ...target, state: 'verified', missingReasons: [] }; }
      else assert.fail(`Unexpected assistant action ${path}`);
    }
    await route.fulfill({ json: target });
  });
  const record = { id: 'browser-work-record', childId: 'browser-child', parentSessionId: 'browser-parent', conversationId: 'group:456001',
    generation: 1, createdAt: 1000, deadlineAt: 2000, status: 'completed', result: { stopReason: 'completed', output: [{ type: 'text', text: 'Browser readonly work result' }, { type: 'file', name: 'report.txt', assetId: 'browser-output-asset' }] },
    lateResult: null, delivery: 'confirmed', lastError: null, resultId: 'browser-result', deliveryId: 'browser-delivery', deliveryMessageId: 'browser-qq-receipt', deliveryError: null, deliveryFileId: 'browser-file-receipt' };
  await page.route('**/api/chat/work?*', async route => {
    assert.equal(route.request().method(), 'GET'); const query = new URL(route.request().url()).searchParams;
    await route.fulfill({ json: query.has('id') ? { schema: 1, record } : { schema: 1, records: query.get('conversationId') === 'group:999' ? [] : [record], next: null } });
  });
  await navigate(page, '聊天方案', 'model', '聊天方案');
  const deployment = page.locator('#assistant-deployment');
  await deployment.getByRole('button', { name: '检查助手部署', exact: true }).click();
  await deployment.getByText('已检查，等待明确应用', { exact: true }).waitFor();
  assert.equal(applies, 0);
  await deployment.getByRole('checkbox', { name: '确认应用已保存的独立助手模型配置', exact: true }).check();
  await deployment.getByRole('button', { name: '应用助手目标', exact: true }).click();
  await deployment.getByText('助手应用结果待核对', { exact: true }).waitFor();
  assert.equal(applies, 1); assert.equal(await deployment.getByRole('button', { name: '应用助手目标', exact: true }).isDisabled(), true);
  await deployment.getByRole('button', { name: '读取助手部署状态', exact: true }).click();
  await deployment.getByText('助手应用结果待核对', { exact: true }).waitFor(); assert.equal(applies, 1);
  await deployment.getByRole('button', { name: '核对助手目标实际结果', exact: true }).click();
  await deployment.getByText('助手目标已核验', { exact: true }).waitFor();
  await page.locator('#chat-assistant').getByText('助手执行已就绪', { exact: true }).waitFor();
  assert.equal(applies, 1); assert.equal(reconciles, 1);
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
  return page.getByText(label, { exact: true }).locator('xpath=ancestor::label[1]').first();
}

async function navigate(page: Page, label: string, pageId: string, heading: string): Promise<void> {
  await navigateConsolePage(page, pageId as PageId);
  await page.locator(`[data-page="${pageId}"]`).waitFor();
  await page.getByRole('heading', { name: pageId === 'access' || pageId === 'settings' ? '安全' : heading, exact: true, level: 1 }).waitFor();
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
  await field(page, options.nameLabel).locator('input').waitFor();
  const name = field(page, options.nameLabel).locator('input');
  const builtin = page.getByRole('button', { name: options.builtinLabel, exact: true });
  assert.equal(await name.inputValue(), options.originalName);
  await page.getByRole('button', { name: options.pageId === 'persona' ? '新建人设' : '新建方案', exact: true }).click();
  const automaticId = page.locator(options.pageId === 'persona' ? '#chat-persona-id' : '#chat-plan-id');
  const generated = await automaticId.inputValue();
  assert.match(generated, new RegExp(`^${options.pageId === 'persona' ? 'persona' : 'plan'}-[a-f0-9-]+$`));
  await automaticId.locator('xpath=ancestor::details[1]').locator('summary').click();
  await automaticId.fill('compatibility-id');
  await page.getByRole('button', { name: '撤销更改', exact: true }).click();
  assert.equal(await automaticId.inputValue(), generated);
  await page.getByRole('button', { name: new RegExp(`^${options.originalName}`) }).first().click();
  await name.fill('UNSAVED_BUILTIN_GUARD');
  assert.equal(await builtin.isDisabled(), true);
  assert.equal(await name.inputValue(), 'UNSAVED_BUILTIN_GUARD');
  await page.getByRole('button', { name: '撤销更改', exact: true }).click();
  await builtin.click();
  const advanced = page.locator(`details:has(#${options.pageId === 'persona' ? 'chat-persona-id' : 'chat-plan-id'})`);
  if (await advanced.count() > 0) await advanced.locator('summary').first().click();
  const identifier = field(page, '内部标识').locator('input');
  assert.notEqual(await identifier.inputValue(), options.originalId);
  assert.notEqual(await name.inputValue(), options.originalName);
  assert((await name.inputValue()).trim().length > 0);
  if (options.pageId === 'persona') {
    assert.equal(await identifier.inputValue(), 'whale-copy');
    assert.equal(await name.inputValue(), '小鲸鱼');
    assert((await field(page, '身份定义').locator('textarea').inputValue()).trim().length > 0);
    assert((await field(page, '表达风格').locator('textarea').inputValue()).trim().length > 0);
  } else {
    assert.equal(await identifier.inputValue(), 'daily-chat-copy');
    assert.equal(await name.inputValue(), '日常聊天方案');
    for (const label of ['模型提供方', '模型', '关联人设']) {
      assert.equal(await field(page, label).locator('select').inputValue(), '');
    }
    const reasoning = field(page, '思考强度');
    assert.equal(await reasoning.locator('select').inputValue(), 'low');
    assert.equal(await reasoning.locator('option[value="low"]').isDisabled(), true);
    assert.equal(await reasoning.locator('select').isDisabled(), true);
    await reasoning.getByText(/草稿原值“low”仍保留/).waitFor();
    for (const label of ['群聊上下文', '私聊上下文']) {
      assert.equal(await field(page, label).locator('input').inputValue(), '128000');
    }
    assert.equal(await page.getByRole('button', { name: '选择为启用方案', exact: true }).isDisabled(), true);
  }
  assert.equal(await name.isEditable(), true);
  assert.equal(await builtin.isDisabled(), true);
  const draftName = 'Editable Unsaved Builtin Draft';
  await name.fill(draftName);
  await page.getByRole('button', { name: '概览', exact: true }).first().click();
  const leaveGuard = page.getByRole('dialog', { name: '还有未保存的更改', exact: true });
  await page.locator('[data-page="overview"]').waitFor();
  assert.equal(await leaveGuard.count(), 0);
  await navigate(page, options.pageLabel, options.pageId, options.pageLabel);
  await name.waitFor();
  const restoredAdvanced = page.locator(`details:has(#${options.pageId === 'persona' ? 'chat-persona-id' : 'chat-plan-id'})`);
  if (await restoredAdvanced.count() > 0) await restoredAdvanced.locator('summary').first().click();
  assert.equal(await name.inputValue(), draftName);
  assert.notEqual(await field(page, '内部标识').locator('input').inputValue(), options.originalId);
  await page.getByRole('button', { name: '撤销更改', exact: true }).first().click();
  await page.getByRole('button').filter({ has: page.locator('strong', { hasText: options.originalName }) }).first().click();
  assert.equal(await name.inputValue(), options.originalName);
  assert.equal(await field(page, '内部标识').locator('input').inputValue(), options.originalId);
  assert.equal(await readFile(join(runtimeDirectory, options.filename), 'utf8'), savedBefore);
  assert.equal(requests.filter(request => request.method === 'POST' && request.pathname.startsWith('/api/chat/')).length, postsBefore);
}

async function exerciseProviderEditor(page: Page, runtimeDirectory: string, requests: readonly RequestRecord[]): Promise<void> {
  await navigate(page, '模型提供方', 'providers', '模型提供方');
  const editor = section(page, 'Fixture Provider');
  await editor.waitFor();
  assert.equal(await page.locator('[data-page="providers"] [data-bounded-card]').count(), 2);
  const modelList = page.getByRole('group', { name: '可用模型列表', exact: true });
  await field(page, '提供方显示名称').locator('input').fill('Fixture Provider Updated');
  await field(page, '接口基础地址').locator('input').fill('https://provider.invalid/v2');
  const protocolInput = field(page, 'DSH 接口协议').getByRole('combobox');
  await page.getByRole('button', { name: '选择 DSH 接口协议', exact: true }).click();
  assert.equal(await page.getByRole('option').count(), 3);
  await page.getByRole('option', { name: /OpenAI Responses/ }).click();
  assert.equal(await protocolInput.inputValue(), 'openai-responses');
  await protocolInput.fill('claude');
  await page.getByRole('option', { name: /Anthropic Messages/ }).waitFor();
  assert.equal(await page.getByRole('option').count(), 1);
  await protocolInput.press('ArrowDown');
  await protocolInput.press('Enter');
  assert.equal(await protocolInput.inputValue(), 'anthropic-messages');
  await protocolInput.fill('operator-custom-api');
  await page.getByText('没有匹配项；仍可使用输入的自定义协议标识。', { exact: true }).waitFor();
  await protocolInput.press('Escape');
  assert.equal(await protocolInput.inputValue(), 'operator-custom-api');
  await page.getByRole('button', { name: '选择 DSH 接口协议', exact: true }).click();
  assert.equal(await page.getByRole('option').count(), 3);
  await page.getByRole('option', { name: /Anthropic Messages/ }).click();
  await field(page, '填写密钥（可选）').locator('input[type="password"]').fill(fixtureProviderCredential);
  await page.locator('#provider-model-name-0').fill('Fixture Model Updated');
  const navigationPosts = requests.filter(request => request.method === 'POST' && request.pathname.startsWith('/api/chat/')).length;
  await page.getByRole('button', { name: '概览', exact: true }).first().click();
  await page.locator('[data-page="overview"]').waitFor();
  await navigate(page, '模型提供方', 'providers', '模型提供方');
  const restoredName = field(page, '提供方显示名称').locator('input');
  await restoredName.waitFor();
  assert.equal(await restoredName.inputValue(), 'Fixture Provider Updated');
  assert.equal(await field(page, '接口基础地址').locator('input').inputValue(), 'https://provider.invalid/v2');
  assert.equal(await page.locator('#provider-model-name-0').inputValue(), 'Fixture Model Updated');
  assert.equal(await field(page, '填写密钥（可选）').locator('input[type="password"]').inputValue(), '');
  assert.equal(requests.filter(request => request.method === 'POST' && request.pathname.startsWith('/api/chat/')).length, navigationPosts);
  await field(page, '填写密钥（可选）').locator('input[type="password"]').fill(fixtureProviderCredential);
  const before = await editor.evaluate(element => ({
    sectionHeight: element.getBoundingClientRect().height,
    cardHeight: element.querySelector('[data-bounded-card]')!.getBoundingClientRect().height,
  }));
  assert.equal(before.cardHeight, 384);
  for (let index = 0; index < 16; index += 1) {
    await page.getByRole('button', { name: '添加模型', exact: true }).click();
    await modelList.locator('input').nth((index + 2) * 2).fill(`fixture-additional-model-${index + 1}`);
    if (index < 15) await modelList.locator('input').nth((index + 2) * 2 + 1).fill(`Additional Model ${index + 1}`);
  }
  const modelBounds = await modelList.evaluate(element => {
    element.scrollTop = 96;
    return { clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop,
      overflowY: getComputedStyle(element).overflowY };
  });
  assert(modelBounds.scrollHeight > modelBounds.clientHeight && modelBounds.scrollTop > 0
    && ['auto', 'scroll'].includes(modelBounds.overflowY), 'Provider models do not scroll internally.');
  const after = await editor.evaluate(element => {
    const card = element.querySelector('[data-bounded-card]');
    const footer = element.querySelector('.panel-footer');
    assertElement(card);
    assertElement(footer);
    function assertElement(candidate: Element | null): asserts candidate is HTMLElement {
      if (!(candidate instanceof HTMLElement)) throw new Error('Provider card or independent footer missing.');
    }
    card.scrollTop = 96;
    return {
      sectionHeight: element.getBoundingClientRect().height,
      cardHeight: card.getBoundingClientRect().height,
      cardScrollTop: card.scrollTop,
      footerAfterCard: footer.getBoundingClientRect().top >= card.getBoundingClientRect().bottom - 1,
    };
  });
  assert(Math.abs(after.sectionHeight - before.sectionHeight) <= 2 && Math.abs(after.cardHeight - before.cardHeight) <= 2,
    `Adding provider models changed bounded geometry: ${JSON.stringify({ before, after })}.`);
  assert(after.cardScrollTop > 0 && after.footerAfterCard);
  await editor.locator('.panel-footer').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '保存提供方', exact: true }).click();
  await page.getByText('提供方目录已保存；未测试连通性，也未同步外部运行环境。', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-page="providers"] input[type="password"]').inputValue(), '');
  await assertStoredProviderKey(runtimeDirectory, 'fixture-provider', fixtureProviderCredential);
  const saved = await apiJson(page, '/api/chat/providers');
  assert.equal(saved.status, 200);
  assertProviderCredentialsRedacted(saved.value);
  assert(isRecord(saved.value) && Array.isArray(saved.value.providers));
  const provider: unknown = saved.value.providers.find(candidate => isRecord(candidate) && candidate.id === 'fixture-provider');
  assert(isRecord(provider));
  assert.equal(provider.name, 'Fixture Provider Updated');
  assert.equal(provider.baseUrl, 'https://provider.invalid/v2');
  assert.equal(provider.api, 'anthropic-messages');
  assert.equal(Object.hasOwn(provider, 'type'), false);
  assert.equal(provider.apiKeyConfigured, true);
  assert(Array.isArray(provider.models) && provider.models.length === 18);
  assert.deepEqual(provider.models[0], { id: 'fixture-model', name: 'Fixture Model Updated' });
  assert.deepEqual(provider.models[17], { id: 'fixture-additional-model-16', name: 'fixture-additional-model-16' });
  assert.equal((await page.locator('body').innerText()).includes(fixtureProviderCredential), false);
  assert.equal(await page.evaluate(value => `${JSON.stringify(localStorage)}${JSON.stringify(sessionStorage)}${document.cookie}${location.href}`.includes(value), fixtureProviderCredential), false);
  await field(page, '提供方显示名称').locator('input').fill('Fixture Provider Saved');
  await page.getByRole('button', { name: '保存提供方', exact: true }).click();
  await page.getByText('提供方目录已保存；未测试连通性，也未同步外部运行环境。', { exact: true }).waitFor();
  await assertStoredProviderKey(runtimeDirectory, 'fixture-provider', fixtureProviderCredential);
  await page.getByRole('switch', { name: '清除已保存密钥', exact: true }).click();
  await page.getByRole('button', { name: '保存提供方', exact: true }).click();
  await page.getByText('未保存密钥', { exact: true }).waitFor();
  await assertStoredProviderKey(runtimeDirectory, 'fixture-provider', '');
  const postsBeforeCancel = requests.filter(request => request.method === 'POST' && request.pathname === '/api/chat/providers').length;
  await page.getByRole('button', { name: '删除提供方', exact: true }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(requests.filter(request => request.method === 'POST' && request.pathname === '/api/chat/providers').length, postsBeforeCancel);
  const referenceRejected = page.waitForResponse(response => response.url().endsWith('/api/chat/providers') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '删除提供方', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  const rejected = await referenceRejected;
  assert.equal(rejected.status(), 409);
  assert.deepEqual(await rejected.json() as unknown, { error: 'provider_model_in_use' });
  await page.getByRole('alert').waitFor();
  await page.getByRole('button', { name: '重新载入目录', exact: true }).click();
  await section(page, 'Fixture Provider Saved').waitFor();
  const references = section(page, '模型使用者');
  await references.getByText('聊天方案：Existing Custom Daily Plan', { exact: true }).locator('xpath=ancestor::div[1]').getByRole('button', { name: '更换模型', exact: true }).click();
  const referenceEditor = page.getByLabel('修改模型引用', { exact: true });
  await field(referenceEditor, '更换到模型').locator('select').selectOption(JSON.stringify(['fixture-provider-v2', 'fixture-model-v2']));
  await field(referenceEditor, '新模型思考强度').locator('select').locator('option[value="medium"]').waitFor({ state: 'attached' });
  await field(referenceEditor, '新模型思考强度').locator('select').selectOption('medium');
  const referenceWrites = requests.filter(request => request.method === 'POST' && request.pathname === '/api/chat/plans').length;
  await navigate(page, '概览', 'overview', '工作台概览');
  assert.equal(await page.getByRole('dialog', { name: '还有未保存的更改', exact: true }).count(), 0);
  await navigate(page, '模型提供方', 'providers', '模型提供方');
  await referenceEditor.waitFor();
  assert.equal(await field(referenceEditor, '更换到模型').locator('select').inputValue(), JSON.stringify(['fixture-provider-v2', 'fixture-model-v2']));
  assert.equal(await field(referenceEditor, '新模型思考强度').locator('select').inputValue(), 'medium');
  assert.equal(await referenceEditor.getByRole('checkbox', { name: '确认单独保存这项引用更改', exact: true }).isChecked(), false);
  assert.equal(requests.filter(request => request.method === 'POST' && request.pathname === '/api/chat/plans').length, referenceWrites);
  await referenceEditor.getByRole('checkbox', { name: '确认单独保存这项引用更改', exact: true }).check();
  await referenceEditor.getByRole('button', { name: '保存引用更改', exact: true }).click();
  await references.getByText('引用更改已保存。可读取核对后，再明确删除或调整提供方；运行中的聊天需另行应用。', { exact: true }).waitFor();
  const updatedReferences = await apiJson(page, '/api/chat/plans');
  assert(isRecord(updatedReferences.value) && Array.isArray(updatedReferences.value.plans));
  const updatedDailyPlan = updatedReferences.value.plans.find(plan => isRecord(plan) && plan.id === 'daily-chat');
  assert(isRecord(updatedDailyPlan));
  assert.equal(updatedDailyPlan.provider, 'fixture-provider-v2');
  const assistant = await apiJson(page, '/api/chat/assistant');
  assert(isRecord(assistant.value) && isRecord(assistant.value.configuration));
  await apiJson(page, '/api/chat/assistant', { method: 'POST', body: { revision: assistant.value.revision,
    configuration: { ...assistant.value.configuration, provider: 'fixture-provider', model: 'fixture-model' } } });
  await references.getByRole('button', { name: '重新读取引用', exact: true }).click();
  await references.getByText('独立助手（保留的模型选择）', { exact: true }).waitFor();
  await references.getByRole('button', { name: '更换模型或解除引用', exact: true }).click();
  await referenceEditor.getByRole('checkbox', { name: '停用独立助手并清除其模型引用', exact: true }).check();
  await referenceEditor.getByRole('checkbox', { name: '确认单独保存这项引用更改', exact: true }).check();
  await referenceEditor.getByRole('button', { name: '保存引用更改', exact: true }).click();
  await references.getByText('独立助手（保留的模型选择）', { exact: true }).waitFor({ state: 'hidden' });
  const clearedAssistant = await apiJson(page, '/api/chat/assistant');
  assert(isRecord(clearedAssistant.value) && isRecord(clearedAssistant.value.configuration));
  assert.equal(clearedAssistant.value.configuration.provider, null);
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
      routes: [...nativeRoutes.filter(route => !route.pathname.startsWith('/api/chat/reminders') && !route.pathname.startsWith('/api/chat/tool-permissions') && !route.pathname.startsWith('/api/chat/memory')), ...reminderRoutes, ...toolPermissionRoutes, ...memoryRoutes, ...maintenance.routes, ...authorizationRoutes, ...accounts.routes].map(route => route.method === 'GET' && route.pathname === '/api/chat/model-capabilities'
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
      pageId: 'persona', pageLabel: '人设与形象', builtinLabel: '使用内置小鲸鱼', nameLabel: '显示名称',
      originalName: 'Fixture Persona', originalId: 'fixture-persona', filename: 'chat-personas.json',
    });
    await exerciseBuiltinDraft(page, runtimeDirectory, requests, {
      pageId: 'model', pageLabel: '聊天方案', builtinLabel: '使用内置日常方案', nameLabel: '方案名称',
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

    await exerciseProviderEditor(page, runtimeDirectory, requests);

    await navigate(page, '聊天方案', 'model', '聊天方案');
    await section(page, 'Fixture Plan').waitFor();
    await page.getByText('保存并选择启用方案后，在本页应用到 DSH。', { exact: true }).waitFor();
    await page.getByText('聊天暂不可用', { exact: true }).waitFor();
    const planName = field(page, '方案名称').locator('input');
    const providerSelect = field(page, '模型提供方').locator('select');
    const modelSelect = field(page, '模型').locator('select');
    assert.equal(await providerSelect.inputValue(), 'fixture-provider');
    assert.equal(await modelSelect.inputValue(), 'fixture-model');
    assert.equal(await providerSelect.locator('option:checked').textContent(), 'Fixture Provider Saved');
    assert.equal(await modelSelect.locator('option:checked').textContent(), 'Fixture Model Updated');
    assert.equal(await field(page, '群聊上下文').locator('input').inputValue(), '128000');
    assert.equal(await field(page, '私聊上下文').locator('input').inputValue(), '128000');
    await providerSelect.selectOption('fixture-provider-v2');
    assert.equal(await modelSelect.locator('option[value="fixture-model"]').count(), 0);
    await modelSelect.selectOption('fixture-model-v2');
    const reasoningSelect = field(page, '思考强度').locator('select');
    await reasoningSelect.locator('option[value="medium"]').waitFor({ state: 'attached' });
    await reasoningSelect.selectOption('medium');
    await field(page, '群聊上下文').locator('input[type="number"]').fill('172000');
    await field(page, '私聊上下文').locator('input[type="number"]').fill('384000');
    await planName.fill('Fixture Plan Updated');
    const plansBeforeInline = requests.filter(request => request.method === 'POST' && request.pathname === '/api/chat/plans').length;
    await page.getByRole('button', { name: '就地选择或添加模型', exact: true }).click();
    const inline = page.getByRole('dialog', { name: '就地选择或添加模型', exact: true });
    await inline.getByRole('button', { name: '添加模型', exact: true }).click();
    await inline.locator('#provider-model-id-1').fill('browser-inline-model');
    await inline.locator('#provider-model-name-1').fill('Browser Inline Model');
    await inline.getByRole('button', { name: '保存提供方', exact: true }).click();
    await inline.getByText('提供方目录已保存；未测试连通性，也未同步外部运行环境。', { exact: true }).waitFor();
    await inline.getByRole('button', { name: '在聊天方案中使用此模型', exact: true }).last().click();
    await inline.waitFor({ state: 'hidden' });
    assert.equal(await planName.inputValue(), 'Fixture Plan Updated');
    assert.equal(await modelSelect.inputValue(), 'browser-inline-model');
    assert.equal(requests.filter(request => request.method === 'POST' && request.pathname === '/api/chat/plans').length, plansBeforeInline);
    await modelSelect.selectOption('fixture-model-v2');
    const planPostsBeforeInvalidContext = requests.filter(request => request.method === 'POST' && request.pathname === '/api/chat/plans').length;
    await field(page, '群聊上下文').locator('input[type="number"]').fill('0');
    await page.getByRole('button', { name: '保存聊天方案', exact: true }).click();
    await page.getByRole('alert').getByText('群聊和私聊上下文分别填写 1–16,777,216 之间的整数，单位为 token。', { exact: true }).waitFor();
    assert.equal(requests.filter(request => request.method === 'POST' && request.pathname === '/api/chat/plans').length, planPostsBeforeInvalidContext);
    await field(page, '群聊上下文').locator('input[type="number"]').fill('172000');
    await assertBoundedLongText(
      section(page, 'Fixture Plan Updated'),
      field(page, '方案指令').locator('textarea'),
      Array.from({ length: 120 }, (_, index) => `Plan instruction ${index + 1}: remain within the native plan boundary.`).join('\n'),
    );
    await page.getByRole('button', { name: '保存聊天方案', exact: true }).click();
    await section(page, 'Fixture Plan Updated').getByText('已保存。', { exact: true }).waitFor();

    const planResponse = await apiJson(page, '/api/chat/plans');
    assert.equal(planResponse.status, 200);
    assert(isRecord(planResponse.value) && typeof planResponse.value.revision === 'string');
    assert(Array.isArray(planResponse.value.plans) && isRecord(planResponse.value.plans[0]));
    assert.equal(planResponse.value.plans[0].provider, 'fixture-provider-v2');
    assert.equal(planResponse.value.plans[0].model, 'fixture-model-v2');
    assert.deepEqual(planResponse.value.plans[0].contextLimits, { group: 172000, private: 384000 });
    await page.getByRole('button', { name: '刷新状态', exact: true }).click();
    await page.getByRole('button', { name: '刷新状态', exact: true }).waitFor();
    assert.equal(await providerSelect.inputValue(), 'fixture-provider-v2');
    assert.equal(await modelSelect.inputValue(), 'fixture-model-v2');
    assert.equal(await field(page, '群聊上下文').locator('input').inputValue(), '172000');
    assert.equal(await field(page, '私聊上下文').locator('input').inputValue(), '384000');
    const missingBinding = await apiJson(page, '/api/chat/plans', {
      method: 'POST',
      body: {
        revision: planResponse.value.revision,
        activePlanId: planResponse.value.activePlanId,
        plans: planResponse.value.plans.map(plan => {
          assert(isRecord(plan));
          return { ...plan, provider: 'missing-provider', model: 'missing-model' };
        }),
      },
    });
    assert.deepEqual(missingBinding, { status: 409, value: { error: 'provider_model_missing_or_disabled' } });
    const legacyActivation = await apiJson(page, '/api/chat/plans', {
      method: 'POST',
      body: { revision: planResponse.value.revision, activePlanId: 'legacy-plan', plans: planResponse.value.plans },
    });
    assert.deepEqual(legacyActivation, { status: 409, value: { error: 'provider_model_missing_or_disabled' } });
    assert.equal(planResponse.value.plans.some(plan => isRecord(plan) && plan.id === 'legacy-plan'
      && plan.provider === 'legacy-provider' && plan.model === 'legacy-model'), true);
    const modelBefore = await apiJson(page, '/api/chat/model');
    assert.equal(modelBefore.status, 200);
    assert(isRecord(modelBefore.value) && typeof modelBefore.value.revision === 'string');
    const missingModelBinding = await apiJson(page, '/api/chat/model', {
      method: 'POST',
      body: { revision: modelBefore.value.revision, provider: 'missing-provider', model: 'missing-model', reasoningEffort: 'high' },
    });
    assert.deepEqual(missingModelBinding, { status: 409, value: { error: 'provider_model_missing_or_disabled' } });
    const modelSaved = await apiJson(page, '/api/chat/model', {
      method: 'POST',
      body: { revision: modelBefore.value.revision, provider: 'fixture-provider-v2', model: 'fixture-model-v2', reasoningEffort: 'high' },
    });
    assert.equal(modelSaved.status, 200);
    assert.deepEqual(isRecord(modelSaved.value) ? {
      activePlanId: modelSaved.value.activePlanId,
      provider: modelSaved.value.provider,
      model: modelSaved.value.model,
      reasoningEffort: modelSaved.value.reasoningEffort,
    } : null, {
      activePlanId: 'fixture-plan', provider: 'fixture-provider-v2', model: 'fixture-model-v2', reasoningEffort: 'high',
    });
    const staleModel = await apiJson(page, '/api/chat/model', {
      method: 'POST',
      body: { revision: modelBefore.value.revision, provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'low' },
    });
    assert.equal(staleModel.status, 409);
    assert.deepEqual(staleModel.value, { error: 'chat_revision_conflict' });

    await navigate(page, '人设与形象', 'persona', '人设与形象');
    await page.getByText(xssText, { exact: true }).waitFor();
    const style = field(page, '表达风格').locator('textarea');
    const personaStyle = Array.from({ length: 120 }, (_, index) => `Style rule ${index + 1}: warm, direct, and bounded.`).join('\n');
    await assertBoundedLongText(section(page, 'Fixture Persona'), style, personaStyle);
    await page.getByRole('button', { name: '保存人设', exact: true }).click();
    await page.getByText('人设库已保存。', { exact: true }).waitFor();
    const appearance = page.locator('#native-appearance');
    await appearance.getByText('上传参考图或新版本', { exact: true }).click();
    await appearance.getByRole('textbox', { name: '参考图名称', exact: true }).fill('Browser Role Reference');
    await appearance.getByRole('textbox', { name: '参考图说明', exact: true }).fill('Synthetic browser reference image');
    const fixtureImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHd8AAAAASUVORK5CYII=', 'base64');
    await appearance.getByLabel('参考图片文件', { exact: true }).setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: fixtureImage });
    await appearance.getByText('已选择：reference.png', { exact: true }).waitFor();
    const appearanceWrites = requests.filter(request => request.method === 'POST' && request.pathname === '/api/chat/appearance').length;
    await navigate(page, '概览', 'overview', '工作台概览');
    await navigate(page, '人设与形象', 'persona', '人设与形象');
    await appearance.getByText('上传参考图或新版本', { exact: true }).click();
    assert.equal(await appearance.getByRole('textbox', { name: '参考图名称', exact: true }).inputValue(), 'Browser Role Reference');
    await appearance.getByText('已选择：reference.png', { exact: true }).waitFor();
    assert.equal(requests.filter(request => request.method === 'POST' && request.pathname === '/api/chat/appearance').length, appearanceWrites);
    await appearance.getByRole('checkbox', { name: '确认保存参考图，不更改人设绑定', exact: true }).check();
    await appearance.getByRole('button', { name: '保存参考图版本', exact: true }).click();
    await appearance.getByText('参考图版本已保存；人设绑定保持原样。', { exact: true }).waitFor();
    await appearance.getByRole('img', { name: '角色参考图预览：Browser Role Reference，版本 1', exact: true }).waitFor();
    await page.waitForFunction(() => { const image = document.querySelector('#native-appearance img'); return image instanceof HTMLImageElement && image.complete && image.naturalWidth === 1; });
    const appearanceSaved = await apiJson(page, '/api/chat/appearance'); assert(isRecord(appearanceSaved.value) && Array.isArray(appearanceSaved.value.assets));
    assert.equal(appearanceSaved.value.bindings instanceof Array && appearanceSaved.value.bindings.length, 0);
    await appearance.getByRole('checkbox', { name: '确认将这版参考图用于当前人设', exact: true }).check();
    await appearance.getByRole('button', { name: '绑定当前人设', exact: true }).click();
    await appearance.getByText('当前绑定：Browser Role Reference · 版本 1', { exact: true }).waitFor();
    await appearance.getByText('删除参考素材', { exact: true }).click();
    assert.equal(await appearance.getByRole('button', { name: '删除参考素材及版本', exact: true }).isDisabled(), true);
    await appearance.getByLabel('参考图片文件', { exact: true }).setInputFiles({ name: 'reference-v2.png', mimeType: 'image/png', buffer: fixtureImage });
    await appearance.getByText('已选择：reference-v2.png', { exact: true }).waitFor();
    await appearance.getByRole('textbox', { name: '参考图名称', exact: true }).fill('Browser Role Reference');
    await appearance.getByRole('checkbox', { name: '保存为选中素材的新版本', exact: true }).check();
    await appearance.getByRole('checkbox', { name: '确认保存参考图，不更改人设绑定', exact: true }).check();
    await appearance.getByRole('button', { name: '保存参考图版本', exact: true }).click();
    await appearance.getByRole('img', { name: '角色参考图预览：Browser Role Reference，版本 2', exact: true }).waitFor();
    await appearance.getByText('当前绑定：Browser Role Reference · 版本 1', { exact: true }).waitFor();
    await appearance.getByRole('combobox', { name: '参考素材与版本', exact: true }).selectOption({ label: 'Browser Role Reference · 版本 1' });
    await appearance.getByRole('img', { name: '角色参考图预览：Browser Role Reference，版本 1', exact: true }).waitFor();
    await appearance.getByText('解除当前人设参考图', { exact: true }).click();
    await appearance.getByRole('checkbox', { name: '确认解除当前人设参考图绑定', exact: true }).check();
    await appearance.getByRole('button', { name: '解除参考图绑定', exact: true }).click();
    await appearance.getByText('人设参考图绑定已解除。', { exact: true }).waitFor();
    const removeAppearance = appearance.getByText('删除参考素材', { exact: true }).locator('xpath=ancestor::details[1]');
    if (await removeAppearance.getAttribute('open') === null) await removeAppearance.locator('summary').click();
    await appearance.getByRole('checkbox', { name: '确认删除未被人设使用的素材及全部版本', exact: true }).check();
    await appearance.getByRole('button', { name: '删除参考素材及版本', exact: true }).click();
    await appearance.getByText('未被引用的素材及版本已删除。', { exact: true }).waitFor();


    await navigate(page, '访问范围', 'access', '访问范围');
    await page.getByText('当前默认全部拒绝。', { exact: true }).waitFor();
    const allow = field(page, '群聊白名单').locator('textarea');
    const privateAllow = field(page, '私聊白名单').locator('textarea');
    await page.getByText('拒绝名单（可选）', { exact: true }).click();
    const deny = field(page, '群聊拒绝名单').locator('textarea');
    const owner = field(page, '主人账号').locator('input');
    await allow.fill('456001');
    await privateAllow.fill('123001');
    await deny.fill('999001');
    await owner.fill('123001');
    const accessPostsBeforeInvalid = requests.filter(request => request.method === 'POST' && request.pathname === '/api/chat/access').length;
    await allow.fill('456001, 456001');
    await page.getByRole('button', { name: '保存名单', exact: true }).click();
    await page.getByRole('alert').getByText('同一份名单中不能重复填写群号。', { exact: true }).waitFor();
    assert.equal(requests.filter(request => request.method === 'POST' && request.pathname === '/api/chat/access').length, accessPostsBeforeInvalid);
    await allow.fill('456001, 456002');
    await privateAllow.fill('123001，123002');
    await field(page, '私聊拒绝名单').locator('textarea').fill('999002');
    await page.getByRole('button', { name: '保存名单', exact: true }).click();
    await page.getByText('聊天名单已保存。', { exact: true }).waitFor();
    const authorizationBeforeToolGrant = await apiJson(page, '/api/chat/authorization');
    const toolPermissions = page.locator('#native-tool-permissions');
    await field(toolPermissions, '授权 QQ 会话').locator('input').fill('group:456001');
    await toolPermissions.getByRole('checkbox', { name: '查看媒体状态', exact: true }).check();
    await field(toolPermissions, '查看媒体状态最多调用次数').locator('input').fill('3');
    await toolPermissions.getByRole('checkbox', { name: '确认独立授予以上会话、能力、次数和期限', exact: true }).check();
    await toolPermissions.getByRole('button', { name: '创建工具授权', exact: true }).click();
    await toolPermissions.getByText('授权配置已保存，当前运行权限尚未确认应用。', { exact: true }).waitFor();
    const permissionsSaved = await apiJson(page, '/api/chat/tool-permissions');
    assert(isRecord(permissionsSaved.value) && Array.isArray(permissionsSaved.value.grants));
    assert.equal(permissionsSaved.value.grants.length, 1);
    assert.deepEqual(await apiJson(page, '/api/chat/authorization'), authorizationBeforeToolGrant);
    await toolPermissions.getByRole('button', { name: '撤销此授权', exact: true }).click();
    await toolPermissions.getByRole('button', { name: '确认撤销工具授权', exact: true }).click();
    await toolPermissions.getByText('group:456001 · 已撤销', { exact: true }).waitFor();
    const permissionsRevoked = await apiJson(page, '/api/chat/tool-permissions');
    assert(isRecord(permissionsRevoked.value) && Array.isArray(permissionsRevoked.value.grants) && isRecord(permissionsRevoked.value.grants[0]));
    assert.equal(typeof permissionsRevoked.value.grants[0].revokedAt, 'number');

    const adaptersBefore = await apiJson(page, '/api/chat/adapters');
    assert.equal(adaptersBefore.status, 200);
    assert(isRecord(adaptersBefore.value) && typeof adaptersBefore.value.revision === 'string');
    assertAdapterCredentialsRedacted(adaptersBefore.value);
    assert(isRecord(adaptersBefore.value.adapters) && isRecord(adaptersBefore.value.adapters.onebotWs));
    assert.deepEqual(Object.keys(adaptersBefore.value.adapters).sort(), ['dshAgent', 'onebotHttp', 'onebotWebhook', 'onebotWs']);
    assert.equal(adaptersBefore.value.adapters.onebotWs.enabled, false);
    assert(isRecord(adaptersBefore.value.status));
    assert.equal(adaptersBefore.value.status.assembled, false);
    assert.equal(adaptersBefore.value.status.running, false);
    assert.equal(adaptersBefore.value.status.applyAvailable, false);
    if (isRecord(adaptersBefore.value.connection)) assert.equal(adaptersBefore.value.connection.chatReady, false);
    for (const [pathname, body] of [
      ['/api/chat/adapters/connect', { revision: adaptersBefore.value.revision }],
      ['/api/chat/adapters/disconnect', {}],
    ] as const) {
      const unavailableControl = await apiJson(page, pathname, { method: 'POST', body });
      assert.deepEqual(unavailableControl, { status: 503, value: { error: 'adapter_runtime_unavailable' } });
    }
    assert.deepEqual(await apiJson(page, '/api/chat/adapters'), adaptersBefore);
    const initialAdapterRevision = adaptersBefore.value.revision;
    const adapterEndpoint = 'http://127.0.0.1:3000';
    const adaptersSaved = await apiJson(page, '/api/chat/adapters', {
      method: 'POST',
      body: {
        revision: initialAdapterRevision,
        adapters: { onebotHttp: { enabled: true, endpoint: adapterEndpoint, secret: fixtureAdapterCredential } },
      },
    });
    assert.equal(adaptersSaved.status, 200);
    assert(isRecord(adaptersSaved.value) && typeof adaptersSaved.value.revision === 'string');
    assertAdapterCredentialsRedacted(adaptersSaved.value);
    const savedAdapters = adaptersSaved.value.adapters;
    assert(isRecord(savedAdapters) && isRecord(savedAdapters.onebotHttp));
    assert(isRecord(savedAdapters.onebotWs) && savedAdapters.onebotWs.enabled === false);
    assert.deepEqual(savedAdapters.onebotHttp, {
      enabled: true,
      endpoint: adapterEndpoint,
      secretConfigured: true,
    });
    const adaptersAfterReplace = await readJson(join(runtimeDirectory, 'chat-adapters.json'));
    assert(isRecord(adaptersAfterReplace.adapters) && isRecord(adaptersAfterReplace.adapters.onebotHttp));
    assert(adaptersAfterReplace.adapters.onebotHttp.secret === fixtureAdapterCredential,
      'Replacing an adapter credential did not persist the submitted fixture value.');

    await navigate(page, '连接', 'adapters', '连接');
    await section(page, '聊天运行').waitFor();
    await page.getByText('协议连接管理', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-page="adapters"] [data-bounded-card]').count(), 5);
    for (const [id, title] of [
      ['chat-runtime', '聊天运行'],
      ['adapter-onebotHttp', 'OneBot'], ['adapter-dshAgent', 'DSH 聊天引擎'],
      ['native-runtime-compatibility', '保留会话兼容性 / 原配置核对']
    ]) {
      const card = page.locator(`[data-page="adapters"] section[id="${id}"]`);
      assert.equal(await card.count(), 1);
      await card.getByRole('heading', { name: title, exact: true }).waitFor();
      assert.equal(await card.locator('[data-bounded-card]').count(), 1);
    }
    assert.equal(await page.getByRole('heading', { name: '图片服务', exact: true }).count(), 0);
    assert.equal(await page.getByRole('switch', { name: '启用此连接', exact: true, includeHidden: true }).count(), 2);
    assert.equal(await page.getByRole('switch', { name: '收取 OneBot 上报', exact: true, includeHidden: true }).getAttribute('aria-checked'), 'false');
    assert.equal(await page.locator('#adapter-webhook-self-id').count(), 0);
    assert.equal(await page.getByPlaceholder('机器人 QQ 号', { exact: true }).count(), 0);
    assert.equal(await page.locator('#adapter-webhook-host, #adapter-webhook-port, #adapter-webhook-hmac-action').count(), 0);
    await page.getByText('协议端 API 密钥（可选）', { exact: true }).waitFor();
    await page.getByText('复制协议端 HTTP 服务设置中的 accessToken。不是本管理后台的管理员令牌或登录会话；协议端未启用认证时可不填。', { exact: true }).waitFor();
    assert.equal(await page.locator('#adapter-onebotHttp-credential-action').inputValue(), 'keep');
    assert.equal(await page.locator('#adapter-onebotHttp-credential-value').count(), 0);
    assert.equal((await page.locator('body').innerText()).includes(fixtureAdapterCredential), false);
    await section(page, '聊天运行').getByText('运行状态待确认', { exact: true }).waitFor();
    await section(page, '聊天运行').getByText(/管理服务启动时，以及聊天停止状态下保存参数后，会自动尝试连接已启用的 WebSocket/).waitFor();
    const chatControls = section(page, '聊天运行');
    await chatControls.getByText('确认设置已应用后再启动聊天。WebSocket 可自动连接；聊天模型仍需单独启停。', { exact: true }).waitFor();
    await chatControls.getByText('不会自动启动，也不会清空会话。', { exact: true }).waitFor();
    assert.equal(await chatControls.getByRole('button', { name: '启动聊天', exact: true }).isDisabled(), true);
    assert.equal(await chatControls.getByRole('button', { name: '停止聊天', exact: true }).count(), 0);
    assert.equal(requests.filter(request => request.method === 'POST'
      && /^\/api\/chat\/runtime\/(?:start|stop)$/.test(request.pathname)).length, 0);
    for (const label of ['重试连接 WebSocket', '断开 WebSocket']) {
      assert.equal(await page.getByRole('button', { name: label, exact: true }).isDisabled(), true);
    }
    const websocketToggle = page.getByRole('switch', { name: '启用 WebSocket 收消息', exact: true });
    assert.equal(await websocketToggle.getAttribute('aria-checked'), 'false');
    assert.equal(await page.locator('#adapter-onebotWs-endpoint').count(), 0);
    const advancedReception = page.locator('details').filter({ has: page.getByText('其他接收方式（高级）', { exact: true }) });
    assert.equal(await advancedReception.evaluate(element => element instanceof HTMLDetailsElement && element.open), false);
    const adapterPostsBeforeDraft = requests.filter(request => request.method === 'POST' && request.pathname.startsWith('/api/chat/adapters')).length;
    const adaptersBeforeDraft = await readFile(join(runtimeDirectory, 'chat-adapters.json'), 'utf8');
    await websocketToggle.click();
    await page.locator('#adapter-onebotWs-endpoint').fill('ws://127.0.0.1:3001');
    await page.locator('#adapter-onebotWs-credential-action').selectOption('replace');
    await page.locator('#adapter-onebotWs-credential-value').fill(fixtureWebSocketCredential);
    await websocketToggle.click();
    assert.equal(await page.locator('#adapter-onebotWs-endpoint').inputValue(), 'ws://127.0.0.1:3001');
    assert.equal(await page.locator('#adapter-onebotWs-credential-value').inputValue(), fixtureWebSocketCredential);
    assert.equal(await page.getByRole('button', { name: '重试连接 WebSocket', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '撤销更改', exact: true }).click();
    assert.equal(await page.locator('#adapter-onebotWs-endpoint, #adapter-onebotWs-credential-value').count(), 0);
    assert.equal(await readFile(join(runtimeDirectory, 'chat-adapters.json'), 'utf8'), adaptersBeforeDraft);
    assert.equal(requests.filter(request => request.method === 'POST' && request.pathname.startsWith('/api/chat/adapters')).length, adapterPostsBeforeDraft);

    const adaptersKept = await apiJson(page, '/api/chat/adapters', {
      method: 'POST',
      body: {
        revision: adaptersSaved.value.revision,
        adapters: { onebotHttp: { enabled: true, endpoint: adapterEndpoint, secret: '' } },
      },
    });
    assert.equal(adaptersKept.status, 200);
    assert(isRecord(adaptersKept.value) && typeof adaptersKept.value.revision === 'string');
    assertAdapterCredentialsRedacted(adaptersKept.value);
    const adaptersAfterKeep = await readJson(join(runtimeDirectory, 'chat-adapters.json'));
    assert(isRecord(adaptersAfterKeep.adapters) && isRecord(adaptersAfterKeep.adapters.onebotHttp));
    assert(adaptersAfterKeep.adapters.onebotHttp.secret === fixtureAdapterCredential,
      'An empty adapter credential did not preserve the saved fixture value.');

    const adaptersCleared = await apiJson(page, '/api/chat/adapters', {
      method: 'POST',
      body: {
        revision: adaptersKept.value.revision,
        adapters: { onebotHttp: { enabled: true, endpoint: adapterEndpoint, clearSecret: true } },
      },
    });
    assert.equal(adaptersCleared.status, 200);
    assert(isRecord(adaptersCleared.value) && typeof adaptersCleared.value.revision === 'string');
    assertAdapterCredentialsRedacted(adaptersCleared.value);
    const clearedAdapters = adaptersCleared.value.adapters;
    assert(isRecord(clearedAdapters) && isRecord(clearedAdapters.onebotHttp));
    assert.equal(clearedAdapters.onebotHttp.secretConfigured, false);
    const adaptersAfterClear = await readJson(join(runtimeDirectory, 'chat-adapters.json'));
    assert(isRecord(adaptersAfterClear.adapters) && isRecord(adaptersAfterClear.adapters.onebotHttp));
    assert(adaptersAfterClear.adapters.onebotHttp.secret === '', 'Clearing an adapter credential did not remove it.');

    const staleAdapters = await apiJson(page, '/api/chat/adapters', {
      method: 'POST',
      body: {
        revision: initialAdapterRevision,
        adapters: { onebotHttp: { enabled: false, endpoint: adapterEndpoint } },
      },
    });
    assert.equal(staleAdapters.status, 409);
    assert.deepEqual(staleAdapters.value, { error: 'chat_revision_conflict' });
    await page.getByRole('button', { name: '重新读取', exact: true }).first().click();
    await page.getByText('尚未设置', { exact: true }).first().waitFor();
    assert.equal(await page.locator('#adapter-onebotHttp-credential-value').count(), 0);

    await navigate(page, '功能与触发', 'features', '功能与触发');
    const triggers = page.locator('#chat-input');
    await field(triggers, '呼叫昵称').locator('textarea').fill('Browser Whale');
    await field(triggers, '同人续聊期限').locator('input').fill('12');
    const triggerPostsBeforeNavigation = requests.filter(request => request.method === 'POST' && request.pathname === '/api/chat/packages/configuration').length;
    await navigate(page, '安全', 'security', '安全');
    await navigate(page, '功能与触发', 'features', '功能与触发');
    assert.equal(await field(triggers, '呼叫昵称').locator('textarea').inputValue(), 'Browser Whale');
    assert.equal(requests.filter(request => request.method === 'POST' && request.pathname === '/api/chat/packages/configuration').length, triggerPostsBeforeNavigation);
    await triggers.getByRole('button', { name: '保存触发配置', exact: true }).click();
    await triggers.getByText('触发配置已保存，后续消息按当前配置处理；已受理任务不会重放。', { exact: true }).waitFor();
    const triggerConfiguration = await apiJson(page, '/api/chat/packages/configuration?id=chat-input');
    assert(isRecord(triggerConfiguration.value) && isRecord(triggerConfiguration.value.configuration));
    assert.deepEqual(triggerConfiguration.value.configuration.nicknames, ['Browser Whale']);
    assert.equal(triggerConfiguration.value.configuration.continuationMs, 12_000);
    const reminderCard = page.locator('#native-reminders');
    await reminderCard.getByText('还没有提醒规则，填写后明确创建；新草稿默认停用。', { exact: true }).waitFor();
    assert.equal(await reminderCard.getByRole('switch', { name: '保存后启用提醒', exact: true }).getAttribute('aria-checked'), 'false');
    await field(reminderCard, '目标 QQ 会话').locator('input').fill('group:456001');
    await field(reminderCard, '提醒正文').locator('textarea').fill('Browser reminder draft');
    await field(reminderCard, '提醒时区').locator('input').fill('Asia/Shanghai');
    await field(reminderCard, '延迟分钟数').locator('input').fill('1');
    const reminderPostsBeforeNavigation = requests.filter(request => request.method === 'POST' && request.pathname === '/api/chat/reminders').length;
    await navigate(page, '安全', 'security', '安全');
    await navigate(page, '功能与触发', 'features', '功能与触发');
    assert.equal(await field(reminderCard, '提醒正文').locator('textarea').inputValue(), 'Browser reminder draft');
    assert.equal(requests.filter(request => request.method === 'POST' && request.pathname === '/api/chat/reminders').length, reminderPostsBeforeNavigation);
    await reminderCard.getByRole('checkbox', { name: /我已核对目标会话、时间和正文/ }).check();
    await reminderCard.getByRole('button', { name: '创建停用提醒', exact: true }).click();
    await reminderCard.getByText('提醒设置已保存。', { exact: true }).waitFor();
    assert.equal(reminderService.list({}).rules[0]?.configuration.enabled, false);
    await field(reminderCard, '提醒正文').locator('textarea').fill('Browser reminder corrected');
    await reminderCard.getByRole('checkbox', { name: /我已核对目标会话、时间和正文/ }).check();
    await reminderCard.getByRole('button', { name: '保存提醒设置', exact: true }).click();
    await reminderCard.getByText('提醒设置已保存。', { exact: true }).waitFor();
    assert.equal(reminderService.list({}).rules[0]?.configuration.text, 'Browser reminder corrected');
    await reminderCard.getByRole('button', { name: '启用此提醒', exact: true }).click();
    await reminderCard.getByText('提醒已保存并启用，后续按实际权限与发送状态执行。', { exact: true }).waitFor();
    reminderNow += 60_001;
    await reminderService.tick();
    assert.equal(reminderSends, 1);
    await reminderCard.getByRole('button', { name: '重新读取规则', exact: true }).click();
    await reminderCard.getByRole('button', { name: '读取执行历史', exact: true }).click();
    await reminderCard.getByText(/已确认发送/).first().waitFor();
    await reminderCard.getByText('取消此规则', { exact: true }).click();
    await reminderCard.getByRole('checkbox', { name: /^确认取消规则/ }).check();
    await reminderCard.getByRole('button', { name: '确认取消提醒', exact: true }).click();
    await reminderCard.getByText('规则已取消，已有历史结果保留。', { exact: true }).waitFor();
    await reminderService.tick();
    assert.equal(reminderSends, 1);
    assert.equal(reminderService.history({}).history.length, 1);
    await page.getByText('记忆与偏好管理', { exact: true }).click();
    const memoryCard = page.locator('#native-memory');
    await memoryCard.getByText('Browser proposed preference', { exact: true }).waitFor();
    await memoryCard.getByRole('button', { name: '查看来源或纠正', exact: true }).click();
    assert.equal(await memoryCard.getByRole('button', { name: /确认.*(?:记忆|提议|建议)/ }).count(), 0);
    await field(memoryCard, '记忆正文').locator('textarea').fill('Browser corrected proposal');
    await memoryCard.getByRole('button', { name: '保存更正（仍待QQ确认）', exact: true }).click();
    await memoryCard.getByText('更正已保存；这条提议仍需主人在所属 QQ 会话确认。', { exact: true }).waitFor();
    assert.equal(memoryService.read(memoryProposal.id).status, 'proposed');
    assert.equal(memoryService.read(memoryProposal.id).confirmedBy, null);
    await memoryCard.getByRole('button', { name: '新增手工记忆', exact: true }).click();
    await field(memoryCard, '记忆来源会话').locator('input').fill('group:456001');
    await field(memoryCard, '记忆正文').locator('textarea').fill('Browser manual scoped memory');
    await field(memoryCard, '记忆标签').locator('textarea').fill('browser');
    await memoryCard.getByRole('button', { name: '保存手工记忆', exact: true }).click();
    await memoryCard.getByText('手工记忆更改已保存，按范围与有效期用于后续上下文，不扩大权限。', { exact: true }).waitFor();
    const manualMemory = memoryService.list({}).entries.find(entry => entry.content === 'Browser manual scoped memory'); assert(manualMemory);
    assert.equal(manualMemory.status, 'confirmed'); assert.deepEqual(manualMemory.scope, { kind: 'group', conversationId: 'group:456001' });
    await field(memoryCard, '记忆正文').locator('textarea').fill('Browser corrected manual memory');
    await memoryCard.getByRole('button', { name: '保存记忆纠正', exact: true }).click();
    await memoryCard.getByText('手工记忆更改已保存，按范围与有效期用于后续上下文，不扩大权限。', { exact: true }).waitFor();
    assert.equal(memoryService.read(manualMemory.id).content, 'Browser corrected manual memory');
    await memoryCard.getByText('来源与修改记录', { exact: true }).click();
    await memoryCard.getByText('采用依据：主人手工记录', { exact: true }).waitFor();
    await memoryCard.getByText('撤销此条记忆', { exact: true }).click();
    await memoryCard.getByRole('checkbox', { name: '确认撤销此条内容，不再用于后续上下文', exact: true }).check();
    await memoryCard.getByRole('button', { name: '撤销记忆', exact: true }).click();
    await memoryCard.getByText('记忆已撤销，后续上下文不再采用。', { exact: true }).waitFor();
    assert.equal(memoryService.read(manualMemory.id).status, 'revoked');
    assert.deepEqual(await memoryService.query({ conversationId: 'group:456001', userId: '123001' }, new AbortController().signal), []);
    const outputCard = page.locator('#package-configuration-chat-output');
    await outputCard.getByRole('switch', { name: '长文合并转发', exact: true }).click();
    await outputCard.getByRole('spinbutton', { name: '长文字符阈值', exact: true }).fill('4000');
    const outputAuth = await apiJson(page, '/api/chat/authorization');
    const packageWrites = requests.filter(request => request.method === 'POST' && request.pathname.startsWith('/api/chat/packages/configuration')).length;
    await navigate(page, '概览', 'overview', '工作台概览');
    await navigate(page, '功能与触发', 'features', '功能与触发');
    assert.equal(await outputCard.getByRole('switch', { name: '长文合并转发', exact: true }).isChecked(), true);
    assert.equal(await outputCard.getByRole('spinbutton', { name: '长文字符阈值', exact: true }).inputValue(), '4000');
    assert.equal(requests.filter(request => request.method === 'POST' && request.pathname.startsWith('/api/chat/packages/configuration')).length, packageWrites);
    await outputCard.getByRole('checkbox', { name: '确认保存这项功能配置，不增加访问权限', exact: true }).check();
    await outputCard.getByRole('button', { name: '保存功能配置', exact: true }).click();
    await outputCard.getByText('功能配置已保存，后续处理按已保存值读取；不会创建授权。', { exact: true }).waitFor();
    const outputSaved = await apiJson(page, '/api/chat/packages/configuration?id=chat-output'); assert(isRecord(outputSaved.value) && isRecord(outputSaved.value.configuration));
    assert.equal(outputSaved.value.configuration.longTextAsForward, true); assert.equal(outputSaved.value.configuration.longTextThreshold, 4000);
    assert.deepEqual(await apiJson(page, '/api/chat/authorization'), outputAuth);
    const forwardCard = page.locator('#forward-authorization');
    await forwardCard.getByRole('textbox', { name: '允许合并转发的会话', exact: true }).fill('group:456001');
    await forwardCard.getByRole('checkbox', { name: '确认以新授权版本保存合并转发会话范围', exact: true }).check();
    await forwardCard.getByRole('button', { name: '保存合并转发权限', exact: true }).click();
    await forwardCard.getByText('合并转发权限已保存为新授权版本；请到连接页明确应用。输出开关不会代替这项授权。', { exact: true }).waitFor();
    const forwardSaved = await apiJson(page, '/api/chat/authorization'); assert(isRecord(forwardSaved.value)); assert.deepEqual(forwardSaved.value.forwardAllow, ['group:456001']);
    await page.getByRole('tab', { name: '功能设置', exact: true }).click();
    const packageCard = page.locator('#package-configuration-browser-settings');
    await packageCard.getByRole('checkbox', { name: '确认迁移已保存的配置到当前字段版本', exact: true }).check();
    await packageCard.getByRole('button', { name: '迁移此功能配置', exact: true }).click();
    await packageCard.getByText('配置迁移已保存；没有自动重启或重新执行任务。', { exact: true }).waitFor();
    await packageCard.getByRole('switch', { name: '启用测试扩展', exact: true }).click();
    await packageCard.getByRole('spinbutton', { name: '测试扩展期限', exact: true }).fill('8');
    await packageCard.getByRole('textbox', { name: '测试扩展别名', exact: true }).fill('alpha\nbeta');
    await navigate(page, '概览', 'overview', '工作台概览');
    await navigate(page, '功能与触发', 'features', '功能与触发');
    await page.getByRole('tab', { name: '功能设置', exact: true }).click();
    assert.equal(await packageCard.getByRole('switch', { name: '启用测试扩展', exact: true }).isChecked(), true);
    assert.equal(await packageCard.getByRole('spinbutton', { name: '测试扩展期限', exact: true }).inputValue(), '8');
    assert.equal(await packageCard.getByRole('textbox', { name: '测试扩展别名', exact: true }).inputValue(), 'alpha\nbeta');
    await packageCard.getByRole('checkbox', { name: '确认保存这项功能配置，不增加访问权限', exact: true }).check();
    await packageCard.getByRole('button', { name: '保存功能配置', exact: true }).click();
    await packageCard.getByText('功能配置已保存，需要明确重启对应宿主后生效。', { exact: true }).waitFor();
    const extensionSaved = await apiJson(page, '/api/chat/packages/configuration?id=browser-settings'); assert(isRecord(extensionSaved.value));
    assert.deepEqual(extensionSaved.value.configuration, { enabled: true, limit: 8, names: ['alpha', 'beta'] });
    await page.getByText('聊天暂未就绪。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: '聊天功能', exact: true }).count(), 0);
    await exerciseAssistantAndReadOnlyWork(page, requests);
    await exerciseProtocolConnectionDiagnostics(page, requests, adaptersCleared.value);
    await exerciseModelReasoningCapabilities(page, requests, fixtureProviders);
    let pricingSaves = 0;
    await page.route('**/api/chat/usage/pricing', route => {
      if (route.request().method() === 'POST') { pricingSaves++; return route.fulfill({ status: 504, json: { error: 'usage_pricing_operation_unknown' } }); }
      return route.fulfill({ json: { revision: null, prices: [] } });
    });
    await navigate(page, '用量统计', 'usage', '用量与费用');
    const pricing = page.locator('#usage-pricing-editor');
    await pricing.getByText('高级：人工单价覆盖', { exact: true }).click();
    await pricing.getByRole('button', { name: '添加单价', exact: true }).click();
    await pricing.locator('#usage-price-provider-0').selectOption('fixture-provider-v2');
    await pricing.locator('#usage-price-model-0').selectOption('fixture-model-v2');
    await pricing.locator('#usage-price-currency-0').fill('USD');
    for (const component of ['inputPerMillion', 'outputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion']) await pricing.locator(`#usage-price-${component}-0`).fill('1.25');
    await navigate(page, '概览', 'overview', '工作台概览');
    await navigate(page, '用量统计', 'usage', '用量与费用');
    await pricing.getByText('高级：人工单价覆盖', { exact: true }).click();
    assert.equal(await pricing.locator('#usage-price-currency-0').inputValue(), 'USD');
    assert.equal(await pricing.locator('#usage-price-inputPerMillion-0').inputValue(), '1.25'); assert.equal(pricingSaves, 0);
    await pricing.getByRole('button', { name: '保存后续单价', exact: true }).click();
    await pricing.getByText('上次写入结果待核对；草稿保留，不会自动重试。', { exact: true }).waitFor();
    assert.equal(pricingSaves, 1);
    await navigate(page, '概览', 'overview', '工作台概览');
    await navigate(page, '用量统计', 'usage', '用量与费用');
    await pricing.getByText('上次写入结果待核对；草稿保留，不会自动重试。', { exact: true }).waitFor();
    await pricing.getByRole('button', { name: '读取已保存内容', exact: true }).click();
    await pricing.getByRole('button', { name: '已核对，允许新的保存', exact: true }).click();
    await pricing.getByText('高级：人工单价覆盖', { exact: true }).click();
    assert.equal(await pricing.locator('#usage-price-currency-0').inputValue(), 'USD'); assert.equal(pricingSaves, 1);
    await pricing.getByRole('button', { name: '撤销更改', exact: true }).click();

    await exerciseCapacityRecommendations(page);
    await exerciseUsageMaintenance(page, maintenance);
    await exerciseExecutionRecovery(page);
    await exerciseMediaAndInteractions(page);
    await exerciseAccountWorkspace(page);
    const sessionsUnavailable = await apiJson(page, '/api/chat/sessions');
    const usageUnavailable = await apiJson(page, '/api/chat/usage');
    assert.deepEqual(sessionsUnavailable, { status: 503, value: { error: 'runtime_not_connected' } });
    assert.deepEqual(usageUnavailable, { status: 503, value: { error: 'runtime_not_connected' } });

    const plansDocument = await readJson(join(runtimeDirectory, 'chat-plans.json'));
    const personasDocument = await readJson(join(runtimeDirectory, 'chat-personas.json'));
    const accessDocument = await readJson(join(runtimeDirectory, 'chat-access.json'));
    assert.equal((plansDocument.plans as Array<Record<string, unknown>>)[0]?.name, 'Fixture Plan Updated');
    assert.equal((plansDocument.plans as Array<Record<string, unknown>>)[0]?.reasoningEffort, 'high');
    assert.deepEqual((plansDocument.plans as Array<Record<string, unknown>>)[0]?.contextLimits, { group: 172000, private: 384000 });
    assert.equal((personasDocument.personas as Array<Record<string, unknown>>)[0]?.style, personaStyle);
    assert.deepEqual(accessDocument, {
      schema: 1, allow: ['group:456001', 'group:456002', 'private:123001', 'private:123002'],
      deny: ['group:999001', 'private:999002'], owner: '123001',
    });
    assert.equal((await stat(runtimeDirectory)).mode & 0o777, 0o700);
    for (const filename of ['chat-plans.json', 'chat-personas.json', 'chat-access.json', 'chat-adapters.json', 'chat-providers.json']) {
      assert.equal((await stat(join(runtimeDirectory, filename))).mode & 0o777, 0o600);
    }

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
      websocketConnectedDiagnosticsAndExplicitReconnectRemainIndependent: true,
      reasoningRetainsCurrentValueAndRestoresOnlyRealSupportWithLateReadsIsolated: true,
      usageExactPreviewAtomicMaintenanceExportUnknownRecovery: true,
      sdkReconciliationAndOriginalRevisionRecoveryNoReplay: true,
      conversationDiagnosticsPartialCoverage: true,
      realModelCapacityRecommendationPreservesManualDrafts: true,
      independentAccountWorkspaceDraftsUnknownAndExplicitLegacyAdoption: true,
      mediaQuoteActualReadingFailureStatesAndReadonlyQqInteractionDeadline: true,
      plansSaved: true,
      builtinTemplatesCreateOnlyEditableDrafts: true,
      builtinTemplatesCannotOverwriteUnsavedEdits: true,
      builtinTemplateIdCollisionsDoNotOverwrite: true,
      builtinTemplatesDoNotWriteOrActivateAutomatically: true,
      providerAndModelDropdownsSaved: true,
      groupAndPrivateContextLimitsSaved: true,
      invalidContextPreventsWrite: true,
      invalidPlanBindingRejected: true,
      unchangedLegacyBindingPreserved: true,
      missingLegacyBindingCannotActivate: true,
      providerCredentialsRedacted: true,
      providerEditorSaved: true,
      providerCredentialEditorKeepAndClear: true,
      providerDeleteCancelDoesNotWrite: true,
      boundedProviderModelList: true,
      omittedProviderCredentialPreserved: true,
      emptyProviderCredentialPreserved: true,
      providerCredentialCleared: true,
      staleProviderWriteRejected: true,
      referencedProviderDeleteDisableAndModelRemovalRejected: true,
      personasSaved: true,
      modelUpdatesActivePlan: true,
      staleModelWriteRejected: true,
      accessDefaultsToDeny: true,
      accessValidationPreventsWrite: true,
      accessSaved: true,
      adapterCredentialsRedacted: true,
      websocketDefaultsDisabled: true,
      adapterRuntimeNotFalselyAssembled: true,
      websocketControlsUnavailableWithoutRuntime: true,
      websocketDraftRetainedWhileDisabled: true,
      websocketDraftDoesNotSaveOrConnectAutomatically: true,
      protocolConnectionDoesNotClaimChatReady: true,
      disabledUnchangedWebhookFieldsHidden: true,
      emptyAdapterCredentialPreserved: true,
      adapterCredentialCleared: true,
      staleAdapterWriteRejected: true,
      boundedLongTextCards: true,
      longTextScrollsInternally: true,
      independentFootersVisible: true,
      operationalRoutesUnavailableWithoutHost: true,
      providerConsumersCanChangeTargetAndUnlinkAssistant: true,
      inlineModelCreationReturnsToPlanDraftWithoutSavingPlan: true,
      automaticStableIdsKeepAdvancedCompatibilityAndReset: true,
      inputTriggerDraftAndExplicitSave: true,
      toolPermissionGrantAndTombstoneRevokeAreIndependent: true,
      realReminderCrudSendHistoryAndCancel: true,
      assistantDeploymentExplicitAndUnknownReconciledWithoutReplay: true,
      workResultsAndReceiptsReadOnly: true,
      roleReferencesUploadPreviewVersionBindingAndDelete: true,
      genericPackageFieldsMigrationAndRetainedDrafts: true,
      outputConfigurationAndForwardAuthorizationRemainIndependent: true,
      pricingDraftAndUnknownSurviveNavigationWithoutReplay: true,
      memoryCorrectionNeverConfirmsModelProposal: true,
      manualScopedMemoryCanCorrectAndRevoke: true,
      privateRuntimePermissions: true,
      tokenStoredByBrowserScript: false,
      xssExecuted: false,
      pageErrors: 0,
      externalRequests: 0,
    });
    console.log(`Management smoke passed. Results: runtime/management-smoke/result-${runId}.json`);
  } catch (error: unknown) {
    if (page !== undefined && !page.isClosed()) await screenshot(page, 'failure').catch(() => undefined);
    await writePrivateJson(new URL(`failure-${runId}.json`, outputDirectory).pathname, {
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
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
