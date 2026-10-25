import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { createNativeMemoryService, readNativeMemoryEntries } from '../src/host/native-memory.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { FrameworkError } from '../src/core/values.ts'
import { parseNativeMemoryEntry, type NativeMemoryAuthority, type NativeMemoryInput, type NativeMemorySource } from '../src/contracts/native-memory.ts'
import { parseNativeMemorySnapshot } from '../src/contracts/native-memory.ts'
import { createNativeMemoryRuntime } from '../src/host/native-memory-runtime.ts'
import { createNativeMemoryRoutes } from '../src/admin/native-memory.ts'
import { createAdminServer } from '../src/admin/server.ts'
import { createNativePackages } from '../src/host/native-packages.ts'
import { createMemoryNativePackage, type NativeMemoryPackageService } from '../src/host/default-native-packages.ts'
import { createPackageConfigurationRegistry } from '../src/host/package-configuration.ts'
import { createPackageConfigurationFileStore } from '../src/storage/package-configuration.ts'

const signal = new AbortController().signal
const operator: NativeMemoryAuthority = { kind: 'operator' }
const owner: NativeMemoryAuthority = { kind: 'owner-message', conversationId: 'group:123', userId: '999', messageId: 'owner-confirmation' }
const source: NativeMemorySource = { kind: 'model-inference', conversationId: 'group:123', userId: '456', messageId: 'actual-user-message' }
const note: NativeMemoryInput = { scope: { kind: 'user', userId: '456', conversationId: 'group:123' }, kind: 'preference',
  content: '用户可能喜欢简短的回复，尚未确认。', tags: ['reply-style'], expiresAt: null }

function fixture(context: TestContext, options: { maxPerScope?: number; maxEntries?: number } = {}) {
  const store = createSqliteStore({ filename: ':memory:' })
  let now = 10_000
  let ownerAllowed = true
  let readsAllowed = true
  const service = createNativeMemoryService({ store, clock: () => now, ...options,
    authorizeSource(actual) {
      if (actual.kind === 'operator' || !['actual-user-message', 'second-user-message'].includes(actual.messageId))
        throw new FrameworkError('MEMORY_SOURCE_NOT_VERIFIED', 'No matching trusted incoming message')
    },
    authorizeOwner(actual) { if (!ownerAllowed || actual.kind !== 'operator' && actual.userId !== '999') throw new FrameworkError('MEMORY_OWNER_REQUIRED', 'Only the actual owner can change confirmed memory') },
    authorizeRead() { if (!readsAllowed) throw new FrameworkError('MEMORY_ACCESS_DENIED', 'The current conversation is not allowed') } })
  context.after(() => store.close())
  return { store, service, now: () => now, advance(ms: number) { now += ms }, ownerAllowed(value: boolean) { ownerAllowed = value }, readsAllowed(value: boolean) { readsAllowed = value } }
}

test('model observations stay proposed and only verified same-conversation QQ owner confirmation makes them retrievable', async context => {
  const { store, service } = fixture(context)
  const proposed = await service.propose(note, source, signal)
  assert.equal(proposed.status, 'proposed')
  assert.equal(proposed.confirmedBy, null)
  assert.deepEqual(await service.query({ conversationId: 'group:123', userId: '456' }, signal), [])
  await assert.rejects(service.confirm(proposed.id, proposed.revision, operator, signal), { code: 'MEMORY_CONFIRMATION_REQUIRES_QQ_OWNER' })
  await assert.rejects(service.confirm(proposed.id, proposed.revision, { ...owner, conversationId: 'group:789' }, signal), { code: 'MEMORY_CONFIRMATION_SCOPE_MISMATCH' })
  await assert.rejects(service.confirm(proposed.id, proposed.revision, { ...owner, userId: '456' }, signal), { code: 'MEMORY_OWNER_REQUIRED' })
  const confirmed = await service.confirm(proposed.id, proposed.revision, owner, signal)
  assert.equal(parseNativeMemoryEntry(confirmed)?.status, 'confirmed')
  assert.deepEqual(confirmed.source, source)
  assert.deepEqual(confirmed.confirmedBy, owner)
  assert.deepEqual((await service.query({ conversationId: 'group:123', userId: '456' }, signal)).map(entry => entry.id), [proposed.id])
  assert.equal(store.list('context.preferences').length, 0)
  assert.equal(store.list('context.configurations').length, 0)
  assert.equal(store.list('policy.grants').length, 0)
})

