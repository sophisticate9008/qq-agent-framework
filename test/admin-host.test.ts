import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { createAdminServer } from '../src/admin/server.ts';
import { createHostAdminRoutes } from '../src/admin/host.ts';
import { createContextStore } from '../src/core/context.ts';
import type { DeliveryReceipt, SendRequest, TransportAdapter } from '../src/core/types.ts';
import { createBridgeHost } from '../src/host/bridge.ts';
import type { AgentAdapter } from '../src/host/types.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

const TOKEN = 'admin-host-test-token-1234567890';
const TASK_SECRET = 'private-task-payload-must-not-leak';
const OUTBOX_SECRET = 'private-outbox-content-must-not-leak';

class FakeAgent implements AgentAdapter {
  async createSession({ conversationId }: Parameters<AgentAdapter['createSession']>[0]): Promise<{ sessionId: string }> {
    return { sessionId: `session-${conversationId}` };
  }

  async submit(): Promise<{ status: 'accepted' }> {
    return { status: 'accepted' };
  }

  async follow(): Promise<() => void> {
    return () => {};
  }
}

class FakeTransport implements TransportAdapter {
  readonly requests: SendRequest[] = [];

  async send(input: SendRequest): Promise<DeliveryReceipt> {
    this.requests.push(input);
    return { status: 'confirmed', messageId: `message-${this.requests.length}` };
  }
}

interface HttpResponse {
  status: number;
  text: string;
  headers: Record<string, string | string[] | undefined>;
}

function rawRequest(origin: string, pathname: string, options: {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
} = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = request(new URL(pathname, origin), {
      method: options.method ?? 'GET',
      headers: options.headers,
      signal: AbortSignal.timeout(5_000)
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: unknown) => {
        if (!(chunk instanceof Uint8Array)) {
          response.destroy(new Error('Invalid response chunk.'));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        text: Buffer.concat(chunks).toString('utf8'),
        headers: response.headers
      }));
      response.once('error', reject);
    });
    outgoing.once('error', reject);
    outgoing.end(options.body);
  });
}

function parseObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

