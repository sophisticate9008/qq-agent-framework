import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createApiClient, errorMessage } from '../web/lib/api.ts';

test('web writes with lost or unreadable responses are unknown and never retried', async context => {
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    throw new TypeError('network lost');
  });
  const api = createApiClient(() => 'fixture-token');
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
  const api = createApiClient(() => 'fixture-token');
  await assert.rejects(api.get('/api/settings'), { code: 'service_unavailable' });
  context.mock.restoreAll();
  context.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'revision_conflict' }, { status: 409 }));
  await assert.rejects(api.post('/api/configuration', {}), { code: 'revision_conflict', status: 409 });
});