test('user memories remain in their source conversation; group/global visibility is explicit and private memories never enter another group', async context => {
  const { service } = fixture(context)
  const local = await service.createConfirmed(note, operator, signal)
  const privateNote = await service.createConfirmed({ ...note, scope: { kind: 'user', userId: '456', conversationId: 'private:456' }, content: 'private detail' }, operator, signal)
  const group = await service.createConfirmed({ ...note, scope: { kind: 'group', conversationId: 'group:123' }, content: 'group convention' }, operator, signal)
  const global = await service.createConfirmed({ ...note, scope: { kind: 'global' }, content: 'explicitly shared public preference' }, operator, signal)
  const groupContext = await service.query({ conversationId: 'group:123', userId: '456' }, signal)
  assert.deepEqual(new Set(groupContext.map(entry => entry.id)), new Set([local.id, group.id, global.id]))
  assert.equal(groupContext.some(entry => entry.id === privateNote.id), false)
  assert.deepEqual((await service.query({ conversationId: 'group:789', userId: '456' }, signal)).map(entry => entry.id), [global.id])
  assert.deepEqual(new Set((await service.query({ conversationId: 'private:456', userId: '456' }, signal)).map(entry => entry.id)), new Set([privateNote.id, global.id]))
  assert.deepEqual(new Set((await service.query({ conversationId: 'group:123', userId: '789' }, signal)).map(entry => entry.id)), new Set([group.id, global.id]))
  await assert.rejects(service.propose({ ...note, scope: { kind: 'global' } }, source, signal), { code: 'MEMORY_SOURCE_SCOPE_MISMATCH' })
  await assert.rejects(service.propose({ ...note, scope: { kind: 'group', conversationId: 'group:789' } }, source, signal), { code: 'MEMORY_SOURCE_SCOPE_MISMATCH' })
})

test('owner corrections and revocations use CAS, preserve source audit and do not silently broaden visibility', async context => {
  const data = fixture(context)
  const original = await data.service.createConfirmed(note, operator, signal)
  const corrected = await data.service.correct(original.id, original.revision, { ...note, content: '用户明确喜欢详细解释。' }, owner, signal)
  assert.equal(corrected.history.at(-1)?.action, 'correct')
  assert.match(corrected.history.at(-1)?.previousDigest ?? '', /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(corrected.history).includes(note.content), false)
  await assert.rejects(data.service.correct(original.id, original.revision, note, operator, signal), { code: 'MEMORY_CONFLICT' })
  await assert.rejects(data.service.correct(corrected.id, corrected.revision, { ...note, scope: { kind: 'global' } }, operator, signal), { code: 'MEMORY_SCOPE_IMMUTABLE' })
  data.ownerAllowed(false)
  await assert.rejects(data.service.revoke(corrected.id, corrected.revision, operator, signal), { code: 'MEMORY_OWNER_REQUIRED' })
  data.ownerAllowed(true)
  const revoked = await data.service.revoke(corrected.id, corrected.revision, owner, signal)
  assert.equal(revoked.status, 'revoked')
  assert.deepEqual(await data.service.query({ conversationId: 'group:123', userId: '456' }, signal), [])
  assert.equal(await data.service.remove(revoked.id, revoked.revision, operator, signal), true)
  assert.throws(() => data.service.read(revoked.id), { code: 'MEMORY_NOT_FOUND' })
})

test('expiry is enforced in readonly queries, explicit cleanup frees bounded capacity and no live records are silently evicted', async context => {
  const data = fixture(context, { maxPerScope: 2, maxEntries: 3 })
  const expires = await data.service.createConfirmed({ ...note, expiresAt: data.now() + 1_000 }, operator, signal)
  const retained = await data.service.createConfirmed(note, operator, signal)
  await assert.rejects(data.service.createConfirmed(note, operator, signal), { code: 'MEMORY_SCOPE_CAPACITY_EXCEEDED' })
  data.advance(1_000)
  const before = data.store.read('package.memory.entries', expires.id)
  assert.equal(data.service.read(expires.id).status, 'expired')
  assert.deepEqual((await data.service.query({ conversationId: 'group:123', userId: '456' }, signal)).map(entry => entry.id), [retained.id])
  assert.deepEqual(data.store.read('package.memory.entries', expires.id), before)
  assert.deepEqual(await data.service.purgeExpired(operator, signal), { removed: 1, remaining: false })
  await data.service.createConfirmed(note, operator, signal)
  assert(data.store.read('package.memory.entries', retained.id))
})