async function startFixture(testContext: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'qq-bridge-framework-admin-host-'));
  const store = createSqliteStore({ filename: join(directory, 'host.sqlite') });
  const context = createContextStore();
  const persona = context.registerPersona({
    id: 'admin-host-test',
    version: '1.0.0',
    name: 'Admin Host Test',
    identity: {},
    style: {}
  });
  const host = createBridgeHost({
    store,
    agent: new FakeAgent(),
    transport: new FakeTransport(),
    context,
    persona,
    authorizeIncoming: () => true,
    taskTickMs: 60_000
  });

  for (const ordinal of [1, 2]) {
    const binding = host.sessions.bind(`group:${ordinal}00`, `session-${ordinal}00`);
    host.replies.watch(binding, `admin-request-${ordinal}`);
    host.tasks.schedule({
      id: `admin-task-${ordinal}`,
      kind: 'admin.fixture',
      scope: `group:${ordinal}00`,
      payload: { secret: `${TASK_SECRET}-${ordinal}` },
      dueAt: Date.now() + 60_000
    });
    await host.outbox.send({
      conversationId: `group:${ordinal}00`,
      content: [{ type: 'text', text: `${OUTBOX_SECRET}-${ordinal}` }],
      idempotencyKey: `admin-outbox-${ordinal}`,
      signal: new AbortController().signal
    });
  }
  await host.start();

  const server = createAdminServer({
    token: TOKEN,
    snapshot: () => host.metrics(),
    routes: createHostAdminRoutes(host)
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert(address !== null && typeof address !== 'string');

  testContext.after(async () => {
    await closeServer(server);
    await host.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { host, origin: `http://127.0.0.1:${address.port}` };
}

test('host admin routes paginate metadata without exposing stored bodies', async testContext => {
  const fixture = await startFixture(testContext);
  const authorized = { Authorization: `Bearer ${TOKEN}` };

  const unauthorized = await rawRequest(fixture.origin, '/api/host/sessions');
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(parseObject(unauthorized.text), { error: 'unauthorized' });

  const exposedResponses: string[] = [];
  for (const collection of ['sessions', 'tasks', 'outbox', 'replies']) {
    const first = await rawRequest(fixture.origin, `/api/host/${collection}?limit=1`, { headers: authorized });
    assert.equal(first.status, 200);
    exposedResponses.push(first.text);
    const firstPage = parseObject(first.text);
    assert(Array.isArray(firstPage.items));
    assert.equal(firstPage.items.length, 1);
    assert.equal(typeof firstPage.next, 'string');

    const second = await rawRequest(
      fixture.origin,
      `/api/host/${collection}?limit=1&after=${encodeURIComponent(String(firstPage.next))}`,
      { headers: authorized }
    );
    assert.equal(second.status, 200);
    exposedResponses.push(second.text);
    const secondPage = parseObject(second.text);
    assert(Array.isArray(secondPage.items));
    assert.equal(secondPage.items.length, 1);
    assert.notDeepEqual(secondPage.items, firstPage.items);
    assert.equal(typeof secondPage.next, 'string');
    if (collection === 'replies') {
      for (const item of [...firstPage.items, ...secondPage.items]) {
        assert(item !== null && typeof item === 'object' && !Array.isArray(item));
        assert.deepEqual(Object.keys(item).sort(), [
          'conversationId', 'cursor', 'deadlineAt', 'generation', 'id', 'requestId', 'sessionId', 'status', 'updatedAt'
        ]);
      }
    }

    const exhausted = await rawRequest(
      fixture.origin,
      `/api/host/${collection}?limit=1&after=${encodeURIComponent(String(secondPage.next))}`,
      { headers: authorized }
    );
    assert.equal(exhausted.status, 200);
    exposedResponses.push(exhausted.text);
    assert.deepEqual(parseObject(exhausted.text), { items: [], next: null });
  }

  const metrics = await rawRequest(fixture.origin, '/api/host/metrics', { headers: authorized });
  assert.equal(metrics.status, 200);
  exposedResponses.push(metrics.text);
  const storage = await rawRequest(fixture.origin, '/api/host/storage?limit=1', { headers: authorized });
  assert.equal(storage.status, 200);
  const storageData = parseObject(storage.text);
  assert.equal(typeof storageData.totalRecords, 'number');
  assert(Array.isArray(storageData.namespaces) && storageData.namespaces.length === 1);
  exposedResponses.push(storage.text);
  const exposed = exposedResponses.join('\n');
  assert.doesNotMatch(exposed, /private-task-payload-must-not-leak/);
  assert.doesNotMatch(exposed, /private-outbox-content-must-not-leak/);
  assert.doesNotMatch(exposed, /"payload"|"content"/);
});

test('host admin routes reject invalid queries and expose no write or demo dispatch endpoint', async testContext => {
  const fixture = await startFixture(testContext);
  const authorized = { Authorization: `Bearer ${TOKEN}` };
  for (const query of [
    'limit=0',
    'limit=1001',
    'limit=1&limit=2',
    'after=first&after=second',
    'unexpected=true'
  ]) {
    const response = await rawRequest(fixture.origin, `/api/host/tasks?${query}`, { headers: authorized });
    assert.equal(response.status, 400, query);
    assert.deepEqual(parseObject(response.text), { error: 'invalid_query' });
  }

  const health = await rawRequest(fixture.origin, '/health');
  assert.equal(health.status, 200);
  assert.deepEqual(parseObject(health.text), { ok: true, mode: 'framework' });

  const before = fixture.host.policy.describe();
  const postHeaders = {
    ...authorized,
    Origin: fixture.origin,
    'Content-Type': 'application/json'
  };
  const readOnly = await rawRequest(fixture.origin, '/api/host/metrics', {
    method: 'POST',
    headers: postHeaders,
    body: '{}'
  });
  assert.equal(readOnly.status, 405);
  const missingGrantRoute = await rawRequest(fixture.origin, '/api/host/grants', {
    method: 'POST',
    headers: postHeaders,
    body: '{}'
  });
  assert.equal(missingGrantRoute.status, 404);
  const absentDemoDispatch = await rawRequest(fixture.origin, '/api/demo/events', {
    method: 'POST',
    headers: postHeaders,
    body: '{}'
  });
  assert.equal(absentDemoDispatch.status, 404);
  assert.deepEqual(fixture.host.policy.describe(), before);
});
