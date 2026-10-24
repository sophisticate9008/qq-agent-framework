import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Request as PlaywrightRequest } from 'playwright';

import { createAdminServer } from '../src/admin/server.ts';
import { createLegacyAdminRoutes } from '../src/integrations/legacy-admin.ts';

const outputDirectory = new URL('../runtime/activity-smoke/', import.meta.url);
const builtApplication = new URL('../dist/admin-web/app.js', import.meta.url);
const administratorToken = 'activity-smoke-administrator-token-1234567890';
const legacyToken = 'activity-smoke-legacy-token-1234567890';
const resetKey = 'group:410001';
const resetSessionId = 'fixture-session-group-410001';
const filteredKey = 'private:420002';
const xssText = '<img src="/activity-smoke-xss" onerror="globalThis.__activitySmokeXss=true">';
const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');

interface FixtureSession {
  readonly key: string;
  readonly sessionId: string;
  readonly owner: boolean;
}

type ResetOutcome = 'success' | 'unknown';

interface BrowserPost {
  readonly pathname: string;
  readonly body: unknown;
}

interface SmokeState {
  sessions: FixtureSession[];
  resetOutcome: ResetOutcome;
  unavailable: boolean;
  chatManagement: boolean;
  readonly legacyRequests: string[];
  readonly upstreamResetBodies: unknown[];
  readonly browserPosts: BrowserPost[];
  readonly browserAuthorizations: string[];
  readonly pageErrors: string[];
  readonly externalRequests: string[];
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
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function requestBody(request: PlaywrightRequest): Promise<unknown> {
  const text = request.postData();
  return text === null || text.length === 0 ? null : JSON.parse(text) as unknown;
}

function sessionsRevision(sessions: readonly FixtureSession[]): string {
  const sorted = [...sessions].sort((left, right) => left.key.localeCompare(right.key)
    || left.sessionId.localeCompare(right.sessionId)
    || Number(left.owner) - Number(right.owner));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

function usageFixture(): unknown {
  return {
    ok: true,
    generatedAt: Date.UTC(2026, 9, 24, 8, 30, 0),
    currency: 'USD',
    symbol: '$',
    totals: {
      buckets: { cacheMiss: 30_000, cacheHit: 10_000, cacheWrite: 1_000, output: 4_678, reasoning: 2_345 },
      inputTokens: 41_000,
      totalTokens: 45_678,
      cost: 1.234567,
      attributedCost: 1.111111,
      estimated: true,
      conversations: 2,
      turns: 12,
      steps: 21,
      unattributedCost: 0.123456,
      byTier: { peak: 0.4, off: 0.834567 },
      cacheHitRate: 10_000 / 41_000,
      avgCostPerTurn: 1.234567 / 12,
      avgCostPerStep: 1.234567 / 21,
    },
    conversations: [
      {
        key: resetKey,
        sessions: 2,
        buckets: { cacheMiss: 20_000, cacheHit: 8_000, cacheWrite: 500, output: 3_000, reasoning: 1_500 },
        inputTokens: 28_500,
        totalTokens: 31_500,
        cost: 0.987654,
        attributedCost: 0.9,
        unattributedCost: 0.087654,
        byTier: { peak: 0.3, off: 0.687654 },
        cacheHitRate: 8_000 / 28_500,
        estimated: true,
        turns: 8,
        steps: 14,
        firstAt: Date.UTC(2026, 9, 24, 7, 29, 0),
        lastAt: Date.UTC(2026, 9, 24, 8, 29, 0),
        models: ['fixture-chat-model', xssText],
      },
      {
        key: filteredKey,
        sessions: 1,
        buckets: { cacheMiss: 10_000, cacheHit: 2_000, cacheWrite: 500, output: 1_678, reasoning: 845 },
        inputTokens: 12_500,
        totalTokens: 14_178,
        cost: 0.123457,
        attributedCost: 0.111111,
        unattributedCost: 0.012346,
        byTier: { peak: 0.1, off: 0.023457 },
        cacheHitRate: 2_000 / 12_500,
        estimated: true,
        turns: 4,
        steps: 7,
        firstAt: Date.UTC(2026, 9, 24, 7, 28, 0),
        lastAt: Date.UTC(2026, 9, 24, 8, 28, 0),
        models: ['fixture-chat-model'],
      },
    ],
  };
}

function usageTurnsFixture(key: string): unknown {
  const sessionId = key === filteredKey ? 'fixture-session-private-420002' : resetSessionId;
  const turnBuckets = { cacheMiss: 900, cacheHit: 3_200, cacheWrite: 30, output: 420, reasoning: 40 };
  return {
    ok: true,
    generatedAt: Date.UTC(2026, 9, 24, 8, 30, 0),
    currency: 'USD',
    symbol: '$',
    key,
    sessionIds: [sessionId],
    sessions: 1,
    buckets: turnBuckets,
    cost: 0.01,
    attributedCost: 0.01,
    unattributedCost: 0,
    byTier: { peak: 0, off: 0.01 },
    estimated: true,
    firstAt: Date.UTC(2026, 9, 24, 8, 20, 0),
    lastAt: Date.UTC(2026, 9, 24, 8, 29, 0),
    models: ['fixture-chat-model'],
    turnLimit: 200,
    limited: false,
    turns: [{
      sessionId,
      key,
      turn: 1,
      steps: 1,
      attempts: 1,
      startedAt: Date.UTC(2026, 9, 24, 8, 28, 0),
      endedAt: Date.UTC(2026, 9, 24, 8, 29, 0),
      model: 'fixture-chat-model',
      provider: 'fixture-provider',
      buckets: turnBuckets,
      cost: 0.01,
      tier: 'off',
    }],
  };
}

function createFixtureFetch(state: SmokeState): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(request.headers.get('x-console-token'), legacyToken);
    state.legacyRequests.push(`${request.method} ${url.pathname}${url.search}`);
    if (state.unavailable && (url.pathname === '/api/sessions' || url.pathname === '/api/tokens/summary')) {
      throw new TypeError('fixture legacy API disconnected');
    }
    if (request.method === 'GET' && url.pathname === '/api/sessions') {
      return jsonResponse({ sessions: state.sessions });
    }
    if (request.method === 'GET' && url.pathname === '/api/tokens/summary') {
      assert.equal(url.searchParams.get('limit'), '200');
      return jsonResponse(usageFixture());
    }
    if (request.method === 'GET' && url.pathname === '/api/tokens/turns') {
      assert.equal(url.searchParams.get('limit'), '200');
      return jsonResponse(usageTurnsFixture(url.searchParams.get('key') ?? resetKey));
    }
    if (request.method === 'POST' && url.pathname === '/api/session/reset') {
      const body = await request.json() as unknown;
      state.upstreamResetBodies.push(body);
      if (state.resetOutcome === 'unknown') {
        return jsonResponse({ ok: true, key: resetKey, archived: 'different-fixture-session' });
      }
      state.sessions = state.sessions.filter(session => session.key !== resetKey);
      return jsonResponse({ ok: true, key: resetKey, archived: resetSessionId });
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

function section(page: Page, title: string): Locator {
  return page.locator('section').filter({
    has: page.getByRole('heading', { name: title, exact: true, includeHidden: true }),
  }).first();
}

async function navigate(page: Page, label: string, pageId: 'sessions' | 'usage', heading: string): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).first().click();
  await page.locator(`[data-page="${pageId}"]`).waitFor();
  await page.getByRole('heading', { name: heading, exact: true }).waitFor();
}

async function connect(page: Page): Promise<void> {
  await page.locator('#token').waitFor();
  await page.locator('#token').fill(administratorToken);
  await page.locator('#connect').click();
  await page.getByRole('button', { name: '断开连接', exact: true }).waitFor();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#token').count(), 0);
}

async function openWorkspaceSearch(page: Page, query: string, title: string, pagePath: string): Promise<void> {
  await page.getByRole('button', { name: '搜索工作台', exact: true }).click();
  const search = page.getByRole('combobox', { name: '搜索设置或功能', exact: true });
  await search.waitFor();
  await search.fill(query);
  const option = page.locator(`[role="option"][data-search-title=${JSON.stringify(title)}]`).filter({ hasText: pagePath });
  await option.first().waitFor();
  assert.equal(await option.count(), 1);
  await option.click();
  await search.waitFor({ state: 'hidden' });
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.getByRole('combobox', { name: '显示模式' }).selectOption(theme);
  await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme);
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

async function assertBuiltActivityContract(): Promise<void> {
  let application: string;
  try {
    application = await readFile(builtApplication, 'utf8');
  } catch {
    throw new Error('Built UI is missing. Wait for the main thread build before running activity smoke.');
  }
  for (const text of ['会话管理', '用量统计', '重置这条会话', '费用估算', '尚未接入聊天宿主']) {
    assert(application.includes(text), `Built UI does not contain ${text}; wait for the main thread build.`);
  }
}

async function waitForPostCount(state: SmokeState, pathname: string, count: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (state.browserPosts.filter(request => request.pathname === pathname).length >= count) return;
    await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 20));
  }
  assert.fail(`Timed out waiting for ${count} POST requests to ${pathname}.`);
}

