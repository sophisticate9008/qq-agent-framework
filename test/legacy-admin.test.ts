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

async function fixture(testContext: TestContext, configuredToken = CONFIG_TOKEN): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), 'legacy-admin-'));
  const legacyRoot = join(directory, 'legacy');
  mkdirSync(join(legacyRoot, 'state'), { recursive: true });
  const state: Fixture = {
    directory,
    legacyRoot,
    requests: [],
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
        mode: 'reserved2', role: state.currentRole, dshReady: true, socialV2Paused: state.paused,
        ownerQQ: 123, activity: ['private conversation secret'], consoleToken: CONFIG_TOKEN,
        snowluma: { connected: true, accountOnline: null, good: true, goodSource: 'secret-source',
          goodError: 'private error', lastPacketAgoMs: 25, lastPacketKind: 'meta_event', silent: false,
          degraded: false, hint: 'private diagnostic' }
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/sessions') {
      json(response, { sessions: [{ key: 'group:456', sessionId: 'session-secret-id', owner: false }] });
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
  return Promise.resolve(selected.handle({ query, body: bodyValue, signal }));
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
    'GET /api/legacy/sessions',
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
  assert.deepEqual(await call(route(routes, 'GET', '/api/legacy/sessions')), {
    sessions: [{ key: 'group:456', sessionId: 'session-secret-id', owner: false }]
  });
  assert(source.requests.every(request => request.token === CONFIG_TOKEN));
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
