import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { chmod, mkdtemp, rename, rm, symlink, utimes, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createLocalDshAuthenticationProvider } from '../src/adapters/dsh-local-auth.ts'

function credentials(secret: Buffer): string {
  return JSON.stringify({ records: { 'client-connection/browser-session': { kind: 'grant', payload: {
    version: 1, secret: secret.toString('base64url')
  } } } })
}

function signature(cookie: string, secret: Buffer): void {
  const parts = cookie.split('.')
  assert.equal(parts.length, 3)
  assert.equal(parts[2], createHmac('sha256', secret).update(parts[1]!).digest('base64url'))
}

test('local authentication reuses cookies only after current file checks and renews before expiry', { skip: process.platform !== 'linux' }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-local-auth-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, '.credentials.yaml')
  const first = Buffer.alloc(32, 1)
  const second = Buffer.alloc(32, 2)
  await writeFile(path, credentials(first), { mode: 0o600 })
  let now = Date.now()
  context.mock.method(Date, 'now', () => now)
  const provider = createLocalDshAuthenticationProvider({ endpoint: 'http://127.0.0.1:3000', credentialsPath: path })
  const signal = new AbortController().signal
  const initial = await provider('none', signal)
  signature(initial, first)
  now += 1_000
  assert.equal(await provider('answer', signal), initial)
  now += 240_000
  const renewed = await provider('none', signal)
  assert.notEqual(renewed, initial)
  signature(renewed, first)

  const before = await stat(path)
  await writeFile(path, credentials(second))
  await utimes(path, before.atime, before.mtime)
  const rotated = await provider('none', signal)
  signature(rotated, second)
  assert.notEqual(rotated, renewed)
  await chmod(path, 0o640)
  await assert.rejects(provider('none', signal), { code: 'DSH_LOCAL_AUTH_UNAVAILABLE' })
  await chmod(path, 0o600)
  signature(await provider('none', signal), second)
  await writeFile(path, JSON.stringify({ records: {} }))
  await assert.rejects(provider('none', signal), { code: 'DSH_LOCAL_AUTH_UNAVAILABLE' })
  await writeFile(path, credentials(first))
  await rename(path, `${path}.old`)
  await symlink(`${path}.old`, path)
  await assert.rejects(provider('none', signal), { code: 'DSH_LOCAL_AUTH_UNAVAILABLE' })
})

test('concurrent local authentication isolates caller cancellation', { skip: process.platform !== 'linux' }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-local-auth-concurrent-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, '.credentials.yaml')
  const secret = Buffer.alloc(32, 3)
  await writeFile(path, credentials(secret), { mode: 0o600 })
  const provider = createLocalDshAuthenticationProvider({ endpoint: 'http://127.0.0.1:3000', credentialsPath: path })
  const controller = new AbortController()
  const canceled = provider('none', controller.signal)
  const active = provider('answer', new AbortController().signal)
  controller.abort()
  await assert.rejects(canceled, { code: 'DSH_LOCAL_AUTH_ABORTED' })
  signature(await active, secret)
})
