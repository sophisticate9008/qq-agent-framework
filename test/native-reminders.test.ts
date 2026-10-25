import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { createContextStore } from '../src/core/context.ts'
import { createEngine } from '../src/core/engine.ts'
import { createPolicy } from '../src/core/policy.ts'
import { FrameworkError } from '../src/core/values.ts'
import type { DeliveryReceipt, SendRequest } from '../src/core/types.ts'
import { createNativeReminderService, readNativeReminderHistory, readNativeReminders } from '../src/host/native-reminders.ts'
import { createNativeReminderRoutes } from '../src/admin/native-reminders.ts'
import { createAdminServer } from '../src/admin/server.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { openReadonlySqliteStore } from '../src/storage/sqlite-readonly.ts'
import { parseNativeReminderHistorySnapshot, parseNativeReminderSnapshot, parseNativeRemindersSnapshot,
  validateNativeReminderConfiguration, type NativeReminderConfiguration } from '../src/contracts/native-reminders.ts'
import { createNativePackages } from '../src/host/native-packages.ts'
import { createRemindersNativePackage } from '../src/host/default-native-packages.ts'
import { createPackageConfigurationRegistry } from '../src/host/package-configuration.ts'
import { createPackageConfigurationFileStore } from '../src/storage/package-configuration.ts'

const signal = new AbortController().signal
const startAt = Date.UTC(2026, 0, 5, 8, 59)
const base: NativeReminderConfiguration = { conversationId: 'group:123', text: '显式提醒内容', timeZone: 'UTC',
  schedule: { kind: 'delay', delayMs: 1_000 }, enabled: true }

async function fixture(context: TestContext, options: { grant?: boolean; receipt?: DeliveryReceipt; timeoutMs?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'native-reminders-'))
  const filename = join(directory, 'native-reminders.sqlite')
  const store = createSqliteStore({ filename })
  let now = startAt
  let allowed = true
  let guardCalls = 0
  let onGuard: (() => void) | undefined
  let engine: ReturnType<typeof createEngine>
  const sent: SendRequest[] = []
  const service = createNativeReminderService({ store, clock: () => now, timeoutMs: options.timeoutMs ?? 3_000,
    intervalMs: 60_000,
    authorizeConfiguration() { if (!allowed) throw new FrameworkError('REMINDER_ACCESS_DENIED', 'Denied') },
    guard() { guardCalls++; onGuard?.(); if (!allowed) throw new FrameworkError('REMINDER_ACCESS_DENIED', 'Denied') },
    async dispatch(event, dispatchSignal) { await engine.emit(event, { signal: dispatchSignal }); return { status: 'accepted' } } })
  const policy = createPolicy({ clock: () => now })
  const contextStore = createContextStore()
  const persona = contextStore.registerPersona({ id: 'reminder-persona', version: '1.0.0', name: 'Reminder', identity: {}, style: {} })
  engine = createEngine({ context: contextStore, persona, policy, clock: () => now, eventTimeoutMs: 5_000,
    eventValidators: service.eventValidators,
    transport: { async send(request) { sent.push(request); return options.receipt ?? { status: 'confirmed', messageId: `sent-${sent.length}` } } } })
  engine.install(service.feature)
  if (options.grant !== false) policy.grant({ id: 'explicit-reminder-grant', featureId: 'reminder', conversationId: base.conversationId,
    capabilities: ['messaging.send'], maxUses: { 'messaging.send': 100 } })
  context.after(async () => { await service.stop(); await engine.stop(); store.close(); await rm(directory, { recursive: true, force: true }) })
  return { directory, filename, store, service, engine, sent, policy,
    now: () => now, setNow(value: number) { now = value }, allowed(value: boolean) { allowed = value },
    onGuard(callback: () => void) { onGuard = callback }, guardCalls: () => guardCalls }
}

test('once and delay reminders persist private rules, use real execution.send policy and never replay completed sends', async context => {
  const data = await fixture(context)
  const once = await data.service.create({ ...base, schedule: { kind: 'once', at: data.now() + 1_000 } }, signal)
  const delay = await data.service.create(base, signal)
  assert.equal(data.sent.length, 0)
  assert.equal(parseNativeReminderSnapshot(once)?.nextAt, data.now() + 1_000)
  assert.equal(data.store.list('tasks').length, 0)
  await Promise.all([data.service.start(), data.service.start()])
  await data.service.tick()
  data.setNow(data.now() + 1_000)
  await data.service.tick()
  assert.equal(data.sent.length, 2)
  assert.equal(data.guardCalls(), 4)
  assert(data.sent.every(request => request.conversationId === base.conversationId && request.content[0]?.type === 'text'))
  assert.equal(data.service.read(once.id).state, 'completed')
  assert.equal(data.service.read(delay.id).lastOccurrence?.status, 'confirmed')
  await data.service.tick(); await data.service.stop(); await data.service.start(); await data.service.tick()
  assert.equal(data.sent.length, 2)
  assert.equal(parseNativeRemindersSnapshot(data.service.list())?.rules.length, 2)
  assert.equal(parseNativeReminderHistorySnapshot(data.service.history())?.history.length, 2)
  assert(data.store.list('package.reminders.scheduler.tasks').every(record => (record.value as { status: string }).status === 'completed'))
})

