import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page, type Request as PlaywrightRequest } from 'playwright';

import { createAdminServer } from '../src/admin/server.ts';
import { createLegacyAdminRoutes } from '../src/integrations/legacy-admin.ts';

const outputDirectory = new URL('../runtime/usage-smoke/', import.meta.url);
const builtApplication = new URL('../dist/admin-web/app.js', import.meta.url);
const administratorToken = 'usage-smoke-administrator-token-1234567890';
const legacyToken = 'usage-smoke-legacy-token-1234567890';
const primaryKey = 'group:510001';
const secondaryKey = 'private:520002';
const xssText = '<img src="/usage-smoke-xss" onerror="globalThis.__usageSmokeXss=true">';
const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const anchor = Date.UTC(2026, 9, 24, 8, 30, 0);

type ReadMode = 'success' | 'failure' | 'timeout';
type ResetMode = 'success' | 'unknown';

interface UpstreamRequest {
  readonly method: string;
  readonly pathname: string;
  readonly search: string;
}

interface BrowserPost {
  readonly pathname: string;
  readonly body: unknown;
}

interface SmokeState {
  summaryEpoch: number;
  summaryMode: ReadMode;
  seriesMode: ReadMode;
  turnsMode: ReadMode;
  recentMode: ReadMode;
  resetMode: ResetMode;
  activeSeries: number;
  maxActiveSeries: number;
  abortedReads: number;
  lateResponses: number;
  readonly upstreamRequests: UpstreamRequest[];
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

function buckets(cacheMiss: number, cacheHit: number, cacheWrite: number, output: number, reasoning: number) {
  return { cacheMiss, cacheHit, cacheWrite, output, reasoning };
}

function usageSummaryFixture(epoch: number): unknown {
  const adjustment = epoch * 0.01;
  const firstCost = 0.9 + adjustment;
  const secondCost = 0.3;
  const totalCost = firstCost + secondCost;
  const firstBuckets = buckets(20_000, 8_000, 500, 3_000, 1_500);
  const secondBuckets = buckets(10_000, 2_000, 500, 1_678, 845);
  const totalBuckets = buckets(30_000, 10_000, 1_000, 4_678, 2_345);
  const inputTokens = totalBuckets.cacheMiss + totalBuckets.cacheHit + totalBuckets.cacheWrite;
  return {
    ok: true,
    generatedAt: anchor + epoch * 1_000,
    priceVersion: 'fixture-prices-v3',
    currency: 'CNY',
    symbol: 'CN¥',
    nowTier: {
      model: 'fixture-chat-model',
      label: 'Fixture Chat',
      tier: 'peak',
      tierLabel: '高峰时段',
      currency: 'CNY',
      symbol: 'CN¥',
      unit: 1_000_000,
      estimated: false,
      cacheHit: 0.04,
      cacheMiss: 2,
      cacheWrite: 2,
      output: 8,
    },
    priceTable: {
      version: 'fixture-prices-v3',
      currency: 'CNY',
      symbol: 'CN¥',
      unit: 1_000_000,
      peakMultiplier: 2,
      peakWindows: [[9.5, 12], [14, 18.25]],
      peakWeekdays: [1, 2, 3, 4, 5],
      holidayCount: 33,
      models: {
        'fixture-chat-model': {
          label: xssText,
          off: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 },
        },
        'fixture-reasoner': {
          label: 'Fixture Reasoner',
          off: { cacheHit: 0.15, cacheMiss: 4.5, cacheWrite: 4.5, output: 13.5 },
        },
      },
    },
    totals: {
      buckets: totalBuckets,
      inputTokens,
      totalTokens: inputTokens + totalBuckets.output,
      cost: totalCost,
      attributedCost: totalCost - 0.15,
      unattributedCost: 0.15,
      byTier: { peak: 0.4, off: totalCost - 0.4 },
      estimated: true,
      conversations: 2,
      turns: 12,
      steps: 21,
      cacheHitRate: totalBuckets.cacheHit / inputTokens,
      avgCostPerTurn: totalCost / 12,
      avgCostPerStep: totalCost / 21,
    },
    conversations: [
      {
        key: primaryKey,
        sessionIds: ['fixture-session-group-510001'],
        sessions: 1,
        buckets: firstBuckets,
        cost: firstCost,
        attributedCost: firstCost - 0.1,
        unattributedCost: 0.1,
        byTier: { peak: 0.3, off: firstCost - 0.3 },
        cacheHitRate: firstBuckets.cacheHit / (firstBuckets.cacheMiss + firstBuckets.cacheHit + firstBuckets.cacheWrite),
        estimated: true,
        turns: 8,
        steps: 14,
        firstAt: anchor - 3_600_000,
        lastAt: anchor - 60_000,
        models: ['fixture-chat-model', xssText],
      },
      {
        key: secondaryKey,
        sessionIds: ['fixture-session-private-520002'],
        sessions: 1,
        buckets: secondBuckets,
        cost: secondCost,
        attributedCost: 0.25,
        unattributedCost: 0.05,
        byTier: { peak: 0.1, off: 0.2 },
        cacheHitRate: secondBuckets.cacheHit / (secondBuckets.cacheMiss + secondBuckets.cacheHit + secondBuckets.cacheWrite),
        estimated: false,
        turns: 4,
        steps: 7,
        firstAt: anchor - 7_200_000,
        lastAt: anchor - 120_000,
        models: ['fixture-reasoner'],
      },
    ],
    ledger: {
      file: '/private/fixture/never-forwarded.jsonl',
      journalLines: 61,
      maxLines: 20_000,
      droppedLines: 3,
      sessions: 2,
      baselines: 2,
      samples: 21,
      lastIngestAt: anchor - 30_000,
      lastCompactedAt: anchor - 3_600_000,
      priceVersion: 'fixture-prices-v3',
    },
  };
}

