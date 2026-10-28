import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { WebSocketServer, type WebSocket } from 'ws'
import { createNativeRuntimeRoutes, prepareNativeChatAuthorization, readNativeChatConfiguration } from '../src/admin/runtime.ts'
import type { AdminRoute } from '../src/admin/server.ts'
import type { JsonObject } from '../src/core/types.ts'
import type { ControlCommandDefinition } from '../src/host/control-commands.ts'
import type { LifecycleCheckpoint, LifecycleHookDefinition } from '../src/host/lifecycle-hooks.ts'
import { createNativeChatRuntime } from '../src/host/native-chat-runtime.ts'
import { buildChatSessionDefinition } from '../src/host/chat-plans.ts'
import { createDshClaimPluginFixture } from './fixtures/dsh-claim-plugin.ts'

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

async function until(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(5)
  }
  assert.fail(label)
}

async function route(routes: readonly AdminRoute[], method: 'GET' | 'POST', pathname: string,
  body: Record<string, unknown> | null = null) {
  const selected = routes.find(candidate => candidate.method === method && candidate.pathname === pathname)
  assert(selected)
  return object(await selected.handle({ body, query: new URLSearchParams(), signal: AbortSignal.timeout(3_000) }))
}

test('stopped native accepts trusted owner controls before chat allowlist, observes metadata and never invokes DSH',
  { timeout: 15_000 }, async context => {
    const directory = await mkdtemp(join(tmpdir(), 'native-control-hooks-'))
    context.after(() => rm(directory, { recursive: true, force: true }))
    const sockets = new WebSocketServer({ noServer: true })
    const onebots = new Set<WebSocket>()
    const httpPaths: string[] = []
    const sends: Array<Record<string, unknown>> = []
    const fixtureErrors: unknown[] = []
    let httpIdentityReads = 0
    const server = createServer(async (request, response) => {
      try {
        const path = new URL(request.url!, 'http://local.test').pathname
        httpPaths.push(path)
        assert.equal(request.headers.authorization, 'Bearer fixture-http-only')
        response.setHeader('content-type', 'application/json')
        if (path === '/onebot/get_login_info') {
          httpIdentityReads++
          response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 999 } }))
          return
        }
        assert.equal(path, '/onebot/send_group_msg')
        let body = ''
        for await (const chunk of request) body += String(chunk)
        sends.push(object(JSON.parse(body)))
        response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1000 + sends.length } }))
      } catch (error) {
        fixtureErrors.push(error)
        response.writeHead(500).end()
      }
    })
    server.on('upgrade', (request, socket, head) => {
      try {
        assert.equal(request.url, '/onebot-ws')
        assert.equal(request.headers.authorization, 'Bearer fixture-ws-only')
        sockets.handleUpgrade(request, socket, head, connection => {
          onebots.add(connection)
          connection.once('close', () => onebots.delete(connection))
          connection.on('message', data => {
            try {
              const action = object(JSON.parse(data.toString()))
              assert.equal(action.action, 'get_login_info')
              connection.send(JSON.stringify({ status: 'ok', retcode: 0, echo: action.echo, data: { user_id: 999 } }))
            } catch (error) { fixtureErrors.push(error) }
          })
        })
      } catch (error) { fixtureErrors.push(error); socket.destroy() }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    context.after(async () => {
      for (const socket of sockets.clients) socket.terminate()
      await new Promise<void>(resolve => sockets.close(() => resolve()))
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    })
    const address = server.address()
    assert(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    const routes = createNativeRuntimeRoutes({ directory })
    const save = async (name: string, value: Record<string, unknown>) => {
      const current = await route(routes, 'GET', `/api/chat/${name}`)
      return route(routes, 'POST', `/api/chat/${name}`, { revision: current.revision, ...value })
    }
    await save('access', { allow: [], deny: [], owner: '123' })
    await save('adapters', { adapters: {
      onebotHttp: { enabled: true, endpoint: `${base}/onebot`, secret: 'fixture-http-only' },
      onebotWs: { enabled: true, endpoint: `${base.replace('http:', 'ws:')}/onebot-ws`, secret: 'fixture-ws-only' },
      dshAgent: { enabled: false, endpoint: '', auth: '' }
    } })
    const handled: string[] = []
    const rejectedReply: string[] = []
    const observed: Readonly<JsonObject>[] = []
    const fixedReply = '离线管理指令已处理。'
    const commandText = '/fixture-control'
    const controlCommands: readonly ControlCommandDefinition[] = [{ id: 'fixture-control',
      matches: message => message.content.some(block => block.type === 'text' && block.text === commandText),
      replyTexts: [fixedReply],
      async handle({ message, signal, reply }) {
        signal.throwIfAborted()
        const current = await readNativeChatConfiguration(directory)
        if (message.userId !== current.access.owner) return
        handled.push(message.id)
        await reply(fixedReply)
      } }, { id: 'fixture-denied-reply',
      matches: message => message.content.some(block => block.type === 'text' && block.text === '/fixture-denied-reply'),
      replyTexts: [fixedReply],
      async handle({ message, reply }) {
        const current = await readNativeChatConfiguration(directory)
        if (message.userId !== current.access.owner) return
        try { await reply('undeclared-private-response') } catch { rejectedReply.push(message.id) }
      } }]
    const lifecycleHooks: readonly LifecycleHookDefinition[] = [{ id: 'fixture-normalized',
      checkpoint: 'message.normalized', kind: 'observe',
      run({ data }) {
        assert(Object.isFrozen(data))
        observed.push(data)
        throw new Error('private-hook-error-must-not-be-logged')
      } }]
    let deploymentReads = 0
    const runtime = createNativeChatRuntime({ directory, controlCommands, lifecycleHooks,
      loadConfiguration: () => readNativeChatConfiguration(directory),
      async resolveDeployment() { deploymentReads++; return { missingReasons: ['no-dsh-for-controls'], presetBindings: [] } } })
    context.after(() => runtime.close())
    const configuration = await readNativeChatConfiguration(directory)
    assert.deepEqual(configuration.access.allow, [])
    assert.equal(configuration.adapters.dshAgent.enabled, false)
    await runtime.adapterRuntime.connect!(configuration.adapters, AbortSignal.timeout(3_000))
    assert.equal((await runtime.adapterRuntime.connectionStatus!()).state, 'connected')
    assert.equal((await runtime.status()).state, 'stopped')

    function inbound(id: number, userId: number, text: string,
      segments: unknown[] = [{ type: 'text', data: { text } }]) {
      for (const socket of onebots) socket.send(JSON.stringify({ post_type: 'message', self_id: 999,
        message_type: 'group', group_id: 456, user_id: userId, message_id: id, time: Math.floor(Date.now() / 1000),
        message: segments, isOwner: true, sender: { nickname: '主人', user_id: 123 } }))
    }
    inbound(1, 123, commandText)
    await until(() => sends.length === 1, 'Unlisted group owner control must execute while native chat is stopped')
    assert.deepEqual(handled, ['1'])
    assert(httpIdentityReads > 0, 'Controlled replies must verify the real HTTP OneBot identity before sending')
    assert.deepEqual(rejectedReply, [])
    assert.equal(sends[0]!.group_id, 456)
    assert.deepEqual(sends[0]!.message, [{ type: 'text', data: { text: fixedReply } }])
    assert(observed.some(data => object(data.message).conversationId === 'group:456'))
    assert.equal(JSON.stringify(runtime.activity()).includes('private-hook-error-must-not-be-logged'), false)

    inbound(10, 123, '/fixture-denied-reply')
    inbound(2, 789, commandText)
    inbound(3, 999, commandText)
    inbound(4, 123, commandText, [{ type: 'forward', data: { id: 'forwarded-record' } },
      { type: 'text', data: { text: commandText } }])
    inbound(40, 123, commandText, [{ type: 'json', data: { data: '{"text":"forwarded-card"}' } },
      { type: 'text', data: { text: commandText } }])
    inbound(41, 123, commandText, [{ type: 'image', data: { file: 'ignored-image' } },
      { type: 'text', data: { text: commandText } }])
    inbound(5, 123, commandText, [{ type: 'reply', data: { id: '555' } },
      { type: 'text', data: { text: commandText } }])
    inbound(6, 123, '', [{ type: 'reply', data: { id: '555', text: commandText } }])
    inbound(7, 123, 'Ordinary text must not start a model while stopped')
    inbound(8, 123, commandText)
    await until(() => sends.length >= 3, 'Final owner command must drain prior rejected events in the OneBot callback queue')
    assert.deepEqual(handled, ['1', '5', '8'])
    assert.deepEqual(rejectedReply, ['10'])
    assert.equal(sends.length, 3)
    assert.equal(deploymentReads, 0)
    assert(httpPaths.every(path => path === '/onebot/get_login_info' || path === '/onebot/send_group_msg'))
    assert.equal(runtime.host(), undefined)
    assert.equal(runtime.executions(), undefined)
    assert.equal((await runtime.status()).state, 'stopped')
    const peers = [...onebots]
    await runtime.close()
    for (const socket of peers) if (socket.readyState === 1) socket.send(JSON.stringify({ post_type: 'message',
      self_id: 999, message_type: 'group', group_id: 456, user_id: 123, message_id: 9,
      message: [{ type: 'text', data: { text: commandText } }] }))
    await delay(40)
    assert.deepEqual(handled, ['1', '5', '8'])
    assert.equal(sends.length, 3)
    assert.deepEqual(fixtureErrors, [])
  })

test('running native hot-applies access with unchanged existing session and grant usage, then stops without disconnecting protocol',
  { timeout: 20_000 }, async context => {
    const directory = await mkdtemp(join(tmpdir(), 'native-hot-access-hooks-'))
    const wire = new WebSocketServer({ noServer: true })
    const plugin = createDshClaimPluginFixture()
    const errors: unknown[] = []
    const methods: string[] = []
    const phases: LifecycleCheckpoint[] = []
    let eventStreams = 0
    let runtime: ReturnType<typeof createNativeChatRuntime> | undefined
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url!, 'http://fixture.test')
        if (url.pathname === '/onebot/get_login_info') {
          assert.equal(request.headers.authorization, 'Bearer hot-http')
          response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 999 } }))
          return
        }
        if (url.pathname === '/dsh/connect') {
          assert.equal(url.searchParams.get('token'), 'hot-dsh')
          assert(['none', 'answer'].includes(url.searchParams.get('interactions')!))
          response.writeHead(302, { location: './api/remote.mux', 'set-cookie': 'hot_dsh=owner; HttpOnly' }).end()
          return
        }
        assert(url.pathname.startsWith('/dsh/api/'))
        assert.equal(request.headers.cookie, 'hot_dsh=owner')
        let body = ''
        for await (const chunk of request) body += String(chunk)
        const envelope = object(JSON.parse(body))
        const method = String(envelope.method)
        assert.equal(url.pathname, `/dsh/api/${method}`)
        methods.push(method)
        const args = object(object(envelope.payload).args)
        assert(method === 'settings/describe' || method === 'bridgePlugin/describe' || method === 'bridgePlugin/claimReceipts')
        const value = method === 'settings/describe' ? {} : plugin.invoke(method, object(args.request ?? args))
        response.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } }))
      } catch (error) { errors.push(error); response.writeHead(500).end() }
    })
    server.on('upgrade', (request, socket, head) => {
      try {
        assert(request.url === '/onebot-ws' || request.url === '/dsh/api/remote.mux')
        if (request.url === '/onebot-ws') assert.equal(request.headers.authorization, 'Bearer hot-ws')
        else assert.equal(request.headers.cookie, 'hot_dsh=owner')
        const onebot = request.url === '/onebot-ws'
        wire.handleUpgrade(request, socket, head, connection => connection.on('message', data => {
          try {
            const input = object(JSON.parse(data.toString()))
            if (onebot) {
              assert.equal(input.action, 'get_login_info')
              connection.send(JSON.stringify({ status: 'ok', retcode: 0, echo: input.echo, data: { user_id: 999 } }))
            } else if (input.type !== 'cancel') {
              assert.equal(input.endpoint, '$events')
              eventStreams++
              connection.send(JSON.stringify({ type: 'item', streamId: input.streamId,
                value: { type: 'ready', clientId: 'hot-access-events' } }))
            }
          } catch (error) { errors.push(error) }
        }))
      } catch (error) { errors.push(error); socket.destroy() }
    })
    context.after(async () => {
      for (const socket of wire.clients) socket.terminate()
      server.closeAllConnections()
      const timer = setTimeout(() => {
        for (const socket of wire.clients) socket.terminate()
        server.closeAllConnections()
      }, 1_000)
      try {
        await runtime?.close()
        await new Promise<void>(resolve => wire.close(() => resolve()))
        await new Promise<void>(resolve => server.close(() => resolve()))
      } finally { clearTimeout(timer); await rm(directory, { recursive: true, force: true }) }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    const routes = createNativeRuntimeRoutes({ directory })
    const save = async (name: string, value: Record<string, unknown>) => {
      const current = await route(routes, 'GET', `/api/chat/${name}`)
      return route(routes, 'POST', `/api/chat/${name}`, { revision: current.revision, ...value })
    }
    await save('personas', { personas: [{ id: 'hot-persona', name: 'Fixture', identity: 'Offline identity.', style: 'Concise.' }] })
    await save('providers', { providers: [{ id: 'hot-provider', name: 'Offline', type: 'openai', enabled: true,
      baseUrl: `${base}/never-model`, apiKey: 'synthetic-never-called', models: [{ id: 'hot-model', name: 'Fixture model' }] }] })
    await save('plans', { activePlanId: 'hot-plan', plans: [{ id: 'hot-plan', name: 'Fixture', description: '', instructions: 'Offline.',
      personaId: 'hot-persona', provider: 'hot-provider', model: 'hot-model', reasoningEffort: 'off',
      contextLimits: { group: 100_000, private: 120_000 } }] })
    await save('access', { allow: ['private:123', 'group:456'], deny: [], owner: '123' })
    await save('adapters', { adapters: {
      onebotHttp: { enabled: true, endpoint: `${base}/onebot`, secret: 'hot-http' },
      onebotWs: { enabled: true, endpoint: `${base.replace('http:', 'ws:')}/onebot-ws`, secret: 'hot-ws' },
      dshAgent: { enabled: true, endpoint: `${base}/dsh`, auth: 'hot-dsh' }
    } })
    await prepareNativeChatAuthorization(directory)
    const before = await readNativeChatConfiguration(directory)
    assert.equal(before.authorization.mode, 'whitelist')
    assert.deepEqual(before.authorization.grants, [])
    const lifecycleHooks: readonly LifecycleHookDefinition[] = (
      ['runtime.starting', 'runtime.ready', 'access.changed', 'runtime.stopping', 'runtime.stopped'] as const
    ).map(checkpoint => ({ id: `hot-${checkpoint}`, checkpoint, kind: 'observe', run({ checkpoint: phase }) { phases.push(phase) } }))
    runtime = createNativeChatRuntime({ directory, lifecycleHooks,
      prepareAuthorization: () => prepareNativeChatAuthorization(directory),
      loadConfiguration: () => readNativeChatConfiguration(directory),
      async resolveDeployment(configuration) {
        return { missingReasons: [], presetBindings: [{ agentPreset: 'fixture-deployed',
          definition: buildChatSessionDefinition(configuration.catalog.plans[0]!, configuration.personas[0]!) }] }
      } })
    await runtime.start(before.revisions, AbortSignal.timeout(5_000))
    assert.deepEqual(phases, ['runtime.starting', 'runtime.ready'])
    assert.equal(eventStreams, 1)
    assert.equal((await runtime.status()).chatReady, true)
    const host = runtime.host()!
    const binding = host.sessions.bind('private:123', 'synthetic-existing-session', 1)
    host.policy.begin(host.policy.reserve({ featureId: 'agent-relay', conversationId: 'private:123', capability: 'agent.submit' }))
    const queuedRemovedSend = host.policy.reserve({ featureId: 'agent-relay', conversationId: 'group:456', capability: 'messaging.send' })
    const grantsBefore = host.policy.describe().grants
    const unchanged = grantsBefore.find(grant => grant.conversationId === 'private:123')!
    const removed = grantsBefore.find(grant => grant.conversationId === 'group:456')!
    await save('access', { allow: ['private:123', 'group:789'], deny: ['group:456'], owner: '123' })
    const after = await readNativeChatConfiguration(directory)
    await runtime.applyAccessChange(before.revisions.access, after.revisions.access, AbortSignal.timeout(5_000))
    const status = await runtime.status()
    assert.equal(status.chatReady, true)
    assert.deepEqual(status.activeRevisions, after.revisions)
    assert.equal(status.missingReasons.includes('configuration_changed'), false)
    assert.deepEqual(host.sessions.get('private:123'), binding)
    const grantsAfter = host.policy.describe().grants
    assert.deepEqual(grantsAfter.find(grant => grant.id === unchanged.id), unchanged)
    assert.deepEqual(grantsAfter.find(grant => grant.id === removed.id), { ...removed, active: false })
    assert.throws(() => host.policy.begin(queuedRemovedSend), { code: 'GRANT_REVOKED' })
    assert.throws(() => host.policy.reserve({ featureId: 'agent-relay', conversationId: 'group:456', capability: 'agent.submit' }),
      { code: 'POLICY_DENIED' })
    const added = grantsAfter.find(grant => grant.conversationId === 'group:789')!
    assert(added.active)
    assert.equal(added.maxUses['agent.submit'], null)
    host.policy.begin(host.policy.reserve({ featureId: 'agent-relay', conversationId: 'group:789', capability: 'agent.submit' }))
    assert.equal(host.policy.describe().grants.find(grant => grant.id === added.id)!.used['agent.submit'], 1)
    await runtime.applyAccessChange(before.revisions.access, after.revisions.access, AbortSignal.timeout(5_000))
    assert.equal((await runtime.status()).chatReady, true)
    await runtime.stop()
    assert.deepEqual(phases, ['runtime.starting', 'runtime.ready', 'access.changed', 'access.changed', 'runtime.stopping', 'runtime.stopped'])
    assert.equal((await runtime.adapterRuntime.connectionStatus!()).state, 'connected')
    assert.equal((await runtime.status()).state, 'stopped')
    assert.equal(methods.includes('session/prompt'), false)
    assert.equal(methods.includes('session/create'), false)
    assert.deepEqual(errors, [])
  })