test('daily and weekly reminders use calendar timezone schedules and report next execution and history', async context => {
  const data = await fixture(context)
  const daily = await data.service.create({ ...base, schedule: { kind: 'daily', hour: 9, minute: 0 } }, signal)
  const weekly = await data.service.create({ ...base, schedule: { kind: 'weekly', dayOfWeek: 1, hour: 9, minute: 1 } }, signal)
  assert.equal(daily.nextAt, Date.UTC(2026, 0, 5, 9))
  assert.equal(weekly.nextAt, Date.UTC(2026, 0, 5, 9, 1))
  await data.service.start(); await data.service.tick()
  data.setNow(Date.UTC(2026, 0, 5, 9)); await data.service.tick()
  data.setNow(Date.UTC(2026, 0, 5, 9, 1)); await data.service.tick()
  assert.equal(data.sent.length, 2)
  assert.equal(data.service.read(daily.id).nextAt, Date.UTC(2026, 0, 6, 9))
  assert.equal(data.service.read(weekly.id).nextAt, Date.UTC(2026, 0, 12, 9, 1))
  assert.equal(data.service.history({ ruleId: weekly.id }).history.length, 1)
})

test('configuration uses CAS while stopped; disable, cancel and current access revocation prevent sends', async context => {
  const data = await fixture(context)
  const first = await data.service.create(base, signal)
  const second = await data.service.update(first.id, first.revision, { ...base, text: 'changed' }, signal)
  await assert.rejects(data.service.update(first.id, first.revision, base, signal), { code: 'REMINDER_CONFLICT' })
  const disabled = await data.service.setEnabled(second.id, second.revision, false, signal)
  assert.equal(disabled.state, 'disabled')
  await data.service.start(); data.setNow(data.now() + 2_000); await data.service.tick()
  assert.equal(data.sent.length, 0)
  const enabled = await data.service.setEnabled(disabled.id, disabled.revision, true, signal)
  await data.service.tick()
  data.setNow(data.now() + 1_000); data.allowed(false); await data.service.tick()
  assert.equal(data.sent.length, 0)
  assert.equal(data.service.read(enabled.id).lastOccurrence?.status, 'failed')
  assert.equal(data.service.read(enabled.id).lastOccurrence?.errorCode, 'REMINDER_ACCESS_DENIED')
  const current = data.service.read(enabled.id)
  assert.equal((await data.service.cancel(current.id, current.revision, signal)).state, 'cancelled')
  await data.service.stop()
  assert.equal(data.service.list().rules.length, 1)
  await assert.rejects(data.service.create(base, signal), { code: 'REMINDER_ACCESS_DENIED' })
})

test('guard rechecks before send and reminder feature cannot inherit the chat relay policy grant', async context => {
  const denied = await fixture(context, { grant: false })
  denied.policy.grant({ id: 'relay-only', featureId: 'agent-relay', conversationId: base.conversationId,
    capabilities: ['messaging.send'], maxUses: { 'messaging.send': 10 } })
  const rule = await denied.service.create(base, signal)
  await denied.service.start(); await denied.service.tick(); denied.setNow(denied.now() + 1_000); await denied.service.tick()
  assert.equal(denied.sent.length, 0)
  assert.equal(denied.service.read(rule.id).lastOccurrence?.errorCode, 'POLICY_DENIED')
  assert.equal(denied.service.read(rule.id).lastOccurrence?.status, 'failed')
  const revoked = await fixture(context)
  const scheduled = await revoked.service.create(base, signal)
  revoked.onGuard(() => { if (revoked.guardCalls() === 2) revoked.allowed(false) })
  await revoked.service.start(); await revoked.service.tick(); revoked.setNow(revoked.now() + 1_000); await revoked.service.tick()
  assert.equal(revoked.sent.length, 0)
  assert.equal(revoked.service.read(scheduled.id).lastOccurrence?.errorCode, 'REMINDER_ACCESS_DENIED')
})

