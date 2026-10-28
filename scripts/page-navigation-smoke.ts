import { readBuiltBrowserApplication } from './browser-assets-smoke.ts';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';

import { createConfigurationRoutes } from '../src/admin/configuration.ts';
import { createNativeRuntimeRoutes } from '../src/admin/runtime.ts';
import { createAdminServer } from '../src/admin/server.ts';
import { createSettingsRoutes } from '../src/admin/settings.ts';
import { createDefaultAdapterConfiguration } from '../src/host/adapter-configuration.ts';
import { navigateConsolePage } from './browser-navigation-smoke.ts';
import { pageRegistry, type PageId } from '../web/lib/page-registry.ts';

const outputDirectory = new URL('../runtime/page-navigation-smoke/', import.meta.url);
const builtApplication = new URL('../dist/admin-web/app.js', import.meta.url);
const token = 'page-navigation-fixture-token-1234567890';
const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const nativeResourceFilenames = ['chat-plans.json', 'chat-personas.json', 'chat-access.json', 'chat-adapters.json', 'chat-providers.json'] as const;

const pages = [
  { id: 'overview', label: '概览', heading: '连接与概览' },
  { id: 'sessions', label: '会话管理', heading: '会话与执行记录' },
  { id: 'usage', label: '用量统计', heading: '用量与费用' },
  { id: 'persona', label: '人设与唤醒', heading: '人设与唤醒' },
  { id: 'features', label: '功能与触发', heading: '功能与扩展' },
  { id: 'access', label: '访问范围', heading: '访问范围' },
  { id: 'model', label: '聊天方案', heading: '聊天方案' },
  { id: 'providers', label: '模型提供方', heading: '模型提供方' },
  { id: 'adapters', label: '连接', heading: '连接' },
  { id: 'settings', label: '运行设置', heading: '运行设置' },
] as const;

interface SmokeState {
  readonly assetResponses: string[];
  readonly pageErrors: string[];
  readonly nativeDialogs: string[];
  readonly externalRequests: string[];
  readonly postRequests: string[];
  readonly pageEntryCounts: Record<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function writePrivateJson(filename: string, value: unknown): Promise<void> {
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
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

function visibleNavigator(page: Page): Locator {
  return page.locator('[aria-label="本页目录"]:visible').first();
}

function section(page: Page, title: string): Locator {
  return page.getByRole('heading', { name: title, exact: true }).locator('xpath=ancestor::section[1]').first();
}

function field(page: Page, label: string): Locator {
  return page.getByText(label, { exact: true }).locator('xpath=ancestor::label[1]').first();
}

async function connect(page: Page): Promise<void> {
  await page.locator('#token').fill(token);
  await page.locator('#connect').click();
  await page.getByRole('button', { name: '断开连接', exact: true }).waitFor();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
}

async function navigate(page: Page, id: string, label: string, heading: string): Promise<void> {
  await navigateConsolePage(page, id as PageId);
  await page.locator(`[data-page="${id === 'access' || id === 'settings' ? 'security' : id}"]`).waitFor();
  await page.getByRole('heading', { name: id === 'access' || id === 'settings' ? '访问与设置' : id === 'model' ? '聊天方案与助手' : id === 'providers' ? '模型服务' : heading, exact: true, level: 1 }).waitFor();
}

async function openWorkspaceSearch(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: '搜索工作台', exact: true }).click();
  const search = page.getByRole('combobox', { name: '搜索设置或功能', exact: true });
  await search.waitFor();
  return search;
}

