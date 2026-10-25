import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNativeToolPermissionsRepository } from '../src/host/native-tool-permissions.ts'
import { createNativeToolPermissionRoutes } from '../src/admin/native-tool-permissions.ts'
import { createAdminServer } from '../src/admin/server.ts'
import { parseNativeToolPermissionInput, parseNativeToolPermissionsSnapshot, type NativeToolPermissionInput } from '../src/contracts/native-tool-permissions.ts'

const first: NativeToolPermissionInput = { id: '11111111-1111-4111-8111-111111111111', conversationId: 'group:123',
  capabilities: ['native.media.inspect'], maxUses: { 'native.media.inspect': 5 }, expiresAt: null }

test('tool permission file preserves immutable grant identities and revocation tombstones under CAS without creating files on reads', async context => {
  const parent = await mkdtemp(join(tmpdir(), 'tool-permissions-'))
  context.after(() => rm(parent, { recursive: true, force: true }))
  const directory = join(parent, 'configuration')
  let now = 100
  const repository = createNativeToolPermissionsRepository(directory, () => now)
  const initial = await repository.read()
  assert.equal(initial.configuration.grants.length, 0)
  assert.deepEqual(await readdir(parent), [])
  const saved = await repository.grant(initial.revision, first, new AbortController().signal)
  assert.equal(saved.configuration.grants[0]?.createdAt, 100)
  assert.equal((await stat(join(directory, 'chat-tool-permissions.json'))).mode & 0o777, 0o600)
  await assert.rejects(repository.grant(initial.revision, { ...first, id: '22222222-2222-4222-8222-222222222222' }, new AbortController().signal), /chat_revision_conflict/)
  now = 200
  const revoked = await repository.revoke(saved.revision, first.id, new AbortController().signal)
  assert.equal(revoked.configuration.grants[0]?.revokedAt, 200)
  assert.deepEqual(revoked.configuration.grants[0]?.maxUses, first.maxUses)
  await assert.rejects(repository.grant(revoked.revision, first, new AbortController().signal), { code: 'TOOL_PERMISSION_ID_EXISTS' })
  assert.equal((await repository.read()).configuration.grants.length, 1)
})

test('tool permission decoder requires explicit per-capability limits and rejects broad scopes, extra fields and malformed unlimited grants', () => {
  assert(parseNativeToolPermissionInput(first))
  assert(parseNativeToolPermissionInput({ ...first, maxUses: { 'native.media.inspect': null } }))
  for (const input of [{ ...first, conversationId: '*' }, { ...first, capabilities: ['messaging.send'] },
    { ...first, maxUses: {} }, { ...first, maxUses: { 'native.media.inspect': 0 } },
    { ...first, maxUses: { 'native.media.inspect': null, 'native.media.read': null } }, { ...first, secret: 'synthetic' }]) {
    assert.equal(parseNativeToolPermissionInput(input), null)
  }
})

test('tool permission HTTP commits once and reports runtime unknown without retrying failed live synchronization', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'tool-permission-http-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  let changes = 0
  const server = createAdminServer({ token: 'synthetic-tools-admin-token-123456', snapshot: () => ({}),
    routes: createNativeToolPermissionRoutes({ directory,
      runtime: () => ({ state: 'pending', appliedRevision: null }),
      onChanged() { changes++; throw new Error('synchronization_unknown') } }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  context.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address(); assert(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const headers = { authorization: 'Bearer synthetic-tools-admin-token-123456', origin, 'content-type': 'application/json' }
  const initialResponse = await fetch(origin + '/api/chat/tool-permissions', { headers })
  const initial = parseNativeToolPermissionsSnapshot(await initialResponse.json()); assert(initial)
  const post = (body: unknown) => fetch(origin + '/api/chat/tool-permissions', { method: 'POST', headers, body: JSON.stringify(body) })
  const response = await post({ revision: initial.revision, action: 'grant', grant: first })
  assert.equal(response.status, 200)
  const saved = parseNativeToolPermissionsSnapshot(await response.json()); assert(saved)
  assert.equal(saved.runtime.state, 'unknown'); assert.equal(saved.grants.length, 1); assert.equal(changes, 1)
  assert.equal((await post({ revision: initial.revision, action: 'grant', grant: first })).status, 409)
  assert.equal(changes, 1)
  const read = parseNativeToolPermissionsSnapshot(await (await fetch(origin + '/api/chat/tool-permissions', { headers })).json()); assert(read)
  assert.equal(read.grants.length, 1); assert.equal(changes, 1)
  assert.equal((await post({ revision: saved.revision, action: 'approve', id: first.id })).status, 400)
  const revoked = parseNativeToolPermissionsSnapshot(await (await post({ revision: saved.revision, action: 'revoke', id: first.id })).json()); assert(revoked)
  assert.equal(typeof revoked.grants[0]?.revokedAt, 'number'); assert.equal(changes, 2)
})
