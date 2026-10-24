import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';

import { createNativeRuntimeRoutes } from '../src/admin/runtime.ts';
import { createAdminServer } from '../src/admin/server.ts';

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

function field(page: Page, label: string): Locator {
  return page.getByText(label, { exact: true }).locator('xpath=ancestor::label[1]').first();
}

async function navigate(page: Page, label: string, pageId: string, heading: string): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).first().click();
  await page.locator(`[data-page="${pageId}"]`).waitFor();
  await page.getByRole('heading', { name: heading, exact: true, level: 1 }).waitFor();
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
  await section(page, options.originalName).waitFor();
  const name = field(page, options.nameLabel).locator('input');
  const builtin = page.getByRole('button', { name: options.builtinLabel, exact: true });
  assert.equal(await name.inputValue(), options.originalName);
  await name.fill('UNSAVED_BUILTIN_GUARD');
  assert.equal(await builtin.isDisabled(), true);
  assert.equal(await name.inputValue(), 'UNSAVED_BUILTIN_GUARD');
  await page.getByRole('button', { name: '撤销更改', exact: true }).click();
  await builtin.click();
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
    assert.equal(await field(page, '思考强度').locator('select').inputValue(), 'low');
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
  await leaveGuard.waitFor();
  await leaveGuard.getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(await name.inputValue(), draftName);
  await page.getByRole('button', { name: '概览', exact: true }).first().click();
  await leaveGuard.getByRole('button', { name: '舍弃并离开', exact: true }).click();
  await page.locator('[data-page="overview"]').waitFor();
  await navigate(page, options.pageLabel, options.pageId, options.pageLabel);
  await section(page, options.originalName).waitFor();
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
  await field(page, '接口类型').locator('select').selectOption('anthropic');
  await field(page, '填写密钥（可选）').locator('input[type="password"]').fill(fixtureProviderCredential);
  await page.locator('#provider-model-name-0').fill('Fixture Model Updated');
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
  assert.equal(provider.type, 'anthropic');
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
}

async function run(): Promise<void> {
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await chmod(outputDirectory, 0o700);
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'management-smoke-'));
  const runtimeDirectory = join(fixtureDirectory, 'runtime');
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const nativeRoutes = createNativeRuntimeRoutes({ directory: runtimeDirectory });
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
      routes: nativeRoutes,
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
    await page.getByText('原生聊天宿主未接入，已保存方案当前不可用于真实聊天。', { exact: true }).waitFor();
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
    await field(page, '群聊上下文').locator('input[type="number"]').fill('172000');
    await field(page, '私聊上下文').locator('input[type="number"]').fill('384000');
    await planName.fill('Fixture Plan Updated');
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
    await page.getByText('聊天方案目录已保存。', { exact: true }).waitFor();

    const planResponse = await apiJson(page, '/api/chat/plans');
    assert.equal(planResponse.status, 200);
    assert(isRecord(planResponse.value) && typeof planResponse.value.revision === 'string');
    assert(Array.isArray(planResponse.value.plans) && isRecord(planResponse.value.plans[0]));
    assert.equal(planResponse.value.plans[0].provider, 'fixture-provider-v2');
    assert.equal(planResponse.value.plans[0].model, 'fixture-model-v2');
    assert.deepEqual(planResponse.value.plans[0].contextLimits, { group: 172000, private: 384000 });
    await page.getByRole('button', { name: '重新载入目录', exact: true }).click();
    await page.getByRole('button', { name: '重新载入目录', exact: true }).waitFor();
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

    await navigate(page, '访问范围', 'access', '访问范围');
    await page.getByText('当前默认全部拒绝。', { exact: true }).waitFor();
    const allow = field(page, '允许名单').locator('textarea');
    const deny = field(page, '拒绝名单').locator('textarea');
    const owner = field(page, '所有者用户号').locator('input');
    await allow.fill('group:456001\nprivate:123001');
    await deny.fill('group:999001');
    await owner.fill('123001');
    const accessPostsBeforeInvalid = requests.filter(request => request.method === 'POST' && request.pathname === '/api/chat/access').length;
    await allow.fill('group:456001\ngroup:456001');
    await page.getByRole('button', { name: '保存授权', exact: true }).click();
    await page.getByRole('alert').getByText('同一名单中不能填写重复授权项。', { exact: true }).waitFor();
    assert.equal(requests.filter(request => request.method === 'POST' && request.pathname === '/api/chat/access').length, accessPostsBeforeInvalid);
    await allow.fill('group:456001\nprivate:123001');
    await page.getByRole('button', { name: '保存授权', exact: true }).click();
    await page.getByText('原生访问授权已保存。', { exact: true }).waitFor();

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

    await navigate(page, '适配器', 'adapters', '适配器');
    await section(page, '运行状态').waitFor();
    await page.getByText('聊天收发尚未接通。', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-page="adapters"] [data-bounded-card]').count(), 3);
    assert.equal(await page.getByRole('heading', { name: '图片服务', exact: true }).count(), 0);
    assert.equal(await page.getByRole('switch', { name: '启用此连接', exact: true }).count(), 2);
    assert.equal(await page.getByRole('switch', { name: '收取 OneBot 上报', exact: true, includeHidden: true }).getAttribute('aria-checked'), 'false');
    assert.equal(await page.locator('#adapter-webhook-self-id').count(), 0);
    assert.equal(await page.getByPlaceholder('机器人 QQ 号', { exact: true }).count(), 0);
    assert.equal(await page.locator('#adapter-webhook-host, #adapter-webhook-port, #adapter-webhook-hmac-action').count(), 0);
    await page.getByText('协议端 API 密钥（可选）', { exact: true }).waitFor();
    await page.getByText('复制协议端 HTTP 服务设置中的 accessToken。不是本管理后台的管理员令牌或登录会话；协议端未启用认证时可不填。', { exact: true }).waitFor();
    assert.equal(await page.locator('#adapter-onebotHttp-credential-action').inputValue(), 'keep');
    assert.equal(await page.locator('#adapter-onebotHttp-credential-value').count(), 0);
    assert.equal((await page.locator('body').innerText()).includes(fixtureAdapterCredential), false);
    await section(page, '运行状态').getByText('尚未接入', { exact: true }).waitFor();
    await page.getByText('WebSocket 已连接不等于聊天模型正在处理消息；未接入处理流程时不会自动生成回复。', { exact: true }).waitFor();
    for (const label of ['连接 WebSocket', '断开 WebSocket']) {
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
    assert.equal(await page.getByRole('button', { name: '连接 WebSocket', exact: true }).isDisabled(), true);
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
    await page.getByRole('button', { name: '重新读取', exact: true }).click();
    await page.getByText('尚未设置', { exact: true }).first().waitFor();
    assert.equal(await page.locator('#adapter-onebotHttp-credential-value').count(), 0);

    await navigate(page, '功能与触发', 'features', '功能与触发');
    await page.getByText('原生聊天宿主未接入。', { exact: true }).waitFor();
    await page.getByText('0 项已安装', { exact: true }).waitFor();
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
      schema: 1, allow: ['group:456001', 'private:123001'], deny: ['group:999001'], owner: '123001',
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
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
}

declare global {
  var __managementSmokeXss: boolean | undefined;
}

await run();