function usageSeriesFixture(hours: number): unknown {
  const bucketCount = hours === 720 ? 30 : hours === 168 ? 42 : hours === 72 ? 36 : 48;
  const bucketMs = hours * 3_600_000 / bucketCount;
  const to = anchor;
  const from = to - hours * 3_600_000;
  const zero = hours === 72;
  const seriesBuckets = Array.from({ length: bucketCount }, (_, index) => {
    const tier = index % 5 === 0 ? 'mixed' : index % 2 === 0 ? 'peak' : 'off';
    const multiplier = zero || index % 7 === 0 ? 0 : index + 1;
    const cacheMiss = multiplier * 10;
    const cacheHit = multiplier * 30;
    const cacheWrite = multiplier * 2;
    const output = multiplier * 4;
    return {
      t: from + index * bucketMs,
      cost: multiplier * 0.0002,
      tokens: cacheMiss + cacheHit + cacheWrite + output,
      cacheMiss,
      cacheHit,
      cacheWrite,
      output,
      turns: multiplier === 0 ? 0 : 1,
      steps: multiplier === 0 ? 0 : 2,
      tier,
      keys: multiplier === 0 ? [] : [index % 2 === 0 ? primaryKey : secondaryKey],
    };
  });
  const totals = seriesBuckets.reduce((sum, entry) => ({
    cost: sum.cost + entry.cost,
    tokens: sum.tokens + entry.tokens,
    turns: sum.turns + entry.turns,
    steps: sum.steps + entry.steps,
  }), { cost: 0, tokens: 0, turns: 0, steps: 0 });
  const busiest = zero ? null : seriesBuckets.reduce((best, entry) => entry.cost > best.cost ? entry : best, seriesBuckets[0]!);
  return {
    ok: true,
    generatedAt: anchor,
    currency: 'CNY',
    symbol: 'CN¥',
    hours,
    bucketMs,
    from,
    to,
    buckets: seriesBuckets,
    totals,
    busiest: busiest === null ? null : { t: busiest.t, cost: busiest.cost, tokens: busiest.tokens },
    estimated: true,
    countedSamples: totals.steps,
    offChartCost: 0.15,
    offChartTokens: 9_876,
  };
}

function usageTurnsFixture(key: string): unknown {
  const sessionId = key === secondaryKey ? 'fixture-session-private-520002' : 'fixture-session-group-510001';
  const turns = Array.from({ length: 3 }, (_, index) => ({
    sessionId,
    key,
    turn: 12 - index,
    steps: 2 + index,
    attempts: index + 1,
    startedAt: anchor - (index + 1) * 600_000,
    endedAt: anchor - index * 600_000,
    model: index === 1 ? xssText : 'fixture-chat-model',
    provider: index === 1 ? xssText : 'fixture-provider',
    buckets: buckets(900 + index * 10, 3_200 + index * 20, 30, 420 + index * 5, 40),
    cost: 0.03 + index * 0.01,
    tier: index === 0 ? 'peak' : index === 1 ? 'mixed' : 'off',
  }));
  const aggregate = turns.reduce((sum, entry) => buckets(
    sum.cacheMiss + entry.buckets.cacheMiss,
    sum.cacheHit + entry.buckets.cacheHit,
    sum.cacheWrite + entry.buckets.cacheWrite,
    sum.output + entry.buckets.output,
    sum.reasoning + entry.buckets.reasoning,
  ), buckets(0, 0, 0, 0, 0));
  const cost = turns.reduce((sum, entry) => sum + entry.cost, 0);
  return {
    ok: true,
    key,
    generatedAt: anchor,
    currency: 'CNY',
    symbol: 'CN¥',
    sessionIds: [sessionId],
    sessions: 1,
    buckets: aggregate,
    cost: cost + 0.02,
    attributedCost: cost,
    unattributedCost: 0.02,
    byTier: { peak: 0.04, off: cost - 0.02 },
    estimated: true,
    firstAt: anchor - 3_600_000,
    lastAt: anchor,
    models: ['fixture-chat-model'],
    turnLimit: 200,
    limited: false,
    turns,
  };
}