test('confirmed context retrieval records provenance, relevance, exact byte/character budgets and omitted items without granting authority', async context => {
  const { service } = fixture(context)
  for (let index = 0; index < 5; index++) await service.createConfirmed({ ...note, content: `中文偏好${index}：` + '喜欢简洁回复。'.repeat(150) }, operator, signal)
  const contextValue = await service.context({ conversationId: 'group:123', userId: '456', query: '中文偏好', maxCharacters: 800, maxBytes: 2_000 }, signal)
  assert.equal(contextValue.authorization, false)
  assert.equal(contextValue.source, 'confirmed-memory')
  assert.equal(contextValue.usedBytes, Buffer.byteLength(JSON.stringify(contextValue), 'utf8'))
  assert(contextValue.usedBytes <= 2_000)
  assert(contextValue.usedCharacters <= 800)
  assert.equal(contextValue.total, 5)
  assert.equal(contextValue.omitted, 5 - contextValue.items.length)
  assert.equal(contextValue.truncated, true)
  assert(contextValue.items.every(item => item.confirmedBy.kind === 'operator' && item.source.kind === 'operator'))
  assert.deepEqual((await service.context({ conversationId: 'group:123', userId: '456', maxCharacters: 0, maxBytes: 512 }, signal)).items, [])
  assert.deepEqual(await service.query({ conversationId: 'group:123', userId: '456', query: 'does-not-match' }, signal), [])
})

test('source evidence and read access must be current; malformed authority-shaped inputs never become stored memory', async context => {
  const data = fixture(context)
  await assert.rejects(data.service.propose(note, { ...source, messageId: 'not-in-trusted-inbox' }, signal), { code: 'MEMORY_SOURCE_NOT_VERIFIED' })
  await assert.rejects(data.service.propose({ ...note, authorization: { owner: true } }, source, signal), { code: 'MEMORY_INVALID' })
  await assert.rejects(data.service.propose({ ...note, confirmed: true }, source, signal), { code: 'MEMORY_INVALID' })
  const controller = new AbortController(); controller.abort(new Error('cancelled'))
  await assert.rejects(data.service.createConfirmed(note, operator, controller.signal), /cancelled/)
  assert.deepEqual(data.service.list().entries, [])
  await data.service.createConfirmed(note, operator, signal)
  data.readsAllowed(false)
  await assert.rejects(data.service.context({ conversationId: 'group:123', userId: '456' }, signal), { code: 'MEMORY_ACCESS_DENIED' })
  assert.equal(readNativeMemoryEntries(data.store, { clock: data.now }).entries.length, 1)
})

test('memory controller GET is readonly, POST may open private storage, and closed references cannot write', async context => {
  const parent = await mkdtemp(join(tmpdir(), 'native-memory-controller-'))
  context.after(() => rm(parent, { recursive: true, force: true }))
  const directory = join(parent, 'not-yet-created')
  const options = { directory, clock: () => 10_000, authorizeSource() {}, authorizeOwner() {}, authorizeRead() {} }
  const controller = createNativeMemoryRuntime(options)
  assert.deepEqual(controller.read(), { schema: 1, entries: [], nextCursor: null })
  assert.deepEqual(await readdir(parent), [])
  const saved = await controller.service().createConfirmed(note, operator, signal)
  assert.equal((await stat(join(directory, 'native-memory.sqlite'))).mode & 0o777, 0o600)
  controller.close()
  const reopened = createNativeMemoryRuntime(options)
  context.after(() => reopened.close())
  const bytes = await readFile(join(directory, 'native-memory.sqlite'))
  assert.equal(reopened.read().entries[0]?.id, saved.id)
  assert.equal(reopened.entry(saved.id).revision, saved.revision)
  assert.equal(reopened.status().opened, false)
  assert.deepEqual(await readFile(join(directory, 'native-memory.sqlite')), bytes)
  assert((await readdir(directory)).every(name => ['native-memory.sqlite', 'native-memory.sqlite-wal', 'native-memory.sqlite-shm'].includes(name)))
  const retained = reopened.service()
  reopened.close()
  await assert.rejects(retained.createConfirmed(note, operator, signal), { code: 'NATIVE_CHAT_CLOSED' })
  assert.throws(() => reopened.read(), { code: 'NATIVE_CHAT_CLOSED' })
})

