import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, rm, readFile, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNativeAccounts } from '../src/host/native-accounts.ts'
import { createBridgeHost } from '../src/host/bridge.ts'
import { createContextStore } from '../src/core/context.ts'
import { createPolicy } from '../src/core/policy.ts'
import { createEngine } from '../src/core/engine.ts'
import type { AccountScope, SendRequest } from '../src/core/types.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { assertAccountStore } from '../src/storage/account-scope.ts'
import { openReadonlySqliteStore } from '../src/storage/sqlite-readonly.ts'
import { parseNativeAccountsSnapshot } from '../src/contracts/native-accounts.ts'
const signal = new AbortController().signal
const A: AccountScope = { protocolId: 'onebot', accountId: '10001' }
const B: AccountScope = { protocolId: 'onebot', accountId: '10002' }
function context() { const context = createContextStore(); const persona = context.registerPersona({ id: 'demo', version: '1.0.0', name: 'Demo', identity: {}, style: {} }); return { context, persona } }

test('two registered accounts own actual independent bridge/session/policy/state/outbox databases and reject missing or foreign scopes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'native-accounts-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const hosts = new Map<string, ReturnType<typeof createBridgeHost>>()
  const sends = new Map<string, SendRequest[]>()
  const manager = createNativeAccounts({ directory, protocols: [{ id: 'onebot', create({ directory, accountScope, expectedSelfId }) {
    assert.equal(expectedSelfId, accountScope.accountId)
    const store = createSqliteStore({ filename: join(directory, 'native-chat.sqlite') })
    const sent: SendRequest[] = []; sends.set(accountScope.accountId, sent)
    const host = createBridgeHost({ ...context(), accountScope, store, authorizeIncoming: () => true,
      transport: { send(request) { sent.push(request); return { status: 'confirmed', messageId: 'same-receipt' } } },
      agent: { async createSession() { return { sessionId: 'same-session' } }, async submit() { return { status: 'accepted' } }, async follow() { return () => undefined } } })
    hosts.set(accountScope.accountId, host)
    return { async start() { await host.start() }, async stop() { await host.stop() }, async close() { await host.stop(); store.close() } }
  } }] })
  t.after(() => manager.close())
  let snapshot = await manager.read(); assert(parseNativeAccountsSnapshot(snapshot))
  assert.deepEqual(await readdir(directory), [], 'GET cannot create account files or start adapters')
  snapshot = await manager.create({ revision: snapshot.revision, label: 'A', accountScope: A }, signal)
  await assert.rejects(manager.create({ revision: snapshot.revision, label: 'duplicate', accountScope: A }, signal), { code: 'ACCOUNT_EXISTS' })
  snapshot = await manager.create({ revision: snapshot.revision, label: 'B', accountScope: B }, signal)
  const [a, b] = snapshot.accounts; assert(a && b)
  assert.notEqual(await manager.accountDirectory(a.id), await manager.accountDirectory(b.id))
  assert.equal(hosts.size, 0, 'configuration cannot execute factories')
  await Promise.all([manager.start(a.id, signal), manager.start(b.id, signal)])
  const hostA = hosts.get(A.accountId)!; const hostB = hosts.get(B.accountId)!
  for (const [host, scope] of [[hostA, A], [hostB, B]] as const) {
    const binding = await host.sessions.resolve('private:42', signal)
    assert.deepEqual(binding.accountScope, scope)
    host.policy.grant({ id: 'same-grant', accountScope: scope, featureId: 'sample', conversationId: 'private:42', capabilities: ['messaging.send'], maxUses: { 'messaging.send': 1 } })
    host.engine.install({ id: 'sample', version: '1.0.0', apiVersion: 1, capabilities: ['messaging.send'], subscriptions: ['trigger.fired'], setup(context) { context.on('trigger.fired', async execution => { execution.state.set('same-key', { account: scope.accountId }); await execution.send([{ type: 'text', text: scope.accountId }]) }) } })
    await host.engine.emit({ id: 'same-event', type: 'trigger.fired', conversationId: 'private:42', data: {}, accountScope: scope })
    assert.equal(host.outbox.list().length, 1)
    assert.deepEqual(sends.get(scope.accountId)?.[0]?.scope?.accountScope, scope)
  }
  assert.notEqual(sends.get(A.accountId)?.[0]?.idempotencyKey, sends.get(B.accountId)?.[0]?.idempotencyKey)
  assert.throws(() => hostA.policy.grant({ id: 'bad', featureId: 'sample', conversationId: 'private:42', capabilities: ['messaging.send'], maxUses: { 'messaging.send': 1 } }), { code: 'ACCOUNT_SCOPE_REQUIRED' })
  assert.throws(() => hostA.policy.reserve({ accountScope: B, featureId: 'sample', conversationId: 'private:42', capability: 'messaging.send' }), { code: 'ACCOUNT_SCOPE_MISMATCH' })
  await assert.rejects(async () => hostA.engine.emit({ accountScope: B, id: 'bad', type: 'trigger.fired', conversationId: 'private:42', data: {} }), { code: 'ACCOUNT_SCOPE_MISMATCH' })
  await assert.rejects(hostA.receive({ id: 'bad', conversationId: 'private:42', userId: '42', receivedAt: Date.now(), content: [{ type: 'text', text: 'bad' }], directed: true, isSelf: false }), { code: 'ACCOUNT_SCOPE_REQUIRED' })
  assert.throws(() => hostA.outbox.send({ conversationId: 'private:42', content: [{ type: 'text', text: 'bad' }], idempotencyKey: 'bad', signal }), { code: 'ACCOUNT_SCOPE_REQUIRED' })
  assert.equal(sends.get(A.accountId)?.length, 1)
  await manager.stop(a.id, signal)
  assert.equal((await manager.read()).accounts.find(item => item.id === a.id)?.state, 'stopped')
  assert.equal((await manager.read()).accounts.find(item => item.id === b.id)?.state, 'running')
  const reader = openReadonlySqliteStore(join(await manager.accountDirectory(a.id), 'native-chat.sqlite'))
  try { const revision = reader.revision(); assertAccountStore(reader, A); assert.equal(reader.revision(), revision); assert.throws(() => assertAccountStore(reader, B), { code: 'ACCOUNT_SCOPE_MISMATCH' }) } finally { reader.close() }
})

