import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiClient, loginAccessSession, logoutAccessSession, readAccessSession } from '../web/lib/api.ts';

test('API client sends bearer only during login and uses same-origin cookie credentials for every actual request', async context => {
  const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
  context.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const signal = new AbortController().signal;
  await loginAccessSession('synthetic-login-token', signal);
  await readAccessSession(signal);
  const api = createApiClient();
  await api.get('/api/chat/sessions?limit=2&after=private%3A123', signal);
  await api.post('/api/chat/plans', { revision: 'fixture-revision', plans: [] }, signal);
  await logoutAccessSession(signal);
  assert.deepEqual(calls.map(call => [call.url, call.init.method]), [
    ['/api/auth/login', 'POST'], ['/api/auth/session', 'GET'],
    ['/api/chat/sessions?limit=2&after=private%3A123', 'GET'], ['/api/chat/plans', 'POST'], ['/api/auth/logout', 'POST'],
  ]);
  for (const [index, call] of calls.entries()) {
    const headers = new Headers(call.init.headers);
    assert.equal(call.init.credentials, 'same-origin');
    assert.equal(headers.get('authorization'), index === 0 ? 'Bearer synthetic-login-token' : null);
    assert.equal(headers.get('content-type'), call.init.method === 'POST' ? 'application/json' : null);
    assert(call.init.signal instanceof AbortSignal);
  }
  assert.equal(calls[0]!.init.body, '{}');
  assert.equal(calls[1]!.init.body, undefined);
  assert.equal(calls[3]!.init.body, JSON.stringify({ revision: 'fixture-revision', plans: [] }));
  assert.equal(calls[4]!.init.body, '{}');
});
