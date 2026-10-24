import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';

import { createConfigurationRoutes } from '../src/admin/configuration.ts';
import { createAdminServer } from '../src/admin/server.ts';
import { createSettingsRoutes } from '../src/admin/settings.ts';
import { createLegacyAdminRoutes } from '../src/integrations/legacy-admin.ts';

const outputDirectory = new URL('../runtime/page-navigation-smoke/', import.meta.url);
const builtApplication = new URL('../dist/admin-web/app.js', import.meta.url);
const token = 'page-navigation-fixture-token-1234567890';
const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const personaDraft = 'PAGE_NAV_PERSONA_DRAFT_7d91f2';
const secretDraft = 'PAGE_NAV_SECRET_6b38a4';

const pages = [
  { id: 'overview', label: '概览', heading: '工作台概览' },
  { id: 'persona', label: '人设与形象', heading: '人设与形象' },
  { id: 'features', label: '功能与触发', heading: '功能与触发' },
  { id: 'access', label: '访问范围', heading: '访问范围' },
  { id: 'model', label: '模型与回复', heading: '模型与回复' },
  { id: 'settings', label: '运行设置', heading: '运行设置' }
] as const;

interface SmokeState {
  readonly pageErrors: string[];
  readonly nativeDialogs: string[];
  readonly externalRequests: string[];
  readonly postRequests: string[];
  readonly pageEntryCounts: Record<string, number>;
  legacyWrites: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function writePrivateJson(filename: string, value: unknown): Promise<void> {
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function createFixtureFetch(state: SmokeState): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(request.headers.get('x-console-token'), 'fixture-console-token');
    if (request.method !== 'GET') {
      state.legacyWrites += 1;
      return jsonResponse({ ok: false }, 405);
    }
    if (url.pathname === '/api/status') {
      return jsonResponse({
        mode: 'reserved2', role: '测试伙伴', dshReady: true, socialV2Paused: false,
        snowluma: {
          connected: true, accountOnline: true, good: true, lastPacketAgoMs: 5,
          silent: false, degraded: false
        }
      });
    }
    if (url.pathname === '/api/mode') {
      return jsonResponse({
        mode: 'reserved2',
        revision: '8f2d047817f4eac59304a5a9f4b6a25fc53591d115991fcb6f83a90ba4cc4dd1'
      });
    }
    if (url.pathname === '/api/sessions') return jsonResponse({ sessions: [] });
    if (url.pathname === '/api/whitelist') {
      return jsonResponse({
        allow: { groups: [456001], private: [123001] },
        deny: { groups: [], private: [] },
        ownerQQ: 123001
      });
    }
    if (url.pathname === '/api/dsh/model') {
      return jsonResponse({
        provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'medium',
        options: ['low', 'medium', 'high'],
        labels: {
          low: { name: '较低', description: '较快回复。' },
          medium: { name: '均衡', description: '平衡速度和思考。' },
          high: { name: '深入', description: '更充分地思考。' }
        }
      });
    }
    if (url.pathname === '/api/roles') {
      return jsonResponse({ roles: ['测试伙伴', '备用'], current: '测试伙伴' });
    }
    if (url.pathname === '/api/roles/content') {
      const name = url.searchParams.get('name');
      if (name === '测试伙伴') return jsonResponse({ ok: true, name, content: '固定测试人设正文。' });
      if (name === '备用') return jsonResponse({ ok: true, name, content: '固定备用人设正文。' });
    }
    return jsonResponse({ ok: false }, 404);
  };
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

function workspaceSearch(page: Page): Locator {
  return page.getByRole('combobox', { name: '搜索设置或功能', exact: true });
}

function section(page: Page, title: string): Locator {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true, includeHidden: true }) }).first();
}

function fieldLabel(page: Page, text: string): Locator {
  return page.locator('.field-label').filter({ hasText: new RegExp(`^${text}$`) }).first();
}

async function navigate(page: Page, id: string, label: string, heading: string): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).first().click();
  await page.locator(`[data-page="${id}"]`).waitFor();
  await page.getByRole('heading', { name: heading, exact: true }).waitFor();
  await page.getByRole('button', { name: '搜索工作台', exact: true }).waitFor();
  await visibleNavigator(page).waitFor();
}

