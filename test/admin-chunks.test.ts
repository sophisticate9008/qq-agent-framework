import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import test from 'node:test'
import { createAdminServer } from '../src/admin/server.ts'

const root = import.meta.url.endsWith('.ts')
  ? new URL('../dist/admin-web/', import.meta.url)
  : new URL('../admin-web/', import.meta.url)

test('serves built split modules and rejects source paths, unknown chunks and symlinks', async context => {
  const chunk = (await readdir(root)).find(name => /^[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.js$/.test(name))
  assert(chunk, 'Build must include a split module')
  const marker = `chunk-test-${randomUUID().replaceAll('-', '')}`
  const plain = new URL(`${marker}.js`, root)
  const linkedName = `${marker}-abcdefgh.js`
  const linked = new URL(linkedName, root)
  await writeFile(plain, 'private unbundled source')
  await symlink(plain, linked)
  context.after(async () => { await rm(linked, { force: true }); await rm(plain, { force: true }) })
  const server = createAdminServer({ token: 'chunk-test-token-1234567890', snapshot: () => ({}) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  context.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address()
  assert(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const response = await fetch(`${origin}/${chunk}?v=1`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /^text\/javascript/)
  assert.equal(await response.text(), await readFile(new URL(chunk, root), 'utf8'))
  assert.equal((await fetch(`${origin}/${chunk}`, { method: 'POST' })).status, 405)
  for (const path of [`/${marker}.js`, `/${linkedName}`, '/missing-abcdefgh.js', `/nested/${chunk}`,
    `/nested/../${chunk}`, `/%${chunk.charCodeAt(0).toString(16)}${chunk.slice(1)}`, `/${chunk}.map`]) {
    const status = await new Promise<number>((resolve, reject) => {
      const pending = request(origin, { path }, incoming => { incoming.resume(); incoming.on('end', () => resolve(incoming.statusCode ?? 0)) })
      pending.on('error', reject)
      pending.end()
    })
    assert.equal(status, 404, path)
  }
})