test('unknown sends isolate the durable rule across stop/start and never become an automatic retry', async context => {
  const data = await fixture(context, { receipt: { status: 'unknown' } })
  const rule = await data.service.create(base, signal)
  await data.service.start(); await data.service.tick(); data.setNow(data.now() + 1_000); await data.service.tick()
  const unknown = data.service.read(rule.id)
  assert.equal(unknown.state, 'unknown')
  assert.equal(unknown.nextAt, null)
  assert.equal(unknown.lastOccurrence?.status, 'unknown')
  await data.service.stop(); await data.service.start(); await data.service.tick()
  assert.equal(data.sent.length, 1)
  await assert.rejects(data.service.setEnabled(unknown.id, data.service.read(rule.id).revision, true, signal), { code: 'REMINDER_UNKNOWN_REQUIRES_RECONCILIATION' })
  await assert.rejects(data.service.update(unknown.id, data.service.read(rule.id).revision, base, signal), { code: 'REMINDER_UNKNOWN_REQUIRES_RECONCILIATION' })
  const latest = data.service.read(rule.id)
  assert.equal((await data.service.cancel(latest.id, latest.revision, signal)).state, 'cancelled')
})

test('stopped readonly projections create no scheduler metadata and tools require explicit source authorization', async context => {
  const data = await fixture(context)
  const saved = await data.service.create(base, signal)
  const before = data.store.list('package.reminders.rules')
  const files = await readdir(data.directory)
  const readonly = openReadonlySqliteStore(data.filename)
  try {
    assert.equal(readNativeReminders(readonly, { clock: data.now }).rules[0]?.id, saved.id)
    assert.deepEqual(readNativeReminderHistory(readonly), { schema: 1, history: [], nextCursor: null })
  } finally { readonly.close() }
  assert.deepEqual(data.store.list('package.reminders.rules'), before)
  assert.equal(data.store.list('package.reminders.scheduler.tasks.meta').length, 0)
  assert.deepEqual(await readdir(data.directory), files)
  const request = { input: { text: base.text, timeZone: base.timeZone, schedule: { kind: 'delay', delayMs: 1_000 }, enabled: true }, signal,
    scope: { featureId: 'tool-owner', conversationId: base.conversationId, eventId: 'explicit-event', version: '1.0.0' } }
  await assert.rejects(async () => data.service.effects['reminders.create']!.execute(request), { code: 'REMINDER_TOOL_CONFIGURATION_UNAVAILABLE' })
})

