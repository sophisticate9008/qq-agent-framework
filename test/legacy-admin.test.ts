import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { createLegacyAdminRoutes, type LegacyAccess } from '../src/integrations/legacy-admin.ts';

const CONFIG_TOKEN = 'legacy-console-token-123456';
const STATE_TOKEN = 'legacy-state-token-12345678';

interface LegacyRequest {
  readonly method: string;
  readonly url: string;
  readonly token: string | undefined;
  readonly body: Record<string, unknown> | null;
}

interface Fixture {
  readonly directory: string;
  readonly legacyRoot: string;
  readonly requests: LegacyRequest[];
  sessions: Array<{ key: string; sessionId: string; owner: boolean }>;
  usage: Record<string, unknown>;
  access: LegacyAccess;
  model: {
    provider: string;
    model: string;
    reasoningEffort: string;
    options: string[];
    labels: Record<string, { name: string; description: string }>;
  };
  roles: Map<string, string>;
  currentRole: string | null;
  mode: 'chat' | 'reserved' | 'reserved2' | 'closed-agent';
  modeResult: { readonly ok: boolean; readonly mode: string; readonly dshSynced: boolean } | null;
  paused: boolean;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  if (chunks.length === 0) return null;
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function fixture(
  testContext: TestContext,
  configuredToken = CONFIG_TOKEN,
  supported: { readonly reserved?: boolean; readonly reserved2?: boolean } = {}
): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), 'legacy-admin-'));
  const legacyRoot = join(directory, 'legacy');
  mkdirSync(join(legacyRoot, 'state'), { recursive: true });
  const state: Fixture = {
    directory,
    legacyRoot,
    requests: [],
    sessions: [{ key: 'group:456', sessionId: 'session-secret-id', owner: false }],
    usage: {
      ok: true,
      generatedAt: 1_700_000_000_000,
      currency: 'CNY',
      symbol: '¥',
      priceVersion: 'fixture-v1',
      nowTier: {
        model: 'deepseek-flash', label: 'Flash', tier: 'off', tierLabel: '空闲时段', currency: 'CNY',
        symbol: '¥', unit: 1_000_000, estimated: false, cacheHit: 0.02, cacheMiss: 1,
        cacheWrite: 1, output: 4, fallbackModel: 'must not escape'
      },
      priceTable: {
        version: 'fixture-v1', currency: 'CNY', symbol: '¥', unit: 1_000_000, peakMultiplier: 2,
        peakWindows: [[9.5, 12], [14, 18.25]], peakWeekdays: [1, 2, 3, 4, 5], holidayCount: 30,
        models: {
          'deepseek-flash': {
            label: 'Flash', off: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 },
            peak: { cacheHit: 99 }
          }
        },
        privateRates: 'must not escape', holidays: ['private']
      },
      ledger: {
        journalLines: 12, maxLines: 100_000, droppedLines: 3, sessions: 4, baselines: 2, samples: 9,
        lastIngestAt: 1_700_000_000_000, lastCompactedAt: 1_699_000_000_000,
        file: '/private/token-usage.jsonl', raw: 'must not escape', revision: 'private'
      },
      totals: {
        buckets: { cacheMiss: 100, cacheHit: 20, cacheWrite: 5, output: 40, reasoning: 10 },
        totalTokens: 165,
        inputTokens: 125,
        cacheHitRate: 0.16,
        cost: 0.25,
        estimated: true,
        conversations: 2,
        turns: 3,
        steps: 5,
        avgCostPerTurn: 0.25 / 3,
        avgCostPerStep: 0.05,
        unattributedCost: 0.01,
        attributedCost: 0.24,
        byTier: { peak: 0.1, off: 0.15 }
      },
      conversations: [
        {
          key: '未归属:abcd1234', sessions: 2,
          buckets: { cacheMiss: 20, cacheHit: 0, cacheWrite: 5, output: 10, reasoning: 5 },
          cost: 0.05, estimated: false, turns: 1, steps: 2,
          attributedCost: 0.05, unattributedCost: 0, byTier: { peak: 0, off: 0.05 },
          firstAt: 1_699_999_998_000,
          lastAt: 1_699_999_999_000, models: ['deepseek-chat'],
          sessionIds: ['private-session-secret'], provider: 'private-provider'
        },
        {
          key: 'group:456', sessions: 1,
          buckets: { cacheMiss: 80, cacheHit: 20, cacheWrite: 0, output: 30, reasoning: 5 },
          cost: 0.2, estimated: true, turns: 2, steps: 3,
          attributedCost: 0.19, unattributedCost: 0.01, byTier: { peak: 0.1, off: 0.1 },
          firstAt: 1_699_999_997_000,
          lastAt: 1_700_000_000_000, models: ['deepseek-reasoner'],
          sessionIds: ['group-session-secret'], provider: 'private-provider'
        }
      ]
    },
    access: { allow: { groups: [456], private: [123] }, deny: { groups: [], private: [] }, ownerQQ: 123 },
    model: {
      provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'medium',
      options: ['low', 'medium', 'high'], labels: {
        low: { name: 'Low', description: 'Fast' },
        medium: { name: 'Medium', description: 'Balanced' },
        high: { name: 'High', description: 'Thorough' }
      }
    },
    roles: new Map([['测试伙伴', 'Original persona']]),
    currentRole: '测试伙伴',
    mode: 'reserved2',
    modeResult: null,
    paused: false
  };
  const server = createServer(async (request, response) => {
    const requestBody = await body(request);
    state.requests.push({ method: request.method ?? '', url: request.url ?? '',
      token: typeof request.headers['x-console-token'] === 'string' ? request.headers['x-console-token'] : undefined,
      body: requestBody });
    if (request.headers['x-console-token'] !== (configuredToken === 'invalid token' ? STATE_TOKEN : configuredToken)) {
      json(response, { ok: false }, 401);
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/api/status') {
      json(response, {
        mode: state.mode, role: state.currentRole, dshReady: true, socialV2Paused: state.paused,
        ownerQQ: 123, activity: ['private conversation secret'], consoleToken: CONFIG_TOKEN,
        snowluma: { connected: true, accountOnline: null, good: true, goodSource: 'secret-source',
          goodError: 'private error', lastPacketAgoMs: 25, lastPacketKind: 'meta_event', silent: false,
          degraded: false, hint: 'private diagnostic' }
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/mode') {
      state.mode = String(requestBody?.mode) as Fixture['mode'];
      json(response, state.modeResult ?? { ok: true, mode: state.mode, dshSynced: true });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/sessions') {
      json(response, { sessions: state.sessions, diagnostics: { token: CONFIG_TOKEN } });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/session/reset') {
      const key = String(requestBody?.key ?? '');
      const binding = state.sessions.find(entry => entry.key === key);
      if (binding === undefined) { json(response, { ok: false }, 404); return; }
      state.sessions = state.sessions.filter(entry => entry.key !== key);
      json(response, { ok: true, key, archived: binding.sessionId, dshStopped: true });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/tokens/summary') {
      json(response, state.usage);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/tokens/series') {
      const hours = Number(url.searchParams.get('hours'));
      const bucketMs = hours * 60 * 60 * 1_000 / 2;
      const from = 1_699_913_600_000;
      json(response, {
        ok: true, generatedAt: 1_700_000_000_000, currency: 'CNY', symbol: '¥', hours, bucketMs,
        from, to: from + bucketMs * 2,
        buckets: [
          { t: from, cost: 0.05, tokens: 35, cacheMiss: 20, cacheHit: 0, cacheWrite: 5,
            output: 10, turns: 1, steps: 2, tier: 'off', keys: ['private:123'] },
          { t: from + bucketMs, cost: 0.2, tokens: 130, cacheMiss: 80, cacheHit: 20, cacheWrite: 0,
            output: 30, turns: 2, steps: 3, tier: 'mixed', keys: ['group:456'] }
        ],
        totals: { cost: 0.25, tokens: 165, turns: 3, steps: 5 },
        busiest: { t: from + bucketMs, cost: 0.2, tokens: 130 }, estimated: true, countedSamples: 5,
        offChartCost: 0.01, offChartTokens: 5, private: 'must not escape'
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/tokens/turns') {
      const key = url.searchParams.get('key');
      if (key === 'missing') {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('private detail');
        return;
      }
      const turnLimit = Number(url.searchParams.get('limit'));
      json(response, {
        ok: true, key, generatedAt: 1_700_000_000_000, currency: 'CNY', symbol: '¥',
        sessionIds: ['session-one', 'session-two'], sessions: 2,
        buckets: { cacheMiss: 80, cacheHit: 20, cacheWrite: 0, output: 30, reasoning: 5 },
        cost: 0.2, attributedCost: 0.19, unattributedCost: 0.01, byTier: { peak: 0.1, off: 0.1 },
        estimated: true, firstAt: 1_699_999_997_000, lastAt: 1_700_000_000_000,
        models: ['deepseek-reasoner'], turnLimit,
        turns: [
          { sessionId: 'session-one', turn: 2, steps: 2, attempts: 1, startedAt: 1_699_999_999_000,
            endedAt: 1_700_000_000_000, buckets: { cacheMiss: 50, cacheHit: 20, cacheWrite: 0,
              output: 20, reasoning: 4 }, cost: 0.14, tier: 'mixed', estimated: false },
          { sessionId: 'session-two', key: null, turn: 1, steps: 1, attempts: 0,
            startedAt: 1_699_999_997_000, endedAt: 1_699_999_998_000, model: 'deepseek-reasoner',
            provider: 'fixture-provider', buckets: { cacheMiss: 30, cacheHit: 0, cacheWrite: 0,
              output: 10, reasoning: 1 }, cost: 0.05, tier: 'off' }
        ],
        private: 'must not escape'
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/tokens/recent') {
      json(response, {
        ok: true, symbol: '¥', entries: [
          { time: 1_700_000_000_000, key: undefined, sessionId: 'session-one', turn: 2, step: 1, retry: 1,
            tokens: 90, cacheMiss: 50, cacheHit: 20, cacheWrite: 0, output: 20, reasoning: 4,
            cost: 0.14, tier: 'peak', estimated: false, provider: 'must not escape' }
        ]
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/tokens/reset') {
      json(response, { ok: true, persisted: false, file: '/private/token-usage.jsonl' });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/whitelist') {
      json(response, state.access);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/whitelist') {
      state.access = requestBody as unknown as LegacyAccess;
      json(response, { ok: true, ...state.access });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/dsh/model') {
      json(response, state.model);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/dsh/effort') {
      state.model.reasoningEffort = String(requestBody?.reasoningEffort);
      json(response, { ok: true, reasoningEffort: state.model.reasoningEffort });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/socialV2/activity') {
      state.paused = requestBody?.paused === true;
      json(response, { ok: true, paused: state.paused });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/roles') {
      json(response, { roles: [...state.roles.keys()], current: state.currentRole,
        summaries: [{ content: 'must not escape' }] });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/roles/content') {
      const name = url.searchParams.get('name') ?? '';
      if (!state.roles.has(name)) { json(response, { ok: false }, 404); return; }
      json(response, { ok: true, name, content: state.roles.get(name), warnings: ['private warning'] });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/roles/create') {
      const name = String(requestBody?.name);
      if (state.roles.has(name)) { json(response, { ok: false }, 400); return; }
      state.roles.set(name, String(requestBody?.content));
      json(response, { ok: true, role: name });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/roles/update') {
      const name = String(requestBody?.name);
      state.roles.set(name, String(requestBody?.content));
      json(response, { ok: true, role: name });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/role') {
      state.currentRole = requestBody?.role === null ? null : String(requestBody?.role);
      json(response, { ok: true, role: state.currentRole });
      return;
    }
    json(response, { ok: false }, 404);
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => { server.off('error', rejectPromise); resolvePromise(); });
  });
  const address = server.address() as AddressInfo;
  writeFileSync(join(legacyRoot, 'config.json'), JSON.stringify({
    consolePort: address.port,
    consoleHost: '203.0.113.8',
    consoleToken: configuredToken,
    social: { enabled: supported.reserved ?? true },
    socialV2: { enabled: supported.reserved2 ?? true },
    unrelatedCredential: 'never-return-this'
  }));
  writeFileSync(join(legacyRoot, 'state', 'console-token'), `${STATE_TOKEN}\n`);
  testContext.after(async () => {
    await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
    rmSync(directory, { recursive: true, force: true });
  });
  return state;
}

function route(fixtureRoutes: ReturnType<typeof createLegacyAdminRoutes>, method: 'GET' | 'POST', pathname: string) {
  const selected = fixtureRoutes.find(entry => entry.method === method && entry.pathname === pathname);
  assert(selected);
  return selected;
}

function call(
  selected: ReturnType<typeof route>,
  bodyValue: Record<string, unknown> | null = null,
  query = new URLSearchParams(),
  signal = new AbortController().signal
): Promise<unknown> {
  try {
    return Promise.resolve(selected.handle({ query, body: bodyValue, signal }));
  } catch (error: unknown) {
    return Promise.reject(error);
  }
}

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test('uses the configured loopback port and only exposes bounded status and session fields', async testContext => {
  const source = await fixture(testContext);
  const routes = createLegacyAdminRoutes({ legacyRoot: source.legacyRoot });
  assert.deepEqual(routes.map(entry => `${entry.method} ${entry.pathname}`), [
    'GET /api/legacy/status',
    'GET /api/legacy/mode',
    'POST /api/legacy/mode',
    'GET /api/legacy/sessions',
    'POST /api/legacy/session/reset',
    'GET /api/legacy/usage',
    'GET /api/legacy/usage/series',
    'GET /api/legacy/usage/turns',
    'GET /api/legacy/usage/recent',
    'POST /api/legacy/usage/reset',
    'GET /api/legacy/access',
    'POST /api/legacy/access',
    'GET /api/legacy/model',
    'POST /api/legacy/model',
    'POST /api/legacy/silent',
    'GET /api/legacy/roles',
    'GET /api/legacy/role',
    'POST /api/legacy/role',
    'POST /api/legacy/role/activate'
  ]);
  const status = object(await call(route(routes, 'GET', '/api/legacy/status')));
  assert.deepEqual(status, {
    mode: 'reserved2', role: '测试伙伴', dshReady: true, socialV2Paused: false,
    snowluma: { connected: true, accountOnline: null, good: true, lastPacketAgoMs: 25,
      silent: false, degraded: false }
  });
  assert.doesNotMatch(JSON.stringify(status), /activity|credential|token|diagnostic|error|source/i);
  const mode = object(await call(route(routes, 'GET', '/api/legacy/mode')));
  assert.equal(mode.mode, 'reserved2');
  assert.match(String(mode.revision), /^[a-f0-9]{64}$/);
  assert.deepEqual(mode.supported, { reserved: true, reserved2: true });
  const sessions = object(await call(route(routes, 'GET', '/api/legacy/sessions')));
  assert.deepEqual(sessions.sessions, [{ key: 'group:456', sessionId: 'session-secret-id', owner: false }]);
  assert.match(String(sessions.revision), /^[a-f0-9]{64}$/);
  assert(source.requests.every(request => request.token === CONFIG_TOKEN));
});

test('usage exposes complete safe aggregates and stable revisions with strict limits', async testContext => {
  const source = await fixture(testContext);
  const routes = createLegacyAdminRoutes({ legacyRoot: source.legacyRoot });
  const usage = object(await call(route(routes, 'GET', '/api/legacy/usage')));
  assert.match(String(usage.revision), /^[a-f0-9]{64}$/);
  const { revision: usageRevision, ...usageWithoutRevision } = usage;
  assert.deepEqual(usageWithoutRevision, {
    source: 'chat-ledger',
    generatedAt: 1_700_000_000_000,
    currency: 'CNY',
    symbol: '¥',
    unavailable: [],
    priceVersion: 'fixture-v1',
    nowTier: {
      model: 'deepseek-flash', label: 'Flash', tier: 'off', tierLabel: '空闲时段', currency: 'CNY',
      symbol: '¥', unit: 1_000_000, estimated: false, cacheHit: 0.02, cacheMiss: 1,
      cacheWrite: 1, output: 4
    },
    priceTable: {
      version: 'fixture-v1', currency: 'CNY', symbol: '¥', unit: 1_000_000, peakMultiplier: 2,
      peakWindows: [[9.5, 12], [14, 18.25]], peakWeekdays: [1, 2, 3, 4, 5], holidayCount: 30,
      models: {
        'deepseek-flash': { label: 'Flash', off: { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 } }
      }
    },
    ledger: {
      journalLines: 12, maxLines: 100_000, droppedLines: 3, sessions: 4, baselines: 2, samples: 9,
      lastIngestAt: 1_700_000_000_000, lastCompactedAt: 1_699_000_000_000
    },
    totals: {
      totalTokens: 165,
      inputTokens: 125,
      outputTokens: 40,
      cacheHitTokens: 20,
      cacheMissTokens: 100,
      cacheWriteTokens: 5,
      reasoningTokens: 10,
      buckets: { cacheMiss: 100, cacheHit: 20, cacheWrite: 5, output: 40, reasoning: 10 },
      cost: 0.25,
      attributedCost: 0.24,
      unattributedCost: 0.01,
      byTier: { peak: 0.1, off: 0.15 },
      estimated: true,
      conversations: 2,
      turns: 3,
      steps: 5,
      cacheHitRate: 0.16,
      avgCostPerTurn: 0.25 / 3,
      avgCostPerStep: 0.05
    },
    conversations: [
      {
        key: 'group:456', sessionCount: 1, totalTokens: 130, inputTokens: 100, outputTokens: 30,
        cacheHitTokens: 20, cacheMissTokens: 80, cacheWriteTokens: 0, reasoningTokens: 5,
        buckets: { cacheMiss: 80, cacheHit: 20, cacheWrite: 0, output: 30, reasoning: 5 },
        cost: 0.2, attributedCost: 0.19, unattributedCost: 0.01, byTier: { peak: 0.1, off: 0.1 },
        cacheHitRate: 0.2, estimated: true, turns: 2, steps: 3, firstAt: 1_699_999_997_000,
        lastAt: 1_700_000_000_000,
        models: ['deepseek-reasoner']
      },
      {
        key: '未归属:abcd1234', sessionCount: 2, totalTokens: 35, inputTokens: 25, outputTokens: 10,
        cacheHitTokens: 0, cacheMissTokens: 20, cacheWriteTokens: 5, reasoningTokens: 5,
        buckets: { cacheMiss: 20, cacheHit: 0, cacheWrite: 5, output: 10, reasoning: 5 },
        cost: 0.05, attributedCost: 0.05, unattributedCost: 0, byTier: { peak: 0, off: 0.05 },
        cacheHitRate: 0, estimated: false, turns: 1, steps: 2, firstAt: 1_699_999_998_000,
        lastAt: 1_699_999_999_000,
        models: ['deepseek-chat']
      }
    ],
    limit: 200,
    limited: false
  });
  assert.doesNotMatch(JSON.stringify(usage), /token-usage|sessionIds|provider|privateRates|fallbackModel|holidays|"raw"/i);
  assert.equal(source.requests.at(-1)?.url, '/api/tokens/summary?limit=200');

  const alternateLimit = object(await call(route(routes, 'GET', '/api/legacy/usage'), null,
    new URLSearchParams({ limit: '500' })));
  assert.equal(source.requests.at(-1)?.url, '/api/tokens/summary?limit=500');
  assert.equal(alternateLimit.revision, usageRevision);
  const upstreamConversations = source.usage.conversations;
  assert(Array.isArray(upstreamConversations));
  const firstConversation = object(upstreamConversations[0]);
  const originalKey = firstConversation.key;
  firstConversation.key = 'archived:renamed';
  const renamed = object(await call(route(routes, 'GET', '/api/legacy/usage'), null,
    new URLSearchParams({ limit: '500' })));
  assert.equal(renamed.revision, usageRevision);
  firstConversation.key = originalKey;
  source.usage.conversations = [upstreamConversations[1]];
  const limited = object(await call(route(routes, 'GET', '/api/legacy/usage'), null,
    new URLSearchParams({ limit: '1' })));
  assert.equal(limited.limited, true);
  assert.equal((limited.conversations as unknown[]).length, 1);
  const requestCount = source.requests.length;
  for (const query of [
    new URLSearchParams({ limit: '0' }),
    new URLSearchParams({ limit: '501' }),
    new URLSearchParams({ limit: 'NaN' }),
    new URLSearchParams({ limit: '1.5' }),
    new URLSearchParams({ limit: '01' }),
    new URLSearchParams({ extra: '1' })
  ]) {
    await assert.rejects(call(route(routes, 'GET', '/api/legacy/usage'), null, query), {
      code: 'invalid_query', statusCode: 400
    });
  }
  const duplicate = new URLSearchParams({ limit: '10' });
  duplicate.append('limit', '20');
  await assert.rejects(call(route(routes, 'GET', '/api/legacy/usage'), null, duplicate), {
    code: 'invalid_query', statusCode: 400
  });
  assert.equal(source.requests.length, requestCount);
});

test('usage rejects missing or non-finite critical numbers instead of inventing zeroes', async testContext => {
  const source = await fixture(testContext);
  const routes = createLegacyAdminRoutes({ legacyRoot: source.legacyRoot });
  const totals = object(source.usage.totals);
  totals.cost = Number.NaN;
  await assert.rejects(call(route(routes, 'GET', '/api/legacy/usage')), {
    code: 'legacy_invalid_response', statusCode: 502
  });
  totals.cost = 0.25;
  delete object(totals.buckets).reasoning;
  await assert.rejects(call(route(routes, 'GET', '/api/legacy/usage')), {
    code: 'legacy_invalid_response', statusCode: 502
  });
  object(totals.buckets).reasoning = 10;
  object(source.usage.priceTable).peakWindows = [[9.5, 24.1]];
  await assert.rejects(call(route(routes, 'GET', '/api/legacy/usage')), {
    code: 'legacy_invalid_response', statusCode: 502
  });
});

test('usage marks absent legacy metadata unavailable without inventing pricing or ledger values', async testContext => {
  const source = await fixture(testContext);
  delete source.usage.priceVersion;
  delete source.usage.nowTier;
  delete source.usage.priceTable;
  delete source.usage.ledger;
  const routes = createLegacyAdminRoutes({ legacyRoot: source.legacyRoot });
  const usage = object(await call(route(routes, 'GET', '/api/legacy/usage')));
  assert.deepEqual(usage.unavailable, ['pricing', 'ledger']);
  for (const key of ['priceVersion', 'nowTier', 'priceTable', 'ledger']) assert(!Object.hasOwn(usage, key));

  object(source.usage.totals).conversations = 3;
  const conversationCountChanged = object(await call(route(routes, 'GET', '/api/legacy/usage')));
  assert.notEqual(conversationCountChanged.revision, usage.revision);
  object(source.usage.totals).conversations = 2;

  source.usage.priceVersion = 'partial';
  await assert.rejects(call(route(routes, 'GET', '/api/legacy/usage')), {
    code: 'legacy_invalid_response', statusCode: 502
  });
});

test('usage preserves non-additive attributed estimates from legacy projection pricing', async testContext => {
  const source = await fixture(testContext);
  object(source.usage.totals).attributedCost = 0.3;
  const conversations = source.usage.conversations;
  assert(Array.isArray(conversations));
  object(conversations[0]).attributedCost = 0.08;
  object(conversations[1]).attributedCost = 0.22;
  const usage = object(await call(route(createLegacyAdminRoutes({ legacyRoot: source.legacyRoot }),
    'GET', '/api/legacy/usage')));
  assert.equal(object(usage.totals).attributedCost, 0.3);
  assert((usage.conversations as Array<Record<string, unknown>>).some(entry => Number(entry.attributedCost) > Number(entry.cost)));
});

test('usage detail routes expose bounded safe series, turns and recent samples', async testContext => {
  const source = await fixture(testContext);
  const routes = createLegacyAdminRoutes({ legacyRoot: source.legacyRoot });
  const series = object(await call(route(routes, 'GET', '/api/legacy/usage/series')));
  assert.equal(source.requests.at(-1)?.url, '/api/tokens/series?hours=24&buckets=48');
  assert.equal(series.ok, true);
  assert.equal(series.hours, 24);
  assert.equal((series.buckets as unknown[]).length, 2);
  assert.deepEqual(series.busiest, { t: 1_699_956_800_000, cost: 0.2, tokens: 130 });
  assert.doesNotMatch(JSON.stringify(series), /must not escape/i);

  const turns = object(await call(route(routes, 'GET', '/api/legacy/usage/turns'), null,
    new URLSearchParams({ key: 'group:456', limit: '1000' })));
  assert.equal(source.requests.at(-1)?.url, '/api/tokens/turns?key=group%3A456&limit=1000');
  assert.equal(turns.sessionCount, 2);
  assert.equal(turns.turnLimit, 1000);
  assert(!Object.hasOwn(turns, 'limited'));
  const turnRows = turns.turns as Array<Record<string, unknown>>;
  assert.deepEqual(turnRows[0], {
    sessionId: 'session-one', turn: 2, steps: 2, attempts: 1, startedAt: 1_699_999_999_000,
    endedAt: 1_700_000_000_000, model: null, provider: null,
    buckets: { cacheMiss: 50, cacheHit: 20, cacheWrite: 0, output: 20, reasoning: 4 },
    cost: 0.14, tier: 'mixed'
  });
  assert(!Object.hasOwn(turnRows[1]!, 'key'));
  assert.doesNotMatch(JSON.stringify(turns), /"private"|"estimated":false/);

  const recent = object(await call(route(routes, 'GET', '/api/legacy/usage/recent')));
  assert.equal(source.requests.at(-1)?.url, '/api/tokens/recent?limit=40');
  assert.deepEqual(recent, {
    symbol: '¥',
    entries: [{
      time: 1_700_000_000_000, key: null, sid: 'session-one', turn: 2, step: 1, retry: 1,
      model: null, tokens: 90, cacheMiss: 50, cacheHit: 20, cacheWrite: 0, output: 20,
      reasoning: 4, cost: 0.14, tier: 'peak', estimated: false
    }]
  });
  assert.doesNotMatch(JSON.stringify(recent), /provider|sessionId/);

  await assert.rejects(call(route(routes, 'GET', '/api/legacy/usage/turns'), null,
    new URLSearchParams({ key: 'missing' })), { code: 'usage_conversation_not_found', statusCode: 404 });
  const requestCount = source.requests.length;
  for (const [pathname, query] of [
    ['/api/legacy/usage/series', new URLSearchParams({ hours: '2161' })],
    ['/api/legacy/usage/series', new URLSearchParams({ buckets: '5' })],
    ['/api/legacy/usage/turns', new URLSearchParams({ limit: '200' })],
    ['/api/legacy/usage/turns', new URLSearchParams({ key: 'group:456', limit: '1001' })],
    ['/api/legacy/usage/recent', new URLSearchParams({ limit: '501' })]
  ] as const) {
    await assert.rejects(call(route(routes, 'GET', pathname), null, query), {
      code: 'invalid_query', statusCode: 400
    });
  }
  assert.equal(source.requests.length, requestCount);
});

test('usage turns accepts a bounded 1000-row response larger than the default admin limit', async testContext => {
  const source = await fixture(testContext);
  const model = 'm'.repeat(256);
  const provider = 'p'.repeat(256);
  const rows = Array.from({ length: 1_000 }, (_, index) => ({
    sessionId: 'session-one', turn: index + 1, steps: 1, attempts: 0,
    startedAt: 1_700_000_000_000 + index, endedAt: 1_700_000_000_000 + index,
    model, provider, buckets: { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0 },
    cost: 0, tier: 'off'
  }));
  const routes = createLegacyAdminRoutes({
    legacyRoot: source.legacyRoot,
    fetch: async () => Response.json({
      ok: true, key: 'group:456', generatedAt: 1_700_000_001_000, currency: 'CNY', symbol: '¥',
      sessionIds: ['session-one'], sessions: 1,
      buckets: { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0 },
      cost: 0, attributedCost: 0, unattributedCost: 0, byTier: { peak: 0, off: 0 }, estimated: false,
      firstAt: 1_700_000_000_000, lastAt: 1_700_000_000_999, models: [model], turnLimit: 1_000,
      turns: rows
    })
  });
  const turnsRoute = route(routes, 'GET', '/api/legacy/usage/turns');
  assert.equal(turnsRoute.maxResponseBytes, 4 * 1024 * 1024);
  const result = object(await call(turnsRoute, null,
    new URLSearchParams({ key: 'group:456', limit: '1000' })));
  assert.equal((result.turns as unknown[]).length, 1_000);
  assert(Buffer.byteLength(JSON.stringify(result), 'utf8') > 256 * 1024);
});

test('usage series rejects inconsistent buckets even when declared token totals still add up', async testContext => {
  const source = await fixture(testContext);
  const from = 1_699_913_600_000;
  const bucketMs = 12 * 60 * 60 * 1_000;
  const routes = createLegacyAdminRoutes({
    legacyRoot: source.legacyRoot,
    fetch: async () => Response.json({
      ok: true, generatedAt: 1_700_000_000_000, currency: 'CNY', symbol: '¥', hours: 24, bucketMs,
      from, to: from + bucketMs * 2,
      buckets: [
        { t: from, cost: 0.05, tokens: 36, cacheMiss: 20, cacheHit: 0, cacheWrite: 5,
          output: 10, turns: 1, steps: 2, tier: 'off', keys: ['private:123'] },
        { t: from + bucketMs, cost: 0.2, tokens: 129, cacheMiss: 80, cacheHit: 20, cacheWrite: 0,
          output: 30, turns: 2, steps: 3, tier: 'mixed', keys: ['group:456'] }
      ],
      totals: { cost: 0.25, tokens: 165, turns: 3, steps: 5 },
      busiest: { t: from + bucketMs, cost: 0.2, tokens: 129 }, estimated: true, countedSamples: 5,
      offChartCost: 0.01, offChartTokens: 5
    })
  });
  await assert.rejects(call(route(routes, 'GET', '/api/legacy/usage/series')), {
    code: 'legacy_invalid_response', statusCode: 502
  });
});

test('usage reset uses canonical CAS and only reports legacy endpoint acceptance', async testContext => {
  const source = await fixture(testContext);
  const routes = createLegacyAdminRoutes({ legacyRoot: source.legacyRoot });
  const usage = object(await call(route(routes, 'GET', '/api/legacy/usage'), null,
    new URLSearchParams({ limit: '100' })));
  for (const invalid of [
    { revision: usage.revision, confirm: true },
    { revision: usage.revision, confirm: '清空用量账本', extra: true },
    { revision: 'invalid', confirm: '清空用量账本' }
  ]) {
    await assert.rejects(call(route(routes, 'POST', '/api/legacy/usage/reset'), invalid), {
      code: 'invalid_request', statusCode: 400
    });
  }
  const ledger = object(source.usage.ledger);
  ledger.samples = 10;
  await assert.rejects(call(route(routes, 'POST', '/api/legacy/usage/reset'), {
    revision: usage.revision, confirm: '清空用量账本'
  }), { code: 'revision_conflict', statusCode: 409 });
  ledger.samples = 9;
  assert.equal(source.requests.filter(entry => entry.url === '/api/tokens/reset').length, 0);

  const reset = await call(route(routes, 'POST', '/api/legacy/usage/reset'), {
    revision: usage.revision, confirm: '清空用量账本'
  });
  assert.deepEqual(reset, { ok: true, resetAccepted: true });
  assert.deepEqual(source.requests.filter(entry => entry.url === '/api/tokens/reset').map(entry => entry.body), [{}]);
  const after = object(await call(route(routes, 'GET', '/api/legacy/usage')));
  assert.equal(object(after.totals).cost, 0.25);
});

test('usage reset timeout is unknown and never retries after the legacy write starts', async testContext => {
  const source = await fixture(testContext);
  let posts = 0;
  const routes = createLegacyAdminRoutes({
    legacyRoot: source.legacyRoot,
    timeoutMs: 10,
    fetch: async (_input, init) => {
      if (init?.method === 'GET') return Response.json(source.usage);
      posts++;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }
  });
  const usage = object(await call(route(routes, 'GET', '/api/legacy/usage')));
  await assert.rejects(call(route(routes, 'POST', '/api/legacy/usage/reset'), {
    revision: usage.revision, confirm: '清空用量账本'
  }), { code: 'usage_reset_unknown', statusCode: 504 });
  assert.equal(posts, 1);
});

test('session reset requires confirmation and uses revision plus binding CAS', async testContext => {
  const source = await fixture(testContext);
  const routes = createLegacyAdminRoutes({ legacyRoot: source.legacyRoot });
  const initial = object(await call(route(routes, 'GET', '/api/legacy/sessions')));
  const request = {
    key: 'group:456',
    sessionId: 'session-secret-id',
    revision: initial.revision,
    confirm: true
  };
  for (const invalid of [
    { ...request, confirm: false },
    { key: request.key, sessionId: request.sessionId, revision: request.revision },
    { key: request.key, sid: request.sessionId, revision: request.revision, confirm: true }
  ]) {
    await assert.rejects(call(route(routes, 'POST', '/api/legacy/session/reset'), invalid), {
      code: 'invalid_request', statusCode: 400
    });
  }
  await assert.rejects(call(route(routes, 'POST', '/api/legacy/session/reset'), request,
    new URLSearchParams({ force: 'true' })), { code: 'invalid_query', statusCode: 400 });
  assert.equal(source.requests.filter(entry => entry.method === 'POST').length, 0);

  source.sessions = [{ key: 'group:456', sessionId: 'replacement-session-id', owner: false }];
  await assert.rejects(call(route(routes, 'POST', '/api/legacy/session/reset'), request), {
    code: 'revision_conflict', statusCode: 409
  });
  assert.equal(source.sessions[0]?.sessionId, 'replacement-session-id');
  assert.equal(source.requests.filter(entry => entry.url === '/api/session/reset').length, 0);

  const replacement = object(await call(route(routes, 'GET', '/api/legacy/sessions')));
  await assert.rejects(call(route(routes, 'POST', '/api/legacy/session/reset'), {
    ...request,
    revision: replacement.revision
  }), { code: 'session_binding_conflict', statusCode: 409 });
  assert.equal(source.requests.filter(entry => entry.url === '/api/session/reset').length, 0);

  const reset = await call(route(routes, 'POST', '/api/legacy/session/reset'), {
    key: 'group:456',
    sessionId: 'replacement-session-id',
    revision: replacement.revision,
    confirm: true
  });
  assert.deepEqual(reset, {
    ok: true,
    key: 'group:456',
    previousSessionId: 'replacement-session-id',
    bridgeBindingRemoved: true,
    externalWorkStopped: 'unverified'
  });
  assert.deepEqual(source.requests.filter(entry => entry.url === '/api/session/reset').map(entry => entry.body), [
    { key: 'group:456' }
  ]);
  assert.equal(source.requests.at(-1)?.url, '/api/sessions');
  assert.deepEqual(source.sessions, []);
  assert.doesNotMatch(JSON.stringify(reset), /archived|dshStopped/i);
});

test('session revisions are stable across upstream order and aborted resets start no new action', async testContext => {
  const source = await fixture(testContext);
  source.sessions = [
    { key: 'private:123', sessionId: 'private-session', owner: true },
    { key: 'group:456', sessionId: 'group-session', owner: false }
  ];
  const routes = createLegacyAdminRoutes({ legacyRoot: source.legacyRoot });
  await assert.rejects(call(route(routes, 'GET', '/api/legacy/sessions'), null,
    new URLSearchParams({ limit: '1' })), { code: 'invalid_query', statusCode: 400 });
  const first = object(await call(route(routes, 'GET', '/api/legacy/sessions')));
  source.sessions.reverse();
  const second = object(await call(route(routes, 'GET', '/api/legacy/sessions')));
  assert.deepEqual(second.sessions, first.sessions);
  assert.equal(second.revision, first.revision);

  const controller = new AbortController();
  controller.abort();
  const requestCount = source.requests.length;
  await assert.rejects(call(route(routes, 'POST', '/api/legacy/session/reset'), {
    key: 'group:456', sessionId: 'group-session', revision: first.revision, confirm: true
  }, new URLSearchParams(), controller.signal), { code: 'session_reset_unknown', statusCode: 504 });
  assert.equal(source.requests.length, requestCount);
});

test('mode writes use strict CAS and the fixed legacy mode endpoint without changing feature switches', async testContext => {
  const source = await fixture(testContext);
  const routes = createLegacyAdminRoutes({ legacyRoot: source.legacyRoot });
  const current = object(await call(route(routes, 'GET', '/api/legacy/mode')));
  const changed = object(await call(route(routes, 'POST', '/api/legacy/mode'), {
    revision: current.revision,
    mode: 'reserved'
  }));
  assert.equal(changed.mode, 'reserved');
  assert.deepEqual(changed.supported, { reserved: true, reserved2: true });
  assert.match(String(changed.revision), /^[a-f0-9]{64}$/);
  const writes = source.requests.filter(request => request.method === 'POST' && request.url === '/api/mode');
  assert.deepEqual(writes.map(request => request.body), [{ mode: 'reserved' }]);

  await assert.rejects(call(route(routes, 'POST', '/api/legacy/mode'), {
    revision: current.revision,
    mode: 'chat'
  }), { code: 'revision_conflict', statusCode: 409 });
  await assert.rejects(call(route(routes, 'POST', '/api/legacy/mode'), {
    revision: changed.revision,
    mode: 'simulation'
  }), { code: 'invalid_mode', statusCode: 400 });
  await assert.rejects(call(route(routes, 'POST', '/api/legacy/mode'), {
    revision: changed.revision,
    mode: 'chat',
    pathname: '/api/arbitrary'
  }), { code: 'invalid_request', statusCode: 400 });
  assert.equal(source.requests.filter(request => request.method === 'POST' && request.url === '/api/mode').length, 1);
});

test('mode writes reject disabled generations before contacting the legacy bridge', async testContext => {
  const source = await fixture(testContext, CONFIG_TOKEN, { reserved: false, reserved2: false });
  const routes = createLegacyAdminRoutes({ legacyRoot: source.legacyRoot });
  const current = object(await call(route(routes, 'GET', '/api/legacy/mode')));
  assert.deepEqual(current.supported, { reserved: false, reserved2: false });
  for (const mode of ['reserved', 'reserved2']) {
    await assert.rejects(call(route(routes, 'POST', '/api/legacy/mode'), {
      revision: current.revision,
      mode
    }), { code: 'legacy_mode_disabled', statusCode: 409 });
  }
  assert.equal(source.requests.filter(request => request.method === 'POST' && request.url === '/api/mode').length, 0);
});

test('mode writes remain unknown on mismatched or unsynchronized legacy acknowledgements and are not retried', async testContext => {
  const source = await fixture(testContext);
  const routes = createLegacyAdminRoutes({ legacyRoot: source.legacyRoot });

  let current = object(await call(route(routes, 'GET', '/api/legacy/mode')));
  source.modeResult = { ok: true, mode: 'reserved2', dshSynced: true };
  await assert.rejects(call(route(routes, 'POST', '/api/legacy/mode'), {
    revision: current.revision,
    mode: 'reserved'
  }), { code: 'mode_change_unknown', statusCode: 504 });

  current = object(await call(route(routes, 'GET', '/api/legacy/mode')));
  source.modeResult = { ok: true, mode: 'chat', dshSynced: false };
  await assert.rejects(call(route(routes, 'POST', '/api/legacy/mode'), {
    revision: current.revision,
    mode: 'chat'
  }), { code: 'mode_change_unknown', statusCode: 504 });

  assert.deepEqual(source.requests.filter(request => request.method === 'POST' && request.url === '/api/mode')
    .map(request => request.body), [{ mode: 'reserved' }, { mode: 'chat' }]);
});

test('falls back to the state token without honoring the configured console host', async testContext => {
  const source = await fixture(testContext, 'invalid token');
  const routes = createLegacyAdminRoutes({ legacyRoot: source.legacyRoot });
  await call(route(routes, 'GET', '/api/legacy/access'));
  assert.equal(source.requests[0]?.token, STATE_TOKEN);
});

test('access writes require gateway synchronization, validate QQ ids and enforce revision CAS', async testContext => {
  const source = await fixture(testContext);
  const unsynchronized = createLegacyAdminRoutes({ legacyRoot: source.legacyRoot });
  const initial = object(await call(route(unsynchronized, 'GET', '/api/legacy/access')));
  await assert.rejects(call(route(unsynchronized, 'POST', '/api/legacy/access'), initial), {
    code: 'access_sync_required', statusCode: 503
  });

  const synchronized: LegacyAccess[] = [];
  const routes = createLegacyAdminRoutes({
    legacyRoot: source.legacyRoot,
    async beforeAccessSave(access) {
      assert.equal(source.requests.at(-1)?.method, 'GET');
      assert.equal(source.requests.at(-1)?.url, '/api/whitelist');
      synchronized.push(access);
      assert(Object.isFrozen(access));
      assert(Object.isFrozen(access.allow.groups));
    }
  });
  const current = object(await call(route(routes, 'GET', '/api/legacy/access')));
  const next = {
    ...current,
    allow: { groups: [], private: [789] },
    deny: { groups: [456], private: [] },
    ownerQQ: null
  };
  const saved = await call(route(routes, 'POST', '/api/legacy/access'), next);
  assert.deepEqual(object(saved).allow, next.allow);
  assert.deepEqual(synchronized, [{ allow: next.allow, deny: next.deny, ownerQQ: null }]);
  assert.deepEqual(source.access, { allow: next.allow, deny: next.deny, ownerQQ: null });
  assert.equal(source.requests.at(-1)?.url, '/api/whitelist');
  await assert.rejects(call(route(routes, 'POST', '/api/legacy/access'), next), { code: 'revision_conflict' });
  assert.equal(synchronized.length, 1);
  await assert.rejects(call(route(routes, 'POST', '/api/legacy/access'), {
    ...object(saved), allow: { groups: ['456'], private: [] }
  } as unknown as Record<string, unknown>), { code: 'invalid_request' });
});

test('access save rechecks CAS after synchronization and never overwrites a concurrent update', async testContext => {
  const source = await fixture(testContext);
  const concurrent: LegacyAccess = {
    allow: { groups: [999], private: [] },
    deny: { groups: [], private: [123] },
    ownerQQ: 999
  };
  let synchronizations = 0;
  const routes = createLegacyAdminRoutes({
    legacyRoot: source.legacyRoot,
    async beforeAccessSave() {
      synchronizations++;
      source.access = concurrent;
    }
  });
  const current = object(await call(route(routes, 'GET', '/api/legacy/access')));
  await assert.rejects(call(route(routes, 'POST', '/api/legacy/access'), {
    ...current,
    allow: { groups: [], private: [789] },
    deny: { groups: [456], private: [] },
    ownerQQ: null
  }), { code: 'access_save_unknown', statusCode: 504 });
  assert.equal(synchronizations, 1);
  assert.deepEqual(source.access, concurrent);
  assert.deepEqual(source.requests.filter(request => request.url === '/api/whitelist').map(request => request.method), [
    'GET', 'GET', 'GET'
  ]);
});

test('access synchronization failure and cancellation are unknown without legacy writes or retries', async testContext => {
  const source = await fixture(testContext);
  const initialRoutes = createLegacyAdminRoutes({ legacyRoot: source.legacyRoot });
  const current = object(await call(route(initialRoutes, 'GET', '/api/legacy/access')));
  const next = {
    ...current,
    allow: { groups: [], private: [789] },
    deny: { groups: [456], private: [] },
    ownerQQ: null
  };

  let failedSynchronizations = 0;
  const failingRoutes = createLegacyAdminRoutes({
    legacyRoot: source.legacyRoot,
    async beforeAccessSave() {
      failedSynchronizations++;
      throw new Error('gateway restart result unavailable');
    }
  });
  await assert.rejects(call(route(failingRoutes, 'POST', '/api/legacy/access'), next), {
    code: 'access_save_unknown', statusCode: 504
  });
  assert.equal(failedSynchronizations, 1);
  assert.equal(source.requests.filter(request => request.method === 'POST'
    && request.url === '/api/whitelist').length, 0);

  const controller = new AbortController();
  let cancelledSynchronizations = 0;
  const cancelledRoutes = createLegacyAdminRoutes({
    legacyRoot: source.legacyRoot,
    async beforeAccessSave() {
      cancelledSynchronizations++;
      controller.abort();
    }
  });
  await assert.rejects(call(route(cancelledRoutes, 'POST', '/api/legacy/access'), next,
    new URLSearchParams(), controller.signal), { code: 'access_save_unknown', statusCode: 504 });
  assert.equal(cancelledSynchronizations, 1);
  assert.equal(source.requests.filter(request => request.method === 'POST'
    && request.url === '/api/whitelist').length, 0);
});

test('legacy access write rejection is unknown and is never retried', async testContext => {
  const source = await fixture(testContext);
  const requests: Array<{ method: string; body: unknown }> = [];
  const access: LegacyAccess = {
    allow: { groups: [456], private: [123] },
    deny: { groups: [], private: [] },
    ownerQQ: 123
  };
  const routes = createLegacyAdminRoutes({
    legacyRoot: source.legacyRoot,
    async beforeAccessSave() {},
    async fetch(_input, init) {
      const method = init?.method ?? 'GET';
      requests.push({ method, body: init?.body === undefined ? null : JSON.parse(String(init.body)) as unknown });
      if (method === 'GET') return Response.json(access);
      return Response.json({ ok: false }, { status: 503 });
    }
  });
  const current = object(await call(route(routes, 'GET', '/api/legacy/access')));
  await assert.rejects(call(route(routes, 'POST', '/api/legacy/access'), {
    ...current,
    allow: { groups: [], private: [789] }
  }), { code: 'access_save_unknown', statusCode: 504 });
  assert.deepEqual(requests.map(request => request.method), ['GET', 'GET', 'GET', 'POST']);
  assert.equal(requests.filter(request => request.method === 'POST').length, 1);
});

test('model writes validate against advertised options and CAS before calling the legacy bridge', async testContext => {
  const source = await fixture(testContext);
  const routes = createLegacyAdminRoutes({ legacyRoot: source.legacyRoot });
  const current = object(await call(route(routes, 'GET', '/api/legacy/model')));
  await assert.rejects(call(route(routes, 'POST', '/api/legacy/model'), {
    revision: current.revision,
    reasoningEffort: 'unadvertised'
  }), { code: 'invalid_reasoning_effort' });
  assert.equal(source.requests.filter(request => request.url === '/api/dsh/effort').length, 0);
  const updated = object(await call(route(routes, 'POST', '/api/legacy/model'), {
    revision: current.revision,
    reasoningEffort: 'high'
  }));
  assert.equal(updated.reasoningEffort, 'high');
  assert.equal(source.requests.at(-1)?.url, '/api/dsh/effort');
  await assert.rejects(call(route(routes, 'POST', '/api/legacy/model'), {
    revision: current.revision,
    reasoningEffort: 'low'
  }), { code: 'revision_conflict' });
});

test('silent and role routes map only to the verified legacy write endpoints', async testContext => {
  const source = await fixture(testContext);
  const routes = createLegacyAdminRoutes({ legacyRoot: source.legacyRoot });
  assert.deepEqual(await call(route(routes, 'POST', '/api/legacy/silent'), { paused: true }), { paused: true });
  assert.equal(source.requests.at(-1)?.url, '/api/socialV2/activity');
  assert.deepEqual(await call(route(routes, 'GET', '/api/legacy/roles')), { roles: ['测试伙伴'], current: '测试伙伴' });

  const roleState = object(await call(route(routes, 'GET', '/api/legacy/role'), null,
    new URLSearchParams({ name: '测试伙伴' })));
  assert.equal(roleState.content, 'Original persona');
  await assert.rejects(call(route(routes, 'POST', '/api/legacy/role'), {
    name: '../escape', content: 'no', create: true
  }), { code: 'invalid_request' });
  const updated = await call(route(routes, 'POST', '/api/legacy/role'), {
    name: '测试伙伴', content: 'Updated persona', revision: roleState.revision
  });
  assert.equal(object(updated).content, 'Updated persona');
  const created = await call(route(routes, 'POST', '/api/legacy/role'), {
    name: '新角色', content: 'New persona', create: true
  });
  assert.equal(object(created).name, '新角色');
  assert.deepEqual(await call(route(routes, 'POST', '/api/legacy/role/activate'), { name: null }), { current: null });
  assert.deepEqual(source.requests.filter(request => request.method === 'POST').map(request => request.url), [
    '/api/socialV2/activity', '/api/roles/update', '/api/roles/create', '/api/role'
  ]);
});

test('write timeout is operation_unknown and is not retried', async () => {
  let calls = 0;
  const directory = mkdtempSync(join(tmpdir(), 'legacy-admin-timeout-'));
  mkdirSync(join(directory, 'state'));
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ consolePort: 3100, consoleToken: CONFIG_TOKEN }));
  const timeoutRoutes = createLegacyAdminRoutes({
    legacyRoot: directory,
    timeoutMs: 10,
    fetch: async (_input, init) => {
      calls++;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }
  });
  try {
    await assert.rejects(call(route(timeoutRoutes, 'POST', '/api/legacy/silent'), { paused: true }), {
      code: 'operation_unknown', statusCode: 504
    });
    assert.equal(calls, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('late responses cannot bypass the integration deadline even when fetch ignores abort', async testContext => {
  const source = await fixture(testContext);
  for (const phase of ['headers', 'body'] as const) {
    let calls = 0;
    const routes = createLegacyAdminRoutes({ legacyRoot: source.legacyRoot, timeoutMs: 10,
      async fetch(_input, init) {
        calls++;
        const value = init?.method === 'POST' ? { ok: true, paused: true } : source.usage;
        if (phase === 'headers') {
          await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 30));
          return Response.json(value);
        }
        return new Response(new ReadableStream<Uint8Array>({
          async start(controller) {
            await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 30));
            controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
            controller.close();
          },
        }), { headers: { 'content-type': 'application/json' } });
      },
    });
    await assert.rejects(call(route(routes, 'GET', '/api/legacy/usage')), {
      code: 'legacy_timeout', statusCode: 504,
    });
    await assert.rejects(call(route(routes, 'POST', '/api/legacy/silent'), { paused: true }), {
      code: 'operation_unknown', statusCode: 504,
    });
    assert.equal(calls, 2);
  }
});

test('session reset timeout is session_reset_unknown and never retries the legacy write', async () => {
  let posts = 0;
  let requests = 0;
  const directory = mkdtempSync(join(tmpdir(), 'legacy-session-reset-timeout-'));
  mkdirSync(join(directory, 'state'));
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ consolePort: 3100, consoleToken: CONFIG_TOKEN }));
  const timeoutRoutes = createLegacyAdminRoutes({
    legacyRoot: directory,
    timeoutMs: 10,
    fetch: async (_input, init) => {
      requests++;
      if (init?.method === 'GET') {
        return Response.json({ sessions: [{ key: 'group:456', sessionId: 'session-id', owner: false }] });
      }
      posts++;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }
  });
  try {
    const current = object(await call(route(timeoutRoutes, 'GET', '/api/legacy/sessions')));
    await assert.rejects(call(route(timeoutRoutes, 'POST', '/api/legacy/session/reset'), {
      key: 'group:456', sessionId: 'session-id', revision: current.revision, confirm: true
    }), { code: 'session_reset_unknown', statusCode: 504 });
    assert.equal(posts, 1);
    assert.equal(requests, 3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
