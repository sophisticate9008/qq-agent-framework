import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createConfigurationRoutes } from '../src/admin/configuration.ts'
import { withConfigurationWriteLock } from '../src/admin/configuration-lock.ts'
import { createSettingsRoutes } from '../src/admin/settings.ts'
import { AdminRequestError, type AdminRoute } from '../src/admin/server.ts'

function invoke(routes: readonly AdminRoute[], pathname: string, body: Record<string, unknown>): Promise<unknown> {
  const route = routes.find(value => value.pathname === pathname && value.method === 'POST')
  assert(route)
  return Promise.resolve(route.handle({ body, query: new URLSearchParams(), signal: new AbortController().signal }))
}

test('both configuration APIs share CAS serialization for admin and gateway writes', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'configuration-cas-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const admin = join(directory, 'admin.json')
  const gateway = join(directory, 'gateway.json')
  const options = { adminConfigurationFilename: admin, gatewayConfigurationFilename: gateway }
  const configuration = createConfigurationRoutes(options)
  const settings = createSettingsRoutes(options)
  for (const target of ['admin', 'gateway'] as const) {
    for (let iteration = 0; iteration < 12; iteration++) {
      const original = target === 'admin'
        ? { host: '127.0.0.1', port: 3210, tokenFile: 'admin.token', gatewayConfiguration: gateway }
        : { port: 3131, upstreamEndpoint: 'http://127.0.0.1:3000', tokenFile: 'gateway.token',
          storeFilename: 'gateway.sqlite', allowedConversations: ['private:123'],
          persona: { id: 'test', version: '1' }, budgetEnabled: true, maxSendUses: 7, authorizationVersion: 'initial' }
      const filename = target === 'admin' ? admin : gateway
      const bytes = JSON.stringify(original)
      await writeFile(filename, bytes, { mode: 0o600 })
      const revision = createHash('sha256').update(bytes).digest('hex')
      const results = await Promise.allSettled([
        invoke(configuration, '/api/configuration', { source: target, revision,
          changes: target === 'admin' ? { accessSessionTtlMs: 600_000 } : { allowedConversations: ['group:456'] } }),
        invoke(settings, `/api/settings/${target}`, { revision,
          values: target === 'admin' ? { host: '127.0.0.1', port: 4321 }
            : { budgetEnabled: false, maxSendUses: 11, grantTtlMs: null,
              timeoutMs: 60_000, maxPending: 16, maxBodyBytes: 28 * 1024 * 1024, maxRecords: 10_000 } })
      ])
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
      const conflict = results.find(result => result.status === 'rejected')
      assert(conflict?.status === 'rejected' && conflict.reason instanceof AdminRequestError)
      assert.equal(conflict.reason.statusCode, 409)
      const current: unknown = JSON.parse(await readFile(filename, 'utf8'))
      assert(current !== null && typeof current === 'object')
      if (results[0].status === 'fulfilled') {
        assert.equal(target === 'admin' ? 'accessSessionTtlMs' in current
          : 'allowedConversations' in current && JSON.stringify(current.allowedConversations) === '["group:456"]', true)
      } else {
        assert.equal(target === 'admin' ? 'port' in current && current.port === 4321
          : 'budgetEnabled' in current && current.budgetEnabled === false, true)
      }
    }
  }
})

test('configuration locks canonicalize parent aliases and never remove an existing foreign lock', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'configuration-lock-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const alias = `${directory}-alias`
  await symlink(directory, alias)
  context.after(() => rm(alias, { force: true }))
  let finish: (() => void) | undefined
  let entered: (() => void) | undefined
  const started = new Promise<void>(resolvePromise => { entered = resolvePromise })
  const paused = new Promise<void>(resolvePromise => { finish = resolvePromise })
  const calls: number[] = []
  const first = withConfigurationWriteLock(join(directory, 'admin.json'), async () => {
    calls.push(1)
    entered?.()
    await paused
    calls.push(2)
  })
  await started
  const second = withConfigurationWriteLock(join(alias, 'admin.json'), async () => { calls.push(3) })
  await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 20))
  assert.deepEqual(calls, [1])
  finish?.()
  await Promise.all([first, second])
  assert.deepEqual(calls, [1, 2, 3])
  const foreign = join(directory, '.admin.json.admin-write.lock')
  await writeFile(foreign, 'foreign process', { mode: 0o600 })
  await assert.rejects(withConfigurationWriteLock(join(directory, 'admin.json'), async () => assert.fail()),
    error => error instanceof AdminRequestError && error.code === 'configuration_write_busy')
  assert.equal(await readFile(foreign, 'utf8'), 'foreign process')
})
