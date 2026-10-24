import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import filesystem, { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createConfigurationRoutes } from '../src/admin/configuration.ts'
import { createSettingsRoutes } from '../src/admin/settings.ts'
import { AdminRequestError } from '../src/admin/server.ts'

test('configuration writes distinguish pre-replacement failure from uncertain post-replacement durability', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'admin-write-uncertainty-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const filename = join(directory, 'admin.json')
  const gateway = join(directory, 'gateway.json')
  const originalOpen = filesystem.open
  const originalRename = filesystem.rename
  for (const source of ['configuration', 'settings'] as const) {
    for (const phase of ['write', 'file-sync', 'rename', 'directory-sync', 'readback'] as const) {
      const original = JSON.stringify({ host: '127.0.0.1', port: 3210, tokenFile: 'admin.token', gatewayConfiguration: gateway })
      await writeFile(filename, original, { mode: 0o600 })
      const revision = createHash('sha256').update(original).digest('hex')
      const options = { adminConfigurationFilename: filename, gatewayConfigurationFilename: gateway }
      const routes = source === 'configuration' ? createConfigurationRoutes(options) : createSettingsRoutes(options)
      const route = routes.find(value => value.method === 'POST' && value.pathname === (source === 'configuration' ? '/api/configuration' : '/api/settings/admin'))
      assert(route)
      const invoke = (revision: string) => Promise.resolve(route.handle({ query: new URLSearchParams(), signal: new AbortController().signal,
        body: source === 'configuration' ? { source: 'admin', revision, changes: { accessSessionTtlMs: 600_000 } }
          : { revision, values: { host: '127.0.0.1', port: 4321 } } }))
      let replaced = false
      const fail = (): never => { throw Object.assign(new Error('synthetic I/O failure'), { code: 'EIO' }) }
      filesystem.open = async (...argumentsList) => {
        const target = argumentsList[0]
        if (phase === 'readback' && replaced && target === filename) return fail()
        const handle = await originalOpen(...argumentsList)
        const temporary = typeof target === 'string' && (target.includes('.configuration-') || target.includes('.settings-'))
        if (temporary && phase === 'write') handle.writeFile = async () => fail()
        if (temporary && phase === 'file-sync' || target === directory && phase === 'directory-sync') handle.sync = async () => fail()
        return handle
      }
      filesystem.rename = async (...argumentsList) => {
        if (argumentsList[1] === filename && phase === 'rename') return fail()
        await originalRename(...argumentsList)
        if (argumentsList[1] === filename) replaced = true
      }
      syncBuiltinESMExports()
      try {
        const unknown = phase === 'directory-sync' || phase === 'readback'
        await assert.rejects(invoke(revision), (error: unknown) => error instanceof AdminRequestError
          && error.statusCode === 500 && error.code === `${source}_write_${unknown ? 'unknown' : 'failed'}`,
        `${source}: ${phase}`)
      } finally {
        filesystem.open = originalOpen
        filesystem.rename = originalRename
        syncBuiltinESMExports()
      }
      const after = await readFile(filename, 'utf8')
      assert.equal(after !== original, phase === 'directory-sync' || phase === 'readback', `${source}: ${phase} changed state`)
      assert.equal((await readdir(directory)).some(path => path.endsWith('.lock') || path.endsWith('.tmp')), false)
      const currentRevision = createHash('sha256').update(after).digest('hex')
      await invoke(currentRevision)
    }
  }
})
