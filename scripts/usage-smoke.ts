import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Request as PlaywrightRequest } from 'playwright';

import { AdminRequestError, createAdminServer, type AdminRoute } from '../src/admin/server.ts';

const outputDirectory = new URL('../runtime/usage-smoke/', import.meta.url);
const builtApplication = new URL('../dist/admin-web/app.js', import.meta.url);
const administratorToken = 'usage-smoke-administrator-token-1234567890';
const usagePath = '/api/chat/usage';
const usageSeriesPath = '/api/chat/usage/series';
const usageTurnsPath = '/api/chat/usage/turns';
const usageRecentPath = '/api/chat/usage/recent';
const usageResetPath = '/api/chat/usage/reset';
const primaryKey = 'group:510001';
const secondaryKey = 'private:520002';
const xssText = '<img src="/usage-smoke-xss" onerror="globalThis.__usageSmokeXss=true">';
const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const anchor = Date.UTC(2026, 9, 24, 8, 30, 0);
const fixtureHandlerTimeoutMs = 250;
const navigationHandlerTimeoutMs = 2_000;

type ReadMode = 'success' | 'failure' | 'timeout' | 'navigation';
type ResetMode = 'success' | 'unknown';

interface FixtureRequest {
  readonly method: string;
  readonly pathname: string;
  readonly search: string;
}

interface BrowserPost {
  readonly pathname: string;
  readonly body: unknown;
}

interface ChartBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface ChartHoverEvidence {
  readonly bucketIndex: number;
  readonly bar: ChartBounds;
  readonly activeBar: ChartBounds;
  readonly plot: ChartBounds;
  readonly tooltip: ChartBounds;
  readonly viewport: { readonly width: number; readonly height: number };
}

interface FixedTablePanelEvidence {
  readonly bodyHeight: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
  readonly clientWidth: number;
  readonly scrollWidth: number;
  readonly headerTopOffset: number;
}

interface FixedTablePanelOptions {
  readonly bodySelector: string;
  readonly scrollSelector: string;
  readonly label: string;
}

interface TokenBreakdownEvidence {
  readonly input: string;
  readonly cache: { readonly label: string; readonly value: string; readonly title: string };
  readonly output: { readonly label: string; readonly value: string; readonly title: string };
}

interface ChartBucketCountsEvidence {
  readonly token: string;
  readonly turnsAndSteps: string;
  readonly input: string;
  readonly output: string;
  readonly cache: { readonly label: string; readonly value: string; readonly title: string };
}

interface ShareProgressEvidence {
  readonly key: string;
  readonly value: number;
  readonly valueText: string;
  readonly visualRatio: number;
}

