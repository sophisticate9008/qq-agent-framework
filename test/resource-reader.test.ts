import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApiClient } from '../web/lib/api.ts';
import { clearReadResources, invalidateReadResources, readResource, readResourceSnapshot, writeResource } from '../web/lib/resource-reader.ts';

function deferred() { let resolve!: (value: unknown) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function client() {
  const requests: { readonly path: string; readonly signal?: AbortSignal; readonly response: ReturnType<typeof deferred> }[] = [];
  const api: ApiClient = { get(path, signal) { const response = deferred(); requests.push({ path, signal, response }); return response.promise; },
    async post() { return { ok: true }; } };
  return { api, requests };
}
const dispatched = () => Promise.resolve();

test('concurrent provider reads share one transport, and one consumer cancellation leaves the other alive', async () => {
  const { api, requests } = client(); const first = new AbortController(); const second = new AbortController();
  const a = readResource(api, '/providers', first.signal); const b = readResource(api, '/providers', second.signal);
  await dispatched(); assert.equal(requests.length, 1);
  first.abort(); await assert.rejects(a, { name: 'AbortError' }); assert.equal(requests[0]?.signal?.aborted, false);
  requests[0]?.response.resolve({ providers: [] }); assert.deepEqual(await b, { providers: [] });
  assert.deepEqual(await readResource(api, '/providers', undefined, 1_000), { providers: [] }); assert.equal(requests.length, 1);
});

test('last consumer cancellation releases transport and a late response cannot populate a new read', async () => {
  const { api, requests } = client(); const owner = new AbortController();
  const stale = readResource(api, '/providers', owner.signal); await dispatched(); owner.abort();
  await assert.rejects(stale, { name: 'AbortError' }); assert.equal(requests[0]?.signal?.aborted, true);
  const next = readResource(api, '/providers'); await dispatched(); requests[0]?.response.resolve('old');
  requests[1]?.response.resolve('new'); assert.equal(await next, 'new'); assert.equal(readResourceSnapshot(api, '/providers').value, 'new');
});

test('failure retains the previous read snapshot; API identities and resource keys never mix', async () => {
  const left = client(); const right = client();
  const initial = readResource(left.api, '/providers'); await dispatched(); left.requests[0]?.response.resolve('saved'); await initial;
  const refresh = readResource(left.api, '/providers', undefined, 0); await dispatched(); left.requests[1]?.response.reject(new Error('offline'));
  await assert.rejects(refresh, /offline/); assert.equal(readResourceSnapshot(left.api, '/providers').value, 'saved');
  assert.equal(readResourceSnapshot(right.api, '/providers').hasValue, false); assert.equal(readResourceSnapshot(left.api, '/status').hasValue, false);
});

test('writes invalidate read snapshots, and clearing a session cancels requests and removes cached values', async () => {
  const { api, requests } = client(); const first = readResource(api, '/providers'); await dispatched(); requests[0]?.response.resolve('before'); await first;
  await writeResource(api, '/providers', {}); assert.equal(readResourceSnapshot(api, '/providers').updatedAt, 0);
  const after = readResource(api, '/providers'); await dispatched(); assert.equal(requests.length, 2);
  invalidateReadResources(api); await assert.rejects(after, { name: 'AbortError' });
  clearReadResources(api); assert.equal(readResourceSnapshot(api, '/providers').hasValue, false);
  requests[1]?.response.resolve('late'); await dispatched(); assert.equal(readResourceSnapshot(api, '/providers').hasValue, false);
});