async function connect(page: Page): Promise<void> {
  await page.locator('#token').waitFor();
  await page.locator('#token').fill(token);
  await page.locator('#connect').click();
  await page.getByRole('button', { name: '断开连接', exact: true }).waitFor();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
}

async function assertNoRootLeavePrompt(page: Page): Promise<void> {
  assert.equal(await page.getByRole('dialog').count(), 0, 'Same-page navigation opened a leave guard.');
  assert.equal(await page.getByRole('heading', { name: /未保存|继续编辑|切换前/ }).count(), 0);
}

async function samePageAction(
  page: Page,
  state: SmokeState,
  action: () => Promise<unknown>
): Promise<void> {
  const hash = await page.evaluate(() => location.hash);
  const posts = state.postRequests.length;
  const dialogs = state.nativeDialogs.length;
  await action();
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => location.hash), hash, 'Same-page navigation changed location.hash.');
  assert.equal(state.postRequests.length, posts, 'Same-page navigation triggered a POST request.');
  assert.equal(state.nativeDialogs.length, dialogs, 'Same-page navigation triggered a browser leave prompt.');
  await assertNoRootLeavePrompt(page);
}

async function assertTargetFocused(target: Locator): Promise<void> {
  await target.waitFor();
  const state = await target.evaluate(async element => {
    const deadline = performance.now() + 2_000;
    let focused = false;
    let inViewport = false;
    do {
      const active = document.activeElement;
      const bounds = element.getBoundingClientRect();
      focused = active === element || active !== null && element.contains(active);
      inViewport = bounds.bottom > 0 && bounds.top < window.innerHeight;
      if (focused && inViewport) break;
      await new Promise<void>(resolvePromise => requestAnimationFrame(() => resolvePromise()));
    } while (performance.now() < deadline);
    return { focused, inViewport };
  });
  assert(state.focused, 'Navigation target did not receive focus.');
  assert(state.inViewport, 'Navigation target was not scrolled into view.');
}

async function clickNavigatorEntry(page: Page, state: SmokeState, name: string, target: Locator): Promise<void> {
  const button = visibleNavigator(page).getByRole('button', { name, exact: true });
  await button.waitFor();
  await samePageAction(page, state, () => button.click());
  await assertTargetFocused(target);
}

async function openWorkspaceSearch(page: Page, shortcut = false): Promise<Locator> {
  if (shortcut) await page.keyboard.press('Control+K');
  else await page.getByRole('button', { name: '搜索工作台', exact: true }).click();
  const search = workspaceSearch(page);
  await search.waitFor();
  assert.equal(await search.getAttribute('placeholder'), '搜索设置或功能…');
  assert(await search.evaluate(element => element === document.activeElement), 'Workspace search did not receive focus.');
  return search;
}

async function workspaceOption(page: Page, query: string, title: string, pagePath: string): Promise<Locator> {
  const search = workspaceSearch(page);
  await search.fill(query);
  const option = page.locator(`[role="option"][data-search-title=${JSON.stringify(title)}]`).filter({ hasText: pagePath });
  await option.first().waitFor();
  assert.equal(await option.count(), 1, `Workspace search returned an ambiguous result for ${title}.`);
  return option;
}

async function assertNoMatches(page: Page): Promise<void> {
  await page.getByText(/没有.*匹配/).first().waitFor();
  assert.equal(await page.getByRole('option').count(), 0);
}

async function clearWorkspaceSearch(page: Page): Promise<void> {
  const search = workspaceSearch(page);
  await search.fill('');
  assert.equal(await search.inputValue(), '');
  await page.getByText(/没有.*匹配/).first().waitFor({ state: 'hidden' });
}

async function closeWorkspaceSearch(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await workspaceSearch(page).waitFor({ state: 'hidden' });
}