async function run(): Promise<void> {
  await assertBuiltActivityContract();
  await mkdir(outputDirectory, { recursive: true });
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'activity-smoke-'));
  const legacyRoot = join(fixtureDirectory, 'legacy');
  const state: SmokeState = {
    sessions: [
      { key: resetKey, sessionId: resetSessionId, owner: false },
      { key: filteredKey, sessionId: 'fixture-session-private-420002', owner: true },
    ],
    resetOutcome: 'success',
    unavailable: false,
    chatManagement: true,
    legacyRequests: [],
    upstreamResetBodies: [],
    browserPosts: [],
    browserAuthorizations: [],
    pageErrors: [],
    externalRequests: [],
  };
  let server: Server | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;

  try {
    await mkdir(join(legacyRoot, 'state'), { recursive: true, mode: 0o700 });
    await writePrivateJson(join(legacyRoot, 'config.json'), {
      consolePort: 3100,
      consoleToken: legacyToken,
      privateFixtureMarker: true,
    });
    const routes = createLegacyAdminRoutes({ legacyRoot, fetch: createFixtureFetch(state), timeoutMs: 2_000 });
    server = createAdminServer({
      token: administratorToken,
      snapshot: () => ({
        mode: 'gateway-live',
        integrations: { chatManagement: state.chatManagement },
        overview: {
          online: true,
          gatewayHealthy: true,
          metrics: { writes: 7, pending: 0, rejected: 0, unknown: 0, recoveredUnknown: 0 },
        },
        fixtureOnly: true,
      }),
      routes,
      handlerTimeoutMs: 5_000,
    });
    const address = await listen(server);
    const origin = `http://127.0.0.1:${address.port}`;

    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROMIUM_EXECUTABLE === undefined
        ? {}
        : { executablePath: process.env.CHROMIUM_EXECUTABLE }),
    });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
    page = await context.newPage();
    page.on('pageerror', error => state.pageErrors.push(error.message));
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === origin && url.pathname.startsWith('/api/legacy/')) {
        const authorization = request.headers().authorization;
        if (authorization !== undefined) state.browserAuthorizations.push(authorization);
      }
      if (url.origin === origin && request.method() === 'POST') {
        void requestBody(request).then(body => state.browserPosts.push({ pathname: url.pathname, body }));
      }
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
    const cookies = await context.cookies(`${origin}/api/snapshot`);
    assert(cookies.some(cookie => cookie.httpOnly && cookie.sameSite === 'Strict' && cookie.path === '/api'));

    await openWorkspaceSearch(page, '会话 管理', '会话管理', '会话管理');
    await page.locator('[data-page="sessions"]').waitFor();
    await section(page, '会话绑定').waitFor();
    assert.equal(await visibleNavigator(page).getByRole('button', { name: '会话绑定', exact: true }).count(), 1);
    assert.equal(await visibleNavigator(page).getByRole('button', { name: '绑定详情', exact: true }).count(), 1);
    await page.locator('#session-filter').fill('420002');
    await page.locator(`[data-session-key="${filteredKey}"]`).waitFor();
    assert.equal(await page.locator(`[data-session-key="${resetKey}"]`).count(), 0);
    await page.locator(`[data-session-key="${filteredKey}"]`).getByRole('button', { name: '查看' }).click();
    await page.locator(`[data-selected-session="${filteredKey}"]`).waitFor();
    await section(page, '绑定详情').locator('summary').click();
    await page.getByText('fixture-session-private-420002', { exact: true }).waitFor();
    await page.locator('#session-filter').fill('');
    await page.locator(`[data-session-key="${resetKey}"]`).waitFor();
    await page.locator(`[data-session-key="${resetKey}"]`).getByRole('button', { name: '查看' }).click();

    const resetPostsBeforeCancel = state.browserPosts.filter(request => request.pathname === '/api/legacy/session/reset').length;
    await page.locator('#session-reset-open').click();
    const resetDialog = page.getByRole('dialog');
    await resetDialog.getByRole('heading', { name: '重置所选会话绑定？', exact: true }).waitFor();
    await resetDialog.getByText(/可能打断正在创建的会话/).waitFor();
    const confirmInput = resetDialog.locator('#session-reset-confirm');
    assert(await resetDialog.locator('#session-reset-submit').isDisabled());
    await confirmInput.fill(resetKey);
    assert(!(await resetDialog.locator('#session-reset-submit').isDisabled()));
    await resetDialog.getByRole('button', { name: '取消', exact: true }).click();
    await resetDialog.waitFor({ state: 'hidden' });
    assert.equal(state.browserPosts.filter(request => request.pathname === '/api/legacy/session/reset').length, resetPostsBeforeCancel);
    assert.equal(state.upstreamResetBodies.length, 0);

    const initialRevision = sessionsRevision(state.sessions);
    state.sessions = [...state.sessions, { key: 'group:430003', sessionId: 'fixture-session-group-430003', owner: false }];
    await page.locator('#session-reset-open').click();
    await resetDialog.locator('#session-reset-confirm').fill(resetKey);
    await resetDialog.locator('#session-reset-submit').click();
    await resetDialog.getByText('会话列表已在其他位置变化。请重新读取列表，再检查并确认当前绑定。', { exact: true }).waitFor();
    await waitForPostCount(state, '/api/legacy/session/reset', resetPostsBeforeCancel + 1);
    const conflictPosts = state.browserPosts.filter(request => request.pathname === '/api/legacy/session/reset');
    assert.deepEqual(conflictPosts.at(-1)?.body, {
      key: resetKey,
      sessionId: resetSessionId,
      revision: initialRevision,
      confirm: true,
    });
    assert.equal(state.upstreamResetBodies.length, 0);
    await page.waitForTimeout(250);
    assert.equal(state.browserPosts.filter(request => request.pathname === '/api/legacy/session/reset').length, resetPostsBeforeCancel + 1);
    await resetDialog.getByRole('button', { name: '关闭并刷新', exact: true }).click();
    await resetDialog.waitFor({ state: 'hidden' });
    await page.getByText('已读取 3 条当前绑定。', { exact: true }).waitFor();

    state.resetOutcome = 'unknown';
    const refreshedRevision = sessionsRevision(state.sessions);
    await page.locator(`[data-session-key="${resetKey}"]`).getByRole('button', { name: '查看' }).click();
    await page.locator('#session-reset-open').click();
    await resetDialog.locator('#session-reset-confirm').fill(resetKey);
    await resetDialog.locator('#session-reset-submit').click();
    await resetDialog.getByText('暂时无法确认重置是否完成。请勿再次提交；关闭窗口后手动刷新当前状态。', { exact: true }).waitFor();
    await waitForPostCount(state, '/api/legacy/session/reset', resetPostsBeforeCancel + 2);
    const unknownPosts = state.browserPosts.filter(request => request.pathname === '/api/legacy/session/reset');
    assert.deepEqual(unknownPosts.at(-1)?.body, {
      key: resetKey,
      sessionId: resetSessionId,
      revision: refreshedRevision,
      confirm: true,
    });
    assert.deepEqual(state.upstreamResetBodies, [{ key: resetKey }]);
    await page.waitForTimeout(250);
    assert.equal(state.browserPosts.filter(request => request.pathname === '/api/legacy/session/reset').length, resetPostsBeforeCancel + 2);
    assert.equal(state.upstreamResetBodies.length, 1);
    await resetDialog.getByRole('button', { name: '关闭并刷新', exact: true }).click();
    await resetDialog.waitFor({ state: 'hidden' });

    state.resetOutcome = 'success';
    await page.locator(`[data-session-key="${resetKey}"]`).getByRole('button', { name: '查看' }).click();
    await page.locator('#session-reset-open').click();
    await resetDialog.locator('#session-reset-confirm').fill(resetKey);
    await resetDialog.locator('#session-reset-submit').click();
    await resetDialog.waitFor({ state: 'hidden' });
    await page.getByText('已读取 2 条当前绑定。', { exact: true }).waitFor();
    assert.equal(await page.locator(`[data-session-key="${resetKey}"]`).count(), 0);
    assert.equal(state.upstreamResetBodies.length, 2);
    assert.equal(state.browserPosts.filter(request => request.pathname === '/api/legacy/session/reset').length, resetPostsBeforeCancel + 3);
    await page.getByText(/外部任务是否停止、外部会话是否归档均无法验证/).waitFor();

    await openWorkspaceSearch(page, '用量 统计', '用量统计', '用量统计');
    await page.locator('[data-page="usage"]').waitFor();
    await section(page, '账本汇总').waitFor();
    await page.locator('[data-usage-metric="total-tokens"]').getByText('45,678', { exact: true }).waitFor();
    await page.locator('[data-usage-metric="estimated-cost"]').getByText(/1\.234567/).waitFor();
    await page.locator(`[data-usage-key="${resetKey}"]`).getByText(/0\.987654/).waitFor();
    await page.getByText(xssText, { exact: true }).waitFor();
    await page.getByText(/无法拆到具体轮次的历史估算费用/).waitFor();
    await page.locator('#usage-turns [data-usage-turn]').first().waitFor();
    for (const title of ['账本汇总', 'Token 构成', '按会话汇总']) {
      assert.equal(await visibleNavigator(page).getByRole('button', { name: title, exact: true }).count(), 1);
    }
    assert(state.legacyRequests.some(request => request.includes('/api/tokens/turns')));

    await page.setViewportSize({ width: 390, height: 844 });
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert(await page.locator('[data-usage-key]').first().isVisible());
      assert(await page.locator('table').first().locator('..').evaluate(element => element.scrollWidth > element.clientWidth));
      await page.screenshot({ path: new URL(`loaded-usage-mobile-${theme}-${runId}.png`, outputDirectory).pathname,
        fullPage: true, animations: 'disabled' });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await navigate(page, '会话管理', 'sessions', '会话管理');
    await page.locator('[data-session-key]').first().waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: new URL(`loaded-sessions-mobile-${runId}.png`, outputDirectory).pathname,
      fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await navigate(page, '用量统计', 'usage', '用量与费用');

    state.unavailable = true;
    await navigate(page, '会话管理', 'sessions', '会话管理');
    await section(page, '无法读取会话').waitFor();
    await page.getByText('当前状态未知，不会按零条会话显示。请检查聊天宿主连接后重试。', { exact: true }).waitFor();
    await navigate(page, '用量统计', 'usage', '用量与费用');
    await section(page, '用量不可用').waitFor();
    await page.getByText('统计失败时不会显示为零。请检查聊天宿主和账本服务后重试。', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-usage-metric="total-tokens"]').count(), 0);

    state.unavailable = false;
    state.chatManagement = false;
    const legacyRequestCount = state.legacyRequests.length;
    await page.reload();
    await page.locator('[data-page="usage"]').waitFor();
    await section(page, '尚未接入聊天宿主').waitFor();
    await navigate(page, '会话管理', 'sessions', '会话管理');
    await section(page, '尚未接入聊天宿主').waitFor();
    assert.equal(state.legacyRequests.length, legacyRequestCount);

    await page.setViewportSize({ width: 390, height: 844 });
    await setTheme(page, 'light');
    await page.screenshot({
      path: new URL(`mobile-light-${runId}.png`, outputDirectory).pathname,
      fullPage: true,
      animations: 'disabled',
    });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await setTheme(page, 'dark');
    await page.screenshot({
      path: new URL(`mobile-dark-${runId}.png`, outputDirectory).pathname,
      fullPage: true,
      animations: 'disabled',
    });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

    assert(await tokenIsAbsentFromStorage(page));
    assert.deepEqual(state.browserAuthorizations, []);
    assert.deepEqual(state.pageErrors, []);
    assert.deepEqual(state.externalRequests, []);
    assert.equal(await page.evaluate(() => globalThis.__activitySmokeXss === true), false);
    const result = {
      checkedAt: new Date().toISOString(),
      builtUi: true,
      realAdminServer: true,
      realLegacyAdminRoutes: true,
      fixedPrivateFixture: true,
      cookieAuthentication: true,
      sessionFilteringAndDetails: true,
      resetCancelWithoutPost: true,
      resetConflictWithoutRetry: true,
      resetUnknownWithoutRetry: true,
      resetSuccessOnlyConfirmsBindingRemoved: true,
      usageTotalsAndConversationDetails: true,
      estimatedCostIsNonzero: true,
      perTurnEndpointRequired: true,
      disconnectedApiIsUnavailable: true,
      unconnectedChatHostPrompt: true,
      workspaceSearch: true,
      pageNavigation: true,
      mobileThemes: ['light', 'dark'],
      loadedMobileTablesWithoutPageOverflow: true,
      tokenStoredByBrowserScript: false,
      browserAuthorizationHeaders: 0,
      pageErrors: 0,
      externalRequests: 0,
      xssExecuted: false,
    };
    await writeFile(new URL(`result-${runId}.json`, outputDirectory), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Activity smoke passed. Results: runtime/activity-smoke/result-${runId}.json`);
  } catch (error: unknown) {
    if (page !== undefined && !page.isClosed()) {
      await page.screenshot({
        path: new URL(`failure-${runId}.png`, outputDirectory).pathname,
        fullPage: true,
        animations: 'disabled',
      }).catch(() => undefined);
    }
    const failure = {
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
      state: {
        legacyRequests: state.legacyRequests,
        upstreamResetBodies: state.upstreamResetBodies,
        browserPosts: state.browserPosts,
        browserAuthorizations: state.browserAuthorizations,
        pageErrors: state.pageErrors,
        externalRequests: state.externalRequests,
      },
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

declare global {
  var __activitySmokeXss: boolean | undefined;
}

await run();