test('memory management HTTP creates explicit operator data and never confirms model proposals', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'native-memory-http-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const controller = createNativeMemoryRuntime({ directory, clock: () => 10_000, authorizeSource() {}, authorizeOwner() {}, authorizeRead() {} })
  context.after(() => controller.close())
  const token = 'memory-admin-token-1234567890'
  const server = createAdminServer({ token, snapshot: () => ({}), routes: createNativeMemoryRoutes({
    read: controller.read, entry: controller.entry, service: controller.service }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  context.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address(); assert(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  async function get(query = '') { return fetch(`${origin}/api/chat/memory${query}`, { headers: { authorization: `Bearer ${token}` } }) }
  async function post(value: unknown) { return fetch(`${origin}/api/chat/memory`, { method: 'POST', headers: {
    authorization: `Bearer ${token}`, origin, 'content-type': 'application/json' }, body: JSON.stringify(value) }) }
  assert.deepEqual(parseNativeMemorySnapshot(await (await get()).json())?.entries, [])
  assert.deepEqual(await readdir(directory), [])
  const created = await post({ action: 'create', entry: note })
  assert.equal(created.status, 200)
  const saved = parseNativeMemoryEntry(await created.json()); assert(saved)
  assert.equal(saved.status, 'confirmed')
  assert.equal(saved.source.kind, 'operator')
  const proposed = await controller.service().propose(note, source, signal)
  assert.equal((await post({ action: 'confirm', id: proposed.id, revision: proposed.revision })).status, 400)
  const correctedProposal = await post({ action: 'correct', id: proposed.id, revision: proposed.revision, entry: { ...note, content: 'operator corrected proposal text' } })
  assert.equal(correctedProposal.status, 200)
  assert.equal(parseNativeMemoryEntry(await correctedProposal.json())?.status, 'proposed')
  const corrected = await post({ action: 'correct', id: saved.id, revision: saved.revision, entry: { ...note, content: 'corrected confirmed preference' } })
  const current = parseNativeMemoryEntry(await corrected.json()); assert(current)
  assert.equal((await post({ action: 'revoke', id: saved.id, revision: saved.revision })).status, 409)
  const revoked = await post({ action: 'revoke', id: saved.id, revision: current.revision })
  const revokedEntry = parseNativeMemoryEntry(await revoked.json()); assert(revokedEntry)
  assert.equal((await post({ action: 'remove', id: saved.id, revision: revokedEntry.revision })).status, 200)
  assert.equal((await get(`?id=${saved.id}`)).status, 404)
  assert.equal((await get('?scope=user&conversationId=group:123&userId=456')).status, 200)
  assert.equal((await get('?scope=global&conversationId=group:123')).status, 400)
  assert.equal((await post({ action: 'purge-expired' })).status, 200)
})

test('memory package exposes retrieval/proposal only and revokes retained provider access when stopped', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'native-memory-package-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const { service } = fixture(context)
  const saved = await service.createConfirmed(note, operator, signal)
  const packages = createNativePackages({ packages: [createMemoryNativePackage({ service })],
    configurationRegistry: createPackageConfigurationRegistry({ store: createPackageConfigurationFileStore(directory) }) })
  await packages.start()
  const provider = packages.service('memory', 1) as NativeMemoryPackageService
  assert.equal('confirm' in provider, false)
  assert.equal('createConfirmed' in provider, false)
  assert.equal((await provider.context({ conversationId: 'group:123', userId: '456' }, signal)).items[0]?.id, saved.id)
  await packages.stop()
  await assert.rejects(provider.context({ conversationId: 'group:123', userId: '456' }, signal))
  assert.equal(service.read(saved.id).status, 'confirmed')
})

test('corrupt existing memory storage never becomes an empty/default view', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'native-memory-corrupt-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'native-memory.sqlite'), 'not a database', { mode: 0o600 })
  const controller = createNativeMemoryRuntime({ directory, authorizeSource() {}, authorizeOwner() {}, authorizeRead() {} })
  context.after(() => controller.close())
  assert.throws(() => controller.read(), { code: 'STORE_READONLY_UNAVAILABLE' })
  assert.equal(controller.status().opened, false)
})