async function searchOption(page: Page, query: string, title: string, pagePath: string): Promise<Locator> {
  const search = page.getByRole('combobox', { name: '搜索设置或功能', exact: true });
  await search.fill(query);
  const pathLabel = `${pagePath} · 页面快捷入口`;
  const exactPath = new RegExp(`^${pathLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const option = page.locator(`[role="option"][data-search-title=${JSON.stringify(title)}]`).filter({
    has: page.locator('span.text-muted-foreground').filter({ hasText: exactPath }),
  });
  await option.first().waitFor();
  assert.equal(await option.count(), 1);
  return option.first();
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.getByRole('combobox', { name: '显示模式' }).selectOption(theme);
  await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme);
}

async function screenshot(page: Page, name: string): Promise<void> {
  const filename = new URL(`${name}-${runId}.png`, outputDirectory).pathname;
  await page.screenshot({ path: filename, fullPage: true, animations: 'disabled' });
  await chmod(filename, 0o600);
}

async function assertBuiltNavigationContract(): Promise<void> {
  let application: string;
  try {
    application = await readBuiltBrowserApplication();
  } catch {
    throw new Error('Built UI is missing. Wait for the page build before running this smoke test.');
  }
  for (const text of ['本页目录', '展开本页目录', '搜索工作台', '搜索设置或功能', '搜索设置或功能…']) {
    assert(application.includes(text), `Built UI does not contain ${text}; wait for the workspace search build.`);
  }
}

async function exerciseVirtualSearch(page: Page): Promise<void> {
  await page.route('**/api/configuration', async route => {
    const response = await route.fetch();
    const body: unknown = await response.json();
    assert(isRecord(body) && Array.isArray(body.groups));
    await route.fulfill({ response, json: { ...body, groups: [...body.groups, {
      id: 'virtual-search-fixture', title: '隔离长列表', description: '', category: 'settings', source: 'admin', revision: 'a'.repeat(64),
      fields: [...Array.from({ length: 100 }, (_, index) => ({ id: `virtual-search-${index}`, label: `虚拟搜索${String(index).padStart(3, '0')}`,
        description: '', type: 'text', value: '' })), { id: 'fixture-private-field', label: '草稿凭据隔离', description: '', type: 'secret', value: null, configured: false }]
    }] } });
  });
  try {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await navigate(page, 'overview', '概览', '连接与概览');
      await page.setViewportSize({ width, height: 1000 });
      const search = await openWorkspaceSearch(page);
      await search.fill('虚拟搜索');
      const results = page.getByRole('listbox', { name: '搜索结果', exact: true });
      await results.locator('[data-virtualized="true"]').waitFor();
      assert(await results.getByRole('option').count() < 60);
      await results.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await page.waitForFunction(() => {
        const input = document.querySelector('[role="combobox"][aria-controls]');
        const id = input?.getAttribute('aria-activedescendant');
        return id !== null && id !== undefined && document.getElementById(id)?.getAttribute('role') === 'option';
      });
      await search.press('End');
      await page.waitForFunction(() => {
        const input = document.querySelector('[role="combobox"][aria-controls]');
        const id = input?.getAttribute('aria-activedescendant');
        return id && document.getElementById(id)?.getAttribute('data-search-title') === '虚拟搜索099';
      });
      assert(await results.getByRole('option').count() < 60);
      await search.press('Home');
      await page.waitForFunction(() => {
        const input = document.querySelector('[role="combobox"][aria-controls]');
        const id = input?.getAttribute('aria-activedescendant');
        return id && document.getElementById(id)?.getAttribute('data-search-title') === '虚拟搜索000';
      });
      await search.press('End');
      await search.press('Enter');
      await search.waitFor({ state: 'hidden' });
      await page.locator('[data-page="security"]').waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      if (width === 1440) {
        await page.getByRole('button', { name: '高级设置', exact: true }).click();
        await field(page, '虚拟搜索099').locator('input').fill('RETAINED_PUBLIC_CONFIGURATION_DRAFT');
        await field(page, '草稿凭据隔离').locator('input').fill('fixture-secret-not-retained');
        await page.getByRole('dialog', { name: '管理端高级设置', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
        await navigate(page, 'overview', '概览', '连接与概览');
        assert.equal(await page.getByRole('dialog', { name: '还有未保存的更改', exact: true }).count(), 0);
        const retainedSearch = await openWorkspaceSearch(page); await retainedSearch.fill('虚拟搜索099');
        await page.locator('[role="option"][data-search-title="虚拟搜索099"]').click();
        await page.locator('[data-page="security"]').waitFor();
        await page.getByRole('button', { name: '高级设置', exact: true }).click();
        assert.equal(await field(page, '虚拟搜索099').locator('input').inputValue(), 'RETAINED_PUBLIC_CONFIGURATION_DRAFT');
        assert.equal(await field(page, '草稿凭据隔离').locator('input').inputValue(), '');
        await section(page, '隔离长列表').getByRole('button', { name: '撤销更改', exact: true }).click();
        await page.getByRole('dialog', { name: '管理端高级设置', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
      }
    }
  } finally {
    await page.unroute('**/api/configuration');
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}

async function run(): Promise<void> {
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await chmod(outputDirectory, 0o700);
  await assertBuiltNavigationContract();
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'page-navigation-smoke-'));
  const runtimeDirectory = join(fixtureDirectory, 'runtime');
  const gatewayFile = join(fixtureDirectory, 'gateway.json');
  const adminFile = join(fixtureDirectory, 'admin.json');
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const nativeRoutes = createNativeRuntimeRoutes({ directory: runtimeDirectory });
  const readProviders = nativeRoutes.find(route => route.method === 'GET' && route.pathname === '/api/chat/providers');
  const writeProviders = nativeRoutes.find(route => route.method === 'POST' && route.pathname === '/api/chat/providers');
  assert(readProviders && writeProviders, 'Native provider routes are required for navigation fixtures.');
  const providersBefore: unknown = await readProviders.handle({ query: new URLSearchParams(), body: null, signal: new AbortController().signal });
  assert(isRecord(providersBefore) && typeof providersBefore.revision === 'string');
  await writeProviders.handle({
    query: new URLSearchParams(),
    body: {
      revision: providersBefore.revision,
      providers: [{
        id: 'fixture-provider', name: 'Fixture Provider', type: 'openai', baseUrl: 'https://provider.invalid/v1', enabled: true,
        models: [{ id: 'fixture-model', name: 'Fixture Model' }],
      }],
    },
    signal: new AbortController().signal,
  });
  await writePrivateJson(join(runtimeDirectory, 'chat-personas.json'), {
    schema: 1,
    personas: [{ id: 'fixture-persona', name: 'Fixture Persona', identity: 'Stable identity.', style: 'Direct style.' }],
  });
  await writePrivateJson(join(runtimeDirectory, 'chat-plans.json'), {
    schema: 1,
    activePlanId: 'fixture-plan',
    plans: [{
      id: 'fixture-plan', name: 'Fixture Plan', description: 'Navigation fixture.', instructions: 'Be concise.',
      personaId: 'fixture-persona', provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'medium',
    }],
  });
  await writePrivateJson(join(runtimeDirectory, 'chat-access.json'), { schema: 1, allow: [], deny: [], owner: null });
  await writePrivateJson(join(runtimeDirectory, 'chat-adapters.json'), {
    schema: 1,
    adapters: createDefaultAdapterConfiguration(),
  });
  await writePrivateJson(gatewayFile, {
    port: 3123,
    upstreamEndpoint: 'http://127.0.0.1:3100',
    tokenFile: 'fixture-gateway.token',
    storeFilename: 'fixture-gateway.sqlite',
    allowedConversations: [],
    persona: { id: 'fixture-persona', version: '1.0.0' },
    budgetEnabled: true,
    maxSendUses: 4,
    grantTtlMs: 3_600_000,
    timeoutMs: 15_000,
    maxPending: 16,
    maxBodyBytes: 2 * 1024 * 1024,
    maxRecords: 10_000,
    authorizationVersion: 'fixture-navigation',
  });
  await writePrivateJson(adminFile, {
    host: '127.0.0.1', port: 3210, tokenFile: 'fixture-admin.token', gatewayConfiguration: 'gateway.json',
  });
  const nativeFilesBefore = await Promise.all(nativeResourceFilenames
    .map(filename => readFile(join(runtimeDirectory, filename), 'utf8')));

  const state: SmokeState = {
    pageErrors: [], nativeDialogs: [], externalRequests: [], postRequests: [], pageEntryCounts: {}, assetResponses: [],
  };
  let server: Server | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;

  try {
    const settingsRoutes = createSettingsRoutes({
      gatewayConfigurationFilename: gatewayFile,
      adminConfigurationFilename: adminFile,
      apply: () => ({ applied: true }),
    });
    const configurationRoutes = createConfigurationRoutes({
      gatewayConfigurationFilename: gatewayFile,
      adminConfigurationFilename: adminFile,
      apply: () => ({ applied: true }),
    });
    server = createAdminServer({
      token,
      snapshot: () => ({
        mode: 'gateway-live',
        integrations: { nativeRuntimeResources: true, nativeChatRuntime: false },
        overview: {
          online: true,
          gatewayHealthy: true,
          metrics: { writes: 0, pending: 0, rejected: 0, unknown: 0, recoveredUnknown: 0 },
        },
        policy: { configuration: { budgetEnabled: true } },
        fixtureOnly: true,
      }),
      routes: [...settingsRoutes, ...configurationRoutes, ...nativeRoutes],
      handlerTimeoutMs: 30_000,
    });
    const address = await listen(server);
    const origin = `http://127.0.0.1:${address.port}`;

    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROMIUM_EXECUTABLE === undefined ? {} : { executablePath: process.env.CHROMIUM_EXECUTABLE }),
    });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
    page = await context.newPage();
    page.on('response', response => {
      if (/\.(?:js|css)$/.test(new URL(response.url()).pathname)) state.assetResponses.push(`${response.status()}:${new URL(response.url()).pathname}`);
      if (response.status() >= 400 && /\.(?:js|css)$/.test(new URL(response.url()).pathname)) {
        state.pageErrors.push(`asset:${response.status()}:${new URL(response.url()).pathname}`);
      }
    });
    page.on('pageerror', error => state.pageErrors.push(error.message));
    page.on('dialog', dialog => {
      state.nativeDialogs.push(`${dialog.type()}: ${dialog.message()}`);
      void dialog.dismiss();
    });
    page.on('request', request => {
      if (request.method() === 'POST') state.postRequests.push(new URL(request.url()).pathname);
    });
    await context.route('**/*', route => {
      const requested = new URL(route.request().url());
      if ((requested.protocol === 'http:' || requested.protocol === 'https:') && requested.origin !== origin) {
        state.externalRequests.push(requested.href);
        return route.abort();
      }
      return route.continue();
    });

    await page.goto(origin);
    await connect(page);
    await page.getByRole('heading', { name: '连接与概览', exact: true }).waitFor();
    await exerciseVirtualSearch(page);
    for (const item of pageRegistry) {
      await navigate(page, item.id, item.label, item.id === 'usage' ? '用量与费用' : item.id === 'model' ? '聊天方案与助手' : item.label);
      await page.getByRole('heading', { name: '正在读取运行设置', exact: true }).waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: '展开本页目录', exact: true }).click();
      const navigator = visibleNavigator(page);
      await navigator.waitFor();
      const headings = await page.locator(`[data-page="${item.id}"] h2:visible`).allTextContents();
      assert(headings.length > 0, `${item.label} has no visible sections.`);
      for (const heading of new Set(headings.map(value => value.trim()).filter(Boolean))) {
        assert.equal(await navigator.getByRole('button', { name: heading, exact: true }).count(), 1, `${item.label}: ${heading}`);
      }
      state.pageEntryCounts[item.id] = await navigator.getByRole('button').count();
      await page.keyboard.press('Escape');
    }
    assert.equal(Object.keys(state.pageEntryCounts).length, pageRegistry.length);
    for (const alias of ['access', 'settings']) {
      await page.evaluate(target => { location.hash = `#${target}`; }, alias);
      await page.locator('[data-page="security"]').waitFor();
      await page.locator(`#security-${alias}`).waitFor();
      await page.getByRole('heading', { name: '访问与设置', exact: true, level: 1 }).waitFor();
      assert.equal(await page.evaluate(() => location.hash), `#${alias}`);
    }
    await openWorkspaceSearch(page);
    const providerOption = await searchOption(page, '模型 提供方', '模型服务', '模型服务');
    await providerOption.click();
    await page.locator('[data-page="providers"]').waitFor();
    await section(page, 'Fixture Provider').waitFor();
    assert.equal(await page.evaluate(() => location.hash), '#providers');
    await navigate(page, 'model', '聊天方案', '聊天方案与助手');
    const planName = field(page, '方案名称').locator('input');
    await planName.fill('UNSAVED_NAVIGATION_DRAFT');
    const writes = state.postRequests.length;
    await openWorkspaceSearch(page);
    const personaOption = await searchOption(page, '人设', '人设与唤醒', '人设与唤醒');
    await personaOption.click();
    await page.locator('[data-page="persona"]').waitFor();
    assert.equal(await page.getByRole('dialog', { name: '还有未保存的更改', exact: true }).count(), 0);
    await navigate(page, 'model', '聊天方案', '聊天方案与助手');
    assert.equal(await planName.inputValue(), 'UNSAVED_NAVIGATION_DRAFT');
    assert.equal(state.postRequests.length, writes);
    await page.getByRole('button', { name: '撤销更改', exact: true }).first().click();
    await navigate(page, 'security', '访问与设置', '访问与设置');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        {
          await page.getByRole('button', { name: '展开本页目录', exact: true }).click();
          await visibleNavigator(page).waitFor();
        }
        await screenshot(page, `${width}-${theme}`);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        {
          await visibleNavigator(page).getByRole('button').first().click();
          assert.equal(await page.locator('[aria-label="本页目录"]:visible').count(), 0);
        }
      }
    }

    const nativeFilesAfter = await Promise.all(nativeResourceFilenames
      .map(filename => readFile(join(runtimeDirectory, filename), 'utf8')));
    assert.deepEqual(nativeFilesAfter, nativeFilesBefore);
    assert.deepEqual(state.pageErrors, []);
    assert.deepEqual(state.externalRequests, []);
    assert.deepEqual(state.nativeDialogs, []);
    assert.deepEqual(state.postRequests, ['/api/auth/login']);

    await writePrivateJson(new URL(`result-${runId}.json`, outputDirectory).pathname, {
      checkedAt: new Date().toISOString(),
      nativeRuntimeRoutes: true,
      pageCount: pageRegistry.length,
      nativeAdapterPage: true,
      nativeProvidersPage: true,
      registeredPageSearchShortcuts: pageRegistry.length,
      pageEntryCounts: state.pageEntryCounts,
      allVisibleH2Indexed: true,
      workspaceSearchNativeTargets: true,
      crossPageSearchWithoutWrite: true,
      legacyHashesResolveToSecurity: true,
      unsavedDraftRetainedAcrossPages: true,
      navigationDoesNotModifyNativeResources: true,
      toolbarDirectoryDesktopAndMobile: true,
      mobileNavigationClosedAfterSelection: true,
      noHorizontalOverflow: true,
      pageErrors: 0,
      externalRequests: 0,
    });
    console.log(`Page navigation smoke passed. Results: runtime/page-navigation-smoke/result-${runId}.json`);
  } catch (error: unknown) {
    if (page !== undefined && !page.isClosed()) await screenshot(page, 'failure').catch(() => undefined);
    await writePrivateJson(new URL(`failure-${runId}.json`, outputDirectory).pathname, {
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
      location: page?.url(), body: await page?.locator('body').innerText().catch(() => 'unavailable'),
      state,
    });
    throw error;
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await closeServer(server);
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
}

await run();
