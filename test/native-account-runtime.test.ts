import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNativeAccounts } from '../src/host/native-accounts.ts'
import { createNativeAccountRuntimeBundle, createNativeAccountDispatchRoutes, type NativeAccountRuntimeBundle } from '../src/admin/native-account-runtime.ts'
import { createNativeAccountRoutes } from '../src/admin/native-accounts.ts'
import { isRecord } from '../src/core/values.ts'
const signal = new AbortController().signal

test('the default account bundle configures only its private directory and dispatches concrete account routes without GET writes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'account-runtime-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const bundles = new Map<string, NativeAccountRuntimeBundle>()
  const accounts = createNativeAccounts({ directory, protocols: [{ id: 'onebot', create(options) {
    const bundle = createNativeAccountRuntimeBundle(options); bundles.set(options.accountScope.accountId, bundle); return bundle
  } }] })
  t.after(() => accounts.close())
  let snapshot = await accounts.read()
  snapshot = await accounts.create({ revision: snapshot.revision, label: 'A', accountScope: { protocolId: 'onebot', accountId: '101' } }, signal)
  snapshot = await accounts.create({ revision: snapshot.revision, label: 'B', accountScope: { protocolId: 'onebot', accountId: '102' } }, signal)
  const dispatch = createNativeAccountDispatchRoutes({ accounts, async bundle(id) {
    const target = await accounts.runtime(id)
    assert('routes' in target)
    return target as NativeAccountRuntimeBundle
  } })
  const [a, b] = snapshot.accounts; assert(a && b)
  const firstDirectory = await accounts.accountDirectory(a.id)
  const initialFiles = await readdir(firstDirectory)
  async function run(method: 'GET' | 'POST', id: string, path: string, body: Record<string, unknown> | null = null) {
    return dispatch.find(route => route.method === method)!.handle({ query: new URLSearchParams({ account: id, path }), body, signal })
  }
  const plans = await run('GET', a.id, '/api/chat/plans'); assert(isRecord(plans) && typeof plans.revision === 'string')
  await run('GET', a.id, '/api/chat/status')
  await run('GET', a.id, '/api/chat/features')
  await run('GET', a.id, '/api/chat/adapters')
  assert.deepEqual(await readdir(firstDirectory), initialFiles, 'GET cannot create a database, configuration, lifecycle intent, or scheduler file')
  await assert.rejects(run('GET', a.id, '/api/settings'), { code: 'invalid_account_dispatch' })
  await assert.rejects(run('POST', a.id, '/api/chat/arbitrary'), { code: 'account_route_not_found' })
  const access = await run('GET', a.id, '/api/chat/access'); assert(isRecord(access) && typeof access.revision === 'string')
  const saved = await run('POST', a.id, '/api/chat/access', { revision: access.revision, allow: ['private:42'], deny: [], owner: '42' })
  assert(isRecord(saved)); assert.deepEqual(saved.allow, ['private:42'])
  const other = await run('GET', b.id, '/api/chat/access'); assert(isRecord(other)); assert.deepEqual(other.allow, [])
  const routes = createNativeAccountRoutes(accounts)
  const post = routes.find(route => route.method === 'POST')!
  await assert.rejects(async () => post.handle({ query: new URLSearchParams(), body: { action: 'start', id: a.id, revision: snapshot.revision }, signal }), { code: 'invalid_account_request' })
  await assert.rejects(async () => post.handle({ query: new URLSearchParams(), body: { action: 'stop', id: a.id, revision: '0'.repeat(64) }, signal }), { code: 'account_revision_conflict' })
})