async function clickSamePageSearchResult(
  page: Page,
  state: SmokeState,
  query: string,
  title: string,
  pagePath: string,
  target: Locator
): Promise<void> {
  const hash = await page.evaluate(() => location.hash);
  const posts = state.postRequests.length;
  const dialogs = state.nativeDialogs.length;
  await openWorkspaceSearch(page);
  const option = await workspaceOption(page, query, title, pagePath);
  await option.click();
  await workspaceSearch(page).waitFor({ state: 'hidden' });
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => location.hash), hash, 'Same-page search changed location.hash.');
  assert.equal(state.postRequests.length, posts, 'Same-page search triggered a POST request.');
  assert.equal(state.nativeDialogs.length, dialogs, 'Same-page search triggered a browser leave prompt.');
  await assertNoRootLeavePrompt(page);
  await assertTargetFocused(target);
}

async function clickCrossPageSearchResult(
  page: Page,
  state: SmokeState,
  query: string,
  title: string,
  pagePath: string,
  pageId: string,
  heading: string,
  target: Locator
): Promise<void> {
  const posts = state.postRequests.length;
  const dialogs = state.nativeDialogs.length;
  await openWorkspaceSearch(page);
  const option = await workspaceOption(page, query, title, pagePath);
  await option.click();
  await workspaceSearch(page).waitFor({ state: 'hidden' });
  await page.locator(`[data-page="${pageId}"]`).waitFor();
  await page.getByRole('heading', { name: heading, exact: true }).waitFor();
  assert.equal(await page.evaluate(() => location.hash), `#${pageId}`);
  assert.equal(state.postRequests.length, posts, 'Cross-page search triggered a POST request.');
  assert.equal(state.nativeDialogs.length, dialogs, 'Cross-page search triggered a browser leave prompt.');
  await assertNoRootLeavePrompt(page);
  await assertTargetFocused(target);
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.getByRole('combobox', { name: '显示模式' }).selectOption(theme);
  await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme);
}

async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: new URL(`${name}-${runId}.png`, outputDirectory).pathname,
    fullPage: true,
    animations: 'disabled'
  });
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
  for (const removedText of ['搜索本页分组或设置', '搜索分组或设置名称']) {
    assert(!application.includes(removedText), `Built UI still contains removed inline search text: ${removedText}.`);
  }
}

