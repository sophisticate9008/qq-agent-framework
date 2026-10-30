import type { AccountScope } from '../src/contracts/account-scope.ts'
import { isRecord } from '../src/core/values.ts'
import { awaitCondition } from './fixtures/await-condition.ts'
import { handleDshControlFrame } from './fixtures/dsh-wire.ts'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import test, { type TestContext } from 'node:test'
import { WebSocketServer, type WebSocket } from 'ws'

import { createNativeRuntimeRoutes, readNativeChatConfiguration } from '../src/admin/runtime.ts'
import type { AdminRoute } from '../src/admin/server.ts'
import { buildChatSessionDefinition } from '../src/host/chat-plans.ts'
import { createNativeChatRuntime } from '../src/host/native-chat-runtime.ts'
import { bindSyntheticPaginationSessions } from './fixtures/native-session-pages.ts'
import { createDshClaimPluginFixture } from './fixtures/dsh-claim-plugin.ts'
import { DEFAULT_NATIVE_EXECUTION_POLICY } from '../src/host/native-execution.ts'
import { isNativeEventPage } from '../src/contracts/native-events.ts'
import { parseExecutionJournalPage } from '../web/lib/execution-journal.ts'
import { createNativePersonaIdentity } from '../src/host/native-persona-identity.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { createSessionRegistry } from '../src/host/sessions.ts'
import { createDurableTransport } from '../src/host/outbox.ts'
import { createAdminServer } from '../src/admin/server.ts'
import { parseSessionSnapshot, parseUsageSnapshot } from '../web/lib/activity.ts'
import { parseUsageConversation, parseUsageRecent, parseUsageSeries } from '../web/lib/usage-details.ts'
import { json } from '../src/host/data.ts'
import { normalizeContent } from '../src/core/content.ts'
import type { JsonValue } from '../src/core/types.ts'
import type { LoadedNativeBootstrap } from '../src/host/native-bootstrap.ts'
import { capabilityLabel, featureLabel } from '../web/lib/feature-labels.ts'
import type { DshWorkSnapshot } from '../src/contracts/dsh-work.ts'
import type { FrameworkToolPendingCall, FrameworkToolResult } from '../src/contracts/framework-tools.ts'

const persona = { id: 'native', name: 'Native', identity: 'A test-only identity.', style: 'Concise.' }
const plan = { id: 'daily', name: 'Daily', description: '', instructions: 'Test behavior.',
  personaId: 'native', provider: 'provider', model: 'model', reasoningEffort: 'off' as const,
  contextLimits: { group: 100_000, private: 120_000 } }

test('native live readiness reuses its writer and still rejects private path or inode changes', async context => {
  const fake = await fixture(context)
  await fake.configure()
  await fake.start()
  const prepare = DatabaseSync.prototype.prepare
  const mock = context.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
    if (sql === 'PRAGMA table_list') throw new Error('Synthetic readonly connection unavailable')
    return prepare.call(this, sql)
  })
  assert.equal((await fake.runtime().status()).chatReady, true)
  assert.equal(fake.runtime().configurationBaseline().state, 'available')
  const filename = join(fake.directory, 'native-chat.sqlite')
  await chmod(filename, 0o644)
  try { assert.equal((await fake.runtime().status()).chatReady, false) }
  finally { await chmod(filename, 0o600) }
  const retained = filename + '.retained'
  await rename(filename, retained)
  await writeFile(filename, '', { mode: 0o600 })
  try {
    const status = await fake.runtime().status()
    assert.equal(status.chatReady, false)
    assert(status.missingReasons.includes('persisted_configuration_unavailable'))
  } finally {
    await rm(filename)
    await rename(retained, filename)
    mock.mock.restore()
  }
  assert.equal((await fake.runtime().status()).chatReady, true)
})

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  await awaitCondition(predicate, { message: 'Local native pipeline condition did not settle', timeoutMs: 5_000, intervalMs: 5 })
}

async function invoke(routes: readonly AdminRoute[], method: 'GET' | 'POST', pathname: string,
  body: Record<string, unknown> | null = null, query = new URLSearchParams()): Promise<Record<string, unknown>> {
  const route = routes.find(value => value.method === method && value.pathname === pathname)
  assert(route)
  const result = await route.handle({ body, query, signal: new AbortController().signal })
  assert(result !== null && typeof result === 'object' && !Array.isArray(result))
  return result as Record<string, unknown>
}