interface DelayedReadEvidence {
  readonly pathname: string;
  readonly startedAt: number;
  abortedAt: number | null;
  settledAt: number | null;
  abortReason: string | null;
  clientAbortedAt: number | null;
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
  readonly delayedReads: DelayedReadEvidence[];
  readonly fixtureRequests: FixtureRequest[];
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
    source: 'chat-ledger',
    revision: `usage-fixture-${epoch}`,
    generatedAt: anchor + epoch * 1_000,
    limit: 200,
    limited: false,
    unavailable: [],
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
        ...Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`fixture-additional-model-${index}`, {
          label: `Additional model ${index}`,
          off: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 },
        }])),
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
      outputTokens: totalBuckets.output,
      cacheHitTokens: totalBuckets.cacheHit,
      cacheMissTokens: totalBuckets.cacheMiss,
      cacheWriteTokens: totalBuckets.cacheWrite,
      reasoningTokens: totalBuckets.reasoning,
      totalTokens: inputTokens + totalBuckets.output,
      cost: totalCost,
      attributedCost: totalCost - 0.15,
      unattributedCost: 0.15,
      byTier: { peak: 0.4, off: totalCost - 0.4 },
      estimated: true,
      conversations: 26,
      turns: 12,
      steps: 21,
      cacheHitRate: totalBuckets.cacheHit / inputTokens,
      avgCostPerTurn: totalCost / 12,
      avgCostPerStep: totalCost / 21,
    },
    conversations: [
      {
        key: primaryKey,
        sessionCount: 1,
        buckets: firstBuckets,
        inputTokens: firstBuckets.cacheMiss + firstBuckets.cacheHit + firstBuckets.cacheWrite,
        outputTokens: firstBuckets.output,
        cacheHitTokens: firstBuckets.cacheHit,
        totalTokens: firstBuckets.cacheMiss + firstBuckets.cacheHit + firstBuckets.cacheWrite + firstBuckets.output,
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
        sessionCount: 1,
        buckets: secondBuckets,
        inputTokens: secondBuckets.cacheMiss + secondBuckets.cacheHit + secondBuckets.cacheWrite,
        outputTokens: secondBuckets.output,
        cacheHitTokens: secondBuckets.cacheHit,
        totalTokens: secondBuckets.cacheMiss + secondBuckets.cacheHit + secondBuckets.cacheWrite + secondBuckets.output,
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
      ...Array.from({ length: 24 }, (_, index) => ({
        key: `group:${610000 + index}`,
        sessionCount: 0,
        buckets: buckets(0, 0, 0, 0, 0),
        inputTokens: 0,
        outputTokens: 0,
        cacheHitTokens: 0,
        totalTokens: 0,
        cost: 0,
        attributedCost: 0,
        unattributedCost: 0,
        byTier: { peak: 0, off: 0 },
        cacheHitRate: 0,
        estimated: false,
        turns: 0,
        steps: 0,
        firstAt: 0,
        lastAt: 0,
        models: [],
      })),
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
      keys: multiplier === 0 ? [] : index === 23
        ? Array.from({ length: 500 }, (_, keyIndex) => `group:${710000 + keyIndex}`)
        : [index % 2 === 0 ? primaryKey : secondaryKey],
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
  const turnCount = key === primaryKey ? 50 : 3;
  const turns = Array.from({ length: turnCount }, (_, index) => ({
    sessionId,
    key,
    turn: key === primaryKey ? turnCount - index : 12 - index,
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
    key,
    generatedAt: anchor,
    currency: 'CNY',
    symbol: 'CN¥',
    sessionIds: [sessionId],
    sessionCount: 1,
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
      sid: `fixture-recent-session-${index % 2}`,
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

async function delayedValue(state: SmokeState, signal: AbortSignal, pathname: string, value: unknown, afterAbort = false): Promise<unknown> {
  const evidence: DelayedReadEvidence = { pathname, startedAt: Date.now(), abortedAt: null, settledAt: null, abortReason: null, clientAbortedAt: null };
  state.delayedReads.push(evidence);
  const aborted = new Promise<void>(resolvePromise => {
    signal.addEventListener('abort', () => {
      state.abortedReads += 1;
      evidence.abortedAt = Date.now();
      evidence.abortReason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason);
      resolvePromise();
    }, { once: true });
  });
  if (afterAbort) await aborted;
  await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 500));
  state.lateResponses += 1;
  evidence.settledAt = Date.now();
  return value;
}

function recordRequest(state: SmokeState, method: string, pathname: string, query: URLSearchParams): void {
  const search = query.toString();
  state.fixtureRequests.push({ method, pathname, search: search === '' ? '' : `?${search}` });
}

function createFixtureRoutes(state: SmokeState): readonly AdminRoute[] {
  return [
    {
      method: 'GET', pathname: '/api/chat/status', handle: () => ({
        runtimeConnected: state.summaryMode !== 'failure',
      }),
    },
    {
      method: 'GET', pathname: usagePath, handle: ({ query, signal }) => {
        recordRequest(state, 'GET', usagePath, query);
        assert.equal(query.get('limit'), '200');
        if (state.summaryMode === 'failure') throw new AdminRequestError(503, 'runtime_not_connected');
        if (state.summaryMode === 'timeout' || state.summaryMode === 'navigation') {
          return delayedValue(state, signal, usagePath, usageSummaryFixture(state.summaryEpoch), state.summaryMode === 'navigation');
        }
        return usageSummaryFixture(state.summaryEpoch);
      },
    },
    {
      method: 'GET', pathname: usageSeriesPath, maxResponseBytes: 1024 * 1024, handle: async ({ query, signal }) => {
        recordRequest(state, 'GET', usageSeriesPath, query);
        const hours = Number(query.get('hours'));
        assert([24, 72, 168, 720].includes(hours));
        assert.equal(query.get('buckets'), '48');
        state.activeSeries += 1;
        state.maxActiveSeries = Math.max(state.maxActiveSeries, state.activeSeries);
        try {
          if (state.seriesMode === 'failure') throw new AdminRequestError(503, 'runtime_not_connected');
          if (state.seriesMode === 'timeout' || state.seriesMode === 'navigation') {
            return await delayedValue(state, signal, usageSeriesPath, usageSeriesFixture(hours), state.seriesMode === 'navigation');
          }
          return usageSeriesFixture(hours);
        } finally {
          state.activeSeries -= 1;
        }
      },
    },
    {
      method: 'GET', pathname: usageTurnsPath, maxResponseBytes: 4 * 1024 * 1024, handle: ({ query, signal }) => {
        recordRequest(state, 'GET', usageTurnsPath, query);
        const key = query.get('key') ?? '';
        assert([primaryKey, secondaryKey].includes(key));
        assert.equal(query.get('limit'), '200');
        if (state.turnsMode === 'failure') throw new AdminRequestError(503, 'runtime_not_connected');
        if (state.turnsMode === 'timeout') return delayedValue(state, signal, usageTurnsPath, usageTurnsFixture(key));
        return usageTurnsFixture(key);
      },
    },
    {
      method: 'GET', pathname: usageRecentPath, maxResponseBytes: 2 * 1024 * 1024, handle: ({ query, signal }) => {
        recordRequest(state, 'GET', usageRecentPath, query);
        assert.equal(query.get('limit'), '40');
        if (state.recentMode === 'failure') throw new AdminRequestError(503, 'runtime_not_connected');
        if (state.recentMode === 'timeout') return delayedValue(state, signal, usageRecentPath, usageRecentFixture());
        return usageRecentFixture();
      },
    },
    {
      method: 'POST', pathname: usageResetPath, handle: ({ body, query }) => {
        recordRequest(state, 'POST', usageResetPath, query);
        if (!body || body.revision !== `usage-fixture-${state.summaryEpoch}`) {
          throw new AdminRequestError(409, 'usage_revision_conflict');
        }
        if (body.confirm !== '清空用量账本') throw new AdminRequestError(400, 'invalid_request');
        state.resetBodies.push(body);
        if (state.resetMode === 'unknown') throw new AdminRequestError(504, 'usage_reset_unknown');
        return { ok: true, resetAccepted: true };
      },
    },
  ];
}

function createFixtureServer(state: SmokeState, handlerTimeoutMs = fixtureHandlerTimeoutMs): Server {
  const routes = createFixtureRoutes(state);
  return createAdminServer({
    token: administratorToken,
    snapshot: () => ({
      mode: 'gateway-live',
      integrations: { nativeRuntimeResources: true, nativeChatRuntime: true },
      overview: {
        online: true,
        gatewayHealthy: true,
        metrics: { writes: 0, pending: 0, rejected: 0, unknown: 0, recoveredUnknown: 0 },
      },
      fixtureOnly: true,
    }),
    routes,
    handlerTimeoutMs,
  });
}

function observeUsageReadSignals(): void {
  globalThis.__usageSmokeReadSignals = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    const pathname = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
    if (pathname.startsWith('/api/chat/usage') && options?.signal) {
      const evidence = { pathname, abortedAt: null as number | null };
      globalThis.__usageSmokeReadSignals.push(evidence);
      options.signal.addEventListener('abort', () => { evidence.abortedAt = Date.now(); }, { once: true });
    }
    return originalFetch(input, options);
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

function fixtureCount(state: SmokeState, pathname: string): number {
  return state.fixtureRequests.filter(request => request.pathname === pathname).length;
}

function browserPostCount(state: SmokeState, pathname: string): number {
  return state.browserPosts.filter(request => request.pathname === pathname).length;
}

function usageReadCount(state: SmokeState): number {
  return state.fixtureRequests.filter(request => request.method === 'GET' && request.pathname.startsWith('/api/chat/usage')).length;
}

function chartBar(page: Page, bucketIndex: number): Locator {
  return page.locator(`#usage-chart .recharts-surface path[data-usage-bucket-index="${bucketIndex}"], #usage-chart .recharts-surface rect[data-usage-bucket-index="${bucketIndex}"]`).first();
}

function bucketDetails(page: Page): Locator {
  return page.locator('#usage-chart [data-usage-bucket-details]');
}

function assertBoundsWithin(inner: ChartBounds, outer: ChartBounds, label: string): void {
  assert(inner.width > 0 && inner.height > 0, `${label} has no visible area.`);
  assert(inner.x >= outer.x - 1 && inner.y >= outer.y - 1
    && inner.x + inner.width <= outer.x + outer.width + 1
    && inner.y + inner.height <= outer.y + outer.height + 1, `${label} extends beyond its containing bounds: ${JSON.stringify({ inner, outer })}.`);
}

async function assertNoHoverBand(page: Page): Promise<void> {
  const bands = await page.locator('#usage-chart .recharts-surface').evaluate(svg => {
    const plot = svg.querySelector('.recharts-cartesian-grid')?.getBoundingClientRect();
    if (!plot || plot.width <= 0 || plot.height <= 0) throw new Error('Recharts plot grid is missing.');
    return Array.from(svg.querySelectorAll('path, rect')).filter(element => {
      if (element.closest('defs, clipPath')) return false;
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden'
        && bounds.width > 0 && bounds.width < plot.width / 4 && bounds.height >= plot.height - 1
        && (style.fill === 'transparent' || style.fill === 'none' || style.fill === 'rgba(0, 0, 0, 0)'
          || Number(style.fillOpacity) === 0);
    }).map(element => ({ tag: element.tagName, className: element.getAttribute('class'), bounds: element.getBoundingClientRect().toJSON() }));
  });
  assert.deepEqual(bands, [], 'Chart contains a full-height transparent hover or selection band.');
  assert.equal(await page.locator('#usage-chart .recharts-tooltip-cursor').count(), 0, 'Tooltip rendered a cursor band.');
}

async function assertChartHover(page: Page, bucketIndex: number): Promise<ChartHoverEvidence> {
  const bar = chartBar(page, bucketIndex);
  await bar.scrollIntoViewIfNeeded();
  const barBounds = await bar.boundingBox();
  assert(barBounds && barBounds.width > 0 && barBounds.height > 0, `Bucket ${bucketIndex} has no positive-height bar.`);
  await bar.hover();
  const tooltip = page.getByRole('tooltip');
  await tooltip.waitFor();
  assert.equal(await tooltip.getAttribute('data-usage-tooltip-index'), String(bucketIndex));
  const active = page.locator('#usage-chart .recharts-active-bar');
  await active.waitFor();
  await page.waitForFunction(expected =>
    document.querySelector('#usage-chart .recharts-active-bar [data-usage-bucket-index]')?.getAttribute('data-usage-bucket-index') === String(expected),
  bucketIndex);
  const activeBounds = await active.boundingBox();
  const plotBounds = await page.locator('#usage-chart .recharts-cartesian-grid').boundingBox();
  const tooltipBounds = await tooltip.boundingBox();
  const viewport = page.viewportSize();
  assert(activeBounds && plotBounds && tooltipBounds && viewport);
  assertBoundsWithin(activeBounds, plotBounds, 'Active bar');
  assertBoundsWithin(activeBounds, barBounds, 'Active bar relative to its source column');
  assertBoundsWithin(tooltipBounds, { x: 0, y: 0, width: viewport.width, height: viewport.height }, 'Floating tooltip');
  await assertNoHoverBand(page);
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  await screenshot(page, `hover-${viewport.width}-${theme}-bucket-${bucketIndex}`);
  await page.mouse.move(barBounds.x + barBounds.width / 2, plotBounds.y + 2);
  await assertNoHoverBand(page);
  await page.locator('#usage-summary').hover();
  await tooltip.waitFor({ state: 'hidden' });
  await active.waitFor({ state: 'hidden' });
  await assertNoHoverBand(page);
  return { bucketIndex, bar: barBounds, activeBar: activeBounds, plot: plotBounds, tooltip: tooltipBounds, viewport };
}

async function assertZeroBars(page: Page): Promise<void> {
  const positiveBars = await page.locator('#usage-chart .recharts-surface').evaluate(svg =>
    Array.from(svg.querySelectorAll('.recharts-bar-rectangle path, .recharts-bar-rectangle rect, .recharts-active-bar path, .recharts-active-bar rect, [data-usage-bucket-index]'))
      .filter(element => !element.closest('defs, clipPath') && element.getBoundingClientRect().height > 0)
      .map(element => ({ bucketIndex: element.getAttribute('data-usage-bucket-index'), height: element.getBoundingClientRect().height }))
  );
  assert.deepEqual(positiveBars, [], 'Zero-valued buckets must not draw positive-height bars.');
}

async function assertReadableMobileChart(page: Page): Promise<{ readonly width: number; readonly tickHeights: readonly number[] }> {
  await page.waitForFunction(() => {
    const svg = document.querySelector('#usage-chart svg.recharts-surface');
    if (!(svg instanceof SVGSVGElement)) return false;
    const width = svg.getBoundingClientRect().width;
    return width > 0 && Math.abs(svg.viewBox.baseVal.width - width) <= Math.max(2, width * 0.05);
  });
  const geometry = await page.locator('#usage-chart .recharts-surface').evaluate(svg => ({
    width: svg.getBoundingClientRect().width,
    tickHeights: Array.from(svg.querySelectorAll('.recharts-cartesian-axis-tick-value')).map(tick => tick.getBoundingClientRect().height),
  }));
  assert(geometry.tickHeights.length > 0, 'Mobile chart has no axis labels.');
  assert(geometry.tickHeights.every(height => height >= 8), `Mobile chart labels are too small: ${JSON.stringify(geometry)}.`);
  return geometry;
}

async function assertLongBucketDetails(page: Page): Promise<{ readonly viewportWidth: number; readonly height: number; readonly clientHeight: number; readonly scrollHeight: number }> {
  const details = bucketDetails(page);
  assert.equal(await details.getAttribute('data-usage-bucket-details'), '23');
  const keys = (await details.innerText()).match(/group:7\d{5}/g) ?? [];
  assert.equal(keys.length, 500, 'Pinned details lost conversation keys.');
  const evidence = await details.evaluate(element => {
    element.scrollTop = element.scrollHeight;
    return {
      viewportWidth: innerWidth,
      height: element.getBoundingClientRect().height,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
      overflowY: getComputedStyle(element).overflowY,
    };
  });
  assert(Math.abs(evidence.height - 144) <= 2, `Pinned bucket details grew beyond 144px: ${JSON.stringify(evidence)}.`);
  assert(evidence.scrollHeight > evidence.clientHeight && evidence.scrollTop > 0,
    `Pinned bucket details did not scroll internally: ${JSON.stringify(evidence)}.`);
  assert(['auto', 'scroll'].includes(evidence.overflowY));
  await details.evaluate(element => element.scrollTo(0, 0));
  return evidence;
}

async function assertFixedTablePanelLayout(page: Page, options: FixedTablePanelOptions): Promise<FixedTablePanelEvidence> {
  const body = page.locator(options.bodySelector);
  const bodyHeight = await body.evaluate(element => element.getBoundingClientRect().height);
  assert(Math.abs(bodyHeight - 384) <= 2, `${options.label} body height is ${bodyHeight}px instead of 384px.`);

  const scroll = page.locator(options.scrollSelector);
  const evidence = await scroll.evaluate(async (element, measuredBodyHeight) => {
    const style = getComputedStyle(element);
    const header = element.querySelector('thead');
    if (!(header instanceof HTMLTableSectionElement)) throw new Error('Fixed table panel header is missing.');
    const initialHeaderOffset = header.getBoundingClientRect().top - element.getBoundingClientRect().top;
    element.scrollTop = Math.min(Math.max(160, initialHeaderOffset + 80), element.scrollHeight - element.clientHeight);
    element.scrollLeft = Math.min(160, element.scrollWidth - element.clientWidth);
    await new Promise<void>(resolvePromise => requestAnimationFrame(() => resolvePromise()));
    const bounds = element.getBoundingClientRect();
    const headerBounds = header.getBoundingClientRect();
    const result = {
      bodyHeight: measuredBodyHeight,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      scrollTop: element.scrollTop,
      scrollLeft: element.scrollLeft,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      headerPosition: getComputedStyle(header).position,
      headerTopOffset: headerBounds.top - bounds.top,
    };
    element.scrollTo(0, 0);
    return result;
  }, bodyHeight);
  assert(evidence.scrollHeight > evidence.clientHeight, `${options.label} does not overflow vertically: ${JSON.stringify(evidence)}.`);
  assert(evidence.scrollWidth > evidence.clientWidth, `${options.label} does not overflow horizontally: ${JSON.stringify(evidence)}.`);
  assert(evidence.scrollTop > 0 && evidence.scrollLeft > 0, `${options.label} did not scroll internally: ${JSON.stringify(evidence)}.`);
  assert(['auto', 'scroll'].includes(evidence.overflowX) && ['auto', 'scroll'].includes(evidence.overflowY),
    `${options.label} does not enable both scroll axes: ${JSON.stringify(evidence)}.`);
  assert.equal(evidence.headerPosition, 'sticky');
  assert(Math.abs(evidence.headerTopOffset) <= 2, `${options.label} header did not remain sticky: ${JSON.stringify(evidence)}.`);
  return evidence;
}

async function detailsOpen(panel: Locator): Promise<boolean> {
  return panel.evaluate(element => element instanceof HTMLDetailsElement && element.open);
}

async function expandDetails(panel: Locator): Promise<void> {
  if (!await detailsOpen(panel)) await panel.locator('summary').click();
  assert.equal(await detailsOpen(panel), true);
}

async function assertFixedHeight(locator: Locator, label: string): Promise<number> {
  const height = await locator.evaluate(element => element.getBoundingClientRect().height);
  assert(Math.abs(height - 384) <= 2, `${label} height is ${height}px instead of 384px.`);
  return height;
}

async function assertTokenBreakdown(row: Locator): Promise<TokenBreakdownEvidence> {
  const input = row.locator('[data-token-direction="input"]');
  const output = row.locator('[data-token-direction="output"]');
  const cache = input.locator('[data-token-cache]');
  assert.equal(await input.count(), 1);
  assert.equal(await output.count(), 1);
  assert.equal(await cache.count(), 1);

  const inputRows = input.locator(':scope > span');
  const outputRows = output.locator(':scope > span');
  assert.equal(await inputRows.count(), 2);
  assert.equal(await outputRows.count(), 1);
  assert.equal(await inputRows.first().locator('svg.lucide-arrow-up').count(), 1);
  assert.equal(await cache.locator('svg.lucide-database').count(), 1);
  assert.equal(await outputRows.first().locator('svg.lucide-arrow-down').count(), 1);

  const evidence = {
    input: await inputRows.first().locator('strong').innerText(),
    cache: {
      label: await cache.locator('span').innerText(),
      value: await cache.locator('strong').innerText(),
      title: await cache.getAttribute('title') ?? '',
    },
    output: {
      label: await outputRows.locator('span').innerText(),
      value: await outputRows.locator('strong').innerText(),
      title: await output.getAttribute('title') ?? '',
    },
  };
  assert.equal(evidence.input, '4,130');
  assert.deepEqual(evidence.cache, {
    label: '缓存',
    value: '3,200',
    title: '缓存命中 3,200；缓存写入 30；未命中 900。未命中 = 输入 − 缓存命中 − 缓存写入。',
  });
  assert.deepEqual(evidence.output, {
    label: '输出',
    value: '420',
    title: '推理 40；推理不额外计入总量。',
  });
  return evidence;
}

async function assertChartBucketCounts(container: Locator): Promise<ChartBucketCountsEvidence> {
  const rows = container.locator('dl').first().locator(':scope > div');
  assert.equal(await rows.count(), 5);
  assert.deepEqual(await rows.locator(':scope > dt').allTextContents(), ['Token', '轮次 / 步骤', '输入', '输出', '缓存']);
  assert.equal(await rows.nth(2).locator('dt svg.lucide-arrow-up').count(), 1);
  assert.equal(await rows.nth(3).locator('dt svg.lucide-arrow-down').count(), 1);
  assert.equal(await rows.nth(4).locator('dt svg.lucide-database').count(), 1);

  const cache = rows.nth(4);
  const evidence = {
    token: await rows.nth(0).locator('dd').innerText(),
    turnsAndSteps: await rows.nth(1).locator('dd').innerText(),
    input: await rows.nth(2).locator('dd').innerText(),
    output: await rows.nth(3).locator('dd').innerText(),
    cache: {
      label: await cache.locator('dt').innerText(),
      value: await cache.locator('dd').innerText(),
      title: await cache.getAttribute('title') ?? '',
    },
  };
  assert.deepEqual(evidence, {
    token: '138',
    turnsAndSteps: '1 / 2',
    input: '126',
    output: '12',
    cache: {
      label: '缓存',
      value: '90',
      title: '缓存写入 6；未命中 30。未命中 = 输入 − 缓存命中 − 缓存写入。',
    },
  });
  return evidence;
}

async function assertSummaryTokenCaption(metric: Locator): Promise<void> {
  const rows = metric.locator('p > span > span');
  assert.equal(await rows.count(), 2);
  assert.equal(await rows.nth(0).locator('svg.lucide-arrow-up').count(), 1);
  assert.equal(await rows.nth(1).locator('svg.lucide-arrow-down').count(), 1);
  assert.deepEqual(await rows.allTextContents(), ['41,000', '4,678']);
}

async function assertShareProgress(page: Page, key: string, expected: number): Promise<ShareProgressEvidence> {
  const progress = page.locator(`[data-usage-key="${key}"] [data-slot="progress"][role="progressbar"]`);
  assert.equal(await progress.count(), 1);
  await progress.waitFor();
  await page.waitForTimeout(150);
  const evidence = await progress.evaluate((element, expectedValue) => {
    const track = element.querySelector('[data-slot="progress-track"]');
    const indicator = element.querySelector('[data-slot="progress-indicator"]');
    if (!(track instanceof HTMLElement) || !(indicator instanceof HTMLElement)) {
      throw new Error('Usage share progress track or indicator is missing.');
    }
    const trackWidth = track.getBoundingClientRect().width;
    const indicatorWidth = indicator.getBoundingClientRect().width;
    return {
      key: element.closest('[data-usage-key]')?.getAttribute('data-usage-key') ?? '',
      value: Number(element.getAttribute('aria-valuenow')),
      valueText: element.getAttribute('aria-valuetext') ?? '',
      visualRatio: trackWidth === 0 ? -1 : indicatorWidth / trackWidth,
      expectedValue,
    };
  }, expected);
  assert.equal(evidence.key, key);
  assert.equal(evidence.value, expected);
  assert.equal(evidence.valueText, `${expected.toFixed(1)}%`);
  assert(Math.abs(evidence.visualRatio - expected / 100) <= 0.02,
    `Usage share progress is not visually truthful: ${JSON.stringify(evidence)}.`);
  return { key: evidence.key, value: evidence.value, valueText: evidence.valueText, visualRatio: evidence.visualRatio };
}

async function connect(page: Page): Promise<void> {
  await page.locator('#token').waitFor();
  await page.locator('#token').fill(administratorToken);
  await page.locator('#connect').click();
  await page.getByRole('button', { name: '断开连接', exact: true }).waitFor();
  await page.getByRole('dialog', { name: '连接你的工作台', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#token').count(), 0);
}

async function navigate(page: Page, label: string, pageId: string): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).first().click();
  await page.locator(`[data-page="${pageId}"]`).waitFor();
}

async function leaveUsageDuringRequest(page: Page): Promise<void> {
  await page.getByRole('button', { name: '概览', exact: true }).first().dispatchEvent('click');
  await page.locator('[data-page="overview"]').waitFor();
}

async function assertNavigationCancellation(browser: Browser, state: SmokeState, compactTotal: string): Promise<readonly DelayedReadEvidence[]> {
  const server = createFixtureServer(state, navigationHandlerTimeoutMs);
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  const evidence: DelayedReadEvidence[] = [];
  try {
    const address = await listen(server);
    const origin = `http://127.0.0.1:${address.port}`;
    context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, colorScheme: 'light' });
    context.setDefaultTimeout(15_000);
    context.setDefaultNavigationTimeout(30_000);
    await context.addInitScript(observeUsageReadSignals);
    page = await context.newPage();
    page.on('pageerror', error => state.pageErrors.push(error.message));
    page.on('request', request => {
      const url = new URL(request.url());
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== origin) state.externalRequests.push(url.href);
      if (url.origin === origin && url.pathname.startsWith('/api/chat/')) {
        const authorization = request.headers().authorization;
        if (authorization !== undefined) state.browserAuthorizations.push(authorization);
      }
      if (url.origin === origin && request.method() === 'POST') {
        void requestBody(request).then(body => state.browserPosts.push({ pathname: url.pathname, body }));
      }
    });
    await page.goto(origin);
    await connect(page);
    await navigate(page, '用量统计', 'usage');
    await page.locator('[data-usage-metric="total-tokens"] strong').waitFor();
    await page.locator('#usage-auto-refresh').selectOption('off');
    const turnsPanel = page.locator('details[data-usage-turns-panel]');
    await expandDetails(turnsPanel);
    await page.locator('#usage-turns [data-usage-turn]').first().waitFor();

    for (const pathname of [usageSeriesPath, usagePath]) {
      await page.locator('#usage-auto-refresh').selectOption('off');
      await page.waitForFunction(() => {
        const refresh = document.getElementById('usage-refresh');
        const turns = document.getElementById('usage-turns-load');
        return refresh instanceof HTMLButtonElement && !refresh.disabled && turns instanceof HTMLButtonElement && !turns.disabled;
      });
      if (pathname === usageSeriesPath) {
        await page.getByRole('switch', { name: '详细数值', exact: true }).click();
        assert.equal(await page.locator('#usage-detailed-counts').isChecked(), true);
        state.seriesMode = 'navigation';
      } else {
        state.summaryMode = 'navigation';
      }
      const readsBefore = fixtureCount(state, pathname);
      const turnsBefore = fixtureCount(state, usageTurnsPath);
      const lateBefore = state.lateResponses;
      await page.locator('#usage-refresh').dispatchEvent('click');
      await waitForCount(() => fixtureCount(state, pathname), readsBefore + 1);
      const delayed = state.delayedReads.at(-1);
      assert(delayed?.pathname === pathname && delayed.abortedAt === null,
        'Navigation fixture must still be pending when leaving usage.');
      await leaveUsageDuringRequest(page);
      delayed.clientAbortedAt = await page.evaluate(expected =>
        globalThis.__usageSmokeReadSignals.findLast(entry => entry.pathname === expected)?.abortedAt ?? null, pathname);
      assert(delayed.clientAbortedAt !== null, `Browser did not abort the ${pathname} signal.`);
      await waitForCount(() => delayed.abortedAt === null ? 0 : 1, 1, navigationHandlerTimeoutMs + 1_000);
      assert.equal(delayed.abortReason, 'client disconnected',
        `Navigation fixture was not cancelled by the client: ${JSON.stringify(delayed)}.`);
      await waitForCount(() => state.lateResponses, lateBefore + 1, 2_000);
      assert(delayed.settledAt !== null && delayed.settledAt > delayed.clientAbortedAt,
        'Navigation fixture did not produce a response after browser cancellation.');
      assert.equal(fixtureCount(state, usageTurnsPath), turnsBefore,
        'Leaving usage triggered a late chained turn request.');
      evidence.push(delayed);
      state.summaryMode = 'success';
      state.seriesMode = 'success';
      const turnsBeforeReturn = fixtureCount(state, usageTurnsPath);
      await navigate(page, '用量统计', 'usage');
      await page.locator('[data-usage-metric="total-tokens"] strong').waitFor();
      assert.equal(await page.locator('#usage-detailed-counts').isChecked(), false);
      assert.equal(await page.locator('[data-usage-metric="total-tokens"] strong').innerText(), compactTotal);
      await expandDetails(turnsPanel);
      await waitForCount(() => fixtureCount(state, usageTurnsPath), turnsBeforeReturn + 1);
      await page.locator('#usage-turns [data-usage-turn]').first().waitFor();
    }
    return evidence;
  } catch (error) {
    if (page && !page.isClosed()) await screenshot(page, 'navigation-failure').catch(() => undefined);
    throw error;
  } finally {
    state.summaryMode = 'success';
    state.seriesMode = 'success';
    await context?.close().catch(() => undefined);
    await closeServer(server);
  }
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
  const dialog = page.getByRole('dialog', { name: '确认清空用量账本？', exact: true });
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
  const builtAt = (await stat(builtApplication)).mtimeMs;
  for (const source of ['pages/usage.tsx', 'components/usage-chart.tsx', 'components/usage-token-breakdown.tsx', 'components/ui/progress.tsx']) {
    const modifiedAt = (await stat(new URL(`../web/${source}`, import.meta.url))).mtimeMs;
    assert(builtAt >= modifiedAt, `Built UI predates web/${source}; wait for the main thread build.`);
  }
  for (const text of ['usage-auto-refresh', 'usage-reset-open', 'data-usage-hours', 'usage-recent', 'usage-bucket-select',
    'usage-detailed-counts', 'data-usage-turns-panel', 'data-usage-turns-body', 'data-usage-turns-scroll',
    'data-usage-recent-panel', 'data-usage-recent-body', 'data-usage-recent-scroll',
    'data-token-direction', 'data-token-cache']) {
    assert(application.includes(text), `Built UI does not contain ${text}; wait for the main thread build.`);
  }
}

