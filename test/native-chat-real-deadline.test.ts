import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { createNativeChatGatewayFixture, nativeGatewayFixtureObject as object,
  nativeGatewayFixtureUntil as until } from './fixtures/native-chat-gateway.ts'

test('explicit CLI-native sixty-second deadline expires despite real stream progress and another conversation remains usable',
  { timeout: 80_000 }, async context => {
    const fixture = await createNativeChatGatewayFixture(context)
    await fixture.launch()
    const { save, api, runtime, start, inbound, event } = fixture
    const execution = await api('/api/chat/execution')
    assert.equal(object(execution.policy).turnTimeoutMs, 120_000)
    await save('execution', { policy: { ...object(execution.policy), turnTimeoutMs: 60_000, noticeEnabled: true } })
    await save('personas', { personas: [{ id: 'deadline', name: 'Deadline', identity: 'Local fixture identity.', style: 'Concise.' }] })
    await save('providers', { providers: [{ id: 'provider', name: 'Provider', enabled: true, type: 'openai',
      baseUrl: 'https://never-called.example.test', apiKey: 'never-networked-local-fixture', models: [{ id: 'model', name: 'Model' }] }] })
    await save('plans', { activePlanId: 'daily', plans: [{ id: 'daily', name: 'Daily', description: '',
      instructions: 'Local fake deadline test.', personaId: 'deadline', provider: 'provider', model: 'model', reasoningEffort: 'off',
      contextLimits: { group: 100_000, private: 100_000 } }] })
    await save('access', { allow: ['private:123', 'group:456'], deny: [], owner: null })
    await save('adapters', { adapters: {
      onebotHttp: { enabled: true, endpoint: `${fixture.base}/onebot`, secret: 'onebot-http-only' },
      onebotWs: { enabled: true, endpoint: `${fixture.base.replace('http:', 'ws:')}/onebot-ws`, secret: 'onebot-ws-only' },
      dshAgent: { enabled: true, endpoint: `${fixture.base}/dsh`, auth: 'dsh-fixture-only' }
    } })
    await save('authorization', { version: '1', grants: ['private:123', 'group:456'].map(conversationId => ({
      conversationId, submitUses: 5, sendUses: 5, expiresAt: null
    })) })
    await save('deployment', { deployment: { target: { profilePath: fixture.profilePath, credentialsPath: fixture.credentialsPath,
      schemaVersion: '0.2.1-rc.2' }, modelSettings: { contextWindow: 128_000, maxTokens: 4_096, reasoningEfforts: false }, namespace: 'deadline' } })
    const revisions = (await runtime()).revisions
    const prepared = await api('/api/chat/deployment/prepare', { revisions })
    await api('/api/chat/deployment/apply', { revisions, targetRevision: prepared.targetRevision })
    assert.equal((await start()).modelExecutionVerified, false)
    const began = performance.now()
    inbound(1)
    await until(() => fixture.calls.some(call => call.method === 'session/prompt'))
    const firstPage = await api('/api/chat/executions')
    const original = object((firstPage.items as unknown[])[0])
    assert.equal(Number(original.deadlineAt) - Number(original.admittedAt), 60_000)
    const progress = setInterval(() => event('step/start', { turn: 1, step: 1 }), 500)
    context.after(() => clearInterval(progress))
    await until(() => fixture.sends.length === 1, 65_000)
    clearInterval(progress)
    assert(performance.now() - began >= 59_000)
    const expiredPage = await api('/api/chat/executions')
    const expired = object((expiredPage.items as unknown[])[0])
    assert.equal(expired.deadlineAt, original.deadlineAt)
    assert.equal(expired.deadlineReached, true)
    assert.equal(expired.status, 'timed-out')
    assert.equal(expired.isolated, true)
    assert.equal(expired.cancelStatus, 'rejected')
    assert.equal(fixture.calls.filter(call => call.method === 'session/cancel').length, 0)
    inbound(2)
    await delay(100)
    assert.equal(fixture.calls.filter(call => call.method === 'session/prompt').length, 1)
    inbound(3, { message_type: 'group', group_id: 456, message: [
      { type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: 'An independent explicit new request.' } }
    ] })
    await until(() => fixture.calls.filter(call => call.method === 'session/prompt').length === 2)
    event('assistant/message', { turn: 1, message: { id: 'independent-final', content: [{ type: 'text', text: 'Independent result.' }] } })
    event('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await until(() => fixture.sends.length === 2)
    assert.equal(fixture.controls.creates, 2)
    assert.equal(fixture.sendActions[1], '/onebot/send_group_msg')
    const journal = await api('/api/chat/executions')
    const rows = (journal.items as unknown[]).map(object)
    assert.equal(rows.find(row => row.id === original.id)?.isolated, true)
    assert.equal(rows.find(row => object(row.binding).conversationId === 'group:456')?.status, 'completed')
    assert.equal(fixture.calls.filter(call => call.method === 'session/prompt').length, 2)
    await api('/api/chat/runtime/stop', {})
  })
