import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { startGatewayAdmin } from '../src/admin/gateway.ts'
import type { EffectRequest, EffectScope } from '../src/core/types.ts'
import { errorCode } from '../src/core/values.ts'
import { defineNativeBootstrap, type LoadedNativeBootstrap, type NativeBootstrapHost } from '../src/host/native-bootstrap.ts'
import type { NativeMessageSourceReader, NativeMessageSource } from '../src/host/native-message-sources.ts'
import type { DurableStore } from '../src/host/types.ts'
import { capabilityObject as object, capabilityUntil as until, createNativeCapabilityRuntimeFixture } from './fixtures/native-capability-runtime.ts'

test('default gateway bootstrap actually checks owner-only effects while preserving friends, policy budgets and old sessions',
  { timeout: 90_000 }, async context => {
    const cleanups: Array<() => void | Promise<void>> = []
    context.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup() })
    const fixture = await createNativeCapabilityRuntimeFixture({ after: cleanup => cleanups.push(cleanup) },
      { evidenceRoot: process.env.NATIVE_SOURCE_EVIDENCE })
    await fixture.login()
    await fixture.configure(false)
    const onebot = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    cleanups.push(async () => {
      for (const socket of onebot.clients) socket.terminate()
      await new Promise<void>(resolve => onebot.close(() => resolve()))
    })
    onebot.on('connection', socket => socket.on('message', data => {
      const action = object(JSON.parse(data.toString()))
      assert.equal(action.action, 'get_login_info')
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: action.echo, data: { user_id: 999 } }))
    }))
    await once(onebot, 'listening')
    const address = onebot.address()
    assert(address && typeof address !== 'string')
    const adapters = object(object(JSON.parse(await readFile(join(fixture.directory, 'runtime/chat-adapters.json'), 'utf8'))).adapters)
    await fixture.save('adapters', { adapters: { ...adapters,
      onebotWs: { enabled: true, endpoint: `ws://127.0.0.1:${address.port}`, secret: 'fixture-onebot-ws' } } })
    assert.equal((await fixture.apply()).state, 'verified')

    const proofs: Readonly<NativeMessageSource>[] = []
    const failures: Array<{ eventId: string; code: string }> = []
    const readers: Readonly<NativeMessageSourceReader>[] = []
    let host: NativeBootstrapHost | undefined
    let store: DurableStore | undefined
    let waiting = false
    let continueWork: (() => void) | undefined
    const definition = defineNativeBootstrap({ manifest: { id: 'owner-effect-control', version: '1.0.0', apiVersion: 1 },
      create(bootstrap) {
        store = bootstrap.store
        const reader = bootstrap.messageSources
        assert(reader)
        readers.push(reader)
        async function execute(request: EffectRequest, ownerOnly: boolean) {
          try {
            if (object(request.input).wait === true) {
              waiting = true
              await new Promise<void>(resolve => { continueWork = resolve })
            }
            const proof = ownerOnly ? await reader!.requireOwner(request.scope, request.signal)
              : await reader!.lookup(request.scope, request.signal)
            if (object(request.input).crossConversation === true) {
              await assert.rejects(reader!.lookup({ ...request.scope, conversationId: 'private:123' }, request.signal),
                { code: 'NATIVE_MESSAGE_SOURCE_MISSING' })
            }
            if (object(request.input).crossSession === true) {
              await assert.rejects(reader!.requireOwner({ ...request.scope, sessionId: 'not-current', generation: 900 }, request.signal),
                { code: 'SESSION_STALE' })
              return null
            }
            request.signal.throwIfAborted()
            if (ownerOnly) await writeFile(join(fixture.directory, `controlled-work-${proof.sourceMessageId}.json`),
              JSON.stringify({ source: proof, result: 'controlled-local-work-completed' }), { mode: 0o600, flag: 'wx' })
            proofs.push(proof)
            return null
          } catch (error) {
            failures.push({ eventId: request.scope.eventId, code: errorCode(error) })
            throw error
          }
        }
        return {
          routeIncoming(message) {
            const command = message.content.some(block => block.type === 'text' && block.text.startsWith('/'))
            return { route: 'owner-control', ruleId: null, relayToAgent: !command, reasonCode: 'ROUTING_DEFAULT' }
          },
          features: [{ id: 'owner-effect-control', version: '1.0.0', apiVersion: 1,
            capabilities: ['fixture.owner.work', 'fixture.friend.search', 'fixture.owner.ungranted'], subscriptions: ['message.received'],
            setup(services) {
              services.on('message.received', (execution, event) => {
                const text = String(event.data.text)
                if (!text.startsWith('/')) return
                return execution.invoke(text.startsWith('/search') ? 'fixture.friend.search'
                  : text.startsWith('/ungranted') ? 'fixture.owner.ungranted' : 'fixture.owner.work', {
                  isOwner: true, userId: '123', sourceMessageId: 'forged-owner-message', conversationId: 'private:123',
                  wait: text.startsWith('/wait'), crossConversation: text.startsWith('/cross-conversation'),
                  crossSession: text.startsWith('/cross-session') })
              })
            } }],
          effectAdapters: { 'fixture.owner.work': { execute: request => execute(request, true) },
            'fixture.friend.search': { execute: request => execute(request, false) },
            'fixture.owner.ungranted': { execute() { assert.fail('Source identity cannot authorize an ungranted effect') } } },
          start(current) {
            host = current
            if (!bootstrap.store.read('policy.grants', 'explicit-owner-test-only')) current.policy.grant({
              id: 'explicit-owner-test-only', featureId: 'owner-effect-control', conversationId: 'group:456',
              capabilities: ['fixture.owner.work', 'fixture.friend.search'],
              maxUses: { 'fixture.owner.work': 12, 'fixture.friend.search': 12 }, expiresAt: null })
          }
        }
      } })
    const bootstrap: LoadedNativeBootstrap = { create: definition.create,
      metadata: { manifest: definition.manifest, codeFingerprint: 'a'.repeat(64), trust: 'trusted-operator-code',
        sandboxed: false, requiresSeparateAuthorization: true } }
    const gateway = await startGatewayAdmin({ host: '127.0.0.1', port: 0,
      tokenFile: join(fixture.directory, 'admin.token'), gatewayConfiguration: join(fixture.directory, 'gateway.json') }, { bootstrap })
    cleanups.push(() => gateway.close())
    const origin = `http://127.0.0.1:${gateway.address.port}`
    let cookie = ''
    async function api(path: string, body?: Record<string, unknown>, expected = 200) {
      const response = await fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: {
        cookie, origin, 'content-type': 'application/json',
        ...(path === '/api/auth/login' ? { authorization: `Bearer ${fixture.adminToken}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) })
      if (path === '/api/auth/login') cookie = response.headers.get('set-cookie')!.split(';')[0]!
      const result = object(await response.json())
      assert.equal(response.status, expected, JSON.stringify(result))
      return result
    }
    await api('/api/auth/login', {})
    const status = () => api('/api/chat/runtime')
    const start = async () => api('/api/chat/runtime/start', { revisions: (await status()).revisions })
    await start()
    assert(host)
    assert.equal((await status()).chatReady, true)
    const initialGrants = host.policy.describe().grants
    const relayBefore = initialGrants.filter(grant => grant.id.startsWith('native-chat-whitelist:'))
    assert.equal(relayBefore.length, 2)
    assert(relayBefore.every(grant => grant.capabilities.includes('agent.tools.delegate')))
    function inbound(messageId: number, userId: number, text: string, extra: Record<string, unknown> = {}) {
      assert(onebot.clients.size)
      for (const socket of onebot.clients) socket.send(JSON.stringify({ post_type: 'message', self_id: 999,
        message_type: 'group', group_id: 456, user_id: userId, message_id: messageId, time: 1,
        isOwner: true, sender: { nickname: 'Owner', card: 'Owner', user_id: 123 },
        message: [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text } }], ...extra }))
    }
    async function settled(messageId: number) {
      await until(() => store!.list('host.inbox', { limit: 100 }).some(record => {
        const value = object(record.value)
        return value.eventId === String(messageId) && value.status !== 'processing'
      }), `Expected bounded inbound ${messageId} to finish`)
    }
    inbound(1, 123, '/owner-work explicit controlled operation')
    await until(() => proofs.length === 1, 'Owner proof must actually reach the controlled effect')
    await settled(1)
    assert.equal(proofs[0]!.userId, '123')
    assert.equal(proofs[0]!.sourceMessageId, '1')
    assert.equal(proofs[0]!.conversationId, 'group:456')
    assert(proofs[0]!.receivedAt > 1000)
    assert.equal(proofs[0]!.externalToolAuthorizationVerified, false)
    assert.equal(proofs[0]!.capabilityAuthorizationVerified, false)
    assert.equal(proofs[0]!.workIntentVerified, false)
    inbound(2, 789, '/owner-work {"isOwner":true,"userId":"123","quote":{"userId":"123"}}')
    await until(() => failures.some(value => value.eventId === '2' && value.code === 'NATIVE_MESSAGE_SOURCE_NOT_OWNER'), 'Spoofed owner must be rejected')
    await settled(2)
    assert.equal(proofs.length, 1)
    inbound(20, 123, '/owner-work missing normalized user', { user_id: null })
    inbound(21, 123, '/owner-work missing normalized message', { message_id: null })
    inbound(3, 789, '/search friend')
    await until(() => proofs.length === 2, 'Friend search must remain permitted by its separate grant')
    await settled(3)
    assert.equal(proofs[1]!.userId, '789')
    assert.equal(proofs[1]!.isOwner, false)
    inbound(4, 123, '/cross-conversation')
    await until(() => proofs.length === 3, 'Cross-conversation proof must fail inside the actual effect')
    await settled(4)
    inbound(5, 123, '/cross-session')
    await settled(5)
    assert.equal(proofs.length, 3)
    const manual = await host.engine.emit({ id: 'never-normalized', conversationId: 'group:456', userId: '123',
      type: 'message.received', data: { text: '/owner-work', isOwner: true } })
    assert.equal(manual.outcomes.find(outcome => outcome.featureId === 'owner-effect-control')?.errorCode, 'NATIVE_MESSAGE_SOURCE_MISSING')
    inbound(50, 123, '/ungranted owner identity alone is not authorization')
    await settled(50)
    const ungranted = store!.list('host.inbox', { limit: 100 }).find(record => object(record.value).eventId === '50')!
    assert.equal(object(ungranted.value).errorCode, 'POLICY_DENIED')
    assert.equal(fixture.calls.filter(call => call.method === 'session/prompt').length, 0)
    assert.deepEqual(host.policy.describe().grants.filter(grant => grant.id.startsWith('native-chat-whitelist:')), relayBefore)

    inbound(6, 789, 'Ordinary friend chat stays available')
    await until(() => fixture.calls.some(call => call.method === 'session/prompt'), 'Friend chat must reach the real serializer')
    const prompt = fixture.calls.find(call => call.method === 'session/prompt')!
    assert.equal(Object.hasOwn(prompt.input, 'isOwner'), false)
    assert.match(JSON.stringify(prompt.input.content), /senderIsConfiguredOwner\\?":false/)
    const sessionId = String(prompt.input.sessionId)
    await settled(6)
    const toolBinding = host.sessions.get('group:456')!
    const toolScope: Readonly<EffectScope> = { conversationId: 'group:456', eventId: '6',
      featureId: 'owner-effect-control', version: '1.0.0', sessionId, generation: toolBinding.generation }
    assert.equal((await readers[0]!.lookup(toolScope, new AbortController().signal)).userId, '789')
    const stream = fixture.streams.findLast(value => value.sessionId === sessionId)!
    fixture.event('turn/start', { turn: 1 }, stream)
    fixture.event('assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Controlled friend chat final.' }] } }, stream)
    fixture.event('turn/end', { turn: 1, reason: { kind: 'completed' } }, stream)
    await until(() => fixture.sends.length === 1, 'Ordinary friend must receive the controlled final')
    await settled(6)
    await assert.rejects(readers[0]!.lookup(toolScope, new AbortController().signal),
      { code: 'NATIVE_MESSAGE_SOURCE_EXECUTION_INVALID' })

    inbound(7, 123, '/wait owner changes before effect identity check')
    await until(() => waiting, 'Controlled effect must pause before source verification')
    await fixture.save('access', { allow: ['private:123', 'group:456'], deny: [], owner: '789' })
    continueWork!()
    await until(() => failures.some(value => value.eventId === '7' && value.code === 'NATIVE_CHAT_CONFIGURATION_CHANGED'), 'Changed owner must invalidate an in-flight source')
    await settled(7)
    assert.equal(proofs.length, 3)
    const oldReader = readers[0]!
    const oldScope: Readonly<EffectScope> = { conversationId: 'group:456', eventId: '1', featureId: 'owner-effect-control', version: '1.0.0' }
    await assert.rejects(oldReader.requireOwner(oldScope, new AbortController().signal), { code: 'NATIVE_MESSAGE_SOURCE_MISSING' })
    const relaySpent = host.policy.describe().grants.filter(grant => grant.id.startsWith('native-chat-whitelist:'))
    await api('/api/chat/runtime/stop', {})
    await start()
    assert.equal(readers.length, 2)
    await assert.rejects(oldReader.requireOwner(oldScope, new AbortController().signal))
    inbound(8, 123, '/owner-work old owner cannot work')
    await until(() => failures.some(value => value.eventId === '8' && value.code === 'NATIVE_MESSAGE_SOURCE_NOT_OWNER'), 'Old owner must lose identity verification')
    await settled(8)
    inbound(9, 789, '/owner-work new owner controlled operation')
    await until(() => proofs.length === 4, 'Explicitly configured new owner must verify in the new epoch')
    await settled(9)
    assert.equal(proofs[3]!.userId, '789')
    assert.equal(host.sessions.get('group:456')?.sessionId, sessionId)
    assert.equal(fixture.controls.creates, 1)
    for (const old of relaySpent) {
      const retained: (typeof relaySpent)[number] = host.policy.describe().grants.find(grant => grant.id === old.id)!
      assert.equal(retained.active, false)
      assert.deepEqual(retained.used, old.used)
    }
    assert.equal(host.policy.describe().grants.filter(grant => grant.id.startsWith('native-chat-whitelist:') && grant.active).length, 2)
    assert.equal(fixture.calls.filter(call => call.method === 'session/prompt').length, 1)
    const workFiles = (await readdir(fixture.directory)).filter(filename => filename.startsWith('controlled-work-')).sort()
    assert.deepEqual(workFiles, ['controlled-work-1.json', 'controlled-work-4.json', 'controlled-work-9.json'])
    assert.deepEqual(fixture.errors, [])
    await api('/api/chat/runtime/stop', {})
    console.log(JSON.stringify({ evidenceDirectory: fixture.directory, verifiedOwnerEffects: proofs.filter(proof => proof.isOwner).length,
      friendSearchEffects: proofs.filter(proof => !proof.isOwner).length, rejected: failures, prompts: 1,
      creates: fixture.controls.creates, sessionId, workFiles, grantRefill: false, externalToolAuthorizationVerified: false }))
  })