test('reminder management HTTP supports explicit creation, CAS enable/update/cancel and readonly history', async context => {
  const data = await fixture(context)
  const server = createAdminServer({ token: 'reminder-admin-token-123456789', snapshot: () => ({}), routes: createNativeReminderRoutes({
    read: options => data.service.list(options), history: options => data.service.history(options), service: () => data.service }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  context.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address(); assert(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  async function post(body: unknown) { return fetch(origin + '/api/chat/reminders', { method: 'POST', headers: {
    authorization: 'Bearer reminder-admin-token-123456789', origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }) }
  const created = await post({ action: 'create', configuration: base })
  assert.equal(created.status, 200)
  const saved = parseNativeReminderSnapshot(await created.json()); assert(saved)
  assert.equal((await post({ action: 'update', id: saved.id, revision: saved.revision + 1, configuration: base })).status, 409)
  const disabled = await post({ action: 'set-enabled', id: saved.id, revision: saved.revision, enabled: false })
  assert.equal(disabled.status, 200)
  const current = parseNativeReminderSnapshot(await disabled.json()); assert(current)
  assert.equal((await post({ action: 'cancel', id: saved.id, revision: current.revision })).status, 200)
  const listed = await fetch(origin + '/api/chat/reminders', { headers: { authorization: 'Bearer reminder-admin-token-123456789' } })
  assert.equal(parseNativeRemindersSnapshot(await listed.json())?.rules[0]?.state, 'cancelled')
  const history = await fetch(origin + '/api/chat/reminders/history', { headers: { authorization: 'Bearer reminder-admin-token-123456789' } })
  assert.equal(parseNativeReminderHistorySnapshot(await history.json())?.history.length, 0)
  assert.equal((await post({ action: 'approve', id: saved.id, revision: current.revision })).status, 400)
})

test('a dispatch timeout records unknown and neither periodic ticks nor a new service instance replay it', async context => {
  const store = createSqliteStore({ filename: ':memory:' })
  let now = startAt
  let calls = 0
  const make = () => createNativeReminderService({ store, clock: () => now, timeoutMs: 15, intervalMs: 60_000,
    authorizeConfiguration() {}, guard() {}, dispatch() { calls++; return new Promise(() => {}) } })
  const service = make()
  context.after(async () => { await service.stop(); store.close() })
  const rule = await service.create(base, signal)
  await service.start(); await service.tick(); now += 1_000; await service.tick()
  assert.equal(service.read(rule.id).state, 'unknown')
  assert.equal(service.read(rule.id).lastOccurrence?.status, 'unknown')
  await service.stop()
  const restored = make()
  context.after(() => restored.stop())
  await restored.start(); await restored.tick(); await restored.tick()
  assert.equal(calls, 1)
  assert.equal(restored.read(rule.id).state, 'unknown')
})

test('cancelling while a current guard waits prevents send and keeps explicit cancellation evidence', async context => {
  const store = createSqliteStore({ filename: ':memory:' })
  let now = startAt
  let entered!: () => void
  let release!: () => void
  const entering = new Promise<void>(resolve => { entered = resolve })
  const waiting = new Promise<void>(resolve => { release = resolve })
  let dispatches = 0
  const service = createNativeReminderService({ store, clock: () => now, timeoutMs: 500, intervalMs: 60_000,
    authorizeConfiguration() {}, async guard() { entered(); await waiting }, async dispatch() { dispatches++; return { status: 'accepted' } } })
  context.after(async () => { release(); await service.stop(); store.close() })
  const rule = await service.create(base, signal)
  await service.start(); await service.tick(); now += 1_000
  const ticking = service.tick()
  await entering
  const current = service.read(rule.id)
  await service.cancel(current.id, current.revision, signal)
  release(); await ticking
  assert.equal(dispatches, 0)
  assert.equal(service.read(rule.id).state, 'cancelled')
  assert.equal(service.read(rule.id).lastOccurrence?.status, 'cancelled')
})

test('reminder package owns scheduler cleanup while configuration and history survive stop', async context => {
  const data = await fixture(context)
  const saved = await data.service.create(base, signal)
  const manager = createNativePackages({ configurationRegistry: createPackageConfigurationRegistry({ store: createPackageConfigurationFileStore(data.directory) }),
    packages: [createRemindersNativePackage({ service: data.service })] })
  await manager.start()
  assert.equal(manager.contributions().length, 7)
  assert.equal(data.service.status().running, false)
  await data.service.start()
  assert.equal(data.service.status().running, true)
  await manager.stop()
  assert.equal(data.service.status().running, false)
  assert.equal(data.service.read(saved.id).state, 'enabled')
  const updated = await data.service.update(saved.id, data.service.read(saved.id).revision, { ...base, text: 'stopped edit' }, signal)
  assert.equal(updated.configuration.text, 'stopped edit')
  assert.deepEqual(data.service.history().history, [])
})

test('tool mutations require source authorization and remain bound to the actual conversation', async context => {
  const store = createSqliteStore({ filename: ':memory:' })
  let sources = 0
  const service = createNativeReminderService({ store, clock: () => startAt,
    authorizeConfiguration() {}, guard() {}, async dispatch() { throw new Error('No runtime started') },
    authorizeToolRequest(request) { assert.equal(request.scope.featureId, 'trusted-tool'); sources++ } })
  context.after(async () => { await service.stop(); store.close() })
  const scope = { featureId: 'trusted-tool', conversationId: 'group:123', eventId: 'explicit-qq-request', version: '1.0.0' }
  const configuration = { text: base.text, timeZone: base.timeZone, schedule: base.schedule, enabled: true }
  const created = await service.effects['reminders.create']!.execute({ input: configuration, scope, signal })
  const saved = parseNativeReminderSnapshot(created); assert(saved)
  assert.equal(sources, 1)
  await assert.rejects(async () => service.effects['reminders.cancel']!.execute({ input: { id: saved.id, revision: saved.revision },
    scope: { ...scope, conversationId: 'group:456' }, signal }), { code: 'REMINDER_NOT_FOUND' })
  await assert.rejects(async () => service.effects['reminders.create']!.execute({ input: { ...configuration, conversationId: 'group:456' }, scope, signal }), { code: 'REMINDER_INVALID' })
  for (const value of [{ ...base, authorization: true }, { ...base, schedule: { kind: 'delay', delayMs: 1 } },
    { ...base, schedule: { kind: 'weekly', dayOfWeek: 0, hour: 9, minute: 0 } }, { ...base, timeZone: 'not/a-timezone' }])
    assert.throws(() => validateNativeReminderConfiguration(value))
})
