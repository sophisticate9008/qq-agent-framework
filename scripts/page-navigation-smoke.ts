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

const outputDirectory = new URL('../runtime/page-navigation-smoke/', import.meta.url);
const builtApplication = new URL('../dist/admin-web/app.js', import.meta.url);
const token = 'page-navigation-fixture-token-1234567890';
const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const nativeResourceFilenames = ['chat-plans.json', 'chat-personas.json', 'chat-access.json', 'chat-adapters.json'] as const;

const pages = [
  { id: 'overview', label: '概览', heading: '工作台概览' },
  { id: 'sessions', label: '会话管理', heading: '会话管理' },
  { id: 'usage', label: '用量统计', heading: '用量与费用' },
  { id: 'persona', label: '人设与形象', heading: '人设与形象' },
  { id: 'features', label: '功能与触发', heading: '功能与触发' },
  { id: 'access', label: '访问范围', heading: '访问范围' },
  { id: 'model', label: '聊天方案', heading: '聊天方案' },
  { id: 'adapters', label: '适配器', heading: '适配器' },
  { id: 'settings', label: '运行设置', heading: '运行设置' },
] as const;

interface SmokeState {
  readonly pageErrors: string[];
  readonly nativeDialogs: string[];
  readonly externalRequests: string[];
  readonly postRequests: string[];
  readonly pageEntryCounts: Record<string, number>;
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
  return page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).first();
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
  await page.getByRole('button', { name: label, exact: true }).first().click();
  await page.locator(`[data-page="${id}"]`).waitFor();
  await page.getByRole('heading', { name: heading, exact: true, level: 1 }).waitFor();
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
    application = await readFile(builtApplication, 'utf8');
  } catch {
    throw new Error('Built UI is missing. Wait for the page build before running this smoke test.');
  }
  for (const text of ['本页目录', '展开本页目录', '搜索工作台', '搜索设置或功能', '搜索设置或功能…']) {
    assert(application.includes(text), `Built UI does not contain ${text}; wait for the workspace search build.`);
  }
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
    pageErrors: [], nativeDialogs: [], externalRequests: [], postRequests: [], pageEntryCounts: {},
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
    const nativeRoutes = createNativeRuntimeRoutes({ directory: runtimeDirectory });
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
    await page.getByRole('heading', { name: '工作台概览', exact: true }).waitFor();
    await connect(page);

    for (const item of pages) {
      await navigate(page, item.id, item.label, item.heading);
      const navigator = visibleNavigator(page);
      const entryCount = await navigator.getByRole('button').count();
      assert(entryCount > 0, `${item.label} has no page navigation entries.`);
      state.pageEntryCounts[item.id] = entryCount;
      const headings = await page.locator(`[data-page="${item.id}"] h2:visible`).allTextContents();
      assert(headings.length > 0, `${item.label} has no visible h2 headings.`);
      for (const heading of headings.map(value => value.trim()).filter(Boolean)) {
        assert.equal(await navigator.getByRole('button', { name: heading, exact: true }).count(), 1,
          `${item.label} does not index h2 ${heading}.`);
      }
    }
    assert.equal(Object.keys(state.pageEntryCounts).length, 9);

    await navigate(page, 'adapters', '适配器', '适配器');
    for (const title of ['运行状态', 'OneBot', 'DSH 聊天引擎']) {
      await section(page, title).waitFor();
    }
    await page.getByText('聊天收发尚未接通。', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-page="adapters"] [data-bounded-card]').count(), 3);

    const desktopNavigator = visibleNavigator(page);
    const sticky = await desktopNavigator.evaluate(element => {
      let current: Element | null = element;
      while (current !== null && getComputedStyle(current).position !== 'sticky') current = current.parentElement;
      return current === null ? { found: false, right: false }
        : { found: true, right: current.getBoundingClientRect().left > window.innerWidth / 2 };
    });
    assert.deepEqual(sticky, { found: true, right: true });

    await navigate(page, 'model', '聊天方案', '聊天方案');
    const planName = field(page, '方案名称').locator('input');
    await planName.fill('UNSAVED_NAVIGATION_DRAFT');
    await openWorkspaceSearch(page);
    const personaOption = await searchOption(page, '人设', '人设与形象', '人设与形象');
    await personaOption.click();
    const leaveGuard = page.getByRole('dialog', { name: '还有未保存的更改', exact: true });
    await leaveGuard.waitFor();
    assert.equal(await page.evaluate(() => location.hash), '#model');
    assert.equal(await planName.inputValue(), 'UNSAVED_NAVIGATION_DRAFT');
    await leaveGuard.getByRole('button', { name: '继续编辑', exact: true }).click();
    await page.getByRole('button', { name: '撤销更改', exact: true }).first().click();

    await openWorkspaceSearch(page);
    const planOption = await searchOption(page, '聊天 方案', '聊天方案', '聊天方案');
    await planOption.click();
    await section(page, '聊天方案').waitFor();
    assert.equal(await page.evaluate(() => location.hash), '#model');

    await openWorkspaceSearch(page);
    const accessOption = await searchOption(page, '访问 范围', '访问范围', '访问范围');
    await accessOption.click();
    await page.locator('[data-page="access"]').waitFor();
    await section(page, '授权目录').waitFor();
    assert.equal(await page.evaluate(() => location.hash), '#access');

    await setTheme(page, 'light');
    await screenshot(page, 'desktop-light');
    await setTheme(page, 'dark');
    await screenshot(page, 'desktop-dark');
    await page.setViewportSize({ width: 390, height: 844 });
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      const toggle = page.getByRole('button', { name: '展开本页目录', exact: true });
      await toggle.click();
      await visibleNavigator(page).waitFor();
      await screenshot(page, `mobile-${theme}`);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      await visibleNavigator(page).getByRole('button', { name: '授权目录', exact: true }).click();
      assert.equal(await page.locator('[aria-label="本页目录"]:visible').count(), 0);
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
      pageCount: pages.length,
      nativeAdapterPage: true,
      pageEntryCounts: state.pageEntryCounts,
      allVisibleH2Indexed: true,
      workspaceSearchNativeTargets: true,
      samePageSearchWithoutWrite: true,
      crossPageSearchWithoutWrite: true,
      unsavedNavigationProtected: true,
      navigationDoesNotModifyNativeResources: true,
      desktopStickyRight: true,
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