async function fixture(context: TestContext, options: {
  accountScope?: AccountScope
  expectedSelfId?: string
  protocolSelfId?: number
  deploymentDelayMs?: number
  authFails?: boolean
  wrongHttpIdentity?: boolean
  unknownSend?: boolean
  rejectedSend?: boolean
  holdCreate?: boolean
  pluginMissing?: boolean
  holdPrompt?: boolean
  suppressClaims?: boolean
  failFollow?: boolean
  bootstrap?: LoadedNativeBootstrap
  uses?: number
  forwardMessages?: readonly Record<string, unknown>[]
  quotedMessages?: Readonly<Record<string, Record<string, unknown>>>
  frameworkToolChannel?: boolean
  workChannel?: boolean
  mediaBytes?: boolean
  executionCheckpoint?: boolean
  migrationChannel?: boolean
  unknownCancel?: boolean
  unknownFork?: boolean
} = {}) {
  options.frameworkToolChannel ??= true
  const directory = await mkdtemp(join(tmpdir(), 'native-chat-pipeline-'))
  const wire = new WebSocketServer({ noServer: true })
  const onebots = new Set<WebSocket>()
  const interactions: Array<{ socket: WebSocket; id: string }> = []
  const follows: Array<{ socket: WebSocket; id: string; sequence: number; sessionId: string }> = []
  const rpc: Array<{ method: string; request: Record<string, unknown> }> = []
  const sends: Record<string, unknown>[] = []
  const plugin = createDshClaimPluginFixture()
  const toolCalls: FrameworkToolPendingCall[] = []
  const toolResults = new Map<string, FrameworkToolResult>()
  const toolLeases = new Map<string, { sessionId: string; generation: number; leaseId: string; names: string[] }>()
  const works = new Map<string, DshWorkSnapshot>()
  const migrations = new Map<string, Record<string, unknown>>()
  const workAsset = { type: 'media-reference' as const, kind: 'file' as const, attachmentId: 'report', bytes: 11, name: 'report.txt' }
  let creates = 0
  let checkpointSettled = false
  let heldCreate: { response: ServerResponse; rpcId: string } | undefined
  let heldPrompt: { response: ServerResponse; rpcId: string } | undefined
  let httpReads = 0
  let exchanges = 0
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://local.test')
    if (options.mediaBytes && url.pathname.startsWith('/fixture-assets/')) {
      assert.equal(request.headers.authorization, undefined)
      const image = url.pathname.endsWith('image')
      const audio = url.pathname.endsWith('audio')
      response.setHeader('content-type', image ? 'image/png' : audio ? 'audio/mpeg' : 'text/plain; charset=utf-8')
      response.end(image ? Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=', 'base64') : audio ? 'verified-audio-bytes' : '默认读取器取得的文本文件正文')
      return
    }
    if (url.pathname.startsWith('/onebot/')) {
      assert.equal(request.headers.authorization, 'Bearer http-test-secret')
      let body = ''
      for await (const chunk of request) body += String(chunk)
      if (url.pathname === '/onebot/get_login_info') {
        httpReads++
        response.end(JSON.stringify({ status: 'ok', retcode: 0,
          data: { user_id: options.wrongHttpIdentity ? 998 : options.protocolSelfId ?? 999 } }))
      } else if (url.pathname === '/onebot/get_version_info') {
        response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { app_name: 'SyntheticOneBot', app_version: '1.0.0' } }))
      } else if (options.mediaBytes && ['/onebot/get_image', '/onebot/get_record', '/onebot/get_private_file_url'].includes(url.pathname)) {
        const input = JSON.parse(body) as Record<string, unknown>
        if (url.pathname === '/onebot/get_private_file_url') { assert.equal(String(input.user_id), '123'); assert.equal(input.file_id, 'file-token') }
        response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { url: `${base}/fixture-assets/${url.pathname.endsWith('get_image') ? 'image' : url.pathname.endsWith('get_record') ? 'audio' : 'file'}` } }))
      } else if (url.pathname === '/onebot/get_forward_msg') {
        assert.deepEqual(JSON.parse(body), { id: 'forward-token' })
        response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { messages: options.forwardMessages ?? [] } }))
      } else if (url.pathname === '/onebot/get_msg') {
        const input = JSON.parse(body) as { message_id: string | number }
        const data = options.quotedMessages?.[String(input.message_id)]
        response.end(JSON.stringify(data ? { status: 'ok', retcode: 0, data } : { status: 'failed', retcode: 100 }))
      } else {
        sends.push(JSON.parse(body) as Record<string, unknown>)
        if (options.unknownSend) { response.destroy(); return }
        if (options.rejectedSend) { response.end(JSON.stringify({ status: 'failed', retcode: 100, data: null })); return }
        if (url.pathname === '/onebot/upload_private_file') { response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { file_id: 'uploaded-report' } })); return }
        response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1000 + sends.length } }))
      }
      return
    }
    if (url.pathname === '/dsh/connect') {
      exchanges++
      assert.equal(url.searchParams.get('token'), 'dsh-test-secret')
      if (options.authFails) { response.writeHead(401).end(); return }
      response.writeHead(302, { location: './api/remote.mux', 'set-cookie': 'dsh_test=local.test; HttpOnly' }).end()
      return
    }
    assert.equal(request.headers.cookie, 'dsh_test=local.test')
    let body = ''
    for await (const chunk of request) body += String(chunk)
    const envelope = JSON.parse(body) as { rpcId: string; method: string; payload: { args: { request?: Record<string, unknown> } } }
    const input: Record<string, unknown> = envelope.payload.args.request ?? envelope.payload.args
    rpc.push({ method: envelope.method, request: input })
    if (envelope.method.startsWith('bridgePlugin/') && options.pluginMissing) {
      response.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId,
        result: { ok: false, error: { code: 'unknown-method', message: 'Optional plugin is not installed.' } } }))
      return
    }
    let value: unknown = {}
    if (envelope.method === 'session/modelCatalog') value = { default: { provider: 'external-provider', model: 'model', reasoningEffort: 'off' },
      routableProviders: ['external-provider'], groups: [{ id: 'external-provider', name: 'Local fixture provider',
        models: [{ id: 'model', name: 'Model', reasoning: { efforts: [{ id: 'off', name: 'Off' }], defaultEffort: 'off' } }, ...(options.migrationChannel ? [{ id: 'next-model', name: 'Next', reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } }] : [])] }], failures: [] }
    else if ((options.frameworkToolChannel || options.executionCheckpoint || options.migrationChannel) && envelope.method === 'bridgePlugin/describe') value = {
      ...plugin.invoke(envelope.method, input) as Record<string, unknown>, ...(options.executionCheckpoint ? { executionEvidenceProtocol: 'qq-bridge-framework.execution-evidence/1' } : {}), ...(options.migrationChannel ? { migrationProtocol: 'qbf-session-migration/1', migrationApiVersion: 2 } : {}), methods: [...(options.executionCheckpoint ? ['bridgePlugin/inspectExecution'] : []), ...(options.migrationChannel ? ['bridgePlugin/forkPreview', 'bridgePlugin/forkWithPreset', 'bridgePlugin/inspectMigration'] : [])], ...(options.frameworkToolChannel ? { frameworkToolProtocol: 'qq-bridge-framework.tools/1' } : {}), ...(options.workChannel ? { workProtocol: 'qq-bridge-framework.work/1' } : {}) }
    else if (options.frameworkToolChannel && envelope.method === 'bridgePlugin/inspectFrameworkTools') value = {
      schema: 1, issuerEpoch: input.issuerEpoch, projection: toolLeases.get(String(input.sessionId)) ?? null }
    else if (options.frameworkToolChannel && envelope.method === 'bridgePlugin/installFrameworkTools') {
      assert(!toolLeases.has(String(input.sessionId)))
      const lease = { sessionId: String(input.sessionId), generation: Number(input.generation), leaseId: `lease-${toolLeases.size + 1}`,
        names: (input.tools as { name: string }[]).map(tool => tool.name) }
      toolLeases.set(lease.sessionId, lease); value = { schema: 1, issuerEpoch: input.issuerEpoch, ...lease }
    } else if (options.frameworkToolChannel && envelope.method === 'bridgePlugin/withdrawFrameworkTools') {
      const lease = toolLeases.get(String(input.sessionId))
      const withdrawn = lease?.leaseId === input.leaseId
      if (withdrawn) toolLeases.delete(String(input.sessionId))
      value = { schema: 1, withdrawn }
    } else if (options.frameworkToolChannel && envelope.method === 'bridgePlugin/pollFrameworkTools') value = {
      schema: 1, issuerEpoch: input.issuerEpoch, calls: toolCalls.filter(call => !toolResults.has(call.ticket)) }
    else if (options.frameworkToolChannel && envelope.method === 'bridgePlugin/completeFrameworkTool') {
      toolResults.set(String(input.ticket), input.result as FrameworkToolResult); value = { schema: 1, accepted: true }
    } else if (options.workChannel && envelope.method === 'bridgePlugin/verifyWork') value = { schema: 1, issuerEpoch: input.issuerEpoch,
      available: true, provider: 'spawn', continuable: true, externalToolAuthorizationVerified: false }
    else if (options.workChannel && envelope.method === 'bridgePlugin/startWork') {
      const work: DshWorkSnapshot = { schema: 1, issuerEpoch: String(input.issuerEpoch), id: String(input.id), childId: String(input.childId),
        parentSessionId: String(input.parentSessionId), generation: Number(input.generation), state: 'running', result: null, error: null }
      works.set(work.id, work); value = work
    } else if (options.workChannel && envelope.method === 'bridgePlugin/inspectWork') value = works.get(String(input.id))
    else if (options.workChannel && envelope.method === 'bridgePlugin/readWorkAsset') value = {
      schema: 1, ...input, asset: workAsset, offset: 0, data: Buffer.from('file report').toString('base64'), nextOffset: null }
    else if (options.workChannel && envelope.method === 'bridgePlugin/followupWork') {
      const prior = works.get(String(input.id))!; works.set(prior.id, { ...prior, state: 'running', result: null }); value = { messageId: 'followup-accepted' }
    } else if (options.workChannel && envelope.method === 'bridgePlugin/interruptWork') {
      const prior = works.get(String(input.id))!; works.set(prior.id, { ...prior, state: 'completed', result: { stopReason: 'interrupted', output: [{ type: 'text', text: '工作已停止。' }] } }); value = { accepted: true }
    } else if (options.executionCheckpoint && envelope.method === 'bridgePlugin/inspectExecution') value = {
      ...input, schema: 1, protocol: 'qq-bridge-framework.execution-evidence/1',
      issuerEpoch: (plugin.invoke('bridgePlugin/describe', {}) as Record<string, unknown>).issuerEpoch,
      state: checkpointSettled ? 'settled' : 'not-observed',
      matchedUserMessageId: checkpointSettled ? input.userMessageId ?? `user-${input.requestId}` : null,
      matchedTurn: checkpointSettled ? input.turn ?? 1 : null, outcome: checkpointSettled ? 'completed' : null,
      userSequence: checkpointSettled ? 2 : null, terminalSequence: checkpointSettled ? 7 : null,
      checkpointSequence: checkpointSettled ? 7 : null, checkpointHash: checkpointSettled ? 'c'.repeat(64) : null,
      quiescent: true, missingReasons: checkpointSettled ? [] : ['execution_request_not_observed'] }
    else if (options.migrationChannel && envelope.method === 'settings/describe') value = { namespaces: [{ ns: 'fixture-llm', value: { providers: {
      'external-provider': { models: [{ id: 'model', contextWindow: 120000, maxTokens: 8192 }, { id: 'next-model', contextWindow: 131072, maxTokens: 16000 }] } } } }] }
    else if (options.migrationChannel && envelope.method === 'agentPresets/list') value = { presets: [{ id: 'test-native-chat' }, { id: 'test-native-next' }] }
    else if (options.migrationChannel && envelope.method === 'agentPresets/read') value = { agentPreset: input.agentPreset,
      content: `- name: "@deepseek-ai/dsh-compaction-basic"\n  config: { auto: true, headroomTokens: 0, maxTokens: 16000, summarizationProvider: external-provider, summarizationModel: next-model }\n` }
    else if (options.migrationChannel && envelope.method === 'credentials/describe') value = { credentials: [] }
    else if (options.migrationChannel && envelope.method === 'bridgePlugin/forkPreview') value = { ...input, migrationProtocol: 'qbf-session-migration/1',
      issuerEpoch: (plugin.invoke('bridgePlugin/describe', {}) as Record<string, unknown>).issuerEpoch, state: 'available',
      sourceCursor: 7, sourceDigest: 'c'.repeat(64), targetRevision: 'd'.repeat(64), missingReasons: [] }
    else if (options.migrationChannel && envelope.method === 'bridgePlugin/forkWithPreset') {
      value = { ...input, migrationProtocol: 'qbf-session-migration/1', state: 'completed', childSessionId: `migration-child-${migrations.size+1}`, idempotency: 'created', missingReasons: [] }
      migrations.set(String(input.migrationId), value as Record<string, unknown>)
      if (options.unknownFork) { response.destroy(); return }
    } else if (options.migrationChannel && envelope.method === 'bridgePlugin/inspectMigration') value = { ...migrations.get(String(input.migrationId)), idempotency: 'replayed' }
    else if (envelope.method.startsWith('bridgePlugin/')) value = plugin.invoke(envelope.method, input)
    else if (envelope.method === 'session/create') {
      creates++
      if (options.holdCreate) { heldCreate = { response, rpcId: envelope.rpcId }; return }
      value = { sessionId: `session-${creates}`, agentPreset: options.migrationChannel ? input.agentPreset : 'test-native-chat' }
    } else if (envelope.method === 'session/selectModel') {
      value = { selected: options.migrationChannel ? { provider: input.provider, model: input.model, ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }) } : { provider: 'external-provider', model: 'model', reasoningEffort: 'off' } }
    } else if (envelope.method === 'session/prompt') {
      if (!options.suppressClaims) plugin.accepted(String(input.sessionId), String(input.requestId))
      if (options.holdPrompt) { heldPrompt = { response, rpcId: envelope.rpcId }; return }
      value = { accepted: true }
    } else if (envelope.method === 'session/cancel') {
      if (options.unknownCancel) { response.destroy(); return }
      value = { accepted: true }
    }
    response.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } }))
  })
  server.on('upgrade', (request, socket, head) => {
    wire.handleUpgrade(request, socket, head, connection => {
      if (request.url === '/onebot-ws') {
        assert.equal(request.headers.authorization, 'Bearer ws-test-secret')
        onebots.add(connection)
        connection.once('close', () => onebots.delete(connection))
        connection.on('message', data => {
          const action = JSON.parse(data.toString()) as { action: string; echo: string }
          assert.equal(action.action, 'get_login_info')
          connection.send(JSON.stringify({ status: 'ok', retcode: 0, echo: action.echo, data: { user_id: options.protocolSelfId ?? 999 } }))
        })
        return
      }
      assert.equal(request.url, '/dsh/api/remote.mux')
      assert.equal(request.headers.cookie, 'dsh_test=local.test')
      connection.on('message', data => {
        const input = JSON.parse(data.toString()) as { type: string; streamId: string; payload: { args: { request: { address: { sessionId: string } } } } }
        if (handleDshControlFrame(connection, input)) {
          if (input.type === 'open' && 'endpoint' in input && input.endpoint === '$events') interactions.push({ socket: connection, id: input.streamId })
          return
        }
        if (options.failFollow) {
          connection.send(JSON.stringify({ type: 'error', streamId: input.streamId }))
          return
        }
        const stream = { socket: connection, id: input.streamId, sequence: 0, sessionId: input.payload.args.request.address.sessionId }
        follows.push(stream)
        connection.send(JSON.stringify({ type: 'item', streamId: input.streamId,
          value: { type: 'snapshot', header: { id: input.payload.args.request.address.sessionId }, cursor: -1,
            records: [{ type: 'assistant/message', text: 'Historical output must not be replayed.' }] } }))
      })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const createRuntime = (historyOnly = false) => createNativeChatRuntime({ directory, accountScope: options.accountScope, expectedSelfId: options.expectedSelfId, bootstrap: options.bootstrap,
    ...(options.workChannel ? { resolveWorkTarget: async () => ({ configuration: { schema: 1 as const, enabled: true,
      provider: 'provider', model: 'model', agentPreset: 'test-work', fullAccess: false, timeoutMs: 300000 },
      externalProvider: 'external-work', agentPreset: 'test-work', assistantRevision: 'a'.repeat(64), configurationRevision: 'b'.repeat(64), missingReasons: [] }) } : {}),
    loadConfiguration: () => {
      assert.equal(historyOnly, false, 'Offline history must not load current plans or preferences')
      return readNativeChatConfiguration(directory)
    },
    resolveDeployment: async configuration => {
      assert.equal(historyOnly, false, 'Offline history must not resolve deployment')
      if (options.deploymentDelayMs) await new Promise(resolve => setTimeout(resolve, options.deploymentDelayMs))
      const selectedPlan = configuration.catalog.plans.find(value => value.id === configuration.catalog.activePlanId)!
      const selectedPersona = configuration.personas.find(value => value.id === selectedPlan?.personaId)!
      return { missingReasons: [], presetBindings: selectedPlan && selectedPersona ? [{ agentPreset: options.migrationChannel && selectedPlan.model === 'next-model' ? 'test-native-next' : 'test-native-chat',
        externalProvider: 'external-provider', definition: buildChatSessionDefinition(selectedPlan, selectedPersona) }] : [] }
    } })
  let runtime = createRuntime()
  const routes = () => createNativeRuntimeRoutes({ directory, chatRuntime: runtime, adapterRuntime: runtime.adapterRuntime })
  const save = async (name: string, value: Record<string, unknown>) => {
    const current = await invoke(routes(), 'GET', `/api/chat/${name}`)
    return invoke(routes(), 'POST', `/api/chat/${name}`, { revision: current.revision, ...value })
  }
  const configure = async () => {
    await save('personas', { personas: [persona] })
    await save('providers', { providers: [{ id: 'provider', name: 'Provider', type: 'openai', enabled: true,
      baseUrl: 'https://model.example.test', apiKey: 'never-called-model-key', models: [{ id: 'model', name: 'Model' }] }] })
    await save('plans', { activePlanId: 'daily', plans: [plan] })
    await save('access', { allow: ['private:123', 'group:456'], deny: [], owner: '123' })
    await save('adapters', { adapters: {
      onebotHttp: { enabled: true, endpoint: `${base}/onebot`, secret: 'http-test-secret' },
      onebotWs: { enabled: true, endpoint: `${base.replace('http:', 'ws:')}/onebot-ws`, secret: 'ws-test-secret' },
      dshAgent: { enabled: true, endpoint: `${base}/dsh`, auth: 'dsh-test-secret' }
    } })
    await save('authorization', { version: '1', grants: ['private:123', 'group:456'].map(conversationId => ({
      conversationId, submitUses: options.uses ?? 10, sendUses: options.uses ?? 10, expiresAt: null
    })) })
  }
  const start = async () => {
    const configuration = await readNativeChatConfiguration(directory)
    await runtime.start(configuration.revisions, new AbortController().signal)
  }
  const message = (id: number, extra: Record<string, unknown> = {}) => {
    assert(onebots.size > 0)
    for (const socket of onebots) socket.send(JSON.stringify({ post_type: 'message', self_id: options.protocolSelfId ?? 999,
      message_type: 'private', user_id: 123, message_id: id, time: Math.floor(Date.now() / 1000),
      message: [{ type: 'text', data: { text: `User message ${id}` } }], ...extra }))
  }
  const agentEvent = (type: string, data: Record<string, unknown>, index = follows.length - 1) => {
    const stream = follows[index]
    assert(stream)
    if (stream.socket.readyState !== 1) return
    stream.socket.send(JSON.stringify({ type: 'item', streamId: stream.id,
      value: { type: 'event', event: { seq: stream.sequence++, type, data } } }))
  }
  const rawFinal = (turn = 1) => {
    agentEvent('assistant/message', { turn, message: { id: `answer-${turn}`, role: 'assistant',
      content: [{ type: 'text', text: `Final answer ${turn}` }, { type: 'reasoning', text: 'Not public.' }] } })
    agentEvent('turn/end', { turn, reason: { kind: 'completed' } })
  }
  const reply = async (content: unknown, turn = 1, index = follows.length - 1) => {
    const stream = follows[index]!
    await until(() => rpc.filter(call => call.method === 'session/prompt' && call.request.sessionId === stream.sessionId).length >= turn)
    const prompt = rpc.filter(call => call.method === 'session/prompt' && call.request.sessionId === stream.sessionId)[turn - 1]!.request
    const sessionId = String(prompt.sessionId); const requestId = String(prompt.requestId)
    const id = `reply-${sessionId}-${turn}-${toolCalls.length}`
    const lease = toolLeases.get(sessionId)!
    toolCalls.push({ ticket: id, leaseId: lease.leaseId, call: { id, name: 'qbf_reply',
      input: { content: json(content) }, sessionId, requestId, generation: lease.generation,
      userMessageId: `user-${requestId}`, turn, expiresAt: Date.now() + 10000 } })
    await until(() => toolResults.has(id))
    return toolResults.get(id)!
  }
  const answer = async (turn = 1) => {
    await reply(`Final answer ${turn}`, turn)
    rawFinal(turn)
  }
  context.after(async () => {
    await runtime.close()
    for (const socket of wire.clients) socket.terminate()
    await new Promise<void>(resolve => wire.close(() => resolve()))
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  })
  return { directory, base, configure, save, start, message, agentEvent, answer, rawFinal, reply, routes, rpc, sends, follows,
    toolCalls, toolResults, toolLeases, works, workAsset,
    interaction(value: Record<string, unknown>) { const target = interactions.at(-1)!;
      target.socket.send(JSON.stringify({ type: 'item', streamId: target.id, value })) },
    runtime: () => runtime, creates: () => creates, httpReads: () => httpReads, exchanges: () => exchanges,
    heldCreate: () => heldCreate,
    heldPrompt: () => heldPrompt,
    restartPlugin: plugin.restart,
    confirmCheckpoint() { checkpointSettled = true },
    claimPrompt() {
      const input = rpc.find(value => value.method === 'session/prompt')!.request
      plugin.accepted(String(input.sessionId), String(input.requestId))
    },
    async restart() { await runtime.close(); runtime = createRuntime(); await start() },
    async offline() { await runtime.close(); runtime = createRuntime(true) } }
}

function historyDatabaseSnapshot(filename: string) {
  const database = new DatabaseSync(filename, { readOnly: true })
  try {
    return { records: database.prepare('SELECT * FROM durable_records ORDER BY namespace, key').all(),
      meta: database.prepare('SELECT * FROM durable_meta ORDER BY name').all(),
      schema: database.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY name').all() }
  } finally { database.close() }
}

test('features projection preserves bootstrap custom capabilities without turning declarations into grants', async context => {
  let effects = 0
  const bootstrap: LoadedNativeBootstrap = { metadata: { manifest: { id: 'projection-worker', version: '1.0.0', apiVersion: 1 },
    codeFingerprint: 'f'.repeat(64), trust: 'trusted-operator-code', sandboxed: false, requiresSeparateAuthorization: true },
    create() {
      return { effectAdapters: { 'review.work': { execute() { effects++; return 'review completed' } } },
        eventValidators: { 'review.requested': () => true },
        features: [{ id: 'review-worker', version: '1.0.0', apiVersion: 1, capabilities: ['review.work', 'messaging.send'],
          subscriptions: ['review.requested'], setup(services) {
            services.on('review.requested', async execution => {
              const result = await execution.invoke('review.work', { action: 'synthetic local work' })
              await execution.send([{ type: 'text', text: String(result) }])
            })
          } }] }
    } }
  const fake = await fixture(context, { bootstrap })
  await fake.configure()
  await fake.start()
  const host = fake.runtime().host()!
  const beforeGrants = host.policy.describe().grants
  const projected = await invoke(fake.routes(), 'GET', '/api/chat/features')
  const features = projected.features as Array<Record<string, unknown>>
  const worker = features.find(row => row.id === 'review-worker')!
  assert.deepEqual(worker.capabilities, ['review.work', 'messaging.send'])
  assert.equal(worker.declared, true)
  assert.equal(worker.installed, true)
  assert.equal(projected.authorizationEvaluated, false)
  const work = (projected.capabilities as Array<Record<string, unknown>>).find(row => row.id === 'review.work')!
  assert.equal(work.declared, true)
  assert.equal(work.installed, true)
  assert.equal(capabilityLabel('review.work'), '扩展能力')
  assert.equal(featureLabel('review-worker'), '扩展功能')
  assert.deepEqual(host.policy.describe().grants, beforeGrants)
  const denied = await host.engine.emit({ id: 'manifest-only', type: 'review.requested', conversationId: 'private:123', data: {} })
  assert.equal(denied.outcomes.find(outcome => outcome.featureId === 'review-worker')?.errorCode, 'POLICY_DENIED')
  assert.equal(effects, 0)
  assert.equal(fake.sends.length, 0)
  host.policy.grant({ id: 'explicit-worker-grant', featureId: 'review-worker', conversationId: 'private:123',
    capabilities: ['review.work', 'messaging.send'], maxUses: { 'review.work': 1, 'messaging.send': 1 } })
  const allowed = await host.engine.emit({ id: 'explicit-grant', type: 'review.requested', conversationId: 'private:123', data: {} })
  assert.equal(allowed.outcomes.find(outcome => outcome.featureId === 'review-worker')?.status, 'completed')
  assert.equal(effects, 1)
  assert.equal(fake.sends.length, 1)
  const exhausted = await host.engine.emit({ id: 'exhausted-grant', type: 'review.requested', conversationId: 'private:123', data: {} })
  assert.equal(exhausted.outcomes.find(outcome => outcome.featureId === 'review-worker')?.errorCode, 'BUDGET_EXHAUSTED')
  assert.equal(effects, 1)
  const usedGrants = host.policy.describe().grants
  await invoke(fake.routes(), 'GET', '/api/chat/features')
  assert.deepEqual(host.policy.describe().grants, usedGrants)
  await host.engine.uninstall('review-worker')
  const stopped = await invoke(fake.routes(), 'GET', '/api/chat/features')
  const stoppedWorker = (stopped.features as Array<Record<string, unknown>>).find(row => row.id === 'review-worker')!
  assert.equal(stoppedWorker.declared, true)
  assert.equal(stoppedWorker.installed, false)
  assert.deepEqual(stoppedWorker.capabilities, ['review.work', 'messaging.send'])
  for (let index = 0; index < 260; index++) host.engine.install({ id: `projection-${index}`, version: '1.0.0', apiVersion: 1,
    capabilities: [], subscriptions: [], setup() {} })
  const bounded = await invoke(fake.routes(), 'GET', '/api/chat/features')
  assert.equal((bounded.features as unknown[]).length, 256)
  assert.equal(bounded.featuresLimited, true)
  assert((bounded.capabilities as unknown[]).length <= 512)
  assert.equal(fake.rpc.filter(row => row.method === 'session/prompt' || row.method === 'session/create').length, 0)
  context.diagnostic(JSON.stringify({ worker, work, denied: denied.outcomes, allowed: allowed.outcomes,
    exhausted: exhausted.outcomes, stoppedWorker, effects, sends: fake.sends.length,
    declaredDidNotGrant: true, featureLimit: 256, capabilitiesLimit: 512 }))
})

test('offline history GET routes retain real sessions, usage and unknown journal without starting chat', async context => {
  const fake = await fixture(context)
  await fake.configure()
  await fake.start()
  fake.message(1)
  await until(() => fake.runtime().host()!.replies.get('private:123')?.status === 'waiting'
    && fake.runtime().executions()!.list().length > 0 && fake.rpc.some(call => call.method === 'session/prompt'))
  fake.agentEvent('assistant/message', { turn: 1, step: 0, message: { id: 'history-prefix', role: 'assistant',
    source: { kind: 'model', provider: 'external-provider', model: 'model' },
    content: [{ type: 'text', text: 'Work prefix' }, { type: 'tool-call', name: 'not-run' }] },
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0, totalTokens: 17 } })
  fake.agentEvent('step/start', { turn: 1, step: 1 })
  await fake.reply('History final')
  fake.agentEvent('assistant/message', { turn: 1, step: 1, message: { id: 'history-final', role: 'assistant',
    source: { kind: 'model', provider: 'external-provider', model: 'model' },
    content: [{ type: 'text', text: 'History final' }] },
    usage: { inputTokens: 20, outputTokens: 6, cacheReadTokens: 3, cacheWriteTokens: 0, totalTokens: 29 } })
  fake.agentEvent('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await until(() => fake.sends.length === 1 && fake.runtime().usage()!.summary().records === 2)
  fake.message(2, { message_type: 'group', group_id: 456,
    message: [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: 'Accepted without final' } }] })
  await until(() => fake.runtime().host()!.replies.get('group:456')?.status === 'waiting'
    && fake.rpc.filter(call => call.method === 'session/prompt').length >= 2)
  bindSyntheticPaginationSessions(fake.runtime().host()!, 103)
  const pricing = await invoke(fake.routes(), 'GET', '/api/chat/usage/pricing')
  await fake.runtime().stop()
  const sessions = await invoke(fake.routes(), 'GET', '/api/chat/sessions')
  const usage = await invoke(fake.routes(), 'GET', '/api/chat/usage')
  const journal = await invoke(fake.routes(), 'GET', '/api/chat/executions')
  assert.equal((journal.items as Record<string, unknown>[]).filter(row => row.status === 'unknown' && row.isolated).length, 1)
  await fake.save('plans', { activePlanId: 'daily', plans: [{ ...plan, instructions: 'Changed current plan, not old context' }] })
  await fake.save('personas', { personas: [{ ...persona, style: 'Changed current preferences and style' }] })
  await fake.offline()
  assert.equal(fake.runtime().host(), undefined)
  assert.equal(fake.runtime().usage(), undefined)
  assert.equal(fake.runtime().executions(), undefined)
  const counts = () => ({ rpc: fake.rpc.length, sends: fake.sends.length, http: fake.httpReads(),
    exchanges: fake.exchanges(), follows: fake.follows.length, creates: fake.creates() })
  const beforeCounts = counts()
  const filename = join(fake.directory, 'native-chat.sqlite')
  const beforeDatabase = historyDatabaseSnapshot(filename)
  const beforeBytes = await readFile(filename)
  const server = createAdminServer({ token: 'synthetic-offline-history-token-only', snapshot: () => ({ offline: true }), routes: fake.routes() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  context.after(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  const getRequests: Array<{ path: string; status: number }> = []
  const get = async (path: string) => {
    const response = await fetch(origin + path, { headers: { authorization: 'Bearer synthetic-offline-history-token-only' } })
    getRequests.push({ path, status: response.status })
    assert.equal(response.status, 200, `${path}: ${response.status}`)
    return await response.json() as Record<string, unknown>
  }
  assert.equal((await fetch(origin + '/api/chat/sessions')).status, 401)
  const offlineSessions = await get('/api/chat/sessions')
  assert.deepEqual(offlineSessions.items, sessions.items)
  const actualBindings = offlineSessions.sessions as Array<Record<string, unknown>>
  assert.deepEqual(actualBindings, sessions.sessions)
  for (const binding of actualBindings) {
    const metadata = (offlineSessions.items as Array<Record<string, unknown>>).find(item => item.conversationId === binding.key)!
    assert.equal(binding.generation, metadata.generation)
    assert.match(String(binding.bindingRevision), /^[a-f0-9]{64}$/)
  }
  assert(parseSessionSnapshot(offlineSessions))
  const nextSessions = await get('/api/chat/sessions?limit=100&after=' + encodeURIComponent(String(offlineSessions.next)))
  assert.equal((nextSessions.items as unknown[]).length, 5)
  const offlineUsage = await get('/api/chat/usage')
  assert.equal(offlineUsage.records, usage.records)
  assert.deepEqual(offlineUsage.knownTokens, usage.knownTokens)
  assert.equal((offlineUsage.knownTokens as Record<string, unknown>).total, 46)
  assert.deepEqual(offlineUsage.tokens, usage.tokens)
  assert.deepEqual(offlineUsage.totals, usage.totals)
  assert.equal(offlineUsage.policy, null)
  assert.equal(offlineUsage.metrics, null)
  assert.equal(offlineUsage.outbox, null)
  assert(parseUsageSnapshot(offlineUsage))
  const offlineJournal = await get('/api/chat/executions')
  assert.deepEqual(offlineJournal.items, journal.items)
  assert.equal(offlineJournal.manualCancelAvailable, false)
  assert(parseExecutionJournalPage(offlineJournal))
  const firstJournal = await get('/api/chat/executions?limit=1')
  const secondJournal = await get('/api/chat/executions?limit=1&after=' + String(firstJournal.next))
  assert.equal((secondJournal.items as unknown[]).length, 1)
  const firstUsage = await get('/api/chat/usage/turns?limit=1')
  const secondUsage = await get('/api/chat/usage/turns?limit=1&after=' + String(firstUsage.next))
  assert.equal((secondUsage.items as unknown[]).length, 1)
  assert(parseUsageConversation(await get('/api/chat/usage/turns?key=private%3A123')))
  assert(parseUsageRecent(await get('/api/chat/usage/recent')))
  assert(parseUsageSeries(await get('/api/chat/usage/series?hours=24&buckets=48')))
  assert.equal((await get('/api/chat/usage/series?bucketMs=60000')).partial, false)
  assert(!fake.routes().some(route => route.pathname === '/api/chat/usage/maintenance'))
  await assert.rejects(invoke(fake.routes(), 'POST', '/api/chat/sessions/reset', {}), { statusCode: 400, code: 'invalid_session_reset' })
  await assert.rejects(invoke(fake.routes(), 'POST', '/api/chat/usage/reset', {}), { statusCode: 400, code: 'invalid_usage_reset' })
  assert.deepEqual(await get('/api/chat/usage/pricing'), pricing)
  await assert.rejects(invoke(fake.routes(), 'POST', '/api/chat/usage/pricing', { revision: null, prices: [] }), { statusCode: 503 })
  assert.deepEqual(historyDatabaseSnapshot(filename), beforeDatabase)
  assert.deepEqual(await readFile(filename), beforeBytes)
  assert.deepEqual(counts(), beforeCounts)
  context.diagnostic(JSON.stringify({ beforeCounts, afterCounts: counts(), getRequests, records: offlineUsage.records,
    knownTokens: offlineUsage.knownTokens,
    totals: offlineUsage.totals, journal: offlineJournal.items, bindings: (offlineSessions.items as unknown[]).length + 5,
    mainDatabaseUnchanged: true, allRecordsSchemaAndGrantsUnchanged: true }))
  await fake.runtime().close()
  for (const path of ['/api/chat/sessions', '/api/chat/usage', '/api/chat/executions']) {
    await assert.rejects(invoke(fake.routes(), 'GET', path), { statusCode: 503, code: 'native_history_unavailable' })
  }
})

test('offline history never-started GET is unavailable and creates no files or protocol activity', async context => {
  const fake = await fixture(context)
  const before = await readdir(fake.directory)
  assert(!fake.routes().some(route => route.pathname === '/api/chat/usage/maintenance'))
  for (const path of ['/api/chat/sessions', '/api/chat/usage', '/api/chat/executions', '/api/chat/usage/recent',
    '/api/chat/usage/series', '/api/chat/usage/turns']) {
    await assert.rejects(invoke(fake.routes(), 'GET', path), { statusCode: 503, code: 'runtime_not_connected' })
  }
  assert.deepEqual(await readdir(fake.directory), before)
  assert.equal(fake.rpc.length, 0)
  assert.equal(fake.httpReads(), 0)
  assert.equal(fake.exchanges(), 0)
  assert.equal(fake.follows.length, 0)
  assert.equal(fake.creates(), 0)
})

test('offline history corrupt existing database is explicitly unavailable, not empty success', async context => {
  const fake = await fixture(context)
  const filename = join(fake.directory, 'native-chat.sqlite')
  await writeFile(filename, 'corrupt synthetic database', { mode: 0o600 })
  for (const path of ['/api/chat/sessions', '/api/chat/usage', '/api/chat/executions']) {
    await assert.rejects(invoke(fake.routes(), 'GET', path), { statusCode: 503, code: 'native_history_unavailable' })
  }
  assert.equal((await readFile(filename)).toString(), 'corrupt synthetic database')
  assert.equal(fake.rpc.length, 0)
  assert.equal(fake.httpReads(), 0)
  assert.equal(fake.exchanges(), 0)
})

for (const recovery of [
  { timeoutMs: 1_000, defaultActions: false, crossDeadline: true },
  { timeoutMs: 1_200, defaultActions: true, crossDeadline: true },
  { timeoutMs: 3_000, defaultActions: true, crossDeadline: false }
]) test(`native first restart records recovered reply expiry without replay (${JSON.stringify(recovery)})`, async context => {
  const fake = await fixture(context)
  await fake.configure()
  await fake.save('execution', { policy: { ...DEFAULT_NATIVE_EXECUTION_POLICY, turnTimeoutMs: recovery.timeoutMs,
    ...(recovery.defaultActions ? {} : { noticeEnabled: false, noticeText: null, cancelOnTimeout: false }) } })
  await fake.save('authorization', { version: 'recovery', grants: ['private:123', 'group:456'].map(conversationId => ({
    conversationId, submitUses: 10, sendUses: 10, cancelUses: 1, expiresAt: null
  })) })
  await fake.start()
  fake.message(1)
  await until(() => fake.runtime().host()!.replies.get('private:123')?.status === 'waiting'
    && fake.runtime().executions()!.list().length > 0 && fake.rpc.some(call => call.method === 'session/prompt'))
  const original = fake.runtime().executions()!.list()[0]!
  const host = fake.runtime().host()!
  const reply = host.replies.get('private:123')!
  const bindings = host.sessions.list()
  const history = host.history.snapshot('private:123', { afterSequence: 0 })
  const grants = host.policy.describe().grants
  await fake.runtime().stop()
  assert.equal(host.replies.get('private:123')?.status, 'waiting')
  if (recovery.crossDeadline) await delay(Math.max(0, reply.deadlineAt - Date.now()) + 25)
  else assert(Date.now() < reply.deadlineAt)
  await fake.restart()
  const resumed = fake.runtime()
  const status = await resumed.status()
  assert.equal(status.state, 'running')
  assert.equal(status.chatReady, true)
  assert.equal(status.host?.faults, 0)
  assert.equal(status.lastError, null)
  assert.equal(resumed.executions()!.get(original.id)?.status, 'unknown')
  assert.equal(resumed.executions()!.get(original.id)?.isolated, true)
  assert.equal(resumed.executions()!.get(original.id)?.deadlineAt, original.deadlineAt)
  assert.deepEqual(resumed.host()!.sessions.list(), bindings)
  assert.deepEqual(resumed.host()!.history.snapshot('private:123', { afterSequence: 0 }), history)
  assert.deepEqual(resumed.host()!.policy.describe().grants, grants)
  const restoredFollow = fake.follows.length - 1
  await awaitCondition(() => resumed.host()!.replies.get('private:123')?.status === 'timed-out', { timeoutMs: recovery.timeoutMs + 1_500, intervalMs: 5, message: 'Restored reply deadline did not expire' })
  assert.equal(resumed.host()!.replies.get('private:123')?.deadlineAt, reply.deadlineAt)
  assert.equal(resumed.host()!.metrics().replies.expired, 1)
  assert.equal(resumed.host()!.metrics().faults, 0)
  fake.agentEvent('assistant/message', { turn: 999, message: { id: 'unattributed', role: 'assistant',
    content: [{ type: 'text', text: 'Must not deliver or release unknown work.' }] } }, restoredFollow)
  fake.agentEvent('turn/end', { turn: 999, reason: { kind: 'completed' } }, restoredFollow)
  fake.message(2)
  fake.message(3, { message_type: 'group', group_id: 456,
    message: [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: 'Unaffected conversation' } }] })
  await until(() => fake.rpc.filter(value => value.method === 'session/prompt').length === 2)
  assert.equal(resumed.executions()!.get(original.id)?.isolated, true)
  assert.equal(fake.rpc.filter(value => value.method === 'session/prompt' && value.request.sessionId === original.binding.sessionId).length, 1)
  await until(() => resumed.host()!.replies.get('group:456')?.status === 'waiting')
  await fake.answer(1)
  await until(() => fake.sends.length === 1)
  assert.equal(fake.creates(), 2)
  assert.equal(fake.rpc.filter(value => value.method === 'session/cancel').length, 0)
  fake.agentEvent('assistant/message', { turn: 1, message: { id: 'late', role: 'assistant',
    content: [{ type: 'text', text: 'Late answer must be record-only.' }] } }, restoredFollow)
  fake.agentEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, restoredFollow)
  await until(() => resumed.executions()!.get(original.id)?.lateOutcome?.outcome === 'completed')
  assert.equal(fake.sends.length, 1)
  const retained = resumed.host()!.history.snapshot('private:123', { afterSequence: 0 })
  assert.deepEqual(retained.messages.slice(0, history.messages.length), history.messages)
  assert.deepEqual(retained.messages.slice(history.messages.length).map(item => item.id), ['2'])
  assert.equal(retained.messages.some(item => item.actor === 'assistant'), false)
  assert.deepEqual(resumed.host()!.sessions.get('private:123'), original.binding)
})

test('native recovered reply expiry still blocks startup on a real SQLite write failure', async context => {
  const fake = await fixture(context)
  await fake.configure()
  await fake.save('execution', { policy: { ...DEFAULT_NATIVE_EXECUTION_POLICY, turnTimeoutMs: 1_000 } })
  await fake.start()
  fake.message(1)
  await until(() => fake.runtime().host()!.replies.get('private:123')?.status === 'waiting'
    && fake.runtime().executions()!.list().length > 0 && fake.rpc.some(call => call.method === 'session/prompt'))
  const reply = fake.runtime().host()!.replies.get('private:123')!
  await fake.runtime().close()
  const database = new DatabaseSync(join(fake.directory, 'native-chat.sqlite'))
  try {
    database.exec(`CREATE TRIGGER reject_reply_recovery BEFORE UPDATE ON durable_records
      WHEN OLD.namespace = 'host.replies' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END`)
  } finally { database.close() }
  await delay(Math.max(0, reply.deadlineAt - Date.now()) + 25)
  await assert.rejects(fake.restart(), { code: 'NATIVE_CHAT_HOST_NOT_READY' })
  const status = await fake.runtime().status()
  assert.equal(status.state, 'error')
  assert.equal(status.chatReady, false)
  assert.equal(status.host?.lastFaultCode, 'STORE_IO_ERROR')
  assert.equal(fake.runtime().host()!.replies.get('private:123')?.status, 'waiting')
  assert.equal(fake.creates(), 1)
  assert.equal(fake.rpc.filter(value => value.method === 'session/prompt').length, 1)
})

test('native startup does not ignore a real restored follow failure after local reply expiry', async context => {
  const options = { failFollow: false }
  const fake = await fixture(context, options)
  await fake.configure()
  await fake.save('execution', { policy: { ...DEFAULT_NATIVE_EXECUTION_POLICY, turnTimeoutMs: 1_000 } })
  await fake.start()
  fake.message(1)
  await until(() => fake.runtime().host()!.replies.get('private:123')?.status === 'waiting'
    && fake.runtime().executions()!.list().length > 0 && fake.rpc.some(call => call.method === 'session/prompt'))
  const reply = fake.runtime().host()!.replies.get('private:123')!
  await fake.runtime().stop()
  await delay(Math.max(0, reply.deadlineAt - Date.now()) + 25)
  options.failFollow = true
  await assert.rejects(fake.restart(), { code: 'NATIVE_CHAT_HOST_NOT_READY' })
  const status = await fake.runtime().status()
  assert.equal(status.state, 'error')
  assert.equal(status.chatReady, false)
  assert.equal(status.host?.lastFaultCode, 'DSH_FOLLOW_ENDED')
  assert.equal(fake.runtime().host()!.replies.get('private:123')?.status, 'timed-out')
  assert.equal(fake.creates(), 1)
  assert.equal(fake.rpc.filter(value => value.method === 'session/prompt').length, 1)
})

test('native composition stays offline until manual start and reports layered missing reasons', async context => {
  const fake = await fixture(context)
  const initial = await fake.runtime().status()
  assert.equal(initial.chatReady, false)
  assert(initial.missingReasons.includes('active_plan_or_persona_missing'))
  assert.equal(fake.httpReads(), 0)
  assert.equal(fake.exchanges(), 0)
  await fake.configure()
  assert.equal((await fake.runtime().status()).chatReady, false)
  assert.equal(fake.rpc.length, 0)
  const stale = { ...(await readNativeChatConfiguration(fake.directory)).revisions, plans: '0'.repeat(64) }
  await assert.rejects(fake.runtime().start(stale, new AbortController().signal), { code: 'NATIVE_CHAT_REVISION_CONFLICT' })
  assert.equal(fake.exchanges(), 0)
  assert.equal(fake.creates(), 0)
  assert.throws(() => createNativeRuntimeRoutes({ directory: fake.directory,
    chatRuntime: { status: () => ({ chatReady: true }) } as unknown as ReturnType<typeof createNativeChatRuntime> }), TypeError)
})

test('execution API owns an eighth CAS revision and old authorization documents retain their exact four-field grant shape', async context => {
  const fake = await fixture(context)
  await fake.configure()
  const initial = await invoke(fake.routes(), 'GET', '/api/chat/execution')
  assert.equal((initial.policy as Record<string, unknown>).turnTimeoutMs, 120_000)
  const authorization = await invoke(fake.routes(), 'GET', '/api/chat/authorization')
  assert.equal(authorization.cancelAvailable, true)
  assert.equal(Object.hasOwn((authorization.grants as Record<string, unknown>[])[0]!, 'cancelUses'), false)
  const configuration = await readNativeChatConfiguration(fake.directory)
  assert.equal(Object.keys(configuration.revisions).length, 8)
  assert.equal(configuration.revisions.execution, initial.revision)
  const { execution: _execution, ...oldRevisions } = configuration.revisions
  await assert.rejects(invoke(fake.routes(), 'POST', '/api/chat/runtime/start', { revisions: oldRevisions }),
    { statusCode: 400, code: 'invalid_runtime_revisions' })
  const policy = { ...DEFAULT_NATIVE_EXECUTION_POLICY, noticeEnabled: false, cancelOnTimeout: false }
  await fake.save('execution', { policy })
  await assert.rejects(invoke(fake.routes(), 'POST', '/api/chat/execution', { revision: initial.revision, policy }),
    { statusCode: 409, code: 'chat_revision_conflict' })
  await assert.rejects(invoke(fake.routes(), 'POST', '/api/chat/execution', { revision: initial.revision, policy: { ...policy, turnTimeoutMs: 0 } }),
    { statusCode: 400, code: 'invalid_execution_policy' })
  assert.equal(fake.rpc.length, 0)
})

test('missing trusted optional plugin blocks manual startup with false readiness and zero sessions', async context => {
  const fake = await fixture(context, { pluginMissing: true })
  await fake.configure()
  await assert.rejects(fake.start(), { code: 'NATIVE_CHAT_CORRELATION_PLUGIN_UNAVAILABLE' })
  assert.equal((await fake.runtime().status()).chatReady, false)
  assert.equal(fake.creates(), 0)
  assert.equal((await invoke(fake.routes(), 'GET', '/api/chat/sessions')).items instanceof Array, true)
  assert.equal(fake.runtime().host()?.sessions.list().length, 0)
})

test('actual native persona scope preserves a proven 015 version without aliasing or rewriting old outbox data', async context => {
  const fake = await fixture(context)
  await fake.configure()
  const configuration = await readNativeChatConfiguration(fake.directory)
  const definition = buildChatSessionDefinition(configuration.catalog.plans[0], configuration.personas[0])
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const legacyVersion = hash(definition)
  const nativeIdentity = createNativePersonaIdentity(configuration.personas[0])
  const filename = join(fake.directory, 'native-chat.sqlite')
  const fixtureStore = createSqliteStore({ filename })
  const bindings = [{ agentPreset: 'test-native-chat', externalProvider: 'external-provider', definition }]
  fixtureStore.write('native-chat.meta', 'session-definition', { identity: hash({ definition,
    endpoint: configuration.adapters.dshAgent.endpoint, bindings }) })
  const sessions = createSessionRegistry({ store: fixtureStore, agent: {
    async createSession() { throw new Error('Synthetic legacy fixture must not create a session') },
    async submit() { return { status: 'rejected' } }, async follow() { return () => {} }
  } })
  sessions.bind('private:123', 'session-legacy')
  const outbox = createDurableTransport({ store: fixtureStore, transport: {
    async send() { return { status: 'confirmed', messageId: 'legacy-send' } }
  } })
  await outbox.send({ conversationId: 'private:123', content: [{ type: 'text', text: 'Synthetic legacy fixture.' }],
    idempotencyKey: 'legacy-outbound', signal: new AbortController().signal,
    scope: { persona: { id: nativeIdentity.contextId, version: legacyVersion }, sessionId: 'session-legacy', generation: 1 } })
  const oldOutbox = fixtureStore.list('outbox')[0]!
  fixtureStore.close()
  await fake.start()
  fake.message(1)
  await until(() => fake.rpc.some(value => value.method === 'session/prompt'))
  await fake.answer(1)
  await until(() => fake.sends.length === 1)
  await until(() => fake.runtime().host()!.outbox.list().filter(value => value.status === 'confirmed').length === 2)
  await fake.runtime().stop()
  const observed = createSqliteStore({ filename })
  try {
    assert.deepEqual(observed.read('outbox', oldOutbox.key), oldOutbox)
    const metadata = observed.read('native-chat.meta', 'persona-identity')!.value as Record<string, unknown>
    assert.equal(metadata.contentVersion, nativeIdentity.version)
    assert.equal(metadata.scopeVersion, legacyVersion)
    assert.equal(metadata.source, 'preserved-v15-definition-version')
    const freshOutbox = observed.list('outbox').find(value => value.key !== oldOutbox.key)!
    const scope = (freshOutbox.value as Record<string, unknown>).scope as Record<string, unknown>
    assert.deepEqual(scope.persona, { id: nativeIdentity.contextId, version: legacyVersion })
    assert.equal(fake.creates(), 0)
  } finally { observed.close() }
})

test('adding explicit cancelUses zero to an already used authorization version cannot create a fresh grant or refill budgets', async context => {
  const fake = await fixture(context, { uses: 2 })
  await fake.configure()
  await fake.start()
  fake.message(1)
  await until(() => fake.rpc.some(value => value.method === 'session/prompt'))
  await fake.answer(1)
  await until(() => fake.runtime().host()!.outbox.list()[0]?.status === 'confirmed')
  const before = fake.runtime().host()!.policy.describe().grants
  await fake.runtime().stop()
  const configuration = await readNativeChatConfiguration(fake.directory)
  await fake.save('authorization', { version: configuration.authorization.version,
    grants: configuration.authorization.grants.map(grant => ({ ...grant, cancelUses: 0 })) })
  await assert.rejects(fake.start(), { code: 'NATIVE_CHAT_AUTHORIZATION_VERSION_CONFLICT' })
  assert.deepEqual(fake.runtime().host()!.policy.describe().grants, before)
  assert.equal(fake.creates(), 1)
})

test('delegation availability does not upgrade legacy grants and used authorization versions reject explicit zero or positive delegation', async context => {
  for (const toolDelegationUses of [0, 1]) {
    const fake = await fixture(context)
    await fake.configure()
    const authorization = await invoke(fake.routes(), 'GET', '/api/chat/authorization')
    assert.equal(authorization.toolDelegationAvailable, true)
    assert((authorization.grants as Record<string, unknown>[]).every(grant => !Object.hasOwn(grant, 'toolDelegationUses')))
    await fake.start()
    const before = fake.runtime().host()!.policy.describe().grants
    assert(before.filter(grant => grant.featureId === 'agent-relay').every(grant => grant.capabilities.includes('agent.tools.delegate')))
    await fake.runtime().stop()
    const configuration = await readNativeChatConfiguration(fake.directory)
    await fake.save('authorization', { version: configuration.authorization.version,
      grants: configuration.authorization.grants.map(grant => ({ ...grant, toolDelegationUses })) })
    await assert.rejects(fake.start(), { code: 'NATIVE_CHAT_AUTHORIZATION_VERSION_CONFLICT' })
    assert.deepEqual(fake.runtime().host()!.policy.describe().grants, before)
    assert.equal(fake.creates(), 0)
  }
})

test('legacy zero quotas no longer block whitelisted chat or tool delegation and policy remains persistent', async context => {
  const fake = await fixture(context)
  await fake.configure()
  await fake.save('authorization', { version: 'legacy-zero', grants: [{ conversationId: 'private:123', submitUses: 0, sendUses: 0, toolDelegationUses: 0, expiresAt: null }] })
  await fake.start()
  const privateGrant = () => fake.runtime().host()!.policy.describe().grants.find(grant => grant.conversationId === 'private:123')!
  assert.equal(privateGrant().maxUses['agent.tools.delegate'], null)
  assert.equal(privateGrant().maxUses['agent.submit'], null)
  fake.message(1)
  await until(() => fake.rpc.some(request => request.method === 'session/prompt'))
  await fake.answer()
  await until(() => fake.sends.length === 1)
  const policy = fake.runtime().host()!.policy
  policy.begin(policy.reserve({ featureId: 'agent-relay', conversationId: 'private:123', capability: 'agent.tools.delegate' }))
  await fake.restart()
  assert.equal(privateGrant().used['agent.tools.delegate'], 1)
  assert.doesNotThrow(() => fake.runtime().host()!.policy.reserve({ featureId: 'agent-relay', conversationId: 'private:123', capability: 'agent.tools.delegate' }))
  assert.equal((await fake.runtime().status()).toolDelegation.externalToolAuthorizationVerified, false)
})

test('selected work identity changes cannot reuse or reset an existing native session', async context => {
  const fake = await fixture(context)
  await fake.configure()
  await fake.start()
  fake.message(1)
  await until(() => fake.rpc.some(request => request.method === 'session/prompt'))
  const before = fake.runtime().host()!.sessions.list()
  await fake.runtime().stop()
  await fake.save('plans', { activePlanId: 'daily', plans: [{ ...plan,
    capabilitySelection: { schema: 1, presetId: 'operator-work', revision: 'a'.repeat(64) } }] })
  await fake.start()
  assert.equal(fake.creates(), 1)
  assert.equal(fake.rpc.filter(request => request.method === 'session/prompt').length, 1)
  assert.deepEqual(fake.runtime().host()!.sessions.list(), before)
})

test('real endless progress expires total deadline, consumes finite notice/cancel grants and isolates later same-session prompts', async context => {
  const fake = await fixture(context)
  await fake.configure()
  await fake.save('execution', { policy: { ...DEFAULT_NATIVE_EXECUTION_POLICY, turnTimeoutMs: 2000, noticeEnabled: true } })
  await fake.save('authorization', { version: '2', grants: ['private:123', 'group:456'].map(conversationId => ({
    conversationId, submitUses: 10, sendUses: 10, cancelUses: 1, expiresAt: null
  })) })
  await fake.start()
  fake.message(1)
  await until(() => fake.rpc.some(value => value.method === 'session/prompt'))
  const execution = fake.runtime().executions()!.list()[0]!
  const progress = setInterval(() => fake.agentEvent('step/start', { turn: 1, step: 1 }), 20)
  context.after(() => clearInterval(progress))
  await awaitCondition(() => fake.runtime().executions()!.get(execution.id)?.deadlineReached === true,
    { timeoutMs: 3000, message: 'The immutable execution deadline must expire despite progress' })
  clearInterval(progress)
  await until(() => fake.sends.length === 1 && fake.rpc.some(value => value.method === 'session/cancel')
    && fake.runtime().executions()!.get(execution.id)?.noticeStatus === 'confirmed'
    && fake.runtime().executions()!.get(execution.id)?.cancelStatus === 'accepted')
  assert.equal(fake.runtime().executions()!.get(execution.id)?.deadlineAt, execution.deadlineAt)
  assert.equal(fake.runtime().executions()!.get(execution.id)?.isolated, true)
  assert.equal(fake.runtime().executions()!.get(execution.id)?.cancelStatus, 'accepted')
  assert.equal(fake.runtime().executions()!.get(execution.id)?.noticeStatus, 'confirmed')
  fake.message(2)
  await delay(60)
  assert.equal(fake.rpc.filter(value => value.method === 'session/prompt').length, 1)
  assert.equal(fake.runtime().host()!.history.snapshot('private:123', { afterSequence: 0 }).messages.filter(value => value.actor === '123').length, 2)
  fake.agentEvent('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  await until(() => fake.runtime().executions()!.get(execution.id)?.isolated === false)
  // The isolated message stays queued and is admitted once the old cancellation settles.
  await until(() => fake.rpc.filter(value => value.method === 'session/prompt').length === 2)
  await fake.answer(2)
  await until(() => fake.sends.length === 2)
  assert.equal(fake.creates(), 1)
  assert.equal(fake.rpc.filter(value => value.method === 'session/cancel').length, 1)
  assert.equal(fake.runtime().host()!.policy.describe().grants.find(value => value.conversationId === 'private:123')?.used['agent.cancel'], 1)
})

test('real half-open prompt times out once, sends one notice and never replays after concurrent stop or restart', async context => {
  const fake = await fixture(context, { holdPrompt: true })
  await fake.configure()
  await fake.save('execution', { policy: { ...DEFAULT_NATIVE_EXECUTION_POLICY, turnTimeoutMs: 1000, noticeEnabled: true, cancelOnTimeout: false } })
  await fake.start()
  fake.message(1)
  await until(() => fake.heldPrompt() !== undefined)
  await until(() => fake.runtime().executions()!.list()[0]?.deadlineReached === true)
  await until(() => fake.sends.length === 1)
  const original = fake.runtime().executions()!.list()[0]!
  await Promise.all([fake.runtime().stop(), fake.runtime().stop()])
  await fake.restart()
  fake.message(2)
  await delay(100)
  assert.equal(fake.rpc.filter(value => value.method === 'session/prompt').length, 1)
  assert.equal(fake.runtime().executions()!.get(original.id)?.status, 'unknown')
  assert.equal(fake.runtime().executions()!.get(original.id)?.deadlineAt, original.deadlineAt)
  fake.rawFinal(1)
  await until(() => fake.runtime().executions()!.get(original.id)?.externalStatus === 'completed')
  assert.equal(fake.sends.length, 1)
  assert.equal(fake.runtime().executions()!.get(original.id)?.lateOutcome?.outcome, 'completed')
})

test('real claim gap never guesses the only pending prompt and a later exact final is record-only', async context => {
  const fake = await fixture(context, { suppressClaims: true })
  await fake.configure()
  await fake.save('execution', { policy: { ...DEFAULT_NATIVE_EXECUTION_POLICY, turnTimeoutMs: 1000, noticeEnabled: true, cancelOnTimeout: false } })
  await fake.start()
  fake.message(1)
  await until(() => fake.rpc.some(value => value.method === 'session/prompt'))
  fake.rawFinal(1)
  await delay(60)
  assert.equal(fake.sends.length, 0)
  const execution = fake.runtime().executions()!.list()[0]!
  assert.equal(execution.turn, null)
  await until(() => fake.sends.length === 1)
  assert.equal(fake.runtime().executions()!.get(execution.id)?.isolated, true)
  fake.claimPrompt()
  fake.rawFinal(1)
  await until(() => fake.runtime().executions()!.get(execution.id)?.lateOutcome?.outcome === 'completed')
  assert.equal(fake.sends.length, 1)
  assert.equal(fake.rpc.filter(value => value.method === 'session/prompt').length, 1)
})

test('real plugin epoch change invalidates readiness without adopting a new baseline or resubmitting work', async context => {
  const fake = await fixture(context)
  await fake.configure()
  await fake.start()
  fake.message(1)
  await until(() => fake.rpc.some(value => value.method === 'session/prompt'))
  const execution = fake.runtime().executions()!.list()[0]!
  fake.restartPlugin()
  await until(() => fake.runtime().executions()!.get(execution.id)?.status === 'unknown')
  const status = await fake.runtime().status()
  assert.equal(status.chatReady, false)
  assert.equal(status.execution.correlationVerified, false)
  assert(status.missingReasons.includes('execution_correlation_unavailable'))
  await fake.answer(1)
  fake.message(2)
  await delay(80)
  assert.equal(fake.sends.length, 0)
  assert.equal(fake.rpc.filter(value => value.method === 'session/prompt').length, 1)
})

test('real local WS text passes through native host/DSH/policy/durable outbox to confirmed QQ HTTP send', async context => {
  const fake = await fixture(context)
  await fake.configure()
  await fake.start()
  assert.equal((await fake.runtime().status()).chatReady, true)
  const adapters = await invoke(fake.routes(), 'GET', '/api/chat/adapters')
  assert.equal((adapters.connection as Record<string, unknown>).chatReady, true)
  assert.equal((adapters.connection as Record<string, unknown>).state, 'connected')
  assert.equal((adapters.connection as Record<string, unknown>).selfId, '999')
  const unrelated = createNativeRuntimeRoutes({ directory: fake.directory, chatRuntime: fake.runtime(),
    adapterRuntime: { status: () => ({ running: false }), connectionStatus: () => ({ state: 'connected',
      selfId: '999', lastError: null, received: 0, dropped: 0, chatReady: true }) } })
  await assert.rejects(invoke(unrelated, 'GET', '/api/chat/adapters'), { statusCode: 503, code: 'adapter_runtime_status_unavailable' })
  assert.deepEqual(fake.rpc.map(request => request.method), ['settings/describe', 'bridgePlugin/describe'])
  await assert.rejects(fake.runtime().adapterRuntime.disconnect!(), { code: 'NATIVE_CHAT_BUSY' })
  fake.message(1)
  await until(() => fake.rpc.some(request => request.method === 'session/prompt'))
  assert.deepEqual(fake.rpc.find(request => request.method === 'session/create')?.request, { agentPreset: 'test-native-chat' })
  assert.equal(fake.rpc.find(request => request.method === 'session/selectModel')?.request.provider, 'external-provider')
  fake.agentEvent('assistant/message', { turn: 1, message: { id: 'prefix', content: [{ type: 'text', text: 'Tool narration.' }] } })
  fake.agentEvent('step/start', { turn: 1 })
  await delay(35)
  assert.equal(fake.sends.length, 0)
  await fake.answer()
  await until(() => fake.sends.length === 1)
  await until(() => fake.runtime().host()!.outbox.list()[0]?.status === 'confirmed')
  assert.deepEqual(fake.sends[0], { user_id: 123, message: [{ type: 'text', data: { text: 'Final answer 1' } }] })
  const host = fake.runtime().host()!
  assert.equal(host.history.snapshot('private:123', { afterSequence: 0 }).messages.length, 2)
  assert.equal(host.policy.describe().grants.find(grant => grant.conversationId === 'private:123')?.used['agent.submit'], 1)
  const sessions = await invoke(fake.routes(), 'GET', '/api/chat/sessions')
  assert.equal((sessions.items as unknown[]).length, 1)
  const usage = await invoke(fake.routes(), 'GET', '/api/chat/usage')
  assert.equal(usage.tokenUsageAvailable, false)
  assert.equal(usage.source, 'chat-ledger')
  const journal = await invoke(fake.routes(), 'GET', '/api/chat/executions')
  assert(parseExecutionJournalPage(journal))
  assert.equal(journal.manualCancelAvailable, false)
  assert.equal((journal.items as Record<string, unknown>[])[0]?.status, 'completed')
  assert.equal(Object.hasOwn((journal.items as Record<string, unknown>[])[0]!, 'policy'), false)
  const metrics = await invoke(fake.routes(), 'GET', '/api/host/metrics')
  assert.equal(metrics.started, true)
  fake.message(1)
  await delay(50)
  assert.equal(fake.rpc.filter(request => request.method === 'session/prompt').length, 1)
})

test('access deny and forged WS identities never create agent sessions; self mentions map automatically', async context => {
  const fake = await fixture(context)
  await fake.configure()
  await fake.save('access', { allow: ['group:456'], deny: ['private:123'], owner: '123' })
  await fake.start()
  fake.message(1)
  fake.message(2, { self_id: 100 })
  await delay(50)
  assert.equal(fake.creates(), 0)
  fake.message(3, { message_type: 'group', group_id: 456,
    message: [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: 'Directed group message' } }] })
  await until(() => fake.rpc.some(request => request.method === 'session/prompt'))
  const content = fake.rpc.find(request => request.method === 'session/prompt')?.request.content
  assert(Array.isArray(content))
  const prompt = content.map((part: { text: string }) => part.text).join('\n')
  assert.match(prompt, /Directed group message/)
  assert.match(prompt, /\"senderId\":\"123\"/)
  assert.match(prompt, /\"conversationId\":\"group:456\"/)
})

test('whitelist allows chat without quotas and removing access blocks replies without clearing sessions', async context => {
  const fake = await fixture(context)
  await fake.configure()
  await fake.save('authorization', { version: '1', grants: [] })
  await fake.start()
  fake.message(1)
  await until(() => fake.creates() === 1 && fake.follows.length === 1 && fake.rpc.some(call => call.method === 'session/prompt'))
  await fake.save('access', { allow: [], deny: [], owner: '123' })
  assert.equal((await fake.runtime().status()).chatReady, false)
  await fake.answer()
  fake.message(2)
  await delay(70)
  assert.equal(fake.sends.length, 0)
  assert.equal(fake.creates(), 1)
  assert.equal(fake.runtime().host()!.sessions.list().length, 1)
})

test('failed DSH authentication and HTTP identity mismatch never report chat ready or create sessions', async context => {
  for (const options of [{ authFails: true }, { wrongHttpIdentity: true }]) {
    const fake = await fixture(context, options)
    await fake.configure()
    await assert.rejects(fake.start())
    const status = await fake.runtime().status()
    assert.equal(status.chatReady, false)
    assert.equal(status.protocolConnected, status.connection.state === 'connected' && status.connection.selfId !== null)
    assert.equal(status.state, 'error')
    assert.equal(fake.creates(), 0)
    assert(!JSON.stringify(status).includes('dsh-test-secret'))
  }
})

test('restart preserves sessions, history, exhausted budgets and unknown outbox without replay or refilling', async context => {
  const fake = await fixture(context, { unknownSend: true, uses: 1 })
  await fake.configure()
  await fake.start()
  fake.message(1)
  await until(() => fake.rpc.some(request => request.method === 'session/prompt'))
  await fake.answer()
  await until(() => fake.runtime().host()!.outbox.list()[0]?.status === 'unknown')
  const before = fake.runtime().host()!.sessions.list()[0]
  assert.equal(fake.sends.length, 1)
  await fake.restart()
  assert.deepEqual(fake.runtime().host()!.sessions.list()[0], before)
  assert.equal(fake.runtime().host()!.outbox.list()[0]?.status, 'unknown')
  assert.equal(fake.runtime().host()!.history.snapshot('private:123', { afterSequence: 0 }).messages.length, 1)
  fake.message(1)
  fake.message(2)
  await delay(80)
  assert.equal(fake.rpc.filter(request => request.method === 'session/prompt').length, 1)
  assert.equal(fake.sends.length, 1)
  assert.equal(fake.creates(), 1)
  await fake.runtime().stop()
  await fake.save('authorization', { version: '1', grants: ['private:123', 'group:456'].map(conversationId => ({
    conversationId, submitUses: 2, sendUses: 2, expiresAt: null
  })) })
  await assert.rejects(fake.start(), { code: 'NATIVE_CHAT_AUTHORIZATION_VERSION_CONFLICT' })
})

test('stop cancels in-flight creation, ignores late response and restart never retries unknown session creation', async context => {
  const fake = await fixture(context, { holdCreate: true })
  await fake.configure()
  await fake.start()
  fake.message(1)
  await until(() => fake.heldCreate() !== undefined)
  const held = fake.heldCreate()!
  await fake.runtime().stop()
  held.response.end(JSON.stringify({ type: 'server-response', rpcId: held.rpcId,
    result: { ok: true, value: { sessionId: 'late-session', agentPreset: 'test-native-chat' } } }))
  assert.equal(fake.runtime().host()!.sessions.list()[0]?.state, 'unknown')
  assert.equal((await fake.runtime().status()).chatReady, false)
  await fake.restart()
  fake.message(2)
  await delay(70)
  assert.equal(fake.creates(), 1)
  assert.equal(fake.runtime().host()!.sessions.list()[0]?.state, 'unknown')
  assert.equal(fake.sends.length, 0)
})

test('changed plan cannot silently reuse or reset durable agent sessions', async context => {
  const fake = await fixture(context)
  await fake.configure()
  await fake.start()
  fake.message(1)
  await until(() => fake.rpc.some(request => request.method === 'session/prompt'))
  await fake.runtime().stop()
  await fake.save('plans', { activePlanId: 'daily', plans: [{ ...plan, instructions: 'New behavior.' }] })
  await fake.start()
  assert.equal(fake.creates(), 1)
  assert.equal(fake.runtime().host()!.sessions.list()[0]?.sessionId, 'session-1')
})

test('imported catalog identifiers remain unchanged while private core persona mapping runs the real pipeline', async context => {
  const fake = await fixture(context)
  await fake.configure()
  const imported = { ...persona, id: 'Legacy:Whale_v1' }
  await fake.save('personas', { personas: [persona, imported] })
  await fake.save('plans', { activePlanId: 'PLAN:Chat_v1', plans: [{ ...plan, id: 'PLAN:Chat_v1', personaId: imported.id }] })
  await fake.start()
  fake.message(1)
  await until(() => fake.rpc.some(request => request.method === 'session/prompt'))
  await fake.answer()
  await until(() => fake.runtime().host()!.outbox.list()[0]?.status === 'confirmed')
  const configuration = await readNativeChatConfiguration(fake.directory)
  assert.equal(configuration.catalog.activePlanId, 'PLAN:Chat_v1')
  assert(configuration.personas.some(value => value.id === imported.id))
  assert.equal(fake.creates(), 1)
})

test('real native session metadata reaches page 101+ with stable exclusive cursors and reset blocked while running', async context => {
  const fake = await fixture(context)
  await fake.configure()
  await fake.start()
  const fixtureData = bindSyntheticPaginationSessions(fake.runtime().host()!)
  const keys: string[] = []
  let after: string | null = null
  const pageSizes: number[] = []
  do {
    const query = new URLSearchParams({ limit: '100', ...(after === null ? {} : { after }) })
    const page = await invoke(fake.routes(), 'GET', '/api/chat/sessions', null, query)
    assert.equal(page.resetAvailable, true)
    assert.match(String(page.revision), /^[a-f0-9]{64}$/)
    const sessions = page.sessions as Array<{ key: string; sessionId: string; owner: boolean }>
    pageSizes.push(sessions.length)
    keys.push(...sessions.map(session => session.key))
    after = page.next as string | null
  } while (after !== null)
  assert.deepEqual(pageSizes, [100, 100, 5])
  assert.deepEqual(keys, fixtureData.conversationIds)
  assert.equal(new Set(keys).size, fixtureData.count)
  const large = await invoke(fake.routes(), 'GET', '/api/chat/sessions', null, new URLSearchParams({ limit: '1000' }))
  assert.equal((large.items as unknown[]).length, 205)
  const target = (large.sessions as Array<Record<string, unknown>>)[0]!
  const reset = await invoke(fake.routes(), 'POST', '/api/chat/sessions/reset', { key: target.key, sessionId: target.sessionId,
    generation: target.generation, bindingRevision: target.bindingRevision, confirm: true })
  assert(reset)
  assert.equal(fake.runtime().host()!.sessions.list({ limit: 1_000 }).filter(binding => binding.state !== 'retired').length, 204)
  assert.equal(fake.creates(), 0)
  assert.equal(fake.sends.length, 0)
})

test('native group nickname, bot quote and continuation deliver bounded speaker context without stealing addressed conversation', async context => {
  const fake = await fixture(context)
  await fake.configure()
  await fake.start()
  const prompts = () => fake.rpc.filter(value => value.method === 'session/prompt')
  const group = { message_type: 'group', group_id: 456 }
  fake.message(301, { ...group, user_id: 777, message: [{ type: 'text', data: { text: '大家聊点别的' } }] })
  fake.message(302, { ...group, message: [{ type: 'text', data: { text: 'Native，看看之前大家说的' } }] })
  await until(() => prompts().length === 1)
  const first = JSON.stringify(prompts()[0]!.request.content)
  assert.match(first, /nickname/)
  assert.match(first, /大家聊点别的/)
  assert.match(first, /777/)
  await fake.answer()
  await until(() => fake.sends.length === 1 && fake.runtime().host()!.outbox.list()[0]?.status === 'confirmed')
  fake.message(303, { ...group, message: [{ type: 'at', data: { qq: '777' } }, { type: 'text', data: { text: '问的是你' } }] })
  fake.message(304, { ...group, user_id: 777,
    message: [{ type: 'reply', data: { id: '1001' } }, { type: 'text', data: { text: '解释一下这个回答' } }] })
  await until(() => prompts().length === 2)
  const second = JSON.stringify(prompts()[1]!.request.content)
  assert.match(second, /Final answer 1/)
  assert.match(second, /available\\?":true/)
  assert.match(second, /reply/)
  await fake.answer(2)
  await until(() => fake.sends.length === 2)
  fake.message(305, { ...group, user_id: 777, message: [{ type: 'text', data: { text: '再补充一下' } }] })
  await until(() => prompts().length === 3)
  assert.match(JSON.stringify(prompts()[2]!.request.content), /continuation/)
})

test('native busy corrections suppress the stale reply and merge into one subsequent submission', async context => {
  const fake = await fixture(context)
  await fake.configure()
  await fake.start()
  const prompts = () => fake.rpc.filter(value => value.method === 'session/prompt')
  fake.message(401, { message_type: 'group', group_id: 456, message: [
    { type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: '开始这个问题' } }] })
  await until(() => prompts().length === 1)
  fake.message(402, { message_type: 'group', group_id: 456, message: [{ type: 'text', data: { text: '第一处更正' } }] })
  fake.message(403, { message_type: 'group', group_id: 456, message: [{ type: 'text', data: { text: '第二处补充' } }] })
  await until(() => fake.runtime().host()!.history.snapshot('group:456', { afterSequence: 0 }).messages.length === 3)
  assert.equal(prompts().length, 1)
  await fake.answer()
  await until(() => prompts().length === 2)
  const queued = JSON.stringify(prompts()[1]!.request.content)
  assert.match(queued, /第一处更正/)
  assert.match(queued, /第二处补充/)
  assert.doesNotMatch(queued, /Final answer 1/)
  assert.match(queued, /unsentFor/)
  fake.message(402, { message_type: 'group', group_id: 456, message: [{ type: 'text', data: { text: '第一处更正' } }] })
  await fake.answer(2)
  await until(() => fake.sends.length === 1)
  await delay(300)
  assert.equal(prompts().length, 2)
})

test('native mixed and media-only input retain scoped handles and explicitly unread facts', async context => {
  const fake = await fixture(context, { mediaBytes: true })
  await fake.configure()
  await fake.start()
  const prompts = () => fake.rpc.filter(value => value.method === 'session/prompt')
  fake.message(501, { message: [{ type: 'text', data: { text: '这张图里是什么？' } },
    { type: 'image', data: { file: 'opaque-image-token', url: `${fake.base}/fixture-assets/image?token=private-test-token` } }] })
  await until(() => prompts().length === 1)
  const mixed = JSON.stringify(prompts()[0]!.request.content)
  assert.match(mixed, /这张图里是什么/)
  assert.match(mixed, /图片资源 media-/)
  assert.match(mixed, /以实际附件为准|未读取内容/)
  assert.equal(mixed.includes('private-test-token'), false)
  const history = fake.runtime().host()!.history.snapshot('private:123', { afterSequence: 0 })
  assert.equal(history.messages[0]?.content[1]?.type, 'image')
  await fake.answer()
  await until(() => fake.sends.length === 1)
  fake.message(502, { message: [{ type: 'record', data: { file: 'opaque-audio-token' } }] })
  await until(() => prompts().length === 2)
  assert.match(JSON.stringify(prompts()[1]!.request.content), /audio资源 media-/)
  const counts = fake.rpc.length
  const media = await invoke(fake.routes(), 'GET', '/api/chat/media', null, new URLSearchParams({ conversationId: 'private:123', limit: '100' }))
  assert(Array.isArray(media.items) && media.items.length === 2)
  assert(media.items.some(item => isRecord(item) && item.kind === 'audio' && item.readingAvailable === false
    && Array.isArray(item.missingReasons) && item.missingReasons.includes('native_media_transcriber_not_connected')))
  assert(!JSON.stringify(media).includes('private-test-token'))
  assert.equal(fake.rpc.length, counts)
  await fake.runtime().stop()
  const stopped = await invoke(fake.routes(), 'GET', '/api/chat/media', null, new URLSearchParams({ conversationId: 'private:123' }))
  assert.equal(stopped.running, false); assert(Array.isArray(stopped.items) && stopped.items.length === 2)
})

test('native installed feature reads a registered forward through policy and retains nested unread media', async context => {
  const results: JsonValue[] = []
  const bootstrap: LoadedNativeBootstrap = { metadata: { manifest: { id: 'forward-reader', version: '1.0.0', apiVersion: 1 },
    codeFingerprint: 'e'.repeat(64), trust: 'trusted-operator-code', sandboxed: false, requiresSeparateAuthorization: true },
    create() { return { agentInputPreparation: { capabilities: [], prepare(_execution, event) {
      return [...normalizeContent(event.data.content), { type: 'text', text: 'input-extension-active' }]
    } }, features: [{ id: 'forward-reader', version: '1.0.0', apiVersion: 1,
      capabilities: ['native.media.read'], subscriptions: ['message.received'], setup(services) {
        services.on('message.received', async (execution, event) => {
          const forward = normalizeContent(event.data.content).find(part => part.type === 'forward-reference')
          if (!forward) return
          results.push(await execution.invoke('native.media.read', { assetId: forward.assetId }))
        })
      } }] } } }
  const fake = await fixture(context, { bootstrap, forwardMessages: [{ sender: { user_id: 789, nickname: '转发里的名字' },
    time: 100, content: [{ type: 'text', data: { text: '转发正文' } },
      { type: 'image', data: { file: 'nested-file', url: 'https://media.example.test/nested?token=secret-pointer' } }] }] })
  await fake.configure()
  await fake.start()
  fake.runtime().host()!.policy.grant({ id: 'forward-reader-explicit', featureId: 'forward-reader',
    conversationId: 'private:123', capabilities: ['native.media.read'], maxUses: { 'native.media.read': 1 } })
  fake.message(601, { message: [{ type: 'forward', data: { id: 'forward-token' } }] })
  await until(() => results.length === 1)
  const result = results[0] as { state: string; sourceMeaning: string; contentRead: boolean; nestedMediaRead: boolean;
    nodes: { senderId: string; content: { type: string; assetId?: string }[] }[] }
  assert.equal(result.state, 'expanded')
  assert.equal(result.contentRead, true)
  assert.equal(result.nestedMediaRead, false)
  assert.equal(result.sourceMeaning, 'forwarded-content-not-authenticated-current-sender')
  assert.equal(result.nodes[0]?.senderId, '789')
  assert.equal(result.nodes[0]?.content[1]?.type, 'image')
  assert.match(result.nodes[0]?.content[1]?.assetId ?? '', /^media-/)
  assert.equal(JSON.stringify(result).includes('secret-pointer'), false)
  assert.equal(fake.runtime().host()!.policy.describe().grants.find(grant => grant.id === 'forward-reader-explicit')?.used['native.media.read'], 1)
  await until(() => fake.rpc.some(value => value.method === 'session/prompt'))
  assert.match(JSON.stringify(fake.rpc.find(value => value.method === 'session/prompt')!.request.content), /input-extension-active/)
})

test('editing unused catalog entries keeps active chat and session identity while selected dependencies still block', async context => {
  const fake = await fixture(context)
  await fake.configure()
  await fake.start()
  fake.message(701)
  await until(() => fake.rpc.some(value => value.method === 'session/prompt'))
  const binding = fake.runtime().host()!.sessions.get('private:123')
  await fake.save('personas', { personas: [persona, { ...persona, id: 'unused-persona', name: 'Unused', identity: 'Unused identity.' }] })
  await fake.save('plans', { activePlanId: 'daily', plans: [plan,
    { ...plan, id: 'unused-plan', personaId: 'unused-persona', instructions: 'Unused instructions.' }] })
  const configuration = await readNativeChatConfiguration(fake.directory)
  await fake.save('providers', { providers: [...configuration.providers,
    { ...configuration.providers[0]!, id: 'unused-provider', name: 'Unused provider' }] })
  const status = await fake.runtime().status()
  assert.equal(status.chatReady, true)
  assert.equal(status.configurationImpact?.canContinue, true)
  assert.deepEqual([...status.configurationImpact!.ignoredCatalogRevisions].sort(), ['personas', 'plans', 'providers'])
  await fake.answer()
  await until(() => fake.sends.length === 1)
  fake.message(702)
  await until(() => fake.rpc.filter(value => value.method === 'session/prompt').length === 2)
  assert.deepEqual(fake.runtime().host()!.sessions.get('private:123'), binding)
  assert.equal(fake.creates(), 1)
  await fake.save('personas', { personas: [{ ...persona, identity: 'Selected identity changed.' },
    { ...persona, id: 'unused-persona', name: 'Unused', identity: 'Unused identity.' }] })
  assert.equal((await fake.runtime().status()).chatReady, false)
  await fake.answer(2)
  await delay(80)
  assert.equal(fake.sends.length, 1)
  assert.deepEqual(fake.runtime().host()!.sessions.get('private:123'), binding)
})

test('native protocol notice reaches installed feature with scope checks and no automatic model submission', async context => {
  const notices: JsonValue[] = []
  const bootstrap: LoadedNativeBootstrap = { metadata: { manifest: { id: 'protocol-reader', version: '1.0.0', apiVersion: 1 },
    codeFingerprint: 'd'.repeat(64), trust: 'trusted-operator-code', sandboxed: false, requiresSeparateAuthorization: true },
    create() { return { features: [{ id: 'protocol-reader', version: '1.0.0', apiVersion: 1,
      capabilities: [], subscriptions: ['protocol.message.recalled'], setup(services) {
        services.on('protocol.message.recalled', (_execution, event) => { notices.push(event.data) })
      } }] } } }
  const fake = await fixture(context, { bootstrap })
  await fake.configure()
  await fake.start()
  const notice = { post_type: 'notice', notice_type: 'group_recall', group_id: 456, operator_id: 123, message_id: 800, time: 1000 }
  fake.message(801, notice)
  await until(() => notices.length === 1)
  assert.equal((notices[0] as { messageId: string }).messageId, '800')
  fake.message(801, notice)
  fake.message(802, { ...notice, group_id: 789 })
  fake.message(803, { ...notice, self_id: 100 })
  await delay(100)
  assert.equal(notices.length, 1)
  assert.equal(fake.rpc.filter(value => value.method === 'session/prompt').length, 0)
  assert.equal(fake.creates(), 0)
  assert.equal(fake.sends.length, 0)
})

for (const delivery of ['confirmed', 'rejected', 'unknown'] as const) test(`control command activity records one real receipt without a model step or replay duplicates: ${delivery}`, async context => {
  let selections = 0
  let executions = 0
  const text = '控制命令固定回执。'
  const bootstrap: LoadedNativeBootstrap = { metadata: { manifest: { id: 'control-activity-fixture', version: '1.0.0', apiVersion: 1 },
    codeFingerprint: 'e'.repeat(64), trust: 'trusted-operator-code', sandboxed: false, requiresSeparateAuthorization: true },
    controlCommands: [{ id: 'control-activity-fixture', replyTexts: [text],
      matches(message) { selections++; return message.content.some(part => part.type === 'text' && part.text === '/control-fixture') },
      async handle(context) { executions++; await context.reply(text) } }], create() { return {} } }
  const fake = await fixture(context, { bootstrap, unknownSend: delivery === 'unknown', rejectedSend: delivery === 'rejected' })
  await fake.configure(); await fake.start()
  const raw = { user_id: 123, message_type: 'group', group_id: 789, time: Math.floor(Date.now() / 1000),
    message: [{ type: 'text', data: { text: '/control-fixture' } }] }
  fake.message(805, raw)
  await until(() => fake.runtime().activity().items.some(item => item.type === 'sent'))
  const activity = fake.runtime().activity().items
  const received = activity.filter(item => item.type === 'received')
  const sent = activity.filter(item => item.type === 'sent')
  assert.equal(received.length, 1); assert.equal(received[0]!.content, '/control-fixture')
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.summary, delivery === 'confirmed' ? '协议已确认发送回复。'
    : delivery === 'rejected' ? '回复未能发送。' : '回复发送结果未确认，未自动重复发送。')
  assert.equal(sent[0]!.content, delivery === 'confirmed' ? text : null)
  assert.equal(sent[0]!.level, delivery === 'confirmed' ? 'info' : 'warning')
  assert(activity.indexOf(sent[0]!) < activity.indexOf(received[0]!), 'Actual receipt follows the received command in time')
  assert.equal(fake.rpc.filter(call => call.method === 'session/prompt').length, 0)
  assert.equal(activity.some(item => item.summary === '模型已接收本轮请求，正在等待回复。'), false)
  assert.equal(selections, 1); assert.equal(executions, 1); assert.equal(fake.sends.length, 1)
  fake.message(805, raw)
  await delay(50)
  assert.equal(selections, 1); assert.equal(executions, 1); assert.equal(fake.sends.length, 1)
  assert.equal(fake.runtime().activity().items.filter(item => item.type === 'received').length, 1)
  assert.equal(fake.runtime().activity().items.filter(item => item.type === 'sent').length, 1)
  fake.message(806, { ...raw, message: [{ type: 'text', data: { text: '不在白名单内的普通聊天。' } }] })
  await delay(50)
  assert.equal(fake.runtime().activity().items.filter(item => item.type === 'received').length, 1, 'Denied everyday traffic does not add activity spam')
  assert.equal(fake.rpc.filter(call => call.method === 'session/prompt').length, 0)
})

test('conversational notices admit group uploads through normal wake rules and wake only bot-targeted group pokes', async context => {
  const fake = await fixture(context)
  await fake.configure(); await fake.start()
  const time = Math.floor(Date.now() / 1000)
  const poke = { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', group_id: 456, user_id: 124, time }
  fake.message(810, { ...poke, target_id: 125 })
  fake.message(811, { ...poke, user_id: 999, target_id: 999 })
  fake.message(812, { post_type: 'notice', notice_type: 'group_upload', group_id: 456, user_id: 124, time,
    file: { id: 'fixture-group-file', name: 'notes.txt', size: 42, busid: 102 } })
  await until(() => fake.runtime().host()!.history.snapshot('group:456').messages.some(message => message.content.some(part => part.type === 'file')))
  assert.equal(fake.rpc.filter(call => call.method === 'session/prompt').length, 0, 'An inactive group upload does not force a model reply')
  const file = fake.runtime().host()!.history.snapshot('group:456').messages.find(message => message.content.some(part => part.type === 'file'))!
  assert.equal(file.actor, '124'); assert.match(file.id, /^onebot-notice:/)
  fake.message(813, { ...poke, target_id: 999 })
  await until(() => fake.rpc.some(call => call.method === 'session/prompt')).catch(async error => { throw new Error(JSON.stringify((await fake.runtime().status()).ingress), { cause: error }) })
  assert.equal(fake.rpc.filter(call => call.method === 'session/prompt').length, 1)
  const prompt = JSON.stringify(fake.rpc.find(call => call.method === 'session/prompt')!.request)
  assert.doesNotMatch(prompt, /拍一拍/); assert.match(prompt, /notes.txt/); assert.match(prompt, /senderIsConfiguredOwner\\\":false/)
  fake.message(814, { ...poke, target_id: 999 })
  await delay(40)
  assert.equal(fake.rpc.filter(call => call.method === 'session/prompt').length, 1, 'A replayed notice never starts a second concurrent prompt')
  assert(fake.runtime().readEvents().events.some(event => event.kind === 'message' && event.status === 'received'
    && event.correlation.conversationId === 'group:456'))
})

test('private pokes become real sender direct input while self echoes and other targets stay silent', async context => {
  const fake = await fixture(context)
  await fake.configure(); await fake.start()
  const poke = { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: 123, time: Math.floor(Date.now() / 1000) }
  fake.message(820, { ...poke, target_id: 124 })
  fake.message(821, { ...poke, user_id: 999, target_id: 999 })
  await delay(40)
  assert.equal(fake.rpc.filter(call => call.method === 'session/prompt').length, 0)
  fake.message(822, { ...poke, target_id: 999 })
  await until(() => fake.rpc.some(call => call.method === 'session/prompt')).catch(async error => { throw new Error(JSON.stringify((await fake.runtime().status()).ingress), { cause: error }) })
  const messages = fake.runtime().host()!.history.snapshot('private:123', { afterSequence: 0 }).messages
  assert(messages.some(message => message.actor === '123' && message.id.startsWith('onebot-notice:')))
  assert.equal(fake.rpc.filter(call => call.method === 'session/prompt').length, 1)
  assert(fake.runtime().readEvents().events.some(event => event.kind === 'message' && event.status === 'received'
    && event.correlation.conversationId === 'private:123'))
})

test('persona wake settings apply live while QQ mentions remain enabled and sessions are preserved', async context => {
  const fake = await fixture(context)
  await fake.configure(); await fake.start()
  async function wake(nicknames: string[], continuationMs: number) {
    const current = await readNativeChatConfiguration(fake.directory)
    await fake.save('personas', { personas: current.personas.map(persona => ({ ...persona, wake: { nicknames, wakeOnReply: false, continuationMs } })) })
  }
  await wake(['小框架'], 0)
  fake.message(801, { message_type: 'group', group_id: 456, message: [{ type: 'text', data: { text: '小框架，开始吧' } }] })
  await until(() => fake.rpc.filter(call => call.method === 'session/prompt').length === 1)
  await fake.answer()
  await until(() => fake.runtime().executions()!.forConversation('group:456') === null)
  await wake(['新昵称'], 0)
  fake.message(802, { message_type: 'group', group_id: 456, message: [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: '直接提及仍唤醒' } }] })
  await until(() => fake.rpc.filter(call => call.method === 'session/prompt').length === 2)
  await fake.answer(2)
  assert.equal(fake.creates(), 1)
  assert.equal((await fake.runtime().status()).chatReady, true)
})

test('native persistent application survives request cancellation and repeated route construction without repeating a start', async context => {
  const { randomUUID } = await import('node:crypto')
  const { parseNativeApplicationSnapshot } = await import('../src/contracts/native-application.ts')
  const fake = await fixture(context)
  await fake.configure()
  const revisions = (await readNativeChatConfiguration(fake.directory)).revisions
  const operationId = randomUUID()
  const request = new AbortController()
  const route = fake.routes().find(route => route.pathname === '/api/chat/application' && route.method === 'POST')!
  const response = await route.handle({ query: new URLSearchParams(), body: { operationId, revisions, deploy: false }, signal: request.signal })
  assert(response && typeof response === 'object' && 'operation' in response)
  assert.equal(parseNativeApplicationSnapshot(response.operation)?.state, 'running')
  request.abort()
  await until(async () => {
    const read = await invoke(fake.routes(), 'GET', '/api/chat/application')
    return parseNativeApplicationSnapshot(read.operation)?.state === 'completed'
  })
  const first = await invoke(fake.routes(), 'GET', '/api/chat/application', null, new URLSearchParams({ id: operationId }))
  const before = fake.rpc.length
  const repeated = await invoke(fake.routes(), 'POST', '/api/chat/application', { operationId, revisions, deploy: false })
  assert.deepEqual(repeated, first)
  assert.equal(fake.rpc.length, before)
  assert.equal((await fake.runtime().status()).chatReady, true)
  assert.equal((await readNativeChatConfiguration(fake.directory)).revisions.execution, revisions.execution)
})

test('native remote quote resolves same-conversation speaker and text without exposing cross-conversation content', async context => {
  const fake = await fixture(context, { quotedMessages: {
    '9001': { message_id: 9001, message_type: 'group', group_id: 456, sender: { user_id: 999 },
      message: [{ type: 'text', data: { text: '协议返回的本群旧回答' } }] },
    '9002': { message_id: 9002, message_type: 'group', group_id: 777, sender: { user_id: 999 },
      message: [{ type: 'text', data: { text: '其他群的保密上下文' } }] },
  } })
  await fake.configure(); await fake.start()
  const prompts = () => fake.rpc.filter(value => value.method === 'session/prompt')
  const group = { message_type: 'group', group_id: 456 }
  fake.message(901, { ...group, message: [{ type: 'reply', data: { id: '9002' } }, { type: 'text', data: { text: '这个呢' } }] })
  await until(() => fake.runtime().host()!.history.snapshot('group:456', { afterSequence: 0 }).messages.length === 1)
  assert.equal(prompts().length, 0)
  const rejectedQuote = await invoke(fake.routes(), 'GET', '/api/chat/media', null, new URLSearchParams({ conversationId: 'group:456' }))
  assert(isRecord(rejectedQuote.quote)); assert.equal(rejectedQuote.quote.status, 'unknown')
  assert.equal(rejectedQuote.quote.code, 'ONEBOT_ACTION_INVALID_RESPONSE')
  assert(!JSON.stringify(rejectedQuote).includes('其他群的保密上下文'))
  fake.message(902, { ...group, message: [{ type: 'reply', data: { id: '9001' } }, { type: 'text', data: { text: '接着解释' } }] })
  await until(() => prompts().length === 1)
  const input = JSON.stringify(prompts()[0]!.request.content)
  assert.match(input, /协议返回的本群旧回答/)
  assert.match(input, /reply/)
  assert(!input.includes('其他群的保密上下文'))
  const readQuote = await invoke(fake.routes(), 'GET', '/api/chat/media', null, new URLSearchParams({ conversationId: 'group:456' }))
  assert(isRecord(readQuote.quote)); assert.equal(readQuote.quote.status, 'confirmed'); assert.equal(readQuote.quote.messageId, '9001')
  assert.equal(fake.sends.length, 0)
})

test('native default framework tools project only explicit grants and execute media read through current claim and feature policy', async context => {
  const bootstrap: LoadedNativeBootstrap = { metadata: { manifest: { id: 'fixture-tool-grants', version: '1.0.0', apiVersion: 1 },
    codeFingerprint: 'd'.repeat(64), trust: 'trusted-operator-code', sandboxed: false, requiresSeparateAuthorization: true },
    create() { return { start(host) { host.policy.grant({ id: 'explicit-framework-media', featureId: 'framework-tools',
      conversationId: 'private:123', capabilities: ['native.media.inspect', 'native.media.read'],
      maxUses: { 'native.media.inspect': 2, 'native.media.read': 1 } }) } } } }
  const fake = await fixture(context, { bootstrap, frameworkToolChannel: true,
    forwardMessages: [{ sender: { user_id: 789 }, content: [{ type: 'text', data: { text: '由真实宿主工具展开的正文' } }] }] })
  await fake.configure(); await fake.start()
  fake.message(950, { message: [{ type: 'forward', data: { id: 'forward-token' } }, { type: 'text', data: { text: '读这个转发' } }] })
  await until(() => fake.rpc.some(call => call.method === 'session/prompt')).catch(async error => { throw new Error(JSON.stringify((await fake.runtime().status()).ingress), { cause: error }) })
  const prompt = fake.rpc.find(call => call.method === 'session/prompt')!.request
  const sessionId = String(prompt.sessionId); const requestId = String(prompt.requestId)
  const assetId = JSON.stringify(prompt.content).match(/media-[a-f0-9]{64}/)![0]
  const lease = fake.toolLeases.get(sessionId)!
  assert(lease.names.includes('qbf_media_inspect') && lease.names.includes('qbf_media_read'))
  const call = { id: 'tool-call-1', sessionId, generation: 1, requestId, userMessageId: `user-${requestId}`, turn: 1,
    name: 'qbf_media_read', input: { assetId }, expiresAt: Date.now() + 10_000 }
  fake.toolCalls.push({ ticket: 'ticket-forged', leaseId: lease.leaseId, call: { ...call, id: 'forged', userMessageId: 'unmatched-source' } })
  await until(() => fake.toolResults.has('ticket-forged'))
  assert.equal(fake.toolResults.get('ticket-forged')?.status, 'rejected')
  fake.toolCalls.push({ ticket: 'ticket-real', leaseId: lease.leaseId, call })
  await until(() => fake.toolResults.has('ticket-real'))
  const result = fake.toolResults.get('ticket-real')!
  assert.equal(result.status, 'confirmed')
  const toolEvents = await invoke(fake.routes(), 'GET', '/api/chat/events', null, new URLSearchParams({ source: 'host', kind: 'tool', toolCallId: call.id }))
  assert(isNativeEventPage(toolEvents))
  assert.deepEqual(toolEvents.events.map(event => event.status), ['started', 'progress', 'completed'])
  assert(toolEvents.events.every(event => event.correlation.requestId === requestId && event.correlation.generation === 1))
  assert(!JSON.stringify(toolEvents).includes(assetId))
  assert.match(JSON.stringify(result), /由真实宿主工具展开的正文/)
  assert.equal(fake.runtime().host()!.policy.describe().grants.reduce((total, grant) => total + (grant.used['native.media.read'] ?? 0), 0), 1)
  assert.equal(fake.sends.length, 0)
  assert.equal(fake.runtime().host()!.history.snapshot('private:123', { afterSequence: 0 }).messages.length, 1)
  await fake.runtime().stop()
  assert.equal(fake.toolLeases.size, 0)
  assert((await fake.runtime().status()).packages.every(item => item.state === 'stopped'))
})

test('native consumes a structured non-participation decision without sending control text or blocking queued conversation', async context => {
  const fake = await fixture(context)
  await fake.configure(); await fake.start()
  fake.message(960)
  await until(() => fake.rpc.some(call => call.method === 'session/prompt')).catch(async error => { throw new Error(JSON.stringify((await fake.runtime().status()).ingress), { cause: error }) })
  fake.agentEvent('assistant/message', { turn: 1, message: { id: 'silent-final', role: 'assistant', content: [{ type: 'text',
    text: JSON.stringify({ schema: 'qbf.reply/1', action: 'silent', reason: 'user-requested' }) }] } })
  fake.agentEvent('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await until(() => fake.runtime().host()!.replies.get('private:123')?.status === 'suppressed')
  assert.equal(fake.sends.length, 0)
  assert.equal(fake.runtime().host()!.history.snapshot('private:123', { afterSequence: 0 }).messages.length, 1)
  fake.message(961)
  await until(() => fake.rpc.filter(call => call.method === 'session/prompt').length === 2)
  await fake.answer(2)
  await until(() => fake.sends.length === 1)
  assert(!JSON.stringify(fake.sends).includes('qbf.reply/1'))
  assert.equal(fake.creates(), 1)
})

test('reminder configuration stays in its service without a management write route', async context => {
  const fake = await fixture(context)
  await fake.configure()
  assert(!fake.routes().some(route => route.pathname === '/api/chat/reminders'))
  assert.deepEqual(fake.runtime().readReminders().rules, [])
  assert.equal(fake.creates(), 0)
  assert.equal(fake.sends.length, 0)
})

test('native reminder unknown send is retained across restart without an automatic second delivery', async context => {
  const fake = await fixture(context, { unknownSend: true })
  await fake.configure()
  const rule = await fake.runtime().reminderService().create({ conversationId: 'private:123', text: '未知发送',
    timeZone: 'UTC', schedule: { kind: 'delay', delayMs: 1000 }, enabled: true }, new AbortController().signal)
  await fake.start(); await delay(1050); await fake.runtime().reminderService().tick()
  await until(() => fake.runtime().reminderService().read(rule.id).state === 'unknown')
  assert.equal(fake.sends.length, 1)
  await fake.runtime().stop(); await fake.start(); await fake.runtime().reminderService().tick()
  assert.equal(fake.sends.length, 1)
  assert.equal(fake.runtime().readReminders().rules[0].state, 'unknown')
  assert.equal(fake.runtime().readReminderHistory().history[0].status, 'unknown')
})

test('whitelist projects tools without a grant document and removing access rejects an already projected call', async context => {
  const fake = await fixture(context, { frameworkToolChannel: true,
    forwardMessages: [{ sender: { user_id: 789 }, content: [{ type: 'text', data: { text: '白名单读取' } }] }] })
  await fake.configure(); await fake.start()
  fake.message(970, { message: [{ type: 'forward', data: { id: 'forward-token' } }, { type: 'text', data: { text: '读取' } }] })
  await until(() => fake.rpc.some(call => call.method === 'session/prompt')).catch(async error => { throw new Error(JSON.stringify((await fake.runtime().status()).ingress), { cause: error }) })
  const prompt = fake.rpc.find(call => call.method === 'session/prompt')!.request
  const sessionId = String(prompt.sessionId); const requestId = String(prompt.requestId)
  const assetId = JSON.stringify(prompt.content).match(/media-[a-f0-9]{64}/)![0]
  const lease = fake.toolLeases.get(sessionId)!
  assert(lease.names.includes('qbf_media_read'))
  const call = { id: 'whitelist-read', sessionId, generation: 1, requestId, userMessageId: `user-${requestId}`, turn: 1,
    name: 'qbf_media_read', input: { assetId }, expiresAt: Date.now() + 10_000 }
  fake.toolCalls.push({ ticket: 'whitelist-read', leaseId: lease.leaseId, call })
  await until(() => fake.toolResults.has('whitelist-read'))
  assert.equal(fake.toolResults.get('whitelist-read')?.status, 'confirmed')
  await fake.save('access', { allow: ['group:456'], deny: [], owner: '123' })
  fake.toolCalls.push({ ticket: 'removed-read', leaseId: lease.leaseId, call: { ...call, id: 'removed-read' } })
  await until(() => fake.toolResults.has('removed-read'))
  assert.equal(fake.toolResults.get('removed-read')?.status, 'rejected')
  assert.equal(fake.sends.length, 0)
})

test('QQ owner commands persist scoped memory without a management write route', async context => {
  const fake = await fixture(context)
  await fake.configure(); await fake.start()
  assert(!fake.routes().some(route => route.pathname === '/api/chat/memory'))
  fake.message(980, { message: [{ type: 'text', data: { text: '/记住 主人明确确认的测试资料' } }] })
  await until(() => fake.runtime().readMemory().entries.length === 1)
  const entry = fake.runtime().readMemory().entries[0]!
  assert.equal(entry.status, 'confirmed')
  await until(() => fake.sends.length === 1)
  fake.message(981)
  await until(() => fake.rpc.some(call => call.method === 'session/prompt'))
  assert.equal(fake.runtime().readMemoryEntry(entry.id).status, 'confirmed')
  assert.doesNotMatch(JSON.stringify(fake.rpc.find(call => call.method === 'session/prompt')!.request), /主人明确确认的测试资料/)
  await fake.answer()
  fake.message(982, { message: [{ type: 'text', data: { text: `/撤销记忆 ${entry.id}` } }] })
  await until(() => fake.runtime().readMemoryEntry(entry.id).status === 'revoked')
  assert.equal(fake.creates(), 1)
})

test('default tool projection exposes framework tools while memory and reminder business tools are extension owned', async context => {
  const fake = await fixture(context, { accountScope: { protocolId: 'onebot', accountId: '999' } })
  await fake.configure(); await fake.start(); fake.message(990)
  await until(() => fake.rpc.some(call => call.method === 'session/prompt'))
  const names = fake.toolLeases.get('session-1')!.names
  assert(names.includes('qbf_reply'))
  assert(!names.some(name => name.startsWith('qbf_memory_') || name.startsWith('qbf_reminder_')))
  assert.equal((await fake.reply('同账号的显式回复')).status, 'confirmed')
  fake.rawFinal()
  await until(() => fake.runtime().executions()!.forConversation('private:123') === null)
})

test('native work tools run independently, persist results, send with delegation grants and continue the original child', async context => {
  const fake = await fixture(context, { frameworkToolChannel: true, workChannel: true, accountScope: { protocolId: 'onebot', accountId: '999' } })
  await fake.configure()
  const path = '/api/chat/tool-permissions'
  const initial = await invoke(fake.routes(), 'GET', path)
  const capabilities = ['native.work.start', 'native.work.status', 'native.work.followup', 'native.work.interrupt', 'native.work.reconcile']
  await invoke(fake.routes(), 'POST', path, { revision: initial.revision, action: 'grant', grant: {
    id: randomUUID(), conversationId: 'private:123', capabilities,
    maxUses: Object.fromEntries(capabilities.map(capability => [capability, 4])), expiresAt: null } })
  await fake.start(); fake.message(1200)
  await until(() => fake.rpc.some(call => call.method === 'session/prompt')).catch(async error => { throw new Error(JSON.stringify((await fake.runtime().status()).ingress), { cause: error }) })
  assert.equal(fake.runtime().workStatus().available, true)
  const prompt = fake.rpc.find(call => call.method === 'session/prompt')!.request
  const sessionId = String(prompt.sessionId); const requestId = String(prompt.requestId)
  const lease = fake.toolLeases.get(sessionId)!
  async function call(id: string, name: string, input: JsonValue) {
    const requests = fake.rpc.filter(call => call.method === 'session/prompt' && call.request.sessionId === sessionId)
    const requestId = String(requests.at(-1)!.request.requestId)
    const lease = fake.toolLeases.get(sessionId)!
    fake.toolCalls.push({ ticket: id, leaseId: lease.leaseId, call: { id, name, input, sessionId, requestId,
      generation: 1, userMessageId: `user-${requestId}`, turn: requests.length, expiresAt: Date.now() + 10000 } })
    await until(() => fake.toolResults.has(id)); return fake.toolResults.get(id)!
  }
  const started = await call('start-independent', 'qbf_work_start', { task: '执行明确委派的测试任务', context: '' })
  assert.equal(started.status, 'confirmed', JSON.stringify(started))
  assert.equal(fake.works.size, 1)
  const [id, work] = [...fake.works][0]
  assert.equal(fake.runtime().readWork(id)?.status, 'running')
  const start = fake.rpc.find(call => call.method === 'bridgePlugin/startWork')!.request
  assert.equal(start.modelProvider, 'external-work'); assert.equal(start.agentPreset, 'test-work')
  assert.equal(start.parentSessionId, sessionId)
  const status = await call('status-independent', 'qbf_work_status', { id })
  assert.equal(status.status, 'confirmed')
  fake.rawFinal(1)
  await until(() => fake.runtime().executions()!.forConversation('private:123') === null)
  fake.works.set(id, { ...work, state: 'completed', result: { stopReason: 'completed', output: [{ type: 'text', text: '独立工作真实回传' }] } })
  await until(() => fake.rpc.filter(call => call.method === 'session/prompt').length === 2)
  assert.match(JSON.stringify(fake.rpc.filter(call => call.method === 'session/prompt')[1]!.request.content), /独立工作真实回传/)
  fake.rawFinal(2)
  await until(() => fake.runtime().readWork(id)?.delivery === 'confirmed')
  assert.equal(fake.sends.length, 1)
  assert.match(JSON.stringify(fake.sends[0]), /Final answer 2/)
  const receipt = fake.runtime().readWork(id)!
  assert.equal(receipt.deliveryMessageId, '1001'); assert(receipt.resultId)
  assert.equal(fake.runtime().host()!.sessions.get('private:123')?.sessionId, sessionId)
  fake.message(1201)
  await until(() => fake.rpc.filter(call => call.method === 'session/prompt').length === 3)
  const followup = await call('follow-independent', 'qbf_work_followup', { id, text: '补充明确要求', delivery: 'queue' })
  assert.equal(followup.status, 'confirmed', JSON.stringify(followup))
  assert.equal(fake.works.get(id)?.childId, work.childId)
  await until(() => fake.runtime().readWork(id)?.status === 'running')
  const stopped = await call('stop-independent', 'qbf_work_interrupt', { id })
  assert.equal(stopped.status, 'confirmed', JSON.stringify(stopped))
  fake.rawFinal(3)
  await until(() => fake.rpc.filter(call => call.method === 'session/prompt').length === 4)
  fake.rawFinal(4)
  await until(() => fake.runtime().readWork(id)?.delivery === 'confirmed' && fake.sends.length === 2)
  assert.equal(fake.rpc.filter(call => call.method === 'bridgePlugin/startWork').length, 1)
  assert.equal(fake.rpc.filter(call => call.method === 'session/prompt').length, 4)
  await fake.restart()
  assert.equal(fake.runtime().listWork().records.length, 1)
  assert.equal(fake.runtime().readWork(id)?.delivery, 'confirmed')
  assert.equal(fake.sends.length, 2)
})


test('native child questions use QQ owner replies while the main conversation continues independently', async context => {
  const fake = await fixture(context, { frameworkToolChannel: true, workChannel: true })
  await fake.configure()
  const current = await invoke(fake.routes(), 'GET', '/api/chat/tool-permissions')
  await invoke(fake.routes(), 'POST', '/api/chat/tool-permissions', { revision: current.revision, action: 'grant', grant: {
    id: randomUUID(), conversationId: 'private:123', capabilities: ['native.work.start'], maxUses: { 'native.work.start': 1 }, expiresAt: null } })
  await fake.start(); fake.message(1300)
  await until(() => fake.rpc.some(call => call.method === 'session/prompt')).catch(async error => { throw new Error(JSON.stringify((await fake.runtime().status()).ingress), { cause: error }) })
  const prompt = fake.rpc.find(call => call.method === 'session/prompt')!.request
  const sessionId = String(prompt.sessionId); const requestId = String(prompt.requestId)
  const lease = fake.toolLeases.get(sessionId)!
  fake.toolCalls.push({ ticket: 'child-start', leaseId: lease.leaseId, call: { id: 'child-start', name: 'qbf_work_start',
    input: { task: '执行需要确认的独立工作', context: '' }, sessionId, requestId, generation: 1,
    userMessageId: `user-${requestId}`, turn: 1, expiresAt: Date.now() + 10000 } })
  await until(() => fake.toolResults.has('child-start'))
  assert.equal(fake.toolResults.get('child-start')?.status, 'confirmed')
  const [id, work] = [...fake.works][0]
  await fake.answer()
  await until(() => fake.sends.length === 1)
  fake.message(1301)
  await until(() => fake.rpc.filter(call => call.method === 'session/prompt').length === 2)
  assert.equal(fake.runtime().readWork(id)?.status, 'running')
  fake.interaction({ type: 'waterfall', event: 'approval/request', agentId: work.childId, eventId: 'work-approval',
    request: { toolName: 'workspace.write', reason: '需要写入测试报告 secret=dsh-test-secret' } })
  await until(() => fake.rpc.some(call => call.method === '$events/result'))
  const answered = fake.rpc.find(call => call.method === '$events/result')!.request
  assert.equal(answered.eventId, 'work-approval')
  assert.equal(fake.sends.length, 1)
  assert.match(JSON.stringify(answered), /allowed-once/)
  assert.equal(fake.rpc.filter(call => call.method === 'session/prompt').length, 2)
  fake.rawFinal(2)
  await until(() => fake.runtime().executions()!.forConversation('private:123') === null)
  fake.works.set(id, { ...work, state: 'completed', result: { stopReason: 'completed', output: [{ type: 'text', text: '工作完成' }] } })
  await until(() => fake.rpc.filter(call => call.method === 'session/prompt').length === 3)
  fake.rawFinal(3)
  await until(() => fake.runtime().readWork(id)?.delivery === 'confirmed')
})


test('native work file result is registered from SDK bytes and records a real upload receipt without a fake message id', async context => {
  const fake = await fixture(context, { frameworkToolChannel: true, workChannel: true })
  await fake.configure()
  const current = await invoke(fake.routes(), 'GET', '/api/chat/tool-permissions')
  await invoke(fake.routes(), 'POST', '/api/chat/tool-permissions', { revision: current.revision, action: 'grant', grant: {
    id: randomUUID(), conversationId: 'private:123', capabilities: ['native.work.start'], maxUses: { 'native.work.start': 1 }, expiresAt: null } })
  await fake.start(); fake.message(1400)
  await until(() => fake.rpc.some(call => call.method === 'session/prompt')).catch(async error => { throw new Error(JSON.stringify((await fake.runtime().status()).ingress), { cause: error }) })
  const prompt = fake.rpc.find(call => call.method === 'session/prompt')!.request
  const sessionId = String(prompt.sessionId); const requestId = String(prompt.requestId)
  fake.toolCalls.push({ ticket: 'file-start', leaseId: fake.toolLeases.get(sessionId)!.leaseId, call: { id: 'file-start', name: 'qbf_work_start',
    input: { task: '生成报告文件', context: '' }, sessionId, requestId, generation: 1,
    userMessageId: `user-${requestId}`, turn: 1, expiresAt: Date.now() + 10000 } })
  await until(() => fake.toolResults.has('file-start'))
  assert.equal(fake.toolResults.get('file-start')?.status, 'confirmed')
  const [id, work] = [...fake.works][0]
  fake.rawFinal(1)
  await until(() => fake.runtime().executions()!.forConversation('private:123') === null)
  fake.works.set(id, { ...work, state: 'completed', result: { stopReason: 'completed', output: [
    { type: 'text', text: '报告见文件' }, fake.workAsset ] } })
  await until(() => fake.rpc.filter(call => call.method === 'session/prompt').length === 2)
  fake.rawFinal(2)
  await until(() => fake.runtime().readWork(id)?.delivery === 'confirmed')
  const result = fake.runtime().readWork(id)!
  assert.equal(result.deliveryMessageId, null)
  assert.equal(result.deliveryFileId, 'uploaded-report')
  assert.equal(fake.sends.length, 2)
  assert.equal(fake.sends[1].file, 'base64://' + Buffer.from('file report').toString('base64'))
  assert.equal(fake.sends[1].name, 'report.txt')
  assert.equal(fake.sends[1].user_id, 123)
  await fake.restart()
  assert.equal(fake.runtime().readWork(id)?.deliveryFileId, 'uploaded-report')
  assert.equal(fake.sends.length, 2)
})

test('native bootstrap packages share versioned services, contribute input and execute effects only through feature policy', async context => {
  let effects = 0
  const disposed: string[] = []
  const bootstrap: LoadedNativeBootstrap = { metadata: { manifest: { id: 'package-fixture', version: '1.0.0', apiVersion: 1 },
    codeFingerprint: 'a'.repeat(64), trust: 'trusted-operator-code', sandboxed: false, requiresSeparateAuthorization: true },
    create() { return { packages: [
      { manifest: { schema: 1, id: 'fixture-source', version: '1.0.0', dependencies: [], requires: [],
        provides: [{ id: 'fixture-shared', version: 1 }], contributions: [
          { kind: 'effect', id: 'fixture.package-effect' }, { kind: 'feature', id: 'fixture-package-feature' },
          { kind: 'event-validator', id: 'fixture.package-event' }] },
        install(scope) {
          scope.publish('fixture-shared', 1, Object.freeze({ text: '来自第二个扩展包的可信输入' }))
          scope.contribute('effect', 'fixture.package-effect', { async execute() { effects++; return { executed: true } } })
          scope.contribute('event-validator', 'fixture.package-event', (data: Record<string, unknown>) => Object.keys(data).length === 0)
          scope.contribute('feature', 'fixture-package-feature', { id: 'fixture-package-feature', version: '1.0.0', apiVersion: 1,
            capabilities: ['fixture.package-effect'], subscriptions: ['fixture.package-event'],
            setup(services: import('../src/core/types.ts').FeatureSetup) { services.on('fixture.package-event', async execution => {
              await execution.invoke('fixture.package-effect', {})
            }) } })
          scope.own('subscription', 'owned-subscription', () => { disposed.push('source') })
        } },
      { manifest: { schema: 1, id: 'fixture-input', version: '1.0.0', dependencies: ['fixture-source'],
        requires: [{ id: 'fixture-shared', version: 1 }], provides: [],
        contributions: [{ kind: 'input-provider', id: 'fixture-package-input', capabilities: [], order: 10 }] },
        install(scope) {
          const shared = scope.service('fixture-shared', 1) as { readonly text: string }
          scope.contribute('input-provider', 'fixture-package-input', { capabilities: [],
            async prepare(_execution: unknown, event: import('../src/core/types.ts').FrameworkEvent) {
              return [...normalizeContent(event.data.content), { type: 'text' as const, text: shared.text }]
            } })
          scope.own('timer', 'owned-timer', () => { disposed.push('input') })
        } }
    ] } } }
  const fake = await fixture(context, { bootstrap })
  await fake.configure(); await fake.start()
  const host = fake.runtime().host()!
  assert((await fake.runtime().status()).packages.some(item => item.id === 'fixture-source' && item.state === 'running'))
  const denied = await host.dispatchEvent({ id: 'package-denied', type: 'fixture.package-event', conversationId: 'private:123', data: {} })
  assert.equal(denied.errorCode, 'POLICY_DENIED')
  assert.equal(effects, 0)
  host.policy.grant({ id: 'explicit-package-effect', featureId: 'fixture-package-feature', conversationId: 'private:123',
    capabilities: ['fixture.package-effect'], maxUses: { 'fixture.package-effect': 1 } })
  await host.dispatchEvent({ id: 'package-allowed', type: 'fixture.package-event', conversationId: 'private:123', data: {} })
  assert.equal(effects, 1)
  fake.message(1600)
  await until(() => fake.rpc.some(call => call.method === 'session/prompt')).catch(async error => { throw new Error(JSON.stringify((await fake.runtime().status()).ingress), { cause: error }) })
  assert.match(JSON.stringify(fake.rpc.find(call => call.method === 'session/prompt')!.request.content), /来自第二个扩展包的可信输入/)
  await fake.runtime().stop()
  assert.deepEqual(disposed, ['input', 'source'])
  assert((await fake.runtime().status()).packages.every(item => item.state === 'stopped'))
})


test('native media tools read protocol image and text-file bytes without sending source URLs or pretending to transcribe audio', async context => {
  const fake = await fixture(context, { frameworkToolChannel: true, mediaBytes: true })
  await fake.configure()
  const current = await invoke(fake.routes(), 'GET', '/api/chat/tool-permissions')
  await invoke(fake.routes(), 'POST', '/api/chat/tool-permissions', { revision: current.revision, action: 'grant', grant: {
    id: randomUUID(), conversationId: 'private:123', capabilities: ['native.media.read'], maxUses: { 'native.media.read': 3 }, expiresAt: null } })
  await fake.start()
  fake.message(1700, { message: [{ type: 'text', data: { text: '看图和读文件' } },
    { type: 'image', data: { file: 'image-token', url: 'https://untrusted.example.test/not-used' } },
    { type: 'file', data: { file_id: 'file-token', name: 'report.txt', file_hash: 'private-hash' } },
    { type: 'record', data: { file: 'audio-token' } }] })
  await until(() => fake.rpc.some(call => call.method === 'session/prompt')).catch(async error => { throw new Error(JSON.stringify((await fake.runtime().status()).ingress), { cause: error }) })
  const prompt = fake.rpc.find(call => call.method === 'session/prompt')!.request
  const sessionId = String(prompt.sessionId); const requestId = String(prompt.requestId)
  const source = fake.runtime().host()!.history.snapshot('private:123', { afterSequence: 0 }).messages[0]
  const contents = source.content.filter(part => ['image', 'file', 'audio'].includes(part.type))
  assert.equal(contents.length, 3)
  async function call(index: number) {
    const part = contents[index]; assert('assetId' in part)
    const id = `media-read-${index}`
    fake.toolCalls.push({ ticket: id, leaseId: fake.toolLeases.get(sessionId)!.leaseId, call: { id, name: 'qbf_media_read',
      input: { assetId: part.assetId }, sessionId, requestId, generation: 1,
      userMessageId: `user-${requestId}`, turn: 1, expiresAt: Date.now() + 10000 } })
    await until(() => fake.toolResults.has(id)); return fake.toolResults.get(id)!
  }
  const image = await call(0)
  assert.equal(image.status, 'confirmed', JSON.stringify(image)); assert(image.status === 'confirmed')
  assert.equal(image.content?.[0].type, 'image')
  assert(!JSON.stringify(image.value).includes('base64'))
  assert(!JSON.stringify(image).includes('untrusted.example.test'))
  const file = await call(1)
  assert.equal(file.status, 'confirmed', JSON.stringify(file)); assert(file.status === 'confirmed')
  assert.deepEqual(file.content, [{ type: 'text', text: '默认读取器取得的文本文件正文' }])
  const audio = await call(2)
  assert.equal(audio.status, 'confirmed'); assert(audio.status === 'confirmed')
  assert.match(JSON.stringify(audio.value), /native_media_transcriber_not_connected/)
  assert.equal(audio.content, undefined)
  assert.equal(fake.sends.length, 0)
})

test('default native host publishes shared versioned services and invalidates retained package facades after stop', async context => {
  const consumers: import('../src/host/native-services.ts').NativeHostServiceMap[] = []
  const ids = ['native-agent', 'native-interactions', 'native-executions', 'native-tools', 'native-work'] as const
  const { requireNativeHostService } = await import('../src/host/native-services.ts')
  const bootstrap: LoadedNativeBootstrap = { metadata: { manifest: { id: 'service-consumers', version: '1.0.0', apiVersion: 1 },
    codeFingerprint: 'b'.repeat(64), trust: 'trusted-operator-code', sandboxed: false, requiresSeparateAuthorization: true },
    create() { return { packages: ['one', 'two'].map(id => ({
      manifest: { schema: 1 as const, id: `consumer-${id}`, version: '1.0.0', dependencies: ['native-services'],
        requires: ids.map(id => ({ id, version: 1 })), provides: [], contributions: [] },
      install(scope: import('../src/host/native-packages.ts').NativePackageContext) {
        consumers.push({ 'native-agent': requireNativeHostService(scope, 'native-agent'),
          'native-interactions': requireNativeHostService(scope, 'native-interactions'),
          'native-executions': requireNativeHostService(scope, 'native-executions'),
          'native-tools': requireNativeHostService(scope, 'native-tools'), 'native-work': requireNativeHostService(scope, 'native-work') })
      } })) } } }
  const fake = await fixture(context, { bootstrap })
  await fake.configure(); await fake.start()
  assert.equal(consumers.length, 2)
  for (const id of ids) assert.notEqual(consumers[0][id], consumers[1][id])
  assert.deepEqual(consumers[0]['native-agent'].status(), consumers[1]['native-agent'].status())
  assert.equal(consumers[0]['native-agent'].status().available, true)
  assert.equal(consumers[0]['native-agent'].binding('private:123'), null)
  assert.equal(consumers[0]['native-work'].status().available, false)
  assert.deepEqual(consumers[0]['native-work'].list().records, [])
  fake.message(1800)
  await until(() => fake.rpc.some(call => call.method === 'session/prompt')).catch(async error => { throw new Error(JSON.stringify((await fake.runtime().status()).ingress), { cause: error }) })
  const binding = consumers[0]['native-agent'].binding('private:123')
  assert.equal(binding?.generation, 1)
  assert.equal(consumers[0]['native-executions'].list().length, 1)
  assert(!Object.hasOwn(consumers[0]['native-agent'], 'rawRpc'))
  assert(!Object.hasOwn(consumers[0]['native-work'], 'grant'))
  await fake.runtime().stop()
  assert.throws(() => consumers[0]['native-agent'].status())
  assert.throws(() => consumers[0]['native-tools'].catalog(new AbortController().signal))
})

test('native output package sends registered image audio file and configured long forward with real delivery receipts', async context => {
  const fake = await fixture(context, { mediaBytes: true })
  await fake.configure()
  await fake.save('authorization', { version: 'forward-explicit', grants: [{ conversationId: 'private:123', submitUses: 10, sendUses: 10, forwardUses: 2, expiresAt: null }] })
  await fake.start()
  fake.message(1900, { message: [{ type: 'text', data: { text: '把这些资源整理发给我' } },
    { type: 'image', data: { file: 'image-token' } }, { type: 'record', data: { file: 'audio-token' } },
    { type: 'file', data: { file_id: 'file-token', name: 'report.txt' } }] })
  await until(() => fake.rpc.some(call => call.method === 'session/prompt')).catch(async error => { throw new Error(JSON.stringify((await fake.runtime().status()).ingress), { cause: error }) })
  const source = fake.runtime().host()!.history.snapshot('private:123', { afterSequence: 0 }).messages[0]
  const assets = source.content.filter(part => part.type === 'image' || part.type === 'audio' || part.type === 'file')
  assert.equal(assets.length, 3)
  await fake.reply({ schema: 'qbf.output/1', content: [{ type: 'text', text: '这些是原资源。' }, ...assets] })
  fake.agentEvent('assistant/message', { turn: 1, message: { id: 'output-media', role: 'assistant',
    content: [{ type: 'text', text: JSON.stringify({ schema: 'qbf.output/1', content: [{ type: 'text', text: '这些是原资源。' }, ...assets] }) }] } })
  fake.agentEvent('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await until(() => fake.sends.length === 2)
  assert.match(JSON.stringify(fake.sends[0]), /"type":"image"/)
  assert.match(JSON.stringify(fake.sends[0]), /"type":"record"/)
  assert.match(JSON.stringify(fake.sends[0]), /base64:\/\//)
  assert.equal(fake.sends[1].file, `base64://${Buffer.from('默认读取器取得的文本文件正文').toString('base64')}`)
  await until(() => fake.runtime().host()!.outbox.list().every(row => row.status === 'confirmed'))
  const database = new DatabaseSync(join(fake.directory, 'native-chat.sqlite'), { readOnly: true })
  try { assert(database.prepare("SELECT value FROM durable_records WHERE namespace = 'outbox'").all().some(row => String(row.value).includes('uploaded-report'))) }
  finally { database.close() }
  const { createNativePackageConfigurationRegistry } = await import('../src/host/native-package-configuration.ts')
  const registry = createNativePackageConfigurationRegistry({ directory: fake.directory })
  const current = await registry.read('chat-output')
  await registry.compareAndSet('chat-output', current.revision, { schema: 1, bubbles: false, longTextAsForward: true,
    longTextThreshold: 500, media: true }, new AbortController().signal)
  fake.message(1901)
  await until(() => fake.rpc.filter(call => call.method === 'session/prompt').length === 2)
  await fake.reply('长文内容。'.repeat(150), 2)
  fake.agentEvent('assistant/message', { turn: 2, message: { id: 'output-forward', role: 'assistant', content: [{ type: 'text', text: '长文内容。'.repeat(150) }] } })
  fake.agentEvent('turn/end', { turn: 2, reason: { kind: 'completed' } })
  await until(() => fake.sends.length === 3)
  assert(Array.isArray(fake.sends[2].messages))
  const nodes = fake.sends[2].messages as { data: { user_id: string; nickname: string } }[]
  assert.equal(String(nodes[0].data.user_id), '999')
  assert.equal(nodes[0].data.nickname, 'Native')
  assert.equal(fake.rpc.filter(call => call.method === 'session/create').length, 1)
})

test('long-forward uses whitelist and unknown output is not replayed after restart', async context => {
  const fake = await fixture(context)
  await fake.configure()
  const { createNativePackageConfigurationRegistry } = await import('../src/host/native-package-configuration.ts')
  const registry = createNativePackageConfigurationRegistry({ directory: fake.directory })
  const current = await registry.read('chat-output')
  await registry.compareAndSet('chat-output', current.revision, { schema: 1, bubbles: true, longTextAsForward: true,
    longTextThreshold: 500, media: true }, new AbortController().signal)
  await fake.start(); fake.message(1910)
  await until(() => fake.rpc.some(call => call.method === 'session/prompt')).catch(async error => { throw new Error(JSON.stringify((await fake.runtime().status()).ingress), { cause: error }) })
  await fake.reply('没有转发权限。'.repeat(100))
  fake.agentEvent('assistant/message', { turn: 1, message: { id: 'no-forward-authority', role: 'assistant', content: [{ type: 'text', text: '没有转发权限。'.repeat(100) }] } })
  fake.agentEvent('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await until(() => fake.sends.length === 1)
  await until(() => fake.runtime().host()!.engine.describe().outbox.some(row => row.status === 'confirmed'))
  const unknown = await fixture(context, { unknownSend: true })
  await unknown.configure(); await unknown.start(); unknown.message(1911)
  await until(() => unknown.rpc.some(call => call.method === 'session/prompt'))
  await unknown.answer()
  await until(() => unknown.runtime().host()!.outbox.list().some(row => row.status === 'unknown'))
  assert.equal(unknown.sends.length, 1)
  await unknown.restart()
  assert.equal(unknown.sends.length, 1)
  assert(unknown.runtime().host()!.outbox.list().some(row => row.status === 'unknown'))
})

test('all whitelisted conversations can forward without an independent forwarding list', async context => {
  const fake = await fixture(context)
  await fake.configure()
  await fake.save('authorization', { version: 'whitelist-forward', mode: 'whitelist', grants: [], forwardAllow: ['private:123'] })
  await fake.start()
  const grants = fake.runtime().host()!.policy.describe().grants.filter(grant => grant.featureId === 'agent-relay' && grant.active)
  assert(grants.find(grant => grant.conversationId === 'private:123')!.capabilities.includes('messaging.forward'))
  assert(grants.find(grant => grant.conversationId === 'group:456')!.capabilities.includes('messaging.forward'))
  assert((await invoke(fake.routes(), 'GET', '/api/chat/authorization')).forwardAllow)
  await fake.runtime().stop(); await fake.start()
  const actual = fake.runtime().host()!.policy.describe().grants.filter(grant => grant.featureId === 'agent-relay' && grant.active)
  assert.deepEqual(actual.map(grant => [grant.id, grant.used]), grants.map(grant => [grant.id, grant.used]))
})


test('explicit management execution reconciliation verifies fresh SDK checkpoint without replay and suppresses the old reply', async context => {
  const fake = await fixture(context, { executionCheckpoint: true })
  await fake.configure()
  await fake.save('execution', { policy: { ...DEFAULT_NATIVE_EXECUTION_POLICY, noticeEnabled: false, cancelOnTimeout: false } })
  await fake.start(); fake.message(2000)
  await until(() => fake.runtime().host()!.replies.get('private:123')?.status === 'waiting'
    && fake.runtime().executions()!.list().length > 0 && fake.rpc.some(call => call.method === 'session/prompt'))
  const execution = fake.runtime().executions()!.list()[0]!
  fake.restartPlugin()
  await until(() => fake.runtime().executions()!.get(execution.id)?.status === 'unknown')
  const before = fake.rpc.filter(call => ['session/create','session/prompt','session/cancel'].includes(call.method)).length
  await assert.rejects(invoke(fake.routes(), 'POST', '/api/chat/executions/reconcile', { executionId: execution.id, confirm: false }), /invalid_execution_reconciliation/)
  const absent = await invoke(fake.routes(), 'POST', '/api/chat/executions/reconcile', { executionId: execution.id, confirm: true })
  assert.equal(absent.state, 'blocked')
  assert.deepEqual(absent.missingReasons, ['execution_request_not_observed'])
  assert.equal(fake.runtime().executions()!.get(execution.id)?.isolated, true)
  fake.confirmCheckpoint()
  const released = await invoke(fake.routes(), 'POST', '/api/chat/executions/reconcile', { executionId: execution.id, confirm: true })
  assert.equal(released.state, 'released', JSON.stringify(released))
  assert.equal(released.automaticReplayAvailable, false)
  assert.equal(released.restartRequired, true)
  assert.equal(fake.runtime().executions()!.get(execution.id)?.isolated, false)
  assert.equal(fake.runtime().host()!.replies.get('private:123')?.status, 'suppressed')
  assert.equal(fake.rpc.filter(call => ['session/create','session/prompt','session/cancel'].includes(call.method)).length, before)
  assert.equal(fake.sends.length, 0)
  assert.equal((await fake.runtime().status()).chatReady, false)
  await fake.restart()
  fake.message(2001)
  await until(() => fake.rpc.filter(call => call.method === 'session/prompt').length === 2)
  await fake.answer(2)
  await until(() => fake.sends.length === 1)
  assert.match(JSON.stringify(fake.sends[0]), /Final answer 2/)
  assert(!JSON.stringify(fake.sends[0]).includes('Final answer 1'))
  assert.equal(fake.creates(), 1)
})


test('default runtime migrates model reasoning and capacity through verified SDK selection then resumes the child without recreating history', async context => {
  const fake = await fixture(context, { migrationChannel: true })
  await fake.configure()
  await fake.save('authorization', { version: 'migration-whitelist', mode: 'whitelist', grants: [] })
  await fake.start(); fake.message(2010)
  await until(() => fake.runtime().host()!.replies.get('private:123')?.status === 'waiting'
    && fake.runtime().executions()!.list().length > 0 && fake.rpc.some(call => call.method === 'session/prompt'))
  await fake.answer(1)
  await until(() => fake.sends.length === 1
    && fake.runtime().executions()!.list()[0]?.externalStatus === 'completed'
    && fake.runtime().executions()!.list()[0]?.isolated === false
    && fake.runtime().host()!.replies.get('private:123')?.status === 'suppressed'
    && fake.runtime().host()!.outbox.list().every(row => row.status === 'confirmed'))
  const original = fake.runtime().host()!.sessions.get('private:123')!
  const originalHistory = fake.runtime().host()!.history.snapshot('private:123', { afterSequence: 0 }).messages
  await fake.runtime().stop()
  await fake.save('providers', { providers: [{ id: 'provider', name: 'Provider', type: 'openai', enabled: true,
    baseUrl: 'https://model.example.test', apiKey: 'never-called-model-key', models: [{ id: 'model', name: 'Model' }, { id: 'next-model', name: 'Next' }] }] })
  await fake.save('plans', { activePlanId: 'daily', plans: [{ ...plan, model: 'next-model', reasoningEffort: 'high', contextLimits: { group: 65536, private: 131072 } }] })
  const prepared = await invoke(fake.routes(), 'GET', '/api/chat/sessions/migration')
  assert.equal(prepared.state, 'available', JSON.stringify(prepared))
  const bindings = prepared.bindings as Array<Record<string, unknown>>
  const selection = { provider: 'external-provider', model: 'next-model', reasoningEffort: 'high',
    contextLimits: { contextWindow: 131072, maxTokens: 16000, headroomTokens: 0 } }
  assert.deepEqual(bindings[0].targetSelection, selection)
  const configuration = await readNativeChatConfiguration(fake.directory)
  const migrated = await invoke(fake.routes(), 'POST', '/api/chat/sessions/migrate', { revisions: configuration.revisions, confirm: true,
    migrationId: prepared.migrationId, revision: prepared.revision })
  assert.equal(migrated.state, 'completed', JSON.stringify(migrated))
  assert.deepEqual(fake.rpc.find(call => call.method === 'bridgePlugin/forkWithPreset')!.request.targetSelection, selection)
  assert.equal(fake.rpc.filter(call => call.method === 'session/prompt').length, 1)
  await fake.start()
  const child = fake.runtime().host()!.sessions.get('private:123')!
  assert.notEqual(child.sessionId, original.sessionId)
  assert.equal(child.generation, original.generation + 1)
  assert.deepEqual(fake.runtime().host()!.history.snapshot('private:123', { afterSequence: 0 }).messages, originalHistory)
  assert.equal(fake.runtime().host()!.sessions.findBySessionId(original.sessionId), null)
  fake.message(2011)
  await until(() => fake.rpc.filter(call => call.method === 'session/prompt').length === 2)
  assert.equal(fake.rpc.filter(call => call.method === 'session/prompt').at(-1)!.request.sessionId, child.sessionId)
  await fake.reply('迁移后的新回答')
  fake.agentEvent('assistant/message', { turn: 1, message: { id: 'migrated-answer', role: 'assistant', content: [{ type: 'text', text: '迁移后的新回答' }] } })
  fake.agentEvent('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await until(() => fake.sends.length === 2)
  assert.match(JSON.stringify(fake.sends[1]), /迁移后的新回答/)
  assert.equal(fake.creates(), 1)
})


test('default management fork recovery preserves cancellation uncertainty and resumes only a new session after explicit restart', async context => {
  const fake = await fixture(context, { executionCheckpoint: true, migrationChannel: true, unknownCancel: true, unknownFork: true })
  await fake.configure()
  await fake.save('authorization', { version: 'recovery-cancel-explicit', grants: ['private:123', 'group:456'].map(conversationId => ({ conversationId, submitUses: 10, sendUses: 10, cancelUses: 1, expiresAt: null })) })
  await fake.save('execution', { policy: { ...DEFAULT_NATIVE_EXECUTION_POLICY, turnTimeoutMs: 1000, cancelTimeoutMs: 100, noticeEnabled: false } })
  await fake.start(); fake.message(2020)
  await until(() => fake.runtime().host()!.replies.get('private:123')?.status === 'waiting'
    && fake.runtime().executions()!.list().length > 0 && fake.rpc.some(call => call.method === 'session/prompt'))
  const execution = fake.runtime().executions()!.list()[0]!
  const original = execution.binding
  await awaitCondition(() => fake.runtime().executions()!.get(execution.id)?.cancelStatus === 'unknown',
    { timeoutMs: 3000, message: 'The actual cancellation response must remain unknown' })
  fake.confirmCheckpoint()
  const stillBlocked = await invoke(fake.routes(), 'POST', '/api/chat/executions/reconcile', { executionId: execution.id, confirm: true })
  assert.deepEqual(stillBlocked.missingReasons, ['execution_cancel_evidence_unknown'])
  const before = fake.rpc.filter(call => ['session/create','session/prompt','session/cancel'].includes(call.method)).length
  const plan = await invoke(fake.routes(), 'POST', '/api/chat/executions/recovery/preview', { executionId: execution.id })
  assert.equal(plan.state, 'available', JSON.stringify(plan))
  assert.equal(plan.restartRequired, true)
  const unknown = await invoke(fake.routes(), 'POST', '/api/chat/executions/recovery/commit', { executionId: execution.id, revision: plan.revision, confirm: true })
  assert.equal(unknown.state, 'unknown', JSON.stringify(unknown))
  assert.equal(fake.runtime().host()!.sessions.get('private:123')!.sessionId, original.sessionId)
  const inspectBefore = fake.rpc.filter(call => call.method === 'bridgePlugin/inspectMigration').length
  const observed = await invoke(fake.routes(), 'GET', '/api/chat/executions/recovery', null, new URLSearchParams({ id: execution.id }))
  assert.equal((observed.item as Record<string, unknown>).state, 'unknown')
  assert.equal(fake.rpc.filter(call => call.method === 'bridgePlugin/inspectMigration').length, inspectBefore)
  const completed = await invoke(fake.routes(), 'POST', '/api/chat/executions/recovery/commit', { executionId: execution.id, revision: plan.revision, confirm: true })
  assert.equal(completed.state, 'completed', JSON.stringify(completed))
  const child = fake.runtime().host()!.sessions.get('private:123')!
  assert.notEqual(child.sessionId, original.sessionId); assert.equal(child.generation, original.generation + 1)
  assert.equal(fake.runtime().executions()!.get(execution.id)?.cancelStatus, 'unknown')
  assert.equal(fake.runtime().executions()!.get(execution.id)?.isolated, true)
  assert.equal(fake.runtime().host()!.replies.get('private:123')?.status, 'suppressed')
  assert.equal(fake.rpc.filter(call => call.method === 'bridgePlugin/forkWithPreset').length, 1)
  assert.equal(fake.rpc.filter(call => call.method === 'bridgePlugin/inspectMigration').length, inspectBefore + 1)
  assert.equal(fake.rpc.filter(call => ['session/create','session/prompt','session/cancel'].includes(call.method)).length, before)
  assert.equal(fake.sends.length, 0)
  assert.equal((await fake.runtime().status()).chatReady, false)
  await fake.runtime().stop()
  const offlineBefore = fake.rpc.length
  const offline = await invoke(fake.routes(), 'GET', '/api/chat/executions/recovery', null, new URLSearchParams({ id: execution.id }))
  assert.equal((offline.item as Record<string, unknown>).state, 'completed')
  assert.equal(fake.rpc.length, offlineBefore)
  await fake.start()
  fake.message(2021)
  await until(() => fake.rpc.filter(call => call.method === 'session/prompt').length === 2)
  assert.equal(fake.rpc.filter(call => call.method === 'session/prompt').at(-1)!.request.sessionId, child.sessionId)
  await fake.answer(1)
  await until(() => fake.sends.length === 1)
  assert.equal(fake.creates(), 1)
})

function promptHostFacts(request: Record<string, unknown>): Record<string, unknown> {
  assert(Array.isArray(request.content))
  const text = request.content.map((part: unknown) => isRecord(part) && part.type === 'text' ? String(part.text) : '').join('')
  const line = text.split('\n').find(line => line.startsWith('{"schema":1,"conversationId"'))
  assert(line, 'host facts must reach the actual DSH request')
  const facts: unknown = JSON.parse(line.split('当前消息：')[0]!)
  assert(isRecord(facts))
  return facts
}

test('legacy tool permissions do not restrict whitelist tools and absent work backends remain unavailable', async context => {
  const fake = await fixture(context, { frameworkToolChannel: true })
  await fake.configure()
  const path = '/api/chat/tool-permissions'
  const initial = await invoke(fake.routes(), 'GET', path)
  const id = randomUUID()
  const granted = await invoke(fake.routes(), 'POST', path, { revision: initial.revision, action: 'grant', grant: {
    id, conversationId: 'private:123', capabilities: ['native.media.inspect'], maxUses: { 'native.media.inspect': 1 }, expiresAt: null } })
  await fake.start(); fake.message(2300)
  await until(() => fake.rpc.some(call => call.method === 'session/prompt')).catch(async error => { throw new Error(JSON.stringify((await fake.runtime().status()).ingress), { cause: error }) })
  const first = promptHostFacts(fake.rpc.find(call => call.method === 'session/prompt')!.request)
  assert(isRecord(first.tools) && Array.isArray(first.tools.tools))
  assert(first.tools.tools.some(tool => isRecord(tool) && tool.name === 'qbf_media_inspect'))
  assert(!first.tools.tools.some(tool => isRecord(tool) && tool.name === 'qbf_work_start'))
  assert(isRecord(first.output)); assert.equal(first.output.forwardAuthorized, true)
  await fake.answer(1); await until(() => fake.sends.length === 1)
  await invoke(fake.routes(), 'POST', path, { revision: granted.revision, action: 'revoke', id })
  fake.message(2301)
  await until(() => fake.rpc.filter(call => call.method === 'session/prompt').length === 2)
  const second = promptHostFacts(fake.rpc.filter(call => call.method === 'session/prompt')[1]!.request)
  assert(isRecord(second.tools)); assert.deepEqual(second.tools.tools, first.tools.tools)
  assert.equal(fake.runtime().workStatus().available, false)
  assert.equal(fake.creates(), 1)
})

test('native conversation doctor and versioned event routes expose blockers without submitting or revealing message content', async context => {
  const fake = await fixture(context)
  await fake.configure(); await fake.start()
  const before = fake.rpc.length
  const denied = await invoke(fake.routes(), 'GET', '/api/chat/diagnostics', null, new URLSearchParams({ conversationId: 'group:9999' }))
  assert.equal(denied.state, 'blocked')
  assert(Array.isArray(denied.checks) && denied.checks.some(check => isRecord(check) && check.code === 'conversation_not_allowed'))
  assert.equal(fake.rpc.length, before)
  fake.message(2400)
  await until(() => fake.rpc.some(call => call.method === 'session/prompt')).catch(async error => { throw new Error(JSON.stringify((await fake.runtime().status()).ingress), { cause: error }) })
  const busy = await invoke(fake.routes(), 'GET', '/api/chat/diagnostics', null, new URLSearchParams({ conversationId: 'private:123' }))
  assert.equal(busy.state, 'waiting')
  assert(isRecord(busy.context) && busy.context.source === 'active-session' && Number(busy.context.limit) > 0)
  const rows = fake.runtime().executions()!.list()
  assert.equal(rows.length, 1)
  const detail = await invoke(fake.routes(), 'GET', '/api/chat/executions', null, new URLSearchParams({ id: rows[0].id }))
  assert(isRecord(detail.item)); assert.equal(detail.item.id, rows[0].id); assert(!Object.hasOwn(detail.item, 'policy'))
  const events = await invoke(fake.routes(), 'GET', '/api/chat/events', null, new URLSearchParams({ conversationId: 'private:123' }))
  assert.equal(events.protocol, 'qbf.events/1'); assert(Array.isArray(events.events) && events.events.length > 0)
  assert(!JSON.stringify(events).includes('User message 2400'))
  const counts = fake.rpc.length
  const abort = new AbortController()
  const subscription = fake.runtime().subscribeEvents({ signal: abort.signal, after: fake.runtime().readEvents().nextCursor })
  abort.abort()
  await assert.rejects(subscription.next(), { code: 'EVENT_SUBSCRIPTION_ABORTED' })
  assert.equal(fake.rpc.length, counts)
})


test('two default native accounts isolate matching logical sessions grants and replies and reject a wrong verified identity', async context => {
  const first = await fixture(context, { accountScope: { protocolId: 'onebot', accountId: '999' }, protocolSelfId: 999 })
  const second = await fixture(context, { accountScope: { protocolId: 'onebot', accountId: '1000' }, protocolSelfId: 1000 })
  await first.configure(); await second.configure()
  await first.runtime().memoryService().createConfirmed({ scope: { kind: 'user', conversationId: 'private:123', userId: '123' },
    kind: 'memory', content: '账号甲的私有测试资料', tags: [], expiresAt: null }, { kind: 'operator' }, new AbortController().signal)
  assert.deepEqual(second.runtime().readMemory().entries, [])
  await first.start(); await second.start()
  first.message(2500); second.message(2500)
  await until(() => first.rpc.some(call => call.method === 'session/prompt') && second.rpc.some(call => call.method === 'session/prompt'))
  assert.equal(first.runtime().readMemory().entries[0]?.content, '账号甲的私有测试资料')
  assert.doesNotMatch(JSON.stringify(first.rpc.find(call => call.method === 'session/prompt')!.request), /账号甲的私有测试资料/)
  assert.doesNotMatch(JSON.stringify(second.rpc.find(call => call.method === 'session/prompt')!.request), /账号甲的私有测试资料/)
  await first.answer(1); await second.answer(1)
  await until(() => first.sends.length === 1 && second.sends.length === 1)
  const a = first.runtime().host()!; const b = second.runtime().host()!
  assert.deepEqual(a.accountScope, { protocolId: 'onebot', accountId: '999' })
  assert.deepEqual(b.accountScope, { protocolId: 'onebot', accountId: '1000' })
  assert.deepEqual(a.sessions.get('private:123')?.accountScope, a.accountScope)
  assert.deepEqual(b.sessions.get('private:123')?.accountScope, b.accountScope)
  assert.throws(() => a.policy.reserve({ featureId: 'agent-relay', conversationId: 'private:123', capability: 'messaging.send', accountScope: b.accountScope }), /account/i)
  const before = second.rpc.filter(call => call.method === 'session/prompt').length
  await first.runtime().stop(); second.message(2501)
  await until(() => second.rpc.filter(call => call.method === 'session/prompt').length === before + 1)
  assert.equal(second.creates(), 1)
  const wrong = await fixture(context, { accountScope: { protocolId: 'onebot', accountId: '1001' }, protocolSelfId: 999 })
  await wrong.configure()
  await assert.rejects(wrong.start(), { code: 'NATIVE_ACCOUNT_IDENTITY_MISMATCH' })
  assert.equal(wrong.creates(), 0); assert.equal(wrong.sends.length, 0)
})


test('native submit preparation can exceed six seconds within the original turn deadline', { timeout: 60_000 }, async context => {
  const controls = { deploymentDelayMs: 0, frameworkToolChannel: true }
  const f = await fixture(context, controls)
  await f.configure()
  await f.start()
  controls.deploymentDelayMs = 2200
  f.message(901)
  await awaitCondition(() => f.rpc.some(call => call.method === 'session/prompt'), { message: 'Preparation should reach the model within the turn deadline', timeoutMs: 35_000 })
  assert.equal(f.rpc.filter(call => call.method === 'session/prompt').length, 1)
  assert.notEqual((await f.runtime().status()).lastError, 'AGENT_SUBMIT_TIMEOUT_UNKNOWN')
  controls.deploymentDelayMs = 0
  f.answer()
  await until(() => f.sends.length > 0)
})


for (const ownerRequest of [true, false]) test(`external tool confirmation is automatic and restricted to the real owner: ${ownerRequest}`, async context => {
  const fake = await fixture(context)
  await fake.configure()
  if (!ownerRequest) await fake.save('access', { allow: ['private:123', 'group:456'], deny: [], owner: '456' })
  await fake.start(); fake.message(2900)
  await until(() => fake.rpc.some(call => call.method === 'session/prompt')).catch(async error => { throw new Error(JSON.stringify((await fake.runtime().status()).ingress), { cause: error }) })
  const sessionId = String(fake.rpc.find(call => call.method === 'session/prompt')!.request.sessionId)
  fake.interaction({ type: 'waterfall', event: 'approval/request', agentId: sessionId, eventId: 'external-tool',
    request: { toolName: 'workspace.write', reason: 'Synthetic write request' } })
  await until(() => fake.rpc.some(call => call.method === '$events/result'))
  const response = fake.rpc.find(call => call.method === '$events/result')!.request
  assert.match(JSON.stringify(response), ownerRequest ? /allowed-once/ : /rejected/)
  assert.equal(fake.sends.length, 0)
})

test('dense input reaches the inbox during slow submit and replaces an unsent reply with merged corrections', async context => {
  const fake = await fixture(context, { holdPrompt: true })
  await fake.configure(); await fake.start()
  const prompts = () => fake.rpc.filter(item => item.method === 'session/prompt')
  const message = (id: number, text: string) => fake.message(id, { time: Math.floor(Date.now() / 1000),
    message: [{ type: 'text', data: { text } }] })
  const release = () => {
    const held = fake.heldPrompt()!
    held.response.end(JSON.stringify({ type: 'server-response', rpcId: held.rpcId, result: { ok: true, value: { accepted: true } } }))
  }
  message(980, '苹果还是橘子，给我一个建议')
  await until(() => fake.heldPrompt() !== undefined)
  message(981, '不要酸的')
  message(982, '改成苹果和香蕉里挑一个，预算二十')
  await until(() => fake.runtime().host()!.history.snapshot('private:123', { afterSequence: 0 }).messages.length === 3)
  assert.equal(prompts().length, 1, 'protocol intake must not wait for model acceptance')
  assert.equal(fake.runtime().inboxSummary().pending, 3)
  release()
  await until(() => fake.runtime().inboxSummary().pending === 2)
  await fake.answer(1)
  await until(() => prompts().length === 2)
  assert.equal(fake.sends.length, 0, 'old response is withheld before its first bubble')
  const content = JSON.stringify(prompts()[1]!.request.content)
  assert.match(content, /不要酸的/)
  assert.match(content, /苹果和香蕉/)
  assert.match(content, /unsentFor/)
  assert.match(content, /尚未发送/)
  assert.match(content, /direct/)
  release()
  await until(() => fake.runtime().inboxSummary().pending === 0)
  await fake.answer(2)
  await until(() => fake.sends.length === 1)
  assert.match(JSON.stringify(fake.sends), /Final answer 2/)
  assert.doesNotMatch(JSON.stringify(fake.sends), /Final answer 1/)
  message(983, '谢谢')
  await until(() => prompts().length === 3)
  assert.doesNotMatch(JSON.stringify(prompts()[2]!.request.content), /unsentFor/, 'delivery correction is consumed once')
  release()
  await until(() => fake.runtime().inboxSummary().pending === 0)
  await fake.answer(3)
  await until(() => fake.sends.length === 2)
})

test('dense group input keeps different senders separate and does not discard another persons reply', async context => {
  const fake = await fixture(context)
  await fake.configure(); await fake.start()
  const prompts = () => fake.rpc.filter(item => item.method === 'session/prompt')
  const message = (id: number, userId: number, text: string) => fake.message(id, { time: Math.floor(Date.now() / 1000),
    message_type: 'group', group_id: 456, user_id: userId,
    message: [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text } }] })
  message(990, 123, '先回答我这个问题')
  await until(() => prompts().length === 1)
  message(991, 789, '我也有另一个问题')
  await until(() => fake.runtime().host()!.history.snapshot('group:456', { afterSequence: 0 }).messages.length === 2)
  await fake.answer(1)
  await until(() => fake.sends.length === 1 && prompts().length === 2)
  const content = JSON.stringify(prompts()[1]!.request.content)
  assert.match(content, /senderIsConfiguredOwner\\\":false/)
  assert.doesNotMatch(content, /unsentFor/)
  await fake.answer(2)
  await until(() => fake.sends.length === 2)
})

for (const finalKind of ['none', 'text', 'invalid-silent']) test(`explicit reply contract: ${finalKind} final stays silent and settles its watchdog`, async context => {
  const fake = await fixture(context)
  await fake.configure()
  await fake.save('execution', { policy: { ...DEFAULT_NATIVE_EXECUTION_POLICY, turnTimeoutMs: 1000, cancelOnTimeout: false } })
  await fake.start(); fake.message(3001)
  await until(() => fake.rpc.some(call => call.method === 'session/prompt')).catch(async error => { throw new Error(JSON.stringify((await fake.runtime().status()).ingress), { cause: error }) })
  const host = fake.runtime().host()!
  assert.equal(host.replies.get('private:123')?.status, 'waiting')
  if (finalKind === 'none') fake.agentEvent('turn/end', { turn: 1, reason: { kind: 'completed' } })
  else if (finalKind === 'invalid-silent') {
    fake.agentEvent('assistant/message', { turn: 1, message: { id: 'legacy-silent', role: 'assistant', content: [{ type: 'text',
      text: JSON.stringify({ schema: 'qbf.reply/1', action: 'silent', reason: '用户要求不用回复' }) }] } })
    fake.agentEvent('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }
  else fake.rawFinal(1)
  await until(() => fake.runtime().executions()!.forConversation('private:123') === null && host.replies.get('private:123')?.status === 'suppressed')
  assert.equal(fake.sends.length, 0)
  assert.equal(host.history.snapshot('private:123', { afterSequence: 0 }).messages.filter(message => message.actor === 'assistant').length, 0)
  assert(fake.runtime().activity().items.some(item => item.summary === '本轮观察结束，未发言。'))
  assert(!fake.runtime().activity().items.some(item => item.level === 'warning'))
  const reader = createSqliteStore({ filename: join(fake.directory, 'native-chat.sqlite'), requireExisting: true })
  try {
    assert.equal(reader.list('native-chat.reply-decisions', { limit: 10 }).length, 1)
  } finally { reader.close() }
  fake.agentEvent('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await delay(1100)
  assert.equal(host.replies.metrics().expired, 0)
  assert.equal(fake.runtime().activity().items.filter(item => item.summary === '本轮观察结束，未发言。').length, 1)
  assert.equal(fake.sends.length, 0)
})

for (const conversation of ['private', 'group'] as const) test(`explicit reply contract: ${conversation} qbf_reply sends once and terminal final neither repeats nor times out`, async context => {
  const fake = await fixture(context)
  await fake.configure()
  await fake.save('execution', { policy: { ...DEFAULT_NATIVE_EXECUTION_POLICY, turnTimeoutMs: 4000, cancelOnTimeout: false } })
  await fake.start()
  const conversationId = conversation === 'group' ? 'group:456' : 'private:123'
  fake.message(3002, conversation === 'group' ? { message_type: 'group', group_id: 456, user_id: 789,
    message: [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: '请回复' } }] } : {})
  await until(() => fake.rpc.some(call => call.method === 'session/prompt')).catch(async error => { throw new Error(JSON.stringify((await fake.runtime().status()).ingress), { cause: error }) })
  const prompt = fake.rpc.find(call => call.method === 'session/prompt')!.request
  const sessionId = String(prompt.sessionId); const requestId = String(prompt.requestId)
  fake.toolCalls.push({ ticket: 'explicit-send', leaseId: fake.toolLeases.get(sessionId)!.leaseId,
    call: { id: 'explicit-send', name: 'qbf_reply', input: { content: '主动发出的唯一答复' }, sessionId, requestId,
      generation: 1, userMessageId: `user-${requestId}`, turn: 1, expiresAt: Date.now() + 10000 } })
  await until(() => fake.toolResults.has('explicit-send'))
  const result = fake.toolResults.get('explicit-send')!
  assert.equal(result.status, 'confirmed', JSON.stringify(result))
  assert(result.status === 'confirmed' && isRecord(result.value) && result.value.status === 'sent')
  assert.equal(fake.sends.length, 1)
  assert.equal(fake.runtime().host()!.replies.get(conversationId)?.status, 'waiting', 'a send tool is not a terminal model event')
  fake.rawFinal(1)
  await until(() => fake.runtime().host()!.replies.get(conversationId)?.status === 'suppressed')
  assert.equal(fake.runtime().executions()!.forConversation(conversationId), null)
  assert.equal(fake.runtime().host()!.deliveryForRequest(requestId), null, 'terminal releases delivery deduplication and attempted state')
  assert.equal(fake.sends.length, 1)
  assert.doesNotMatch(JSON.stringify(fake.sends), /Final answer|Tool narration/)
  assert.equal(fake.runtime().activity().items.some(item => item.summary === '本轮观察结束，未发言。'), false)
  await delay(4100)
  assert.equal(fake.runtime().host()!.replies.metrics().expired, 0)
  assert.equal(fake.sends.length, 1)
})

test('explicit reply contract: failed model terminal settles its exact watchdog without claiming silence or sending', async context => {
  const fake = await fixture(context)
  await fake.configure(); await fake.start(); fake.message(3003)
  await until(() => fake.rpc.some(call => call.method === 'session/prompt')).catch(async error => { throw new Error(JSON.stringify((await fake.runtime().status()).ingress), { cause: error }) })
  fake.agentEvent('turn/end', { turn: 1, reason: { kind: 'failed', error: { message: 'synthetic model failure' } } })
  await until(() => fake.runtime().executions()!.forConversation('private:123') === null)
  assert.equal(fake.runtime().host()!.replies.get('private:123')?.status, 'suppressed')
  assert.equal(fake.sends.length, 0)
  assert.equal(fake.runtime().activity().items.some(item => item.summary === '本轮观察结束，未发言。'), false)
})

for (const unknownSend of [false, true]) test(`host result feedback keeps the original model context and records its actual delivery (${unknownSend ? 'unknown' : 'confirmed'})`, async context => {
  const fake = await fixture(context, { unknownSend })
  await fake.configure(); await fake.start(); fake.message(3104)
  await until(() => fake.rpc.some(call => call.method === 'session/prompt'))
  fake.rawFinal(1)
  await until(() => fake.runtime().executions()!.forConversation('private:123') === null)
  const host = fake.runtime().host()!
  const binding = host.sessions.get('private:123')!
  const request = { binding, id: 'extension-result:one', presentation: 'reply' as const,
    content: [{ type: 'text' as const, text: 'Observed task failure: provider rejected the request. Narrate in the current persona.' }],
    signal: new AbortController().signal }
  assert.equal((await host.notifyAgent(request)).status, 'accepted')
  assert.equal(host.agentNotificationDelivery(binding, request.id), 'pending')
  const prompts = fake.rpc.filter(call => call.method === 'session/prompt')
  assert.equal(prompts.length, 2)
  assert.equal(prompts[1]!.request.sessionId, binding.sessionId)
  assert.equal(fake.sends.length, 0, 'the task error is model input, never a direct QQ notice')
  fake.agentEvent('assistant/message', { turn: 2, step: 0, message: { id: 'extension-result-final', role: 'assistant',
    content: [{ type: 'text', text: '抱歉，这次上游没给我图片，暂时画不出来啦。' }] } })
  fake.agentEvent('turn/end', { turn: 2, reason: { kind: 'completed' } })
  await until(() => host.agentNotificationDelivery(binding, request.id) !== 'pending')
  assert.equal(host.agentNotificationDelivery(binding, request.id), unknownSend ? 'unknown' : 'confirmed')
  assert.equal(fake.sends.length, 1)
  assert.match(JSON.stringify(fake.sends), /上游没给我图片/)
  assert.doesNotMatch(JSON.stringify(fake.sends), /Observed task failure/)
  assert.equal((await host.notifyAgent(request)).status, 'unknown')
  assert.equal(fake.rpc.filter(call => call.method === 'session/prompt').length, 2, 'a repeated notification is not resubmitted')
  await assert.rejects(host.notifyAgent({ ...request, content: [{ type: 'text', text: 'changed result' }] }), /cannot change/)
  await until(() => fake.runtime().executions()!.forConversation('private:123') === null)
  fake.message(3105)
  await until(() => fake.rpc.filter(call => call.method === 'session/prompt').length === 3)
  fake.rawFinal(3)
  await until(() => fake.runtime().executions()!.forConversation('private:123') === null)
  assert.equal(fake.sends.length, 1, 'a normal QQ turn still requires explicit reply')
})

test('explicit reply contract: host work feedback uses final narration while tool names and intermediate child text remain private', async context => {
  const fake = await fixture(context, { workChannel: true })
  await fake.configure(); await fake.start(); fake.message(3004)
  await until(() => fake.rpc.some(call => call.method === 'session/prompt')).catch(async error => { throw new Error(JSON.stringify((await fake.runtime().status()).ingress), { cause: error }) })
  const prompt = fake.rpc.find(call => call.method === 'session/prompt')!.request
  const sessionId = String(prompt.sessionId); const requestId = String(prompt.requestId)
  const leaseId = fake.toolLeases.get(sessionId)!.leaseId
  fake.toolCalls.push({ ticket: 'feedback-start', leaseId, call: { id: 'feedback-start', name: 'qbf_work_start',
    input: { task: '整理报告', context: '' }, sessionId, requestId, generation: 1,
    userMessageId: `user-${requestId}`, turn: 1, expiresAt: Date.now() + 10000 } })
  await until(() => fake.toolResults.has('feedback-start'))
  assert.equal(fake.toolResults.get('feedback-start')?.status, 'confirmed')
  const [id, work] = [...fake.works][0]
  fake.rawFinal(1)
  await until(() => fake.runtime().executions()!.forConversation('private:123') === null)
  assert.equal(fake.sends.length, 0)
  fake.works.set(id, { ...work, state: 'completed', result: { stopReason: 'completed', output: [
    { type: 'text', text: 'workspace.write succeeded; qbf_work_start internal log: 报告有三项结果。' } ] } })
  await until(() => fake.rpc.filter(call => call.method === 'session/prompt').length === 2)
  const feedback = fake.rpc.filter(call => call.method === 'session/prompt')[1]!.request
  const feedbackRequestId = String(feedback.requestId)
  const feedbackInput = JSON.stringify(feedback.content)
  assert.match(feedbackInput, /qbf.work-feedback\/1/)
  assert.match(feedbackInput, /宿主专用转述/)
  assert.match(feedbackInput, /不照搬助手的格式、工具名/)
  assert.equal(fake.sends.length, 0, 'raw child result is input to the narrator, never directly sent')
  fake.toolCalls.push({ ticket: 'feedback-forbidden-tool', leaseId, call: { id: 'feedback-forbidden-tool', name: 'qbf_reply',
    input: { content: 'must not send' }, sessionId, requestId: feedbackRequestId, generation: 1,
    userMessageId: `user-${feedbackRequestId}`, turn: 2, expiresAt: Date.now() + 10000 } })
  await until(() => fake.toolResults.has('feedback-forbidden-tool'))
  assert.equal(fake.toolResults.get('feedback-forbidden-tool')?.status, 'rejected')
  fake.agentEvent('assistant/message', { turn: 2, step: 0, message: { id: 'feedback-intermediate', role: 'assistant',
    content: [{ type: 'text', text: 'workspace.write internal progress' }, { type: 'tool-call', name: 'private-tool' }] } })
  fake.agentEvent('step/start', { turn: 2, step: 1 })
  await delay(40)
  assert.equal(fake.sends.length, 0)
  fake.agentEvent('assistant/message', { turn: 2, step: 1, message: { id: 'feedback-final', role: 'assistant',
    content: [{ type: 'text', text: '报告整理好了，一共有三项结果。' }] } })
  fake.agentEvent('turn/end', { turn: 2, reason: { kind: 'completed' } })
  await until(() => fake.runtime().readWork(id)?.delivery === 'confirmed')
  assert.equal(fake.sends.length, 1)
  assert.match(JSON.stringify(fake.sends), /报告整理好了/)
  assert.doesNotMatch(JSON.stringify(fake.sends), /workspace.write|qbf_work_start|private-tool|internal progress|must not send/)
  assert.equal(fake.runtime().host()!.replies.get('private:123')?.status, 'responded')
})

for (const sourceOwner of [false, true]) test(`queued source history boundary survives flood truncation without consuming later messages or mixing owner identity (${sourceOwner})`, async context => {
  let paused = false
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const bootstrap: LoadedNativeBootstrap = { metadata: { manifest: { id: 'queued-history-boundary', version: '1.0.0', apiVersion: 1 },
    codeFingerprint: 'f'.repeat(64), trust: 'trusted-operator-code', sandboxed: false, requiresSeparateAuthorization: true },
    create() { return { lifecycleHooks: [{ id: 'hold-original-source', checkpoint: 'message.admitted', kind: 'guard', timeoutMs: 5000,
      async run() { paused = true; await gate } }] } } }
  const fake = await fixture(context, { bootstrap })
  await fake.configure(); await fake.start()
  fake.message(4001, { time: Math.floor(Date.now() / 1000), user_id: sourceOwner ? 123 : 789,
    message_type: 'group', group_id: 456,
    message: [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: 'original-source-body' } }] })
  await until(() => paused)
  const host = fake.runtime().host()!
  const original = host.history.snapshot('group:456', { afterSequence: 0 }).messages[0]!
  assert.equal(original.sequence, 1)
  for (let index = 0; index < 110; index++) host.history.append('group:456', {
    id: `later-${index}`, actor: sourceOwner ? '789' : '123', receivedAt: Date.now(),
    content: [{ type: 'text', text: `later-body-${index} must remain unread by the old source` }] })
  assert.equal(host.history.snapshot('group:456', { afterSequence: 0 }).messages.some(message => message.id === original.id), false)
  release()
  await until(() => fake.rpc.some(call => call.method === 'session/prompt') && host.history.snapshot('group:456').readThrough === original.sequence)
  const prompt = fake.rpc.find(call => call.method === 'session/prompt')!.request
  function strings(value: unknown): string[] {
    return typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings)
      : isRecord(value) ? Object.values(value).flatMap(strings) : []
  }
  const texts = strings(prompt.content)
  const factsText = texts.find(text => text.startsWith('会话事实：\n'))
  assert(factsText)
  const facts: unknown = JSON.parse(factsText.slice('会话事实：\n'.length))
  assert(isRecord(facts) && isRecord(facts.unread))
  assert.equal(facts.senderId, sourceOwner ? '123' : '789')
  assert.equal(facts.senderIsConfiguredOwner, sourceOwner)
  assert.equal(facts.unread.through, original.sequence)
  assert.equal(facts.unread.partial, true)
  assert.equal(facts.historyTruncated, true)
  assert.match(texts.join('\n'), /original-source-body/)
  assert.doesNotMatch(texts.join('\n'), /later-body/)
  const unread = host.history.snapshot('group:456')
  assert.equal(unread.latestSequence, 111)
  assert.equal(unread.readThrough, 1)
  assert.equal(unread.messages.length, 100)
  assert(unread.messages.every(message => message.id.startsWith('later-')))
  assert.equal(fake.sends.length, 0)
})

for (const stopReason of ['completed', 'failed', 'running'] as const) test(stopReason === 'running'
  ? 'work feedback preserves current progress while its work is still running'
  : `work feedback suppresses in-flight stale progress after ${stopReason} and releases the pending final`, async context => {
  const fake = await fixture(context, { workChannel: true })
  await fake.configure(); await fake.start(); fake.message(5001)
  await until(() => fake.rpc.some(call => call.method === 'session/prompt')).catch(async error => { throw new Error(JSON.stringify((await fake.runtime().status()).ingress), { cause: error }) })
  const prompt = fake.rpc.find(call => call.method === 'session/prompt')!.request
  const sessionId = String(prompt.sessionId); const requestId = String(prompt.requestId)
  fake.toolCalls.push({ ticket: 'stale-progress-work', leaseId: fake.toolLeases.get(sessionId)!.leaseId,
    call: { id: 'stale-progress-work', name: 'qbf_work_start', input: { task: '整理一份报告', context: '' },
      sessionId, requestId, generation: 1, userMessageId: `user-${requestId}`, turn: 1, expiresAt: Date.now() + 10000 } })
  await until(() => fake.toolResults.has('stale-progress-work'))
  assert.equal(fake.toolResults.get('stale-progress-work')?.status, 'confirmed')
  const [id, work] = [...fake.works][0]
  fake.rawFinal(1)
  await until(() => fake.runtime().executions()!.forConversation('private:123') === null)
  fake.works.set(id, { ...work, progress: [{ id: 'assistant/message:seq:1', at: Date.now(), text: '正在检查第一份材料。' }] })
  await awaitCondition(() => fake.rpc.filter(call => call.method === 'session/prompt').length === 2,
    { timeoutMs: 6000, message: 'the progress narrator must be admitted before the work settles' })
  const progressPrompt = fake.rpc.filter(call => call.method === 'session/prompt')[1]!.request
  assert.match(JSON.stringify(progressPrompt.content), /正在检查第一份材料/)
  if (stopReason === 'running') {
    fake.agentEvent('assistant/message', { turn: 2, message: { id: 'current-progress', role: 'assistant',
      content: [{ type: 'text', text: '已检查第一份材料，接着核对其余两份。' }] } })
    fake.agentEvent('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await until(() => fake.sends.length === 1)
    assert.match(JSON.stringify(fake.sends), /已检查第一份材料/)
    assert.equal(fake.runtime().readWork(id)?.status, 'running')
    return
  }
  const finalText = stopReason === 'completed' ? '报告已经完成，共有三项结果。' : '材料缺失，报告未能完成。'
  fake.works.set(id, { ...work, state: 'completed', result: { stopReason, output: [{ type: 'text', text: finalText }] } })
  await until(() => fake.runtime().readWork(id)?.status === (stopReason === 'completed' ? 'completed' : 'failed'))
  assert.equal(fake.runtime().readWork(id)?.delivery, 'delivering')
  fake.agentEvent('assistant/message', { turn: 2, message: { id: 'obsolete-progress', role: 'assistant',
    content: [{ type: 'text', text: '我还在检查第一份材料，请再等一下。' }] } })
  fake.agentEvent('turn/end', { turn: 2, reason: { kind: 'completed' } })
  await until(() => fake.rpc.filter(call => call.method === 'session/prompt').length === 3)
  assert.equal(fake.sends.length, 0, 'settled work must not publish the old running progress')
  const finalPrompt = fake.rpc.filter(call => call.method === 'session/prompt')[2]!.request
  assert.match(JSON.stringify(finalPrompt.content), new RegExp(finalText))
  const reader = createSqliteStore({ filename: join(fake.directory, 'native-chat.sqlite'), requireExisting: true })
  try {
    const progress = reader.list('native-work.feedback', { limit: 10 }).find(row => isRecord(row.value) && row.value.final === false)
    assert(progress && isRecord(progress.value))
    assert.equal(progress.value.status, 'rejected', 'old narration is explicitly settled, allowing pending final feedback')
  } finally { reader.close() }
  fake.agentEvent('assistant/message', { turn: 3, message: { id: 'current-final', role: 'assistant',
    content: [{ type: 'text', text: finalText }] } })
  fake.agentEvent('turn/end', { turn: 3, reason: { kind: 'completed' } })
  await until(() => fake.runtime().readWork(id)?.delivery === 'confirmed')
  assert.equal(fake.sends.length, 1)
  assert.match(JSON.stringify(fake.sends), new RegExp(finalText))
  assert.doesNotMatch(JSON.stringify(fake.sends), /还在检查第一份材料/)
})

test('simulated QQ creates a durable task through model tools, reactivates the same session and deletes the temporary task', async context => {
  const fake = await fixture(context, { accountScope: { protocolId: 'onebot', accountId: '999' } })
  await fake.configure(); await fake.start()
  fake.message(78001, { message: [{ type: 'text', data: { text: '一秒后提醒我喝水，这是一条临时测试任务' } }] })
  await until(() => fake.rpc.some(call => call.method === 'session/prompt'))
  const prompt = fake.rpc.find(call => call.method === 'session/prompt')!.request
  const sessionId = String(prompt.sessionId)
  async function tool(id: string, name: string, input: JsonValue, turn: number) {
    const requestId = String(fake.rpc.filter(call => call.method === 'session/prompt')[turn - 1]!.request.requestId)
    const lease = fake.toolLeases.get(sessionId)!
    assert(lease.names.includes(name))
    fake.toolCalls.push({ ticket: id, leaseId: lease.leaseId, call: { id, name, input, sessionId, requestId,
      generation: lease.generation, userMessageId: `user-${requestId}`, turn, expiresAt: Date.now() + 10000 } })
    await until(() => fake.toolResults.has(id))
    const result = fake.toolResults.get(id)!
    assert.equal(result.status, 'confirmed', JSON.stringify(result))
    return result
  }
  const created = await tool('create-temporary', 'qbf_task_create', { title: '临时喝水提醒', instruction: '到点提醒原会话喝水',
    condition: { kind: 'delay', delayMs: 1000 }, executor: 'conversation', deadlineAt: Date.now() + 60000, context: {}, maxSteps: 4 }, 1)
  assert(created.status === 'confirmed' && isRecord(created.value) && typeof created.value.id === 'string')
  const id = created.value.id
  assert.equal(fake.runtime().readConversationTasks().items[0]?.id, id)
  fake.rawFinal(1)
  await until(() => fake.rpc.filter(call => call.method === 'session/prompt').length === 2)
  const activation = fake.rpc.filter(call => call.method === 'session/prompt')[1]!.request
  assert.equal(activation.sessionId, sessionId)
  assert.match(JSON.stringify(activation.content), /到点提醒原会话喝水/)
  assert.equal(fake.creates(), 1)
  await tool('save-task-result', 'qbf_task_continue', { result: '已提醒喝水', checkpoint: { reminded: true } }, 2)
  const reply = await fake.reply('到时间了，喝点水吧', 2)
  assert.equal(reply.status, 'confirmed', JSON.stringify(reply))
  fake.rawFinal(2)
  await until(() => fake.runtime().readConversationTasks().items[0]?.state === 'completed')
  assert.deepEqual(fake.runtime().readConversationTasks().items[0]?.checkpoint, { reminded: true })
  assert.equal(fake.sends.length, 1)
  fake.message(78002, { message: [{ type: 'text', data: { text: '删除刚才的临时任务' } }] })
  await until(() => fake.rpc.filter(call => call.method === 'session/prompt').length === 3)
  const task = fake.runtime().readConversationTasks().items[0]!
  await tool('delete-temporary', 'qbf_task_control', { id, revision: task.revision, action: 'delete' }, 3)
  assert.equal(fake.runtime().readConversationTasks().items.length, 0)
  fake.rawFinal(3)
})