test('legacy keys remain isolated until explicit preview, actual identity verification and CAS adoption', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'native-account-adopt-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const filename = join(directory, 'native-chat.sqlite')
  let store = createSqliteStore({ filename }); store.write('resources', 'old-asset', { preserved: true }); store.close()
  let verified = false
  let stopped = true
  const manager = createNativeAccounts({ directory, protocols: [{ id: 'onebot', create() { throw new Error('adoption must not run any protocol') } }],
    legacy: { isStopped: () => stopped, async verifyIdentity(scope) { return { verified, accountScope: scope, evidence: 'actual-test-login-identity' } } } })
  t.after(() => manager.close())
  let preview = await manager.previewLegacyAdoption(A)
  await assert.rejects(manager.adoptLegacy({ preview, label: 'old' }, signal), { code: 'ACCOUNT_IDENTITY_UNVERIFIED' })
  assert.equal((await manager.read()).accounts.length, 0)
  verified = true
  store = createSqliteStore({ filename, requireExisting: true }); store.write('resources', 'late', { kept: true }); store.close()
  await assert.rejects(manager.adoptLegacy({ preview, label: 'old' }, signal), { code: 'ACCOUNT_ADOPTION_CONFLICT' })
  preview = await manager.previewLegacyAdoption(A)
  stopped = false
  await assert.rejects(manager.adoptLegacy({ preview, label: 'old' }, signal), { code: 'ACCOUNT_LEGACY_REQUIRES_STOPPED' })
  stopped = true
  const result = await manager.adoptLegacy({ preview, label: 'old' }, signal)
  const adopted = result.accounts[0]; assert(adopted)
  assert.equal(adopted.source, 'legacy-adopted'); assert.equal(adopted.adoption, 'ready')
  assert.equal(await manager.accountDirectory(adopted.id), directory)
  const registryFile = join(directory, 'native-accounts.json')
  const pending = JSON.parse(await readFile(registryFile, 'utf8')) as { schema: 1; accounts: { adoption: string }[] }
  pending.accounts[0]!.adoption = 'unknown'
  await writeFile(registryFile, JSON.stringify(pending), { mode: 0o600 })
  await rename(filename, filename + '.retained')
  await assert.rejects(manager.reconcileLegacyAdoption(adopted.id, (await manager.read()).revision, signal), { code: 'STORE_NOT_FOUND' })
  assert.equal((await manager.read()).accounts[0]?.adoption, 'unknown', 'a missing original database cannot count as a complete adoption')
  await rename(filename + '.retained', filename)
  await manager.reconcileLegacyAdoption(adopted.id, (await manager.read()).revision, signal)
  const reader = openReadonlySqliteStore(filename)
  try { assert.equal(assertAccountStore(reader, A).legacyAdopted, true); assert.deepEqual(reader.read('resources', 'old-asset')?.value, { preserved: true }); assert.deepEqual(reader.read('resources', 'late')?.value, { kept: true }); assert.throws(() => assertAccountStore(reader), { code: 'ACCOUNT_SCOPE_MISMATCH' }) } finally { reader.close() }
})