async function run(): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  await assertBuiltNavigationContract();
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'page-navigation-smoke-'));
  const legacyRoot = join(fixtureDirectory, 'legacy');
  const gatewayFile = join(fixtureDirectory, 'gateway.json');
  const adminFile = join(fixtureDirectory, 'admin.json');
  await mkdir(join(legacyRoot, 'state'), { recursive: true, mode: 0o700 });

  const state: SmokeState = {
    pageErrors: [], nativeDialogs: [], externalRequests: [], postRequests: [], pageEntryCounts: {}, legacyWrites: 0
  };
  let server: Server | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;

  try {
    await writePrivateJson(join(legacyRoot, 'config.json'), {
      consolePort: 3100,
      consoleToken: 'fixture-console-token',
      dsh: {
        baseUrl: 'http://127.0.0.1:3000', provider: 'fixture-provider', model: 'fixture-model',
        reasoningEffort: 'high', authToken: 'stored-fixture-secret'
      },
      snowluma: { silenceWarnMs: 120_000, accessToken: 'stored-snowluma-secret' },
      socialV2: { proactive: { enabled: false }, tools: { slangQuery: false, slangSubmit: false } },
      pricing: {
        peakWindows: [[9, 18]],
        models: { 'fixture-model': { label: '测试模型', off: { cacheHit: 0.1, cacheMiss: 1, output: 4 } } }
      }
    });
    await writePrivateJson(gatewayFile, {
      port: 3123,
      upstreamEndpoint: 'http://127.0.0.1:3100',
      tokenFile: 'fixture-gateway.token',
      upstreamTokenFile: 'fixture-upstream.token',
      storeFilename: 'fixture-gateway.sqlite',
      allowedConversations: ['group:456001', 'private:123001'],
      persona: { id: 'fixture-persona', version: '1.0.0' },
      budgetEnabled: true,
      maxSendUses: 4,
      grantTtlMs: 3_600_000,
      timeoutMs: 15_000,
      maxPending: 16,
      maxBodyBytes: 2 * 1024 * 1024,
      maxRecords: 10_000,
      authorizationVersion: 'fixture-navigation'
    });
    await writePrivateJson(adminFile, {
      host: '127.0.0.1', port: 3210, tokenFile: 'fixture-admin.token', gatewayConfiguration: 'gateway.json'
    });

    const settingsRoutes = createSettingsRoutes({
      gatewayConfigurationFilename: gatewayFile,
      adminConfigurationFilename: adminFile,
      apply: () => ({ applied: true })
    });
    const configurationRoutes = createConfigurationRoutes({
      legacyRoot,
      gatewayConfigurationFilename: gatewayFile,
      adminConfigurationFilename: adminFile,
      apply: () => ({ applied: true })
    });
    const legacyRoutes = createLegacyAdminRoutes({
      legacyRoot,
      fetch: createFixtureFetch(state),
      beforeAccessSave: async () => undefined
    });
    server = createAdminServer({
      token,
      snapshot: () => ({
        mode: 'gateway-live',
        overview: {
          online: true,
          gatewayHealthy: true,
          metrics: { writes: 7, pending: 2, rejected: 1, unknown: 1, recoveredUnknown: 0 }
        },
        policy: { configuration: { budgetEnabled: true } },
        fixtureOnly: true
      }),
      routes: [...settingsRoutes, ...configurationRoutes, ...legacyRoutes],
      handlerTimeoutMs: 30_000
    });
    const address = await listen(server);
    const origin = `http://127.0.0.1:${address.port}`;

    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROMIUM_EXECUTABLE === undefined
        ? {}
        : { executablePath: process.env.CHROMIUM_EXECUTABLE })
    });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
    page = await context.newPage();
    page.on('pageerror', error => state.pageErrors.push(error.message));
    page.on('dialog', dialog => {
      state.nativeDialogs.push(`${dialog.type()}: ${dialog.message()}`);
      void dialog.dismiss();
    });
    page.on('request', request => {
      const url = new URL(request.url());
      if (request.method() === 'POST') state.postRequests.push(url.pathname);
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
      for (const heading of headings.map(text => text.trim()).filter(Boolean)) {
        assert.equal(
          await navigator.getByRole('button', { name: heading, exact: true }).count(),
          1,
          `${item.label} does not index h2 ${heading}.`
        );
      }
    }

    const desktopNavigator = visibleNavigator(page);
    const sticky = await desktopNavigator.evaluate(element => {
      let current: Element | null = element;
      while (current !== null && getComputedStyle(current).position !== 'sticky') current = current.parentElement;
      if (current === null) return { found: false, right: false };
      return { found: true, right: current.getBoundingClientRect().left > window.innerWidth / 2 };
    });
    assert(sticky.found, 'Desktop page navigation is not sticky.');
    assert(sticky.right, 'Desktop page navigation is not on the right side.');

    const budgetSection = section(page, '运营预算');
    const sendLimit = budgetSection.locator('input[type="number"]').first();
    const keyboardSearch = await openWorkspaceSearch(page, true);
    await workspaceOption(page, '发送 预算', '启用发送预算', '运行设置');
    await clearWorkspaceSearch(page);
    await keyboardSearch.fill('完全不存在的导航条目');
    await assertNoMatches(page);
    await clearWorkspaceSearch(page);
    await closeWorkspaceSearch(page);

    await sendLimit.fill('11');
    await clickSamePageSearchResult(
      page, state, '发送 预算', '启用发送预算', '运行设置', fieldLabel(page, '启用发送预算')
    );
    assert.equal(await sendLimit.inputValue(), '11');

    const adminSection = section(page, '管理端监听');
    await clickNavigatorEntry(page, state, '管理端监听', adminSection);
    assert.equal(await sendLimit.inputValue(), '11');
    await clickSamePageSearchResult(page, state, '管理端 监听', '管理端监听', '运行设置', adminSection);
    assert.equal(await sendLimit.inputValue(), '11');

    const deepField = fieldLabel(page, '静默告警阈值');
    const deepDetails = deepField.locator('xpath=ancestor::details[1]');
    if (await deepDetails.getAttribute('open') !== null) await deepDetails.locator('summary').click();
    assert.equal(await deepDetails.getAttribute('open'), null);
    await clickSamePageSearchResult(page, state, '静默 告警', '静默告警阈值', '运行设置', deepField);
    assert.notEqual(await deepDetails.getAttribute('open'), null, 'Deep configuration details stayed closed.');
    assert.equal(await sendLimit.inputValue(), '11');

    await openWorkspaceSearch(page);
    const guardedOption = await workspaceOption(page, 'DSH 访问令牌', 'DSH 访问令牌', '模型与回复');
    await guardedOption.click();
    await workspaceSearch(page).waitFor({ state: 'hidden' });
    const leaveGuard = page.getByRole('dialog');
    await leaveGuard.getByRole('heading', { name: '还有未保存的更改', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => location.hash), '#settings');
    assert.equal(await sendLimit.inputValue(), '11');
    await leaveGuard.getByRole('button', { name: '继续编辑', exact: true }).click();
    await leaveGuard.waitFor({ state: 'hidden' });
    assert.equal(await sendLimit.inputValue(), '11');
    await section(page, '技术约束').getByRole('button', { name: '撤销更改', exact: true }).click();

    const secretField = fieldLabel(page, 'DSH 访问令牌');
    await clickCrossPageSearchResult(
      page, state, 'DSH 访问令牌', 'DSH 访问令牌', '模型与回复', 'model', '模型与回复', secretField
    );
    const secretInput = secretField.locator('xpath=ancestor::label[1]').locator('input').first();
    await secretInput.fill(secretDraft);
    await openWorkspaceSearch(page);
    await workspaceSearch(page).fill(secretDraft);
    await assertNoMatches(page);
    assert.equal(await secretInput.inputValue(), secretDraft);
    await clearWorkspaceSearch(page);
    const secretOption = await workspaceOption(page, 'DSH 访问令牌', 'DSH 访问令牌', '模型与回复');
    await secretOption.click();
    await workspaceSearch(page).waitFor({ state: 'hidden' });
    await assertTargetFocused(secretField);
    assert.equal(await secretInput.inputValue(), secretDraft);
    await section(page, 'DSH 模型与连接').getByRole('button', { name: '撤销更改', exact: true }).click();

    await navigate(page, 'persona', '人设与形象', '人设与形象');
    const personaSection = section(page, '测试伙伴');
    const personaBody = personaSection.locator('textarea').first();
    await personaBody.fill(personaDraft);
    await openWorkspaceSearch(page);
    await workspaceSearch(page).fill(personaDraft);
    await assertNoMatches(page);
    assert.equal(await personaBody.inputValue(), personaDraft);
    await clearWorkspaceSearch(page);
    const personaListOption = await workspaceOption(page, '人设 列表', '人设列表', '人设与形象');
    await personaListOption.click();
    await workspaceSearch(page).waitFor({ state: 'hidden' });
    await assertTargetFocused(section(page, '人设列表'));
    assert.equal(await personaBody.inputValue(), personaDraft);
    await personaSection.getByRole('button', { name: '撤销更改', exact: true }).click();

    await navigate(page, 'features', '功能与触发', '功能与触发');
    const showInactive = page.getByRole('switch', { name: '显示停用配置', exact: true });
    await showInactive.waitFor();
    assert.equal(await showInactive.getAttribute('data-checked'), null);
    await openWorkspaceSearch(page);
    const proactiveOption = await workspaceOption(page, '启用 主动话题', '启用主动话题', '功能与触发');
    await proactiveOption.click();
    await workspaceSearch(page).waitFor({ state: 'hidden' });
    const proactiveToggle = page.getByRole('switch', { name: '启用主动话题', exact: true });
    await assertTargetFocused(fieldLabel(page, '启用主动话题'));
    assert.equal(await proactiveToggle.getAttribute('data-checked'), null);
    await openWorkspaceSearch(page);
    await workspaceSearch(page).fill('空闲 阈值');
    await assertNoMatches(page);
    await clearWorkspaceSearch(page);
    await closeWorkspaceSearch(page);
    await samePageAction(page, state, () => proactiveToggle.click());
    await clickSamePageSearchResult(
      page, state, '空闲 阈值', '空闲阈值', '功能与触发', fieldLabel(page, '空闲阈值')
    );
    await section(page, '二代主动话题').getByRole('button', { name: '撤销更改', exact: true }).click();

    await navigate(page, 'settings', '运行设置', '运行设置');
    await setTheme(page, 'light');
    await screenshot(page, 'desktop-light');
    await setTheme(page, 'dark');
    await screenshot(page, 'desktop-dark');

    await page.setViewportSize({ width: 390, height: 844 });
    await setTheme(page, 'light');
    const mobileToggle = page.getByRole('button', { name: '展开本页目录', exact: true });
    await mobileToggle.waitFor();
    await mobileToggle.click();
    await visibleNavigator(page).waitFor();
    await screenshot(page, 'mobile-light');
    await clickNavigatorEntry(page, state, '管理端监听', adminSection);
    assert.equal(await page.locator('[aria-label="本页目录"]:visible').count(), 0, 'Mobile navigation did not close.');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

    await setTheme(page, 'dark');
    await page.getByRole('button', { name: '展开本页目录', exact: true }).click();
    await visibleNavigator(page).waitFor();
    await screenshot(page, 'mobile-dark');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

    await page.waitForTimeout(100);
    assert.deepEqual(state.pageErrors, []);
    assert.deepEqual(state.externalRequests, []);
    assert.deepEqual(state.nativeDialogs, []);
    assert.equal(state.legacyWrites, 0);
    assert.deepEqual(state.postRequests, ['/api/auth/login']);

    const result = {
      checkedAt: new Date().toISOString(),
      builtUi: true,
      realAdminServer: true,
      isolatedConfigurationRoutes: true,
      isolatedSettingsRoutes: true,
      fixedLegacyFixture: true,
      pageEntryCounts: state.pageEntryCounts,
      allVisibleH2Indexed: true,
      workspaceSearchButton: true,
      workspaceSearchKeyboardShortcut: true,
      workspaceSearchResultPaths: true,
      workspaceSearchSamePageJump: true,
      workspaceSearchCrossPageJump: true,
      rootDirtyCrossPageProtected: true,
      chineseMultiWordSearch: true,
      deepFieldExpandedAndFocused: true,
      parentSwitchAlwaysSearchable: true,
      inactiveChildHiddenUntilParentDraftEnabled: true,
      noMatchAndClear: true,
      inputValuesNotIndexed: true,
      personaBodyNotIndexed: true,
      draftPreserved: true,
      samePageNoRootLeavePrompt: true,
      samePageHashUnchanged: true,
      nonWritingNavigation: true,
      configurationPostRequests: 0,
      authenticationPostRequests: 1,
      desktopStickyRight: true,
      mobileNavigationClosedAfterSelection: true,
      noHorizontalOverflow: true,
      pageErrors: 0,
      externalRequests: 0,
      screenshots: [
        `desktop-light-${runId}.png`, `desktop-dark-${runId}.png`,
        `mobile-light-${runId}.png`, `mobile-dark-${runId}.png`
      ]
    };
    await writeFile(new URL(`result-${runId}.json`, outputDirectory), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Page navigation smoke passed. Results: runtime/page-navigation-smoke/result-${runId}.json`);
  } catch (error: unknown) {
    if (page !== undefined && !page.isClosed()) {
      await page.screenshot({
        path: new URL(`failure-${runId}.png`, outputDirectory).pathname,
        fullPage: true,
        animations: 'disabled'
      }).catch(() => undefined);
    }
    const failure = {
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
      state: {
        pageErrors: state.pageErrors,
        nativeDialogs: state.nativeDialogs,
        externalRequests: state.externalRequests,
        postRequests: state.postRequests,
        pageEntryCounts: state.pageEntryCounts,
        legacyWrites: state.legacyWrites
      }
    };
    await writeFile(new URL(`failure-${runId}.json`, outputDirectory), `${JSON.stringify(failure, null, 2)}\n`);
    throw error;
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await closeServer(server);
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
}

await run();