function usageRecentFixture(): unknown {
  return {
    ok: true,
    symbol: 'CN¥',
    entries: Array.from({ length: 40 }, (_, index) => ({
      time: anchor - index * 45_000,
      key: index % 3 === 0 ? null : index % 2 === 0 ? primaryKey : secondaryKey,
      sessionId: `fixture-recent-session-${index % 2}`,
      turn: 20 - Math.floor(index / 3),
      step: 1 + index % 4,
      retry: index % 3,
      model: index === 3 ? xssText : 'fixture-chat-model',
      tokens: 1_000 + index,
      cacheMiss: 200 + index,
      cacheHit: 700,
      cacheWrite: 20,
      output: 80,
      reasoning: 10,
      cost: 0.001 + index * 0.0001,
      tier: index % 2 === 0 ? 'peak' : 'off',
      estimated: index === 3,
    })),
  };
}

async function delayedResponse(state: SmokeState, request: Request, value: unknown): Promise<Response> {
  await new Promise<void>(resolvePromise => {
    request.signal.addEventListener('abort', () => {
      state.abortedReads += 1;
    }, { once: true });
    setTimeout(resolvePromise, 500);
  });
  state.lateResponses += 1;
  return jsonResponse(value);
}

function createFixtureFetch(state: SmokeState): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(request.headers.get('x-console-token'), legacyToken);
    state.upstreamRequests.push({ method: request.method, pathname: url.pathname, search: url.search });

    if (request.method === 'GET' && url.pathname === '/api/tokens/summary') {
      assert.equal(url.searchParams.get('limit'), '200');
      if (state.summaryMode === 'failure') return jsonResponse({ ok: false }, 503);
      if (state.summaryMode === 'timeout') return delayedResponse(state, request, usageSummaryFixture(state.summaryEpoch));
      return jsonResponse(usageSummaryFixture(state.summaryEpoch));
    }
    if (request.method === 'GET' && url.pathname === '/api/tokens/series') {
      const hours = Number(url.searchParams.get('hours'));
      assert([24, 72, 168, 720].includes(hours));
      state.activeSeries += 1;
      state.maxActiveSeries = Math.max(state.maxActiveSeries, state.activeSeries);
      try {
        if (state.seriesMode === 'failure') return jsonResponse({ ok: false }, 503);
        if (state.seriesMode === 'timeout') return await delayedResponse(state, request, usageSeriesFixture(hours));
        return jsonResponse(usageSeriesFixture(hours));
      } finally {
        state.activeSeries -= 1;
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/tokens/turns') {
      const key = url.searchParams.get('key') ?? '';
      assert([primaryKey, secondaryKey].includes(key));
      assert.equal(url.searchParams.get('limit'), '200');
      if (state.turnsMode === 'failure') return jsonResponse({ ok: false }, 503);
      if (state.turnsMode === 'timeout') return delayedResponse(state, request, usageTurnsFixture(key));
      return jsonResponse(usageTurnsFixture(key));
    }
    if (request.method === 'GET' && url.pathname === '/api/tokens/recent') {
      assert.equal(url.searchParams.get('limit'), '40');
      if (state.recentMode === 'failure') return jsonResponse({ ok: false }, 503);
      if (state.recentMode === 'timeout') return delayedResponse(state, request, usageRecentFixture());
      return jsonResponse(usageRecentFixture());
    }
    if (request.method === 'POST' && url.pathname === '/api/tokens/reset') {
      const body = await request.json() as unknown;
      state.upstreamResetBodies.push(body);
      if (state.resetMode === 'unknown') throw new TypeError('fixture reset result unknown');
      return jsonResponse({ ok: true });
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

async function waitForCount(read: () => number, minimum: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (read() >= minimum) return;
    await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 20));
  }
  assert.fail(`Timed out waiting for count ${minimum}; received ${read()}.`);
}

function upstreamCount(state: SmokeState, pathname: string): number {
  return state.upstreamRequests.filter(request => request.pathname === pathname).length;
}

function browserPostCount(state: SmokeState, pathname: string): number {
  return state.browserPosts.filter(request => request.pathname === pathname).length;
}

async function connect(page: Page): Promise<void> {
  await page.locator('#token').waitFor();
  await page.locator('#token').fill(administratorToken);
  await page.locator('#connect').click();
  await page.getByRole('button', { name: '断开连接', exact: true }).waitFor();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#token').count(), 0);
}

