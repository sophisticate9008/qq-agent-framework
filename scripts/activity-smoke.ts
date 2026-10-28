import { readBuiltBrowserApplication } from './browser-assets-smoke.ts';
import { navigateConsolePage } from './browser-navigation-smoke.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Request as PlaywrightRequest } from 'playwright';

import { AdminRequestError, createAdminServer, type AdminRoute } from '../src/admin/server.ts';

const outputDirectory = new URL('../runtime/activity-smoke/', import.meta.url);
const builtApplication = new URL('../dist/admin-web/app.js', import.meta.url);
const administratorToken = 'activity-smoke-administrator-token-1234567890';
const sessionsPath = '/api/chat/sessions';
const sessionResetPath = '/api/chat/sessions/reset';
const usagePath = '/api/chat/usage';
const usageTurnsPath = '/api/chat/usage/turns';
const resetKey = 'group:410001';
const resetSessionId = 'fixture-session-group-410001';
const filteredKey = 'private:420002';
const xssText = '<img src="/activity-smoke-xss" onerror="globalThis.__activitySmokeXss=true">';
const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');

interface FixtureSession {
  readonly key: string;
  readonly sessionId: string;
  readonly owner: boolean;
  readonly generation: number;
  readonly bindingRevision: string;
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
  readonly fixtureRequests: string[];
  readonly resetBodies: unknown[];
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

async function screenshot(page: Page, name: string): Promise<void> {
  const filename = new URL(`${name}-${runId}.png`, outputDirectory).pathname;
  await page.screenshot({ path: filename, fullPage: true, animations: 'disabled' });
  await chmod(filename, 0o600);
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
    source: 'chat-ledger',
    revision: 'activity-fixture-usage-v1',
    generatedAt: Date.UTC(2026, 9, 24, 8, 30, 0),
    currency: 'USD',
    symbol: '$',
    limit: 200,
    limited: false,
    unavailable: ['pricing', 'ledger'],
    totals: {
      buckets: { cacheMiss: 30_000, cacheHit: 10_000, cacheWrite: 1_000, output: 4_678, reasoning: 2_345 },
      inputTokens: 41_000,
      outputTokens: 4_678,
      cacheHitTokens: 10_000,
      cacheMissTokens: 30_000,
      cacheWriteTokens: 1_000,
      reasoningTokens: 2_345,
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
        sessionCount: 2,
        buckets: { cacheMiss: 20_000, cacheHit: 8_000, cacheWrite: 500, output: 3_000, reasoning: 1_500 },
        inputTokens: 28_500,
        outputTokens: 3_000,
        cacheHitTokens: 8_000,
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
        sessionCount: 1,
        buckets: { cacheMiss: 10_000, cacheHit: 2_000, cacheWrite: 500, output: 1_678, reasoning: 845 },
        inputTokens: 12_500,
        outputTokens: 1_678,
        cacheHitTokens: 2_000,
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
    generatedAt: Date.UTC(2026, 9, 24, 8, 30, 0),
    currency: 'USD',
    symbol: '$',
    key,
    sessionIds: [sessionId],
    sessionCount: 1,
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

function createFixtureRoutes(state: SmokeState): readonly AdminRoute[] {
  return [
    {
      method: 'GET', pathname: '/api/chat/activity', handle: ({ query }) => {
        state.fixtureRequests.push(`GET /api/chat/activity?${query.toString()}`);
        assert.equal(query.get('source'), 'all');
        if (state.unavailable) throw new AdminRequestError(503, 'activity_unavailable');
        return { source: 'native-chat', retention: 'process', capacity: 100, state: 'stopped',
          items: Array.from({ length: 100 }, (_, index) => ({ id: `activity-${index}`, at: 1_792_800_000_000 - index * 1000,
            level: index % 5 === 0 ? 'warning' : 'info', type: index % 2 === 0 ? 'received' : 'sent',
            conversationId: index % 2 === 0 ? 'group:410001' : 'private:420002',
            summary: index === 0 ? xssText : `测试活动 ${index}` })) };
      },
    },
    {
      method: 'GET', pathname: sessionsPath, handle: ({ query }) => {
        state.fixtureRequests.push(`GET ${sessionsPath}?${query.toString()}`);
        if (state.unavailable) throw new AdminRequestError(503, 'runtime_not_connected');
        return { sessions: state.sessions, revision: sessionsRevision(state.sessions), resetAvailable: true, next: null };
      },
    },
    {
      method: 'POST', pathname: sessionResetPath, handle: ({ body }) => {
        state.fixtureRequests.push(`POST ${sessionResetPath}`);
        const current = state.sessions.find(session => session.key === body?.key);
        if (!current || body?.generation !== current.generation || body.bindingRevision !== current.bindingRevision) {
          throw new AdminRequestError(409, 'session_reset_conflict');
        }
        if (body.key !== resetKey || body.sessionId !== resetSessionId || body.confirm !== true) {
          throw new AdminRequestError(400, 'invalid_request');
        }
        state.resetBodies.push(body);
        if (state.resetOutcome === 'unknown') throw new AdminRequestError(504, 'session_reset_unknown');
        state.sessions = state.sessions.filter(session => session.key !== resetKey);
        return { ok: true, key: resetKey, previousSessionId: resetSessionId,
          bridgeBindingRemoved: true, externalWorkStopped: 'unverified', previousGeneration: current.generation,
          nextGeneration: current.generation + 1, historyPreserved: true, contextReset: true };
      },
    },
    {
      method: 'GET', pathname: usagePath, handle: ({ query }) => {
        state.fixtureRequests.push(`GET ${usagePath}?${query.toString()}`);
        assert.equal(query.get('limit'), '200');
        if (state.unavailable) throw new AdminRequestError(503, 'runtime_not_connected');
        return usageFixture();
      },
    },
    {
      method: 'GET', pathname: usageTurnsPath, maxResponseBytes: 4 * 1024 * 1024, handle: ({ query }) => {
        state.fixtureRequests.push(`GET ${usageTurnsPath}?${query.toString()}`);
        assert.equal(query.get('limit'), '200');
        return usageTurnsFixture(query.get('key') ?? resetKey);
      },
    },
  ];
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

async function expandDetails(panel: Locator): Promise<void> {
  const open = await panel.evaluate(element => element instanceof HTMLDetailsElement && element.open);
  if (!open) await panel.locator('summary').click();
  assert.equal(await panel.evaluate(element => element instanceof HTMLDetailsElement && element.open), true);
}

async function navigate(page: Page, label: string, pageId: 'sessions' | 'usage', heading: string): Promise<void> {
  await navigateConsolePage(page, pageId);
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
    application = await readBuiltBrowserApplication();
  } catch {
    throw new Error('Built UI is missing. Wait for the main thread build before running activity smoke.');
  }
  for (const text of ['会话管理', '用量统计', '重新开始对话', '费用估算', 'usage-detailed-counts', '原生聊天宿主尚未接入']) {
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
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await chmod(outputDirectory, 0o700);
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'activity-smoke-'));
  const state: SmokeState = {
    sessions: [
      { key: resetKey, sessionId: resetSessionId, owner: false, generation: 1, bindingRevision: 'a'.repeat(64) },
      { key: filteredKey, sessionId: 'fixture-session-private-420002', owner: true, generation: 1, bindingRevision: 'c'.repeat(64) },
    ],
    resetOutcome: 'success',
    unavailable: false,
    fixtureRequests: [],
    resetBodies: [],
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
    const routes = createFixtureRoutes(state);
    server = createAdminServer({
      token: administratorToken,
      snapshot: () => ({
        mode: 'gateway-live',
        integrations: { nativeRuntimeResources: true, nativeChatRuntime: false },
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
      if (url.origin === origin && url.pathname.startsWith('/api/chat/')) {
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
    await connect(page);
    await page.getByRole('heading', { name: '连接与概览', exact: true }).waitFor();
    const cookies = await context.cookies(`${origin}/api/snapshot`);
    assert(cookies.some(cookie => cookie.httpOnly && cookie.sameSite === 'Strict' && cookie.path === '/api'));

    const recent = page.locator('#recent-activity');
    await recent.locator('[data-activity-id="activity-0"]').waitFor();
    await recent.locator('[data-virtualized="true"]').waitFor();
    assert.equal(await recent.locator('img').count(), 0);
    assert(await recent.locator('[data-activity-id]').count() < 60);
    const first = recent.locator('[data-activity-id="activity-0"]');
    assert((await first.innerText()).includes(xssText));
    await first.getByRole('button', { name: '⋯', exact: true }).click();
    const activityDialog = page.getByRole('dialog');
    assert((await activityDialog.innerText()).includes(xssText));
    assert.equal(await activityDialog.locator('img').count(), 0);
    await page.keyboard.press('Escape');
    const viewport = recent.locator('[data-recent-activity-scroll]');
    await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await recent.locator('[data-activity-id="activity-99"]').waitFor();
    assert(await recent.locator('[data-activity-id]').count() < 60);
    state.unavailable = true;
    await recent.getByRole('button', { name: '刷新活动', exact: true }).click();
    await recent.getByRole('alert').waitFor();
    state.unavailable = false;
    await recent.getByRole('button', { name: '刷新活动', exact: true }).click();
    await recent.getByRole('alert').waitFor({ state: 'hidden' });
    assert.equal(state.browserPosts.some(request => request.pathname.startsWith('/api/chat/')), false);

    await navigateConsolePage(page, 'sessions');
    await page.locator('#session-filter').fill('420002');
    await page.locator(`[data-session-key="${filteredKey}"]`).waitFor();
    await page.locator(`[data-session-key="${resetKey}"]`).waitFor({ state: 'hidden' });
    await page.locator(`[data-session-key="${filteredKey}"]`).getByRole('button', { name: '420002', exact: true }).click();
    await page.getByRole('dialog', { name: '会话详情', exact: true }).getByText('fixture-session-private-420002', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#session-filter').fill('');
    const row = page.locator(`[data-session-key="${resetKey}"]`);
    await row.getByRole('button', { name: '解除绑定', exact: true }).click();
    const resetDialog = page.getByRole('dialog', { name: '解除这条会话的绑定？', exact: true });
    await resetDialog.waitFor();
    assert.equal(await resetDialog.locator('#session-reset-delete-ledger').isChecked(), false);
    await resetDialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(state.resetBodies.length, 0);
    state.sessions = state.sessions.map(session => session.key === resetKey ? { ...session, generation: 2, bindingRevision: 'b'.repeat(64) } : session);
    await row.getByRole('button', { name: '解除绑定', exact: true }).click();
    await resetDialog.locator('#session-reset-submit').click();
    await resetDialog.getByRole('alert').waitFor();
    assert.equal(await resetDialog.locator('#session-reset-submit').isDisabled(), true);
    assert.equal(state.resetBodies.length, 0);
    const conflictPosts = state.browserPosts.filter(request => request.pathname === sessionResetPath).length;
    await resetDialog.getByRole('button', { name: '关闭并刷新', exact: true }).click();
    assert.equal(state.browserPosts.filter(request => request.pathname === sessionResetPath).length, conflictPosts);
    state.resetOutcome = 'unknown';
    await row.getByRole('button', { name: '解除绑定', exact: true }).click();
    await resetDialog.locator('#session-reset-submit').click();
    await resetDialog.getByRole('alert').waitFor();
    assert.equal(state.resetBodies.length, 1);
    assert.equal(await resetDialog.locator('#session-reset-submit').isDisabled(), true);
    await resetDialog.getByRole('button', { name: '关闭并刷新', exact: true }).click();
    assert.equal(state.resetBodies.length, 1);
    state.resetOutcome = 'success';
    await row.getByRole('button', { name: '解除绑定', exact: true }).click();
    await resetDialog.locator('#session-reset-submit').click();
    await resetDialog.waitFor({ state: 'hidden' });
    await row.waitFor({ state: 'hidden' });
    assert.equal(state.resetBodies.length, 2);
    assert.equal(state.sessions.some(session => session.key === resetKey), false);
    const body = state.resetBodies.at(-1);
    assert.deepEqual(body, { key: resetKey, sessionId: resetSessionId, generation: 2, bindingRevision: 'b'.repeat(64), confirm: true });
    await navigateConsolePage(page, 'usage');
    await page.locator('[data-usage-metric="total-tokens"] strong').getByText('45.68k', { exact: true }).waitFor();
    await page.locator(`[data-usage-key="${resetKey}"] button`).first().click();
    await page.locator('[data-usage-turn]').first().waitFor();
    assert(state.fixtureRequests.some(request => request.includes(usageTurnsPath)));
    state.unavailable = true;
    await navigateConsolePage(page, 'sessions');
    await section(page, '原生会话不可用').waitFor();
    await navigateConsolePage(page, 'usage');
    await section(page, '用量暂不可用').waitFor();
    assert.equal(await page.locator('[data-usage-metric="total-tokens"]').count(), 0);
    await page.reload();
    await section(page, '用量暂不可用').waitFor();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await screenshot(page, `${width}-${theme}`);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      }
    }

    assert(await tokenIsAbsentFromStorage(page));
    assert.deepEqual(state.browserAuthorizations, []);
    assert.deepEqual(state.pageErrors, []);
    assert.deepEqual(state.externalRequests, []);
    assert.equal(await page.evaluate(() => globalThis.__activitySmokeXss === true), false);
    const result = {
      checkedAt: new Date().toISOString(),
      builtUi: true,
      realAdminServer: true,
      independentFixtureRoutes: true,
      fixedPrivateFixture: true,
      cookieAuthentication: true,
      sessionFilteringAndDetails: true,
      resetCancelWithoutPost: true,
      resetConflictWithoutRetry: true,
      resetUnknownWithoutRetry: true,
      resetSuccessOnlyConfirmsBindingRemoved: true,
      usageTotalsAndConversationDetails: true,
      perTurnEndpointRequired: true,
      disconnectedApiIsUnavailable: true,
      nativeRuntimeUnavailableAfterReload: true,
      mobileThemes: ['light', 'dark'],
      tokenStoredByBrowserScript: false,
      browserAuthorizationHeaders: 0,
      pageErrors: 0,
      externalRequests: 0,
      xssExecuted: false,
    };
    await writePrivateJson(new URL(`result-${runId}.json`, outputDirectory).pathname, result);
    console.log(`Activity smoke passed. Results: runtime/activity-smoke/result-${runId}.json`);
  } catch (error: unknown) {
    if (page !== undefined && !page.isClosed()) {
      await screenshot(page, 'failure').catch(() => undefined);
    }
    const failure = {
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
      state: {
        fixtureRequests: state.fixtureRequests,
        resetBodies: state.resetBodies,
        browserPosts: state.browserPosts,
        browserAuthorizations: state.browserAuthorizations,
        pageErrors: state.pageErrors,
        externalRequests: state.externalRequests,
      },
    };
    await writePrivateJson(new URL(`failure-${runId}.json`, outputDirectory).pathname, failure);
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