test('scoped core policy rejects a forged cross-account grant and unscoped events before any adapter work', async () => {
  const policy = createPolicy({ accountScope: A })
  assert.throws(() => policy.grant({ accountScope: B, id: 'bad', featureId: 'sample', conversationId: 'room', capabilities: ['messaging.send'], maxUses: { 'messaging.send': 1 } }), { code: 'ACCOUNT_SCOPE_MISMATCH' })
  const engine = createEngine({ ...context(), accountScope: A, policy, transport: { send() { throw new Error('must not send') } } })
  await assert.rejects(async () => engine.emit({ id: 'bad', type: 'message.received', conversationId: 'room', data: {} }), { code: 'ACCOUNT_SCOPE_REQUIRED' })
  await engine.stop()
})

test('non-TypeScript async protocol factories are rejected without awaiting unknown work or blocking close', { timeout: 5000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'native-account-factory-')); t.after(() => rm(directory, { recursive: true, force: true }))
  let attempts = 0
  const invalid = { id: 'pending', create() { throw new Error('replaced by JavaScript consumer') } }
  const rejecting = { id: 'rejecting', create() { throw new Error('replaced by JavaScript consumer') } }
  Object.defineProperty(invalid, 'create', { value() { attempts++; return new Promise<never>(() => undefined) } })
  Object.defineProperty(rejecting, 'create', { value() { return Promise.reject(new Error('foreign async constructor')) } })
  const manager = createNativeAccounts({ directory, protocols: [invalid, rejecting] })
  let snapshot = await manager.read()
  snapshot = await manager.create({ revision: snapshot.revision, label: 'Pending', accountScope: { protocolId: 'pending', accountId: 'one' } }, signal)
  snapshot = await manager.create({ revision: snapshot.revision, label: 'Rejecting', accountScope: { protocolId: 'rejecting', accountId: 'two' } }, signal)
  const first = snapshot.accounts[0]!.id
  const second = snapshot.accounts[1]!.id
  await assert.rejects(manager.start(first, signal), { code: 'ACCOUNT_PROTOCOL_FACTORY_INVALID' })
  await assert.rejects(manager.runtime(first), { code: 'ACCOUNT_PROTOCOL_FACTORY_INVALID' })
  await assert.rejects(manager.start(second, signal), { code: 'ACCOUNT_PROTOCOL_FACTORY_INVALID' })
  assert.equal(attempts, 1, 'an invalid unresolved factory cannot be replayed in this manager')
  snapshot = await manager.read()
  assert(snapshot.accounts.every(account => account.state === 'unknown' && account.missingReasons.includes('account_protocol_factory_invalid')))
  await manager.close()
})

test('each account close has one bounded attempt and late completion retains unknown evidence', { timeout: 5000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'native-account-close-')); t.after(() => rm(directory, { recursive: true, force: true }))
  let pendingCalls = 0
  let completeCalls = 0
  let finish: (() => void) | undefined
  const manager = createNativeAccounts({ directory, timeoutMs: 20, protocols: [{ id: 'bounded', create(options) {
    return { state: () => 'running', async start() {}, async stop() {}, close() {
      if (options.accountScope.accountId === 'pending') { pendingCalls++; return new Promise<void>(resolve => { finish = resolve }) }
      completeCalls++
    } }
  } }] })
  let snapshot = await manager.read()
  snapshot = await manager.create({ revision: snapshot.revision, label: 'Pending', accountScope: { protocolId: 'bounded', accountId: 'pending' } }, signal)
  snapshot = await manager.create({ revision: snapshot.revision, label: 'Complete', accountScope: { protocolId: 'bounded', accountId: 'complete' } }, signal)
  await Promise.all(snapshot.accounts.map(account => manager.runtime(account.id)))
  const first = manager.close()
  assert.equal(manager.close(), first, 'concurrent callers share the same close result')
  await assert.rejects(first, { code: 'ACCOUNT_CLOSE_UNKNOWN' })
  assert.equal(pendingCalls, 1); assert.equal(completeCalls, 1, 'one pending close cannot prevent another account closing')
  const evidence = (await manager.read()).accounts.find(account => account.accountScope.accountId === 'pending')
  assert(evidence)
  assert.equal(evidence.state, 'unknown'); assert.deepEqual(evidence.missingReasons, ['ACCOUNT_CLOSE_UNKNOWN'])
  await assert.rejects(manager.runtime(snapshot.accounts[0]!.id), { code: 'ACCOUNT_MANAGER_CLOSED' })
  finish!(); await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal((await manager.read()).accounts.find(account => account.accountScope.accountId === 'pending')?.state, 'unknown')
  await assert.rejects(manager.close(), { code: 'ACCOUNT_CLOSE_UNKNOWN' })
  assert.equal(pendingCalls, 1); assert.equal(completeCalls, 1, 'a late close cannot be replayed')
})