async function run(): Promise<void> {
  await assertBuiltUsageContract();
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await chmod(outputDirectory, 0o700);
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'usage-smoke-'));
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
    delayedReads: [],
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
  let clickedBar: { readonly index: string | null; readonly bounds: ChartBounds } | undefined;
  const hoverEvidence: ChartHoverEvidence[] = [];
  const mobileChartEvidence: Array<{ readonly width: number; readonly tickHeights: readonly number[] }> = [];
  const mobileTableEvidence: Array<{ readonly theme: string; readonly conversations: FixedTablePanelEvidence; readonly prices: FixedTablePanelEvidence }> = [];
  const bucketDetailEvidence: Array<{ readonly viewportWidth: number; readonly height: number; readonly clientHeight: number; readonly scrollHeight: number }> = [];

  try {
    server = createFixtureServer(state);
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
    context.setDefaultTimeout(15_000);
    context.setDefaultNavigationTimeout(30_000);
    await context.addInitScript(observeUsageReadSignals);
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
    await page.getByRole('heading', { name: '工作台概览', exact: true }).waitFor();
    const cookies = await context.cookies(`${origin}/api/auth/session`);
    assert(cookies.some(cookie => cookie.httpOnly && cookie.sameSite === 'Strict' && cookie.path === '/api'));
    await navigate(page, '用量统计', 'usage');
    await page.locator('[data-usage-metric="total-tokens"] strong').waitFor();
    const turnsPanel = page.locator('details[data-usage-turns-panel]');
    const turnsSummary = turnsPanel.locator('summary');
    await turnsSummary.getByText('轮次记录', { exact: true }).waitFor();
    const turnsPanelInitiallyOpen = await detailsOpen(turnsPanel);
    assert.equal(turnsPanelInitiallyOpen, false);
    await expandDetails(turnsPanel);
    await page.locator('#usage-turns [data-usage-turn]').first().waitFor();
    assert.equal(await page.locator('#usage-turns [data-usage-turn]').count(), 50);
    const turnsPanelEvidence = await assertFixedTablePanelLayout(page, {
      bodySelector: 'div[data-usage-turns-body]',
      scrollSelector: '[data-usage-turns-scroll]',
      label: 'Turn details',
    });
    const recentPanel = page.locator('details[data-usage-recent-panel]');
    const recentSummary = recentPanel.locator('summary');
    await recentSummary.getByText('调用记录', { exact: true }).waitFor();
    const recentPanelInitiallyOpen = await detailsOpen(recentPanel);
    assert.equal(recentPanelInitiallyOpen, false);
    await expandDetails(recentPanel);
    await page.locator('#usage-recent [data-usage-recent]').first().waitFor();
    assert.equal(await page.locator('#usage-recent [data-usage-recent]').count(), 40);
    const recentPanelEvidence = await assertFixedTablePanelLayout(page, {
      bodySelector: 'div[data-usage-recent-body]',
      scrollSelector: '[data-usage-recent-scroll]',
      label: 'Recent calls',
    });
    const readsBeforeRecentCollapse = usageReadCount(state);
    await recentSummary.click();
    assert.equal(await detailsOpen(recentPanel), false);
    await page.waitForTimeout(100);
    assert.equal(usageReadCount(state), readsBeforeRecentCollapse, 'Collapsing recent calls refetched usage data.');
    const readsBeforeRecentExpand = usageReadCount(state);
    await recentSummary.click();
    assert.equal(await detailsOpen(recentPanel), true);
    await page.waitForTimeout(100);
    assert.equal(usageReadCount(state), readsBeforeRecentExpand, 'Expanding recent calls refetched usage data.');
    await page.locator('#usage-bucket-select option').first().waitFor({ state: 'attached' });
    await page.locator('#usage-auto-refresh').selectOption('off');
    const detailedCounts = page.getByRole('switch', { name: '详细数值', exact: true });
    const detailedCountsInput = page.locator('#usage-detailed-counts');
    assert.equal(await detailedCountsInput.isChecked(), false);
    const compactTotal = await page.locator('[data-usage-metric="total-tokens"] strong').innerText();
    assert.match(compactTotal, /^45(?:\.\d+)?k$/i);
    const costBeforeCounts = await page.locator('[data-usage-metric="estimated-cost"] strong').innerText();
    const rateBeforeCounts = await page.locator('[data-usage-metric="cache-hit-rate"] strong').innerText();
    const readsBeforeCounts = usageReadCount(state);
    const storageBeforeCounts = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
    await detailedCounts.click();
    assert.equal(await detailedCountsInput.isChecked(), true);
    const totalTokensMetric = page.locator('[data-usage-metric="total-tokens"]');
    await totalTokensMetric.locator('strong').getByText('45,678', { exact: true }).waitFor();
    await assertSummaryTokenCaption(totalTokensMetric);
    const tokenBreakdownEvidence = await assertTokenBreakdown(page.locator('#usage-turns [data-usage-turn]').first());
    await page.locator('[data-usage-metric="estimated-cost"] strong').waitFor();
    await page.locator('[data-usage-metric="cache-hit-rate"] strong').waitFor();
    for (const metric of ['estimated-cost', 'total-tokens', 'cache-hit-rate']) {
      assert.equal(await page.locator(`[data-usage-metric="${metric}"]`).innerText().then(text => text.includes('不可用')), false);
    }
    const averages = page.locator('#usage-summary > .panel-body > dl');
    assert.deepEqual(await averages.locator('dt').allTextContents(), ['平均每轮', '平均每步', '高峰 / 空闲', '未逐轮归属']);
    assert.deepEqual(await averages.locator('dd').allTextContents(), ['CN¥0.10', 'CN¥0.057143', 'CN¥0.40 / CN¥0.80', 'CN¥0.15']);
    await expandDetails(page.locator('#usage-summary details'));
    const summaryText = await page.locator('#usage-summary').innerText();
    assert(summaryText.includes('CN¥'));
    assert(summaryText.includes('最近写入 / 压缩'));
    const conversationsPanel = page.locator('details[data-usage-conversations-panel]');
    await conversationsPanel.locator('summary').getByText('会话记录', { exact: true }).waitFor();
    assert.equal(await detailsOpen(conversationsPanel), false);
    const readsBeforeConversationsExpand = usageReadCount(state);
    await expandDetails(conversationsPanel);
    assert.equal(usageReadCount(state), readsBeforeConversationsExpand, 'Expanding conversation records refetched usage data.');
    const conversationsPanelHeight = await assertFixedHeight(
      page.locator('[data-usage-conversations-scroll]'), 'Conversation records',
    );
    const conversationsPanelEvidence = await assertFixedTablePanelLayout(page, {
      bodySelector: '[data-usage-conversations-scroll]',
      scrollSelector: '[data-usage-conversations-scroll]',
      label: 'Conversation records',
    });
    await page.locator(`[data-usage-key="${primaryKey}"]`).waitFor();
    await page.locator('#usage-chart').waitFor();
    assert.equal(await page.locator('#usage-chart').getAttribute('data-chart-engine'), 'recharts');
    await page.locator('#usage-recent [data-usage-recent]').first().waitFor();
    await page.locator('#usage-turns [data-usage-turn]').first().waitFor();
    assert(state.fixtureRequests.some(request => request.pathname === usageTurnsPath
      && new URLSearchParams(request.search).get('key') === primaryKey));
    await page.locator('#usage-auto-refresh').selectOption('off');
    assert.equal(await page.locator('#usage-recent [data-usage-recent]').count(), 40);
    const recentText = await page.locator('#usage-recent').innerText();
    assert.equal(recentText.includes('Provider'), false);
    await page.getByText(xssText, { exact: true }).first().waitFor();
    const pricesPanel = page.locator('details[data-usage-prices-panel]');
    await pricesPanel.locator('summary').waitFor();
    assert.equal(await detailsOpen(pricesPanel), false);
    const readsBeforePricesExpand = usageReadCount(state);
    await expandDetails(pricesPanel);
    assert.equal(usageReadCount(state), readsBeforePricesExpand, 'Expanding pricing details refetched usage data.');
    const pricesPanelHeight = await assertFixedHeight(page.locator('[data-usage-prices-scroll]'), 'Pricing details');
    const pricingText = await page.locator('#usage-prices').innerText();
    for (const expected of ['高峰时段', '× 2', '09:30–12:00', '14:00–18:15', '周一', '周五', '33 天', '1,000,000']) {
      assert(pricingText.includes(expected), `Pricing section is missing ${expected}.`);
    }
    const conversationText = await page.locator('#conversation-usage').innerText();
    for (const expected of ['输入与缓存', '输出', '命中率', '成本占比']) {
      assert(conversationText.includes(expected), `Conversation table is missing ${expected}.`);
    }
    for (const table of ['#conversation-usage', '#usage-turns', '#usage-recent']) {
      assert.equal(await page.locator(`${table} thead`).getByText('输出', { exact: true }).count(), 1);
    }
    const shareProgressEvidence = [
      await assertShareProgress(page, primaryKey, 75),
      await assertShareProgress(page, secondaryKey, 25),
      await assertShareProgress(page, 'group:610000', 0),
    ];
    assert.equal(await page.locator('body').innerText().then(text => text.includes('never-forwarded')), false);
    await detailedCounts.click();
    assert.equal(await page.locator('[data-usage-metric="total-tokens"] strong').innerText(), compactTotal);
    assert.equal(await page.locator('[data-usage-metric="estimated-cost"] strong').innerText(), costBeforeCounts);
    assert.equal(await page.locator('[data-usage-metric="cache-hit-rate"] strong').innerText(), rateBeforeCounts);
    assert.equal(usageReadCount(state), readsBeforeCounts, 'Count display toggle refetched usage data.');
    assert.deepEqual(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })), storageBeforeCounts, 'Count display mode was persisted in browser storage.');

    await turnsSummary.click();
    assert.equal(await detailsOpen(turnsPanel), false);
    const turnsBeforeConversationClick = fixtureCount(state, usageTurnsPath);
    await page.locator(`[data-usage-key="${secondaryKey}"] button`).click();
    await waitForCount(() => fixtureCount(state, usageTurnsPath), turnsBeforeConversationClick + 1);
    assert.equal(await detailsOpen(turnsPanel), true);
    assert.equal(await page.locator('#usage-key-select').inputValue(), secondaryKey);
    await page.waitForFunction(() => document.querySelectorAll('#usage-turns [data-usage-turn]').length === 3);
    await page.locator(`[data-usage-key="${primaryKey}"] button`).click();
    await page.waitForFunction(() => document.querySelectorAll('#usage-turns [data-usage-turn]').length === 50);

    const initialSeriesCount = fixtureCount(state, usageSeriesPath);
    for (const hours of [72, 168, 720, 24]) {
      await page.locator(`[data-usage-hours="${hours}"]`).click();
      await waitForCount(() => fixtureCount(state, usageSeriesPath), initialSeriesCount + [72, 168, 720, 24].indexOf(hours) + 1);
    }
    const beforeMetricSwitch = fixtureCount(state, usageSeriesPath);
    await page.locator('[data-usage-chart-metric="tokens"]').click();
    await page.waitForTimeout(100);
    assert.equal(fixtureCount(state, usageSeriesPath), beforeMetricSwitch);
    await page.locator('[data-usage-chart-metric="cost"]').click();
    await page.waitForTimeout(100);
    assert.equal(fixtureCount(state, usageSeriesPath), beforeMetricSwitch);
    await page.locator('[data-usage-hours="72"]').click();
    await expandDetails(page.locator('#usage-series details'));
    await page.locator('#usage-series').getByText(/没有采样|无采样|正用量|真实 0/).waitFor();
    const currencyAxis = await page.locator('#usage-chart svg text').allTextContents();
    const currencyTicks = currencyAxis.filter(text => text.includes('¥'));
    assert(currencyTicks.length > 0);
    assert(currencyTicks.every(text => !/[1-9]/.test(text)));
    assert.equal(await page.locator('#usage-bucket-select option:not([value=""])').count(), 36);
    await assertZeroBars(page);
    await page.locator('#usage-bucket-select').selectOption('0');
    await bucketDetails(page).getByText('Token', { exact: true }).waitFor();
    const zeroToken = bucketDetails(page).locator('dl > div').filter({ has: page.getByText('Token', { exact: true }) }).locator('dd');
    assert.equal(await zeroToken.innerText(), '0');
    await assertZeroBars(page);
    await page.locator('[data-usage-hours="24"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#usage-bucket-select option:not([value=""])').length === 48);
    const bucketSelect = page.getByRole('combobox', { name: '查看时间桶', exact: true });
    assert.equal(await bucketSelect.getAttribute('id'), 'usage-bucket-select');
    const bucketValues = await bucketSelect.locator('option:not([value=""])').evaluateAll(options => options.map(option => option.getAttribute('value')));
    assert.deepEqual(bucketValues, Array.from({ length: 48 }, (_, index) => String(index)));
    await bucketSelect.selectOption('0');
    await bucketSelect.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    assert.equal(await bucketSelect.inputValue(), '1');
    clickedBar = await chartBar(page, 2).evaluate(element => ({
      index: element.getAttribute('data-usage-bucket-index'),
      bounds: element.getBoundingClientRect().toJSON(),
    }));
    await chartBar(page, 2).click();
    await page.waitForFunction(expected => {
      const select = document.getElementById('usage-bucket-select');
      const details = document.querySelector('#usage-chart [data-usage-bucket-details]');
      return select instanceof HTMLSelectElement && select.value === String(expected)
        && details?.getAttribute('data-usage-bucket-details') === String(expected);
    }, 2, { timeout: 3_000 });
    assert.equal(await bucketSelect.inputValue(), '2');
    const pointerFocusOutlines = await page.locator('#usage-chart svg [tabindex]').evaluateAll(elements => elements.map(element => {
      const style = getComputedStyle(element);
      return {
        tag: element.tagName,
        className: element.getAttribute('class'),
        focused: element === document.activeElement,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
      };
    }));
    assert(pointerFocusOutlines.length > 0, 'Chart has no internal focus groups to validate after the pointer click.');
    assert(pointerFocusOutlines.every(outline => outline.outlineStyle === 'none' || Number.parseFloat(outline.outlineWidth) === 0),
      `An internal SVG focus group rendered an outline after the pointer click: ${JSON.stringify(pointerFocusOutlines)}.`);
    const chartBucketCountsEvidence = await assertChartBucketCounts(bucketDetails(page));
    const selectedBucketText = await bucketDetails(page).innerText();
    assert(selectedBucketText.includes('CN¥0.0006') && selectedBucketText.includes('涉及会话'));
    for (const bucketIndex of [2, 23, 47]) hoverEvidence.push(await assertChartHover(page, bucketIndex));
    assert.equal(await bucketDetails(page).innerText(), selectedBucketText, 'Hover changed the pinned bucket details.');
    assert.equal(await bucketSelect.inputValue(), '2', 'Hover changed the selected bucket.');
    await bucketSelect.selectOption('23');
    bucketDetailEvidence.push(await assertLongBucketDetails(page));
    const tierLegend = page.locator('#usage-chart [aria-label="价格时段图例"]');
    for (const label of ['高峰', '空闲', '混合']) await tierLegend.getByText(label, { exact: true }).waitFor();
    await page.getByText(/最忙桶/).waitFor();
    await page.getByText(/图外累计历史|窗口外|更早.*历史/).waitFor();

    await page.locator('[data-usage-chart-metric="tokens"]').click();
    await bucketSelect.selectOption('47');
    const selectedToken = bucketDetails(page).locator('dl > div').filter({ has: page.getByText('Token', { exact: true }) }).locator('dd');
    const compactBucketTokens = await selectedToken.innerText();
    assert.match(compactBucketTokens, /^2(?:\.\d+)?k$/i);
    const tokenAxisLabels = page.locator('#usage-chart .recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value');
    await tokenAxisLabels.filter({ hasText: /k/i }).first().waitFor();
    const compactTokenTicks = await tokenAxisLabels.allTextContents();
    assert(compactTokenTicks.some(text => /k/i.test(text)), 'Token axis did not use compact counts.');
    const readsBeforeChartCounts = usageReadCount(state);
    await detailedCounts.click();
    assert.equal(await selectedToken.innerText(), '2,208');
    await tokenAxisLabels.filter({ hasText: /\d,\d{3}/ }).first().waitFor();
    const detailedTokenTicks = await tokenAxisLabels.allTextContents();
    assert(detailedTokenTicks.some(text => /\d,\d{3}/.test(text)) && detailedTokenTicks.every(text => !/[kmb]/i.test(text)));
    await chartBar(page, 47).hover();
    await page.getByRole('tooltip').waitFor();
    assert((await page.getByRole('tooltip').innerText()).includes('2,208'), 'Floating tooltip did not show detailed token counts.');
    await page.locator('#usage-summary').hover();
    await page.getByRole('tooltip').waitFor({ state: 'hidden' });
    await detailedCounts.click();
    assert.equal(await selectedToken.innerText(), compactBucketTokens);
    await chartBar(page, 47).hover();
    await page.getByRole('tooltip').waitFor();
    assert((await page.getByRole('tooltip').innerText()).includes(compactBucketTokens), 'Floating tooltip did not return to compact token counts.');
    await page.locator('#usage-summary').hover();
    await page.getByRole('tooltip').waitFor({ state: 'hidden' });
    assert.equal(usageReadCount(state), readsBeforeChartCounts, 'Chart count display toggle refetched data.');
    assert.equal(await page.locator('[data-usage-metric="estimated-cost"] strong').innerText(), costBeforeCounts);
    assert.equal(await page.locator('[data-usage-metric="cache-hit-rate"] strong').innerText(), rateBeforeCounts);
    await page.locator('[data-usage-chart-metric="cost"]').click();

    const keySelect = page.locator('#usage-key-select');
    const readsBeforeCollapse = usageReadCount(state);
    await turnsSummary.click();
    assert.equal(await detailsOpen(turnsPanel), false);
    await page.waitForTimeout(100);
    assert.equal(usageReadCount(state), readsBeforeCollapse, 'Collapsing turn details refetched usage data.');
    const turnsBeforeSelection = fixtureCount(state, usageTurnsPath);
    await keySelect.selectOption(secondaryKey);
    assert.equal(await detailsOpen(turnsPanel), false);
    await expandDetails(turnsPanel);
    await waitForCount(() => fixtureCount(state, usageTurnsPath), turnsBeforeSelection + 1);
    assert.equal(fixtureCount(state, usageTurnsPath), turnsBeforeSelection + 1,
      'Changing the selected conversation fetched turn details more than once.');
    await page.waitForFunction(() => document.querySelectorAll('#usage-turns [data-usage-turn]').length === 3);
    await page.locator('#usage-turns [data-usage-turn]').first().waitFor();
    const turnsBeforeExplicitLoad = fixtureCount(state, usageTurnsPath);
    await page.locator('#usage-turns-load').click();
    await waitForCount(() => fixtureCount(state, usageTurnsPath), turnsBeforeExplicitLoad + 1);
    await page.locator('#usage-turns [data-usage-turn]').first().waitFor();
    assert.equal(await detailsOpen(turnsPanel), true);
    assert.equal(await page.locator('#usage-turns [data-usage-turn]').count(), 3);
    await page.locator('#usage-turns').getByText('fixture-provider', { exact: true }).first().waitFor();
    await page.locator('#usage-turns').getByText(/累计|归属|追溯/).first().waitFor();

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await screenshot(page, `desktop-${theme}`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert(await page.locator('#usage-turns table').locator('..').evaluate(element => element.scrollWidth > element.clientWidth));
      mobileChartEvidence.push(await assertReadableMobileChart(page));
      mobileTableEvidence.push({
        theme,
        conversations: await assertFixedTablePanelLayout(page, {
          bodySelector: '[data-usage-conversations-scroll]',
          scrollSelector: '[data-usage-conversations-scroll]',
          label: 'Mobile conversation records',
        }),
        prices: await assertFixedTablePanelLayout(page, {
          bodySelector: '[data-usage-prices-scroll]',
          scrollSelector: '[data-usage-prices-scroll]',
          label: 'Mobile pricing details',
        }),
      });
      await bucketSelect.tap();
      await page.keyboard.press('Escape');
      await bucketSelect.selectOption('0');
      assert.equal(await bucketSelect.inputValue(), '0');
      assert.equal(await bucketDetails(page).locator('dl > div').filter({ has: page.getByText('Token', { exact: true }) }).locator('dd').innerText(), '0');
      for (const bucketIndex of [2, 47]) hoverEvidence.push(await assertChartHover(page, bucketIndex));
      await bucketSelect.selectOption('23');
      bucketDetailEvidence.push(await assertLongBucketDetails(page));
      await screenshot(page, `mobile-${theme}`);
    }
    await page.setViewportSize({ width: 1440, height: 1100 });

    await page.locator('[data-usage-hours="168"]').click();
    await page.locator('[data-usage-chart-metric="tokens"]').click();
    await keySelect.selectOption(secondaryKey);
    const turnsBeforeManualRefresh = fixtureCount(state, usageTurnsPath);
    await page.locator('#usage-refresh').click();
    await waitForCount(() => fixtureCount(state, usageTurnsPath), turnsBeforeManualRefresh + 1);
    await page.waitForFunction(() => {
      const button = document.getElementById('usage-refresh');
      return button instanceof HTMLButtonElement && !button.disabled;
    });
    assert.equal(await turnsPanel.evaluate(element => element instanceof HTMLDetailsElement && element.open), true);
    assert.equal(await recentPanel.evaluate(element => element instanceof HTMLDetailsElement && element.open), true);
    const controlsBefore = await page.locator('#usage-auto-refresh').boundingBox();
    await page.locator('#usage-auto-refresh').selectOption('3000');
    const beforeAuto = fixtureCount(state, usagePath);
    const turnsBeforeAuto = fixtureCount(state, usageTurnsPath);
    await waitForCount(() => fixtureCount(state, usagePath), beforeAuto + 1, 4_500);
    await waitForCount(() => fixtureCount(state, usageTurnsPath), turnsBeforeAuto + 1, 4_500);
    assert.equal(await page.locator('[data-usage-hours="168"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-usage-chart-metric="tokens"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await keySelect.inputValue(), secondaryKey);
    const controlsAfter = await page.locator('#usage-auto-refresh').boundingBox();
    assert(controlsBefore && controlsAfter);
    assert(Math.abs(controlsBefore.x - controlsAfter.x) < 1 && Math.abs(controlsBefore.y - controlsAfter.y) < 1);

    await setHidden(page, true);
    const hiddenCount = fixtureCount(state, usagePath);
    await page.waitForTimeout(3_300);
    assert.equal(fixtureCount(state, usagePath), hiddenCount);
    await setHidden(page, false);
    await waitForCount(() => fixtureCount(state, usagePath), hiddenCount + 1, 2_000);
    await page.locator('#usage-auto-refresh').selectOption('off');

    const navigationCancellationEvidence = await assertNavigationCancellation(browser, state, compactTotal);

    state.recentMode = 'failure';
    await page.locator('#usage-refresh').click();
    await page.locator('#usage-recent [role="alert"]').waitFor();
    assert.equal(await page.locator('[data-usage-metric="total-tokens"] strong').count(), 1);
    assert.equal(await page.locator('#usage-recent').innerText().then(text => /暂无最近调用|（空）|接口已成功返回空流水/.test(text)), false);
    state.recentMode = 'success';
    const recentBeforeRecovery = fixtureCount(state, usageRecentPath);
    const turnsBeforeRecovery = fixtureCount(state, usageTurnsPath);
    await page.locator('#usage-refresh').click();
    await waitForCount(() => fixtureCount(state, usageRecentPath), recentBeforeRecovery + 1);
    await waitForCount(() => fixtureCount(state, usageTurnsPath), turnsBeforeRecovery + 1);
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
    const timedOutSeries = state.delayedReads.at(-1);
    assert.equal(timedOutSeries?.pathname, usageSeriesPath);
    await setHidden(page, false);
    await page.waitForTimeout(50);
    assert.equal(state.maxActiveSeries, 1);
    await page.locator('#usage-series [role="alert"]').waitFor();
    await page.locator('#usage-auto-refresh').selectOption('off');
    const timeoutText = await page.locator('#usage-series').innerText();
    await waitForCount(() => state.abortedReads, abortedBeforeTimeout + 1);
    assert.equal(timedOutSeries?.abortReason, 'handler_timeout');
    await waitForCount(() => state.lateResponses, lateBeforeTimeout + 1, 1_000);
    assert.equal(await page.locator('#usage-series').innerText(), timeoutText);
    state.seriesMode = 'success';
    await page.locator('#usage-refresh').click();
    await page.locator('#usage-chart [data-usage-bucket-index]').first().waitFor();
    assert.equal(state.maxActiveSeries, 1);

    const resetPostsBeforeCancel = browserPostCount(state, usageResetPath);
    await page.locator('#usage-reset-open').click();
    const resetDialog = page.getByRole('dialog', { name: '确认清空用量账本？', exact: true });
    await resetDialog.getByText(/非原子|并发.*新用量|新用量.*丢弃/).waitFor();
    await resetDialog.locator('#usage-reset-confirm').fill('清空用量账本');
    await resetDialog.getByRole('button', { name: '取消', exact: true }).click();
    await resetDialog.waitFor({ state: 'hidden' });
    assert.equal(browserPostCount(state, usageResetPath), resetPostsBeforeCancel);
    assert.equal(state.resetBodies.length, 0);

    await page.locator('#usage-refresh').click();
    await page.waitForFunction(() => {
      const button = document.getElementById('usage-refresh');
      return button instanceof HTMLButtonElement && !button.disabled;
    });
    const openedRevision = await page.evaluate(async () => {
      const response = await fetch('/api/chat/usage?limit=200');
      const value = await response.json() as { revision?: unknown };
      return value.revision;
    });
    assert.equal(typeof openedRevision, 'string');
    await page.locator('#usage-auto-refresh').selectOption('3000');
    await page.locator('#usage-reset-open').click();
    state.summaryEpoch += 1;
    const summaryBeforeDialogPoll = fixtureCount(state, usagePath);
    await setHidden(page, false);
    await waitForCount(() => fixtureCount(state, usagePath), summaryBeforeDialogPoll + 1);
    await resetDialog.locator('#usage-reset-confirm').fill('清空用量账本');
    await resetDialog.locator('#usage-reset-submit').click();
    await resetDialog.locator('[role="alert"]').filter({ hasText: /账本已.*变化|重新.*revision/ }).waitFor();
    await page.waitForTimeout(200);
    assert.equal(browserPostCount(state, usageResetPath), resetPostsBeforeCancel + 1);
    assert.equal(state.resetBodies.length, 0);
    const conflictPost = state.browserPosts.filter(request => request.pathname === usageResetPath).at(-1);
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
    assert.equal(browserPostCount(state, usageResetPath), resetPostsBeforeCancel + 2);
    assert.equal(state.resetBodies.length, 1);
    await resetDialog.locator('#usage-reset-submit').dispatchEvent('click');
    await page.waitForTimeout(200);
    assert.equal(browserPostCount(state, usageResetPath), resetPostsBeforeCancel + 2);
    await closeResetDialog(page);

    state.resetMode = 'success';
    await page.locator('#usage-refresh').click();
    await page.locator('#usage-reset-open').click();
    await resetDialog.locator('#usage-reset-confirm').fill('清空用量账本');
    await resetDialog.locator('#usage-reset-submit').click();
    await resetDialog.waitFor({ state: 'hidden' });
    await waitForCount(() => state.resetBodies.length, 2);
    assert.equal(browserPostCount(state, usageResetPath), resetPostsBeforeCancel + 3);

    await navigate(page, '概览', 'overview');
    state.summaryMode = 'failure';
    state.seriesMode = 'failure';
    state.recentMode = 'failure';
    state.turnsMode = 'failure';
    const unavailableResponse = page.waitForResponse(response => new URL(response.url()).pathname === usagePath);
    await navigate(page, '用量统计', 'usage');
    assert.equal((await unavailableResponse).status(), 503);
    await page.locator('#usage-unavailable').getByText('请先接入聊天宿主与账本数据源；不可用不代表用量为零。', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-usage-metric]').count(), 0);
    assert.equal(await page.locator('#usage-reset-open').count(), 0);
    assert(await page.locator('#usage-auto-refresh').isDisabled());
    await screenshot(page, 'native-unavailable');

    assert.equal(await page.evaluate(() => globalThis.__usageSmokeXss === true), false);
    assert.deepEqual(state.browserAuthorizations, []);
    assert.deepEqual(state.pageErrors, []);
    assert.deepEqual(state.externalRequests, []);
    const result = {
      checkedAt: new Date().toISOString(),
      builtUi: true,
      realAdminServer: true,
      independentFixtureRoutes: true,
      fixedPrivateFixture: true,
      completeSummaryAndPricing: true,
      ranges: [24, 72, 168, 720],
      metricSwitchWithoutFetch: true,
      mouseKeyboardTouchBuckets: true,
      rechartsRenderedBars: true,
      allBucketsAvailableInNativeSelect: true,
      zeroBucketsHaveNoPositiveHeight: true,
      hoverActiveBarMatchesColumn: true,
      noFullHeightHoverBand: true,
      internalPointerFocusOutlineAbsent: true,
      pointerFocusOutlines,
      floatingTooltipWithinViewport: true,
      hoverPreservesPinnedDetails: true,
      compactCountsDefault: true,
      detailedCountsPreserveFullValues: true,
      countToggleWithoutFetch: true,
      chartCountsFollowDisplayMode: true,
      countToggleResetsAfterNavigation: true,
      amountAndPercentUnaffected: true,
      zeroSeriesHasNoInventedPositiveAxis: true,
      tiersAndOffChartHistory: true,
      currentTierAndPricingRules: true,
      conversationAndTurnDetails: true,
      conversationClickExpandsTurns: true,
      conversationPanelExplicitlyExpanded: true,
      conversationsPanelDefaultCollapsed: true,
      conversationsPanelHeight,
      conversationsPanelEvidence,
      pricingPanelExplicitlyExpanded: true,
      pricesPanelDefaultCollapsed: true,
      pricesPanelHeight,
      shareProgressIsTruthful: true,
      shareProgressEvidence,
      turnsPanelInitialState: turnsPanelInitiallyOpen ? 'open' : 'collapsed',
      turnsPanelExplicitlyExpanded: true,
      turnsPanelEvidence,
      turnsPanelToggleWithoutFetch: true,
      turnsPanelStatePreserved: true,
      recentPanelInitialState: recentPanelInitiallyOpen ? 'open' : 'collapsed',
      recentPanelExplicitlyExpanded: true,
      recentPanelEvidence,
      recentPanelToggleWithoutFetch: true,
      recentPanelStatePreserved: true,
      tokenBreakdownUsesCompactCacheRow: true,
      tokenBreakdownEvidence,
      summaryTokenCaptionUsesDirectionRows: true,
      chartBucketCountsUseCompactCacheRow: true,
      chartBucketCountsEvidence,
      recentEntries: 40,
      recentProviderNotInvented: true,
      responsiveThemes: ['desktop-light', 'desktop-dark', 'mobile-light', 'mobile-dark'],
      mobileChartUsesReadableGeometry: true,
      hoverEvidence,
      mobileChartEvidence,
      mobileTableEvidence,
      bucketDetailEvidence,
      nativeUnavailableDoesNotFakeZero: true,
      autoRefreshVisibleOnly: true,
      singleFlight: state.maxActiveSeries === 1,
      controlsStableAcrossRefresh: true,
      leaveCancelsRequests: true,
      fixtureHandlerTimeoutMs,
      navigationHandlerTimeoutMs,
      navigationCancellationEvidence,
      delayedReads: state.delayedReads,
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
    console.log(`Usage smoke passed. Results: ${outputDirectory.pathname}result-${runId}.json`);
  } catch (error: unknown) {
    const chartDiagnostics = page === undefined || page.isClosed() ? null : await page.evaluate(() => ({
      selectedIndex: document.querySelector<HTMLSelectElement>('#usage-bucket-select')?.value,
      detailsIndex: document.querySelector('[data-usage-bucket-details]')?.getAttribute('data-usage-bucket-details'),
      tooltipIndex: document.querySelector('[data-usage-tooltip-index]')?.getAttribute('data-usage-tooltip-index'),
      svg: document.querySelector('#usage-chart .recharts-surface')?.getBoundingClientRect().toJSON(),
      bars: Array.from(document.querySelectorAll('#usage-chart path[data-usage-bucket-index], #usage-chart rect[data-usage-bucket-index]')).map(element => ({
        index: element.getAttribute('data-usage-bucket-index'),
        active: element.closest('.recharts-active-bar') !== null,
        bounds: element.getBoundingClientRect().toJSON(),
      })),
    })).catch(() => null);
    if (page !== undefined && !page.isClosed()) {
      await screenshot(page, 'failure').catch(() => undefined);
    }
    await writePrivateJson(new URL(`failure-${runId}.json`, outputDirectory).pathname, {
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
      state: {
        fixtureRequests: state.fixtureRequests,
        resetBodies: state.resetBodies,
        browserPosts: state.browserPosts,
        browserAuthorizations: state.browserAuthorizations,
        pageErrors: state.pageErrors,
        externalRequests: state.externalRequests,
        abortedReads: state.abortedReads,
        lateResponses: state.lateResponses,
        delayedReads: state.delayedReads,
        maxActiveSeries: state.maxActiveSeries,
        hoverEvidence,
        mobileChartEvidence,
        clickedBar,
        chartDiagnostics,
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
  var __usageSmokeReadSignals: Array<{ readonly pathname: string; abortedAt: number | null }>;
  var __usageSmokeHidden: boolean | undefined;
  var __usageSmokeXss: boolean | undefined;
}

await run();
