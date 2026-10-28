import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { parseSessionSnapshot, parseUsageSnapshot } from '../web/lib/activity.ts'
import { parseUsageConversation, parseUsageRecent, parseUsageSeries } from '../web/lib/usage-details.ts'
import { parseExecutionJournalPage } from '../web/lib/execution-journal.ts'
import { awaitCondition } from './fixtures/await-condition.ts'

import { createNativeChatGatewayFixture, nativeGatewayFixtureObject as object, nativeGatewayFixtureUntil as until, useRealCli } from './fixtures/native-chat-gateway.ts'

type Value = Record<string, unknown>

test('CLI-admin subprocess default mount applies real fixture YAML then manually chats, records usage, restores and safely stops/times out',
  { timeout: useRealCli ? 240_000 : 40_000 }, async context => {
    const { directory, bootstrapFile, lifecycleFile, profilePath, credentialsPath, base,
      calls, sends, streams, selected, onebots, api, save, runtime, start, inbound, event, reply, launch, shutdown, controls } =
      await createNativeChatGatewayFixture(context)
    await launch()
    assert.equal((await runtime()).state, 'stopped')
    assert.equal(onebots.size, 0)
    assert.equal(calls.length, 0)
    assert.equal((await readFile(lifecycleFile, 'utf8')).trim(), 'loaded')
    assert.equal(object((await runtime()).bootstrap).state, 'not-started')
    await save('personas', { personas: [{ id: 'native', name: 'Native', identity: 'Fixture identity.', style: 'Concise.' }] })
    await save('providers', { providers: [{ id: 'provider', name: 'Provider', enabled: true, type: 'openai',
      baseUrl: 'https://never-called.example.test', apiKey: 'private-provider-never-networked', models: [{ id: 'model', name: 'Model' }] }] })
    await save('plans', { activePlanId: 'daily', plans: [{ id: 'daily', name: 'Daily', description: '',
      instructions: 'Fixture instructions.', personaId: 'native', provider: 'provider', model: 'model', reasoningEffort: 'off',
      contextLimits: { group: 100_000, private: 120_000 } }] })
    await save('access', { allow: ['private:123'], deny: [], owner: '123' })
    await save('adapters', { adapters: {
      onebotHttp: { enabled: true, endpoint: `${base}/onebot`, secret: 'onebot-http-only' },
      onebotWs: { enabled: true, endpoint: `${base.replace('http:', 'ws:')}/onebot-ws`, secret: 'onebot-ws-only' },
      dshAgent: { enabled: true, endpoint: `${base}/dsh`, auth: 'dsh-fixture-only' }
    } })
    await save('authorization', { version: '1', grants: [{ conversationId: 'private:123', submitUses: 20, sendUses: 20, expiresAt: null }] })
    await save('deployment', { deployment: { target: { profilePath, credentialsPath, schemaVersion: '0.2.1-rc.2' },
      modelSettings: { contextWindow: 200_000, maxTokens: 8_000, reasoningEfforts: false }, namespace: 'fixture' } })
    const revisions = (await runtime()).revisions
    const prepared = await api('/api/chat/deployment/prepare', { revisions })
    assert.equal(prepared.state, 'prepared')
    assert.equal(typeof prepared.targetRevision, 'string')
    await api('/api/chat/deployment/apply', { revisions }, 400)
    const applied = await api('/api/chat/deployment/apply', { revisions, targetRevision: prepared.targetRevision })
    assert.equal(applied.state, 'verified')
    assert.equal((await runtime()).canStart, true)
    assert.equal(controls.creates, 0)
    assert.equal((await runtime()).protocolConnected, true)
    assert.equal(onebots.size, 1)
    for (const source of ['env', 'project-env', 'user-env', 'local-file']) {
      controls.credentialSource = source
      await start(503)
      assert.equal((await runtime()).chatReady, false)
      assert.equal(controls.creates, 0)
    }
    controls.credentialSource = 'file'
    controls.liveCredentialsPath = join(directory, 'different-credentials.yml')
    await start(503)
    assert.equal((await runtime()).chatReady, false)
    assert.equal(controls.creates, 0)
    controls.liveCredentialsPath = credentialsPath
    const stale = { ...object(revisions), access: '0'.repeat(64) }
    await api('/api/chat/runtime/start', { revisions: stale }, 409)
    assert.equal(onebots.size, 1)
    assert.equal((await runtime()).chatReady, false)
    for (const status of [null, 'async', 'failed']) {
      controls.httpLoginStatus = status
      await start(503)
      const refused = await runtime()
      context.diagnostic(JSON.stringify({ case: 'http-login-refusal', responseStatus: status, lastError: refused.lastError,
        bootstrap: object(refused.bootstrap).state, canStart: refused.canStart }))
      assert.equal(refused.chatReady, false)
      assert.equal(refused.modelExecutionVerified, false)
      assert.equal(refused.lastError, 'NATIVE_CHAT_HTTP_IDENTITY_UNVERIFIED')
      assert.equal(refused.canStart, true)
      assert.equal(object(refused.bootstrap).state, 'stopped')
      assert.equal(controls.creates, 0)
      const history = await api('/api/chat/sessions', undefined, [200, 503])
      if (Object.hasOwn(history, 'error')) assert.equal(history.error, 'runtime_not_connected')
      else {
        assert.deepEqual(history.items, [])
        assert.equal(history.historyReadOnly, true)
        assert.equal(history.resetAvailable, false)
      }
    }
    controls.httpLoginStatus = 'ok'
    const started = await start()
    assert.equal(started.chatReady, true)
    assert.equal(started.modelExecutionVerified, false)
    assert.equal(started.credentialValueIdentityVerified, false)
    assert.equal(object(started.bootstrap).state, 'running')
    assert.equal(object(started.bootstrap).grantsCreatedByInstaller, false)
    assert.equal(object(started.bootstrap).mediaResolver, true)
    assert.equal(object(started.bootstrap).forwardConfigured, true)
    assert.equal(object(object(started.bootstrap).manifest).id, 'fixture-bootstrap')
    assert((await readFile(lifecycleFile, 'utf8')).includes('denied:POLICY_DENIED'))
    assert(!(await readFile(lifecycleFile, 'utf8')).includes('effect-ran'))
    await api('/api/chat/usage/pricing', { revision: null, prices: [{ provider: 'provider', model: 'model', currency: 'USD',
      inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1, cacheWritePerMillion: 1 }] })
    inbound(1)
    await until(() => calls.some(call => call.method === 'session/prompt'))
    assert.equal(controls.creates, 1)
    const modelRoute = selected.get('native-session-1')!
    event('turn/start', { turn: 1 })
    event('assistant/message', { turn: 1, step: 1, message: { source: { kind: 'model', ...modelRoute },
      content: [{ type: 'text', text: 'Private work prefix.' }, { type: 'tool-call', name: 'not-run' }] },
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 0, totalTokens: 18 } })
    event('step/start', { turn: 1, step: 2 })
    event('assistant/message', { turn: 1, step: 2, message: { id: 'final-1', source: { kind: 'model', ...modelRoute },
      content: [{ type: 'text', text: 'Only this final answer.' }, { type: 'reasoning', text: 'Private reasoning.' }] },
      usage: { inputTokens: 20, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 0, totalTokens: 33 } })
    await delay(60)
    assert.equal(sends.length, 0)
    await reply('Only this final answer.')
    event('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await until(() => sends.length === 1)
    await until(async () => (await api('/api/chat/usage')).records === 2)
    const usage = await api('/api/chat/usage')
    assert(parseUsageSnapshot(usage), 'Actual native summary must parse in the complete usage UI')
    assert.equal(usage.native, true)
    assert.equal(usage.source, 'chat-ledger')
    assert.equal(object(usage.totals).totalTokens, 51)
    assert.equal(object(usage.totals).reasoningTokens, null)
    assert.equal(object(usage.tokens).total, 51)
    assert.equal(usage.costComplete, true)
    const fullRecent = await api('/api/chat/usage/recent?limit=40')
    assert(parseUsageRecent(fullRecent), 'Actual native recent entries must parse in the usage UI')
    assert.equal(fullRecent.partial, false)
    assert.equal((await api('/api/chat/usage/series?bucketMs=60000')).partial, false)
    const fullSeries = await api('/api/chat/usage/series?hours=24&buckets=48')
    assert(parseUsageSeries(fullSeries), 'Actual native chart must parse in the complete usage UI')
    assert.equal(fullSeries.native, true)
    assert.equal((fullSeries.buckets as unknown[]).length, 48)
    assert.equal(object(fullSeries.totals).tokens, 51)
    const detail = await api('/api/chat/usage/turns?key=private%3A123&limit=200')
    assert(parseUsageConversation(detail, 'private:123'), 'Actual native per-turn detail must parse in the usage UI')
    assert.equal(detail.native, true)
    assert.equal((detail.turns as unknown[]).length, 1)
    const prices = await api('/api/chat/usage/pricing')
    await api('/api/chat/usage/pricing', { revision: null, prices: [] }, 409)
    await api('/api/chat/usage/pricing', { revision: prices.revision, prices: [] })
    assert.equal(object((await api('/api/chat/usage')).totals).cost, object(usage.totals).cost)
    assert(!JSON.stringify(sends).includes('prefix'))
    assert(!JSON.stringify(sends).includes('reasoning'))
    const sessions = await api('/api/chat/sessions')
    assert(parseSessionSnapshot(sessions), 'Actual durable sessions must parse in the sessions UI')
    const journal = await api('/api/chat/executions')
    assert(parseExecutionJournalPage(journal), 'Actual default CLI execution journal must parse in the sessions UI')
    assert.equal((journal.items as Value[])[0]?.status, 'completed')
    assert.equal(journal.manualCancelAvailable, false)
    const streamsBeforeRestart = streams.length
    const originalStream = streams.at(-1)!
    await shutdown()
    await launch()
    await until(() => onebots.size === 1)
    assert.equal((await runtime()).protocolConnected, true)
    let restoredState: Value = {}
    await awaitCondition(async () => { restoredState = await runtime(); return restoredState.chatReady === true
      && object(object(restoredState.lifecycle).restoration).state === 'restored' },
      { message: 'Saved running gateway must restore readiness', timeoutMs: 5_000, diagnostics: () => restoredState })
    assert.equal(object(object(restoredState.lifecycle).restoration).state, 'restored')
    assert.equal(object((await runtime()).bootstrap).state, 'running')
    const restoredHost = object((await runtime()).host)
    assert.equal(restoredHost.followedSessions, 0)
    assert.equal(restoredHost.unhealthyFollows, 0)
    assert.equal(streams.length, streamsBeforeRestart)
    assert.deepEqual((await api('/api/chat/sessions')).items, sessions.items)
    assert.equal((await api('/api/chat/usage')).records, 2)
    assert.equal(sends.length, 1)
    inbound(1)
    await delay(60)
    assert.equal(calls.filter(call => call.method === 'session/prompt').length, 1)
    assert.equal(controls.creates, 1)
    assert.equal(streams.length, streamsBeforeRestart)
    const duplicateHost = object((await runtime()).host)
    assert.equal(duplicateHost.followedSessions, 0)
    assert.equal(duplicateHost.unhealthyFollows, 0)
    inbound(2)
    await until(() => calls.filter(call => call.method === 'session/prompt').length === 2)
    assert.equal(streams.length, streamsBeforeRestart + 1)
    const currentStream = streams.at(-1)!
    assert.notEqual(currentStream, originalStream)
    assert.equal(currentStream.socket.readyState, 1)
    assert.equal(currentStream.sessionId, originalStream.sessionId)
    assert.equal(object((await runtime()).host).followedSessions, 1)
    assert.equal(controls.creates, 1)
    assert.equal((await api('/api/chat/usage')).records, 2)
    await until(async () => (await runtime()).chatReady === true)
    await api('/api/chat/runtime/stop', {})
    assert.equal(object((await runtime()).bootstrap).state, 'stopped')
    assert((await readFile(lifecycleFile, 'utf8')).includes('stop'))
    await api('/api/chat/adapters/disconnect', {})
    await until(() => onebots.size === 0)
    controls.holdLogin = true
    const previousLogins = controls.loginRequests
    const starting = start(503)
    await until(() => controls.loginRequests > previousLogins)
    await Promise.all([api('/api/chat/runtime/stop', {}), api('/api/chat/runtime/stop', {})])
    await starting
    assert.equal((await runtime()).state, 'stopped')
    assert.equal(sends.length, 1)
    const timeoutStart = await start(503)
    assert.equal(timeoutStart.error, 'native_chat_start_failed')
    assert.equal((await runtime()).chatReady, false)
    assert.equal(onebots.size, 0)
    controls.holdLogin = false
    controls.authFails = true
    await start(503)
    assert.equal((await runtime()).chatReady, false)
    assert.equal(controls.creates, 1)
    assert(!JSON.stringify(await runtime()).includes('private-provider-never-networked'))
  })