async function navigate(page: Page, label: string, pageId: string): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).first().click();
  await page.locator(`[data-page="${pageId}"]`).waitFor();
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.getByRole('combobox', { name: '显示模式' }).selectOption(theme);
  await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme);
}

async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate(value => {
    globalThis.__usageSmokeHidden = value;
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

async function closeResetDialog(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog');
  const close = dialog.getByRole('button', { name: /关闭|取消/ }).last();
  if (await close.count() > 0) await close.click();
  await dialog.waitFor({ state: 'hidden' });
}

async function assertBuiltUsageContract(): Promise<void> {
  let application: string;
  try {
    application = await readFile(builtApplication, 'utf8');
  } catch {
    throw new Error('Built UI is missing. Wait for the main thread build before running usage smoke.');
  }
  for (const text of ['usage-auto-refresh', 'usage-reset-open', 'data-usage-hours', 'usage-recent']) {
    assert(application.includes(text), `Built UI does not contain ${text}; wait for the main thread build.`);
  }
}

async function run(): Promise<void> {
  await assertBuiltUsageContract();
  await mkdir(outputDirectory, { recursive: true });
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'usage-smoke-'));
  const legacyRoot = join(fixtureDirectory, 'legacy');
  const state: SmokeState = {
    summaryEpoch: 0,
    summaryMode: 'success',
    seriesMode: 'success',
    turnsMode: 'success',
    recentMode: 'success',
    resetMode: 'success',
    activeSeries: 0,
    maxActiveSeries: 0,
    abortedReads: 0,
    lateResponses: 0,
    upstreamRequests: [],
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
    const routes = createLegacyAdminRoutes({
      legacyRoot,
      fetch: createFixtureFetch(state),
      timeoutMs: 250,
    });
    server = createAdminServer({
      token: administratorToken,
      snapshot: () => ({
        mode: 'gateway-live',
        integrations: { chatManagement: true },
        overview: {
          online: true,
          gatewayHealthy: true,
          metrics: { writes: 0, pending: 0, rejected: 0, unknown: 0, recoveredUnknown: 0 },
        },
        fixtureOnly: true,
      }),
      routes,
      handlerTimeoutMs: 1_000,
    });
    const address = await listen(server);
    const origin = `http://127.0.0.1:${address.port}`;

    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROMIUM_EXECUTABLE === undefined
        ? {}
        : { executablePath: process.env.CHROMIUM_EXECUTABLE }),
    });
    context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
      colorScheme: 'light',
      hasTouch: true,
    });
    await context.addInitScript(() => {
      globalThis.__usageSmokeHidden = false;
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => globalThis.__usageSmokeHidden,
      });
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => globalThis.__usageSmokeHidden ? 'hidden' : 'visible',
      });
    });
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
    const cookies = await context.cookies(`${origin}/api/auth/session`);
    assert(cookies.some(cookie => cookie.httpOnly && cookie.sameSite === 'Strict' && cookie.path === '/api'));
    await navigate(page, '用量统计', 'usage');
    await page.locator('[data-usage-metric="total-tokens"] strong').getByText('45,678', { exact: true }).waitFor();
    await page.locator('[data-usage-metric="estimated-cost"] strong').waitFor();
    await page.locator('[data-usage-metric="cache-hit-rate"] strong').waitFor();
    await page.locator('[data-usage-metric="avg-turn"] strong').waitFor();
    for (const metric of ['estimated-cost', 'total-tokens', 'cache-hit-rate', 'avg-turn']) {
      assert.equal(await page.locator(`[data-usage-metric="${metric}"]`).innerText().then(text => text.includes('不可用')), false);
    }
    await page.locator('[data-usage-metric="peak-off"] strong').waitFor();
    const summaryText = await page.locator('#usage-summary').innerText();
    assert(summaryText.includes('CN¥'));
    assert(summaryText.includes('最近压缩'));
    await page.locator(`[data-usage-key="${primaryKey}"]`).waitFor();
    await page.locator('#usage-chart').waitFor();
    await page.locator('#usage-recent [data-usage-recent]').first().waitFor();
    await page.locator('#usage-turns [data-usage-turn]').first().waitFor();
    assert(state.upstreamRequests.some(request => request.pathname === '/api/tokens/turns'
      && new URLSearchParams(request.search).get('key') === primaryKey));
    await page.locator('#usage-auto-refresh').selectOption('off');
    assert.equal(await page.locator('#usage-recent [data-usage-recent]').count(), 40);
    const recentText = await page.locator('#usage-recent').innerText();
    assert.equal(recentText.includes('Provider'), false);
    await page.getByText(xssText, { exact: true }).first().waitFor();
    const pricingText = await page.locator('#usage-prices').innerText();
    for (const expected of ['高峰时段', '× 2', '09:30–12:00', '14:00–18:15', '周一', '周五', '33 天', '1,000,000']) {
      assert(pricingText.includes(expected), `Pricing section is missing ${expected}.`);
    }
    const conversationText = await page.locator('#conversation-usage').innerText();
    for (const expected of ['未命中 / 命中 / 写入', '输出 / 推理', '命中率', '成本占比']) {
      assert(conversationText.includes(expected), `Conversation table is missing ${expected}.`);
    }
    assert.equal(await page.locator('body').innerText().then(text => text.includes('never-forwarded')), false);

    const initialSeriesCount = upstreamCount(state, '/api/tokens/series');
    for (const hours of [72, 168, 720, 24]) {
      await page.locator(`[data-usage-hours="${hours}"]`).click();
      await waitForCount(() => upstreamCount(state, '/api/tokens/series'), initialSeriesCount + [72, 168, 720, 24].indexOf(hours) + 1);
    }
    const beforeMetricSwitch = upstreamCount(state, '/api/tokens/series');
    await page.locator('[data-usage-chart-metric="tokens"]').click();
    await page.waitForTimeout(100);
    assert.equal(upstreamCount(state, '/api/tokens/series'), beforeMetricSwitch);
    await page.locator('[data-usage-chart-metric="cost"]').click();
    await page.waitForTimeout(100);
    assert.equal(upstreamCount(state, '/api/tokens/series'), beforeMetricSwitch);
    await page.locator('[data-usage-hours="72"]').click();
    await page.locator('#usage-series').getByText(/没有采样|无采样|正用量|真实 0/).waitFor();
    const currencyAxis = await page.locator('#usage-chart svg text').allTextContents();
    const currencyTicks = currencyAxis.filter(text => text.includes('¥'));
    assert(currencyTicks.length > 0);
    assert(currencyTicks.every(text => !/[1-9]/.test(text)));
    await page.locator('[data-usage-hours="24"]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-usage-bucket-index]').length === 48);

    const chartBuckets = page.locator('[data-usage-bucket-index]');
    assert(await chartBuckets.count() >= 3);
    await chartBuckets.nth(0).click();
    assert.equal(await chartBuckets.nth(0).getAttribute('aria-pressed'), 'true');
    await chartBuckets.nth(1).focus();
    await page.keyboard.press('Enter');
    assert.equal(await chartBuckets.nth(1).getAttribute('aria-pressed'), 'true');
    await chartBuckets.nth(2).tap();
    assert.equal(await chartBuckets.nth(2).getAttribute('aria-pressed'), 'true');
    const selectedBucketText = await page.locator('#usage-chart').innerText();
    for (const expected of ['估算费用', 'Token', '轮次 / 步骤', '缓存未命中 / 命中', '缓存写入', '输出', '涉及会话']) {
      assert(selectedBucketText.includes(expected), `Selected bucket details are missing ${expected}.`);
    }
    const tierLegend = page.locator('#usage-chart [aria-label="价格时段图例"]');
    for (const label of ['高峰', '空闲', '混合']) await tierLegend.getByText(label, { exact: true }).waitFor();
    await page.getByText(/最忙时间桶/).waitFor();
    await page.getByText(/图外累计历史|窗口外|更早.*历史/).waitFor();

    const keySelect = page.locator('#usage-key-select');
    const turnsBeforeSelection = upstreamCount(state, '/api/tokens/turns');
    await keySelect.selectOption(secondaryKey);
    await waitForCount(() => upstreamCount(state, '/api/tokens/turns'), turnsBeforeSelection + 1);
    await page.locator('#usage-turns [data-usage-turn]').first().waitFor();
    const turnsBeforeExplicitLoad = upstreamCount(state, '/api/tokens/turns');
    await page.locator('#usage-turns-load').click();
    await waitForCount(() => upstreamCount(state, '/api/tokens/turns'), turnsBeforeExplicitLoad + 1);
    await page.locator('#usage-turns [data-usage-turn]').first().waitFor();
    assert.equal(await page.locator('#usage-turns [data-usage-turn]').count(), 3);
    await page.locator('#usage-turns').getByText('fixture-provider', { exact: true }).first().waitFor();
    await page.locator('#usage-turns').getByText(/累计|归属|追溯/).first().waitFor();

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await page.screenshot({
        path: new URL(`desktop-${theme}-${runId}.png`, outputDirectory).pathname,
        fullPage: true,
        animations: 'disabled',
      });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert(await page.locator('#usage-turns table').locator('..').evaluate(element => element.scrollWidth > element.clientWidth));
      const mobileChart: { readonly clientWidth: number; readonly tickHeight: number; readonly viewBox: string | null } = await page.locator('#usage-chart svg').evaluate(svg => {
        const tick = svg.querySelector('text');
        return {
          clientWidth: svg.getBoundingClientRect().width,
          tickHeight: tick?.getBoundingClientRect().height ?? 0,
          viewBox: svg.getAttribute('viewBox'),
        };
      });
      assert(mobileChart.viewBox !== null);
      const viewBoxParts: number[] = mobileChart.viewBox.trim().split(/\s+/).map(Number);
      assert.equal(viewBoxParts.length, 4);
      const viewBoxWidth = viewBoxParts[2];
      assert(viewBoxWidth !== undefined && Number.isFinite(viewBoxWidth));
      assert(Math.abs(viewBoxWidth - mobileChart.clientWidth) <= Math.max(2, mobileChart.clientWidth * 0.05));
      assert(mobileChart.tickHeight >= 8);
      await page.screenshot({
        path: new URL(`mobile-${theme}-${runId}.png`, outputDirectory).pathname,
        fullPage: true,
        animations: 'disabled',
      });
    }
    await page.setViewportSize({ width: 1440, height: 1100 });

    await page.locator('[data-usage-hours="168"]').click();
    await page.locator('[data-usage-chart-metric="tokens"]').click();
    await keySelect.selectOption(secondaryKey);
    const turnsBeforeManualRefresh = upstreamCount(state, '/api/tokens/turns');
    await page.locator('#usage-refresh').click();
    await waitForCount(() => upstreamCount(state, '/api/tokens/turns'), turnsBeforeManualRefresh + 1);
    const controlsBefore = await page.locator('#usage-auto-refresh').boundingBox();
    await page.locator('#usage-auto-refresh').selectOption('3000');
    const beforeAuto = upstreamCount(state, '/api/tokens/summary');
    const turnsBeforeAuto = upstreamCount(state, '/api/tokens/turns');
    await waitForCount(() => upstreamCount(state, '/api/tokens/summary'), beforeAuto + 1, 4_500);
    await waitForCount(() => upstreamCount(state, '/api/tokens/turns'), turnsBeforeAuto + 1, 4_500);
    assert.equal(await page.locator('[data-usage-hours="168"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-usage-chart-metric="tokens"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await keySelect.inputValue(), secondaryKey);
    const controlsAfter = await page.locator('#usage-auto-refresh').boundingBox();
    assert(controlsBefore && controlsAfter);
    assert(Math.abs(controlsBefore.x - controlsAfter.x) < 1 && Math.abs(controlsBefore.y - controlsAfter.y) < 1);

    await setHidden(page, true);
    const hiddenCount = upstreamCount(state, '/api/tokens/summary');
    await page.waitForTimeout(3_300);
    assert.equal(upstreamCount(state, '/api/tokens/summary'), hiddenCount);
    await setHidden(page, false);
    await waitForCount(() => upstreamCount(state, '/api/tokens/summary'), hiddenCount + 1, 2_000);
    await page.locator('#usage-auto-refresh').selectOption('off');

    state.seriesMode = 'timeout';
    const abortedBeforeLeave = state.abortedReads;
    await page.locator('#usage-refresh').click();
    await waitForCount(() => state.activeSeries, 1);
    await navigate(page, '概览', 'overview');
    await waitForCount(() => state.abortedReads, abortedBeforeLeave + 1);
    await page.waitForTimeout(550);
    state.seriesMode = 'success';
    const turnsBeforeReturn = upstreamCount(state, '/api/tokens/turns');
    await navigate(page, '用量统计', 'usage');
    await page.locator('[data-usage-metric="total-tokens"] strong').waitFor();
    await waitForCount(() => upstreamCount(state, '/api/tokens/turns'), turnsBeforeReturn + 1);
    await page.locator('#usage-turns [data-usage-turn]').first().waitFor();

    state.summaryMode = 'timeout';
    const summaryBeforeDelayedLeave = upstreamCount(state, '/api/tokens/summary');
    const turnsBeforeDelayedLeave = upstreamCount(state, '/api/tokens/turns');
    const abortedBeforeDelayedLeave = state.abortedReads;
    const lateBeforeDelayedLeave = state.lateResponses;
    await page.locator('#usage-refresh').click();
    await waitForCount(() => upstreamCount(state, '/api/tokens/summary'), summaryBeforeDelayedLeave + 1);
    await navigate(page, '概览', 'overview');
    await waitForCount(() => state.abortedReads, abortedBeforeDelayedLeave + 1);
    await waitForCount(() => state.lateResponses, lateBeforeDelayedLeave + 1, 1_000);
    assert.equal(upstreamCount(state, '/api/tokens/turns'), turnsBeforeDelayedLeave);
    state.summaryMode = 'success';
    await navigate(page, '用量统计', 'usage');
    await page.locator('[data-usage-metric="total-tokens"] strong').waitFor();

    state.recentMode = 'failure';
    await page.locator('#usage-refresh').click();
    await page.locator('#usage-recent [role="alert"]').waitFor();
    assert.equal(await page.locator('[data-usage-metric="total-tokens"] strong').count(), 1);
    assert.equal(await page.locator('#usage-recent').innerText().then(text => /暂无最近调用|（空）|接口已成功返回空流水/.test(text)), false);
    state.recentMode = 'success';
    const recentBeforeRecovery = upstreamCount(state, '/api/tokens/recent');
    const turnsBeforeRecovery = upstreamCount(state, '/api/tokens/turns');
    await page.locator('#usage-refresh').click();
    await waitForCount(() => upstreamCount(state, '/api/tokens/recent'), recentBeforeRecovery + 1);
    await waitForCount(() => upstreamCount(state, '/api/tokens/turns'), turnsBeforeRecovery + 1);
    await page.waitForFunction(() => {
      const button = document.getElementById('usage-refresh');
      return button instanceof HTMLButtonElement && !button.disabled;
    });
    await page.locator('#usage-recent [data-usage-recent]').first().waitFor();

    state.seriesMode = 'timeout';
    const abortedBeforeTimeout = state.abortedReads;
    const lateBeforeTimeout = state.lateResponses;
    await page.locator('#usage-auto-refresh').selectOption('3000');
    await page.waitForTimeout(50);
    await setHidden(page, false);
    await waitForCount(() => state.activeSeries, 1);
    await setHidden(page, false);
    await page.waitForTimeout(50);
    assert.equal(state.maxActiveSeries, 1);
    await page.locator('#usage-series [role="alert"]').waitFor();
    await page.locator('#usage-auto-refresh').selectOption('off');
    const timeoutText = await page.locator('#usage-series').innerText();
    await waitForCount(() => state.abortedReads, abortedBeforeTimeout + 1);
    await waitForCount(() => state.lateResponses, lateBeforeTimeout + 1, 1_000);
    assert.equal(await page.locator('#usage-series').innerText(), timeoutText);
    state.seriesMode = 'success';
    await page.locator('#usage-refresh').click();
    await page.locator('#usage-chart [data-usage-bucket-index]').first().waitFor();
    assert.equal(state.maxActiveSeries, 1);

    const resetPostsBeforeCancel = browserPostCount(state, '/api/legacy/usage/reset');
    await page.locator('#usage-reset-open').click();
    const resetDialog = page.getByRole('dialog');
    await resetDialog.getByText(/非原子|并发.*新用量|新用量.*丢弃/).waitFor();
    await resetDialog.locator('#usage-reset-confirm').fill('清空用量账本');
    await resetDialog.getByRole('button', { name: '取消', exact: true }).click();
    await resetDialog.waitFor({ state: 'hidden' });
    assert.equal(browserPostCount(state, '/api/legacy/usage/reset'), resetPostsBeforeCancel);
    assert.equal(state.upstreamResetBodies.length, 0);

    await page.locator('#usage-refresh').click();
    await page.waitForFunction(() => {
      const button = document.getElementById('usage-refresh');
      return button instanceof HTMLButtonElement && !button.disabled;
    });
    const openedRevision = await page.evaluate(async () => {
      const response = await fetch('/api/legacy/usage?limit=200');
      const value = await response.json() as { revision?: unknown };
      return value.revision;
    });
    assert.equal(typeof openedRevision, 'string');
    await page.locator('#usage-auto-refresh').selectOption('3000');
    await page.locator('#usage-reset-open').click();
    state.summaryEpoch += 1;
    const summaryBeforeDialogPoll = upstreamCount(state, '/api/tokens/summary');
    await setHidden(page, false);
    await waitForCount(() => upstreamCount(state, '/api/tokens/summary'), summaryBeforeDialogPoll + 1);
    await resetDialog.locator('#usage-reset-confirm').fill('清空用量账本');
    await resetDialog.locator('#usage-reset-submit').click();
    await resetDialog.locator('[role="alert"]').filter({ hasText: /账本已.*变化|重新.*revision/ }).waitFor();
    await page.waitForTimeout(200);
    assert.equal(browserPostCount(state, '/api/legacy/usage/reset'), resetPostsBeforeCancel + 1);
    assert.equal(state.upstreamResetBodies.length, 0);
    const conflictPost = state.browserPosts.filter(request => request.pathname === '/api/legacy/usage/reset').at(-1);
    assert(isRecord(conflictPost?.body));
    assert.deepEqual(conflictPost.body, {
      revision: openedRevision,
      confirm: '清空用量账本',
    });
    await closeResetDialog(page);
    await page.locator('#usage-auto-refresh').selectOption('off');
    await page.locator('#usage-refresh').click();
    await page.locator('[data-usage-metric="total-tokens"] strong').waitFor();

    state.resetMode = 'unknown';
    await page.locator('#usage-reset-open').click();
    await resetDialog.locator('#usage-reset-confirm').fill('清空用量账本');
    await resetDialog.locator('#usage-reset-submit').click();
    await resetDialog.locator('[role="alert"]').filter({ hasText: /未知|无法确认|不要.*重试|勿.*提交/ }).waitFor();
    assert(await resetDialog.locator('#usage-reset-confirm').isDisabled());
    assert(await resetDialog.locator('#usage-reset-submit').isDisabled());
    await page.waitForTimeout(300);
    assert.equal(browserPostCount(state, '/api/legacy/usage/reset'), resetPostsBeforeCancel + 2);
    assert.equal(state.upstreamResetBodies.length, 1);
    await resetDialog.locator('#usage-reset-submit').dispatchEvent('click');
    await page.waitForTimeout(200);
    assert.equal(browserPostCount(state, '/api/legacy/usage/reset'), resetPostsBeforeCancel + 2);
    await closeResetDialog(page);

    state.resetMode = 'success';
    await page.locator('#usage-refresh').click();
    await page.locator('#usage-reset-open').click();
    await resetDialog.locator('#usage-reset-confirm').fill('清空用量账本');
    await resetDialog.locator('#usage-reset-submit').click();
    await resetDialog.waitFor({ state: 'hidden' });
    await waitForCount(() => state.upstreamResetBodies.length, 2);
    assert.deepEqual(state.upstreamResetBodies, [{}, {}]);
    assert.equal(browserPostCount(state, '/api/legacy/usage/reset'), resetPostsBeforeCancel + 3);

    assert.equal(await page.evaluate(() => globalThis.__usageSmokeXss === true), false);
    assert.deepEqual(state.browserAuthorizations, []);
    assert.deepEqual(state.pageErrors, []);
    assert.deepEqual(state.externalRequests, []);
    const result = {
      checkedAt: new Date().toISOString(),
      builtUi: true,
      realAdminServer: true,
      realLegacyAdminRoutes: true,
      fixedPrivateFixture: true,
      completeSummaryAndPricing: true,
      ranges: [24, 72, 168, 720],
      metricSwitchWithoutFetch: true,
      mouseKeyboardTouchBuckets: true,
      zeroSeriesHasNoInventedPositiveAxis: true,
      tiersAndOffChartHistory: true,
      currentTierAndPricingRules: true,
      conversationAndTurnDetails: true,
      recentEntries: 40,
      recentProviderNotInvented: true,
      responsiveThemes: ['desktop-light', 'desktop-dark', 'mobile-light', 'mobile-dark'],
      mobileChartUsesReadableGeometry: true,
      autoRefreshVisibleOnly: true,
      singleFlight: state.maxActiveSeries === 1,
      controlsStableAcrossRefresh: true,
      leaveCancelsRequests: true,
      leavePreventsLateTurns: true,
      partialFailureDoesNotFakeZero: true,
      timeoutAborted: true,
      lateResponseIgnored: true,
      resetCancelWithoutPost: true,
      resetConflictWithoutRetry: true,
      resetUnknownWithoutRetry: true,
      resetSuccessOnFixtureOnly: true,
      productionResetCalls: 0,
      cookieAuthentication: true,
      browserAuthorizationHeaders: 0,
      xssExecuted: false,
      pageErrors: 0,
      externalRequests: 0,
    };
    await writePrivateJson(new URL(`result-${runId}.json`, outputDirectory).pathname, result);
    console.log(`Usage smoke passed. Results: runtime/usage-smoke/result-${runId}.json`);
  } catch (error: unknown) {
    if (page !== undefined && !page.isClosed()) {
      await page.screenshot({
        path: new URL(`failure-${runId}.png`, outputDirectory).pathname,
        fullPage: true,
        animations: 'disabled',
      }).catch(() => undefined);
    }
    await writePrivateJson(new URL(`failure-${runId}.json`, outputDirectory).pathname, {
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
      state: {
        upstreamRequests: state.upstreamRequests,
        upstreamResetBodies: state.upstreamResetBodies,
        browserPosts: state.browserPosts,
        browserAuthorizations: state.browserAuthorizations,
        pageErrors: state.pageErrors,
        externalRequests: state.externalRequests,
        abortedReads: state.abortedReads,
        lateResponses: state.lateResponses,
        maxActiveSeries: state.maxActiveSeries,
      },
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
  var __usageSmokeHidden: boolean | undefined;
  var __usageSmokeXss: boolean | undefined;
}

await run();
