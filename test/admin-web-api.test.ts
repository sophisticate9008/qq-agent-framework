import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApiError,
  createApiClient,
  errorMessage,
  loginAccessSession,
  logoutAccessSession,
  readAccessSession
} from '../web/lib/api.ts';

test('web writes with lost or unreadable responses are unknown and never retried', async context => {
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    throw new TypeError('network lost');
  });
  const api = createApiClient();
  await assert.rejects(api.post('/api/settings/gateway', {}), { code: 'operation_unknown', status: 504 });
  assert.equal(calls, 1);
  context.mock.restoreAll();
  context.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response('truncated response', { status: 200 });
  });
  await assert.rejects(api.post('/api/configuration', {}), { code: 'operation_unknown' });
  assert.equal(calls, 2);
  assert.match(errorMessage(new ApiError('operation_unknown', 504)), /无法确认.*刷新状态/);
});

test('web reads report unavailable while explicit HTTP errors retain their stable code', async context => {
  context.mock.method(globalThis, 'fetch', async () => { throw new TypeError('network lost'); });
  const api = createApiClient();
  await assert.rejects(api.get('/api/settings'), { code: 'service_unavailable' });
  context.mock.restoreAll();
  context.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'revision_conflict' }, { status: 409 }));
  await assert.rejects(api.post('/api/configuration', {}), { code: 'revision_conflict', status: 409 });
});

test('web uses a bearer administrator token only to create a same-origin cookie session', async context => {
  const calls: Array<{ readonly path: string; readonly method: string; readonly headers: Headers; readonly credentials: RequestCredentials | undefined; readonly body: BodyInit | null | undefined }> = [];
  context.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      path: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      credentials: init?.credentials,
      body: init?.body
    });
    return Response.json({ authenticated: true, expiresAt: Date.now() + 60_000 });
  });

  const administratorToken = 'administrator-token-0123456789';
  await loginAccessSession(administratorToken);
  await readAccessSession();
  await logoutAccessSession();
  await createApiClient().post('/api/settings', { enabled: true });

  assert.deepEqual(calls.map(call => [call.method, call.path]), [
    ['POST', '/api/auth/login'],
    ['GET', '/api/auth/session'],
    ['POST', '/api/auth/logout'],
    ['POST', '/api/settings']
  ]);
  assert.equal(calls[0]?.headers.get('authorization'), `Bearer ${administratorToken}`);
  assert(calls.slice(1).every(call => call.headers.get('authorization') === null));
  assert(calls.every(call => call.credentials === 'same-origin'));
  assert.equal(calls[0]?.headers.get('content-type'), 'application/json');
  assert.equal(calls[0]?.body, '{}');
  assert.equal(calls[1]?.body, undefined);
  assert.equal(calls[2]?.body, '{}');
});
