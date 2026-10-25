import assert from 'node:assert/strict'
import test from 'node:test'
import { readdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { createNativeChatGatewayFixture, nativeGatewayFixtureObject as object, nativeGatewayFixtureUntil as until } from './fixtures/native-chat-gateway.ts'
import { parseNativeAccountsSnapshot } from '../src/contracts/native-accounts.ts'

test('default gateway HTTP mounts two isolated account bundles, verifies explicit legacy adoption, and scopes real protocol starts and stops', { timeout: 40_000 }, async t => {
  const fixture = await createNativeChatGatewayFixture(t, { realCli: false })
  await writeFile(fixture.bootstrapFile, "export default {manifest:{id:'account-test',version:'1.0.0',apiVersion:1},create(){return {}}}", { mode: 0o600 })
  const { api: rawApi, save, launch, directory, base, profilePath, credentialsPath, onebots, calls, controls } = fixture
  const api = rawApi
  const otherSockets = new Set<WebSocket>()
  const wire = new WebSocketServer({ noServer: true })
  const other = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer onebot-http-only')
    response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 888 } }))
  })
  other.on('upgrade', (request, socket, head) => wire.handleUpgrade(request, socket, head, connection => {
    otherSockets.add(connection); connection.once('close', () => otherSockets.delete(connection))
    connection.on('message', raw => { const request = object(JSON.parse(String(raw))); connection.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data: { user_id: 888 } })) })
  }))
  await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve))
  const address = other.address(); assert(address && typeof address !== 'string')
  const otherBase = `http://127.0.0.1:${address.port}`
  t.after(async () => { for (const socket of wire.clients) socket.terminate(); wire.close(); other.closeAllConnections(); other.close() })
  await launch()
  let accounts = await api('/api/accounts'); assert(parseNativeAccountsSnapshot(accounts)); assert.equal(onebots.size, 0); assert.equal(otherSockets.size, 0)
  accounts = await api('/api/accounts', { action: 'create', revision: accounts.revision, label: 'Second', accountScope: { protocolId: 'onebot', accountId: '888' } })
  const secondId = String(object((accounts.accounts as unknown[])[0]).id)
  const secondDirectory = join(directory, 'runtime', 'accounts', secondId)
  const files = await readdir(secondDirectory)
  const dispatch = (id: string, path: string, body?: Record<string, unknown>, expected = 200) => api(`/api/accounts/dispatch?${new URLSearchParams({ account: id, path })}`, body, expected)
  for (const path of ['plans', 'providers', 'personas', 'access', 'adapters', 'status', 'features']) await dispatch(secondId, `/api/chat/${path}`)
  assert.deepEqual(await readdir(secondDirectory), files); assert.equal(otherSockets.size, 0); assert.equal(controls.creates, 0)
  await dispatch(secondId, '/api/settings', undefined, 400)
  await dispatch(secondId, '/api/chat/never-registered', undefined, 404)
  await api('/api/accounts', { action: 'start', id: secondId, revision: '0'.repeat(64), revisions: object(await dispatch(secondId, '/api/chat/runtime')).revisions }, 409)
  const configure = async (save: (name: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>, protocolBase: string) => {
    await save('personas', { personas: [{ id: 'native', name: 'Native', identity: 'Account test.', style: 'Brief.' }] })
    await save('providers', { providers: [{ id: 'provider', name: 'Provider', enabled: true, type: 'openai', baseUrl: 'https://never-called.example.test', apiKey: 'private-account-test-key', models: [{ id: 'model', name: 'Model' }] }] })
    await save('plans', { activePlanId: 'daily', plans: [{ id: 'daily', name: 'Daily', description: '', instructions: 'Account test.', personaId: 'native', provider: 'provider', model: 'model', reasoningEffort: 'off', contextLimits: { group: 100_000, private: 120_000 } }] })
    await save('access', { allow: ['private:123'], deny: [], owner: '123' })
    await save('adapters', { adapters: { onebotHttp: { enabled: true, endpoint: `${protocolBase}/onebot`, secret: 'onebot-http-only' }, onebotWs: { enabled: true, endpoint: `${protocolBase.replace('http:', 'ws:')}/onebot-ws`, secret: 'onebot-ws-only' }, dshAgent: { enabled: true, endpoint: `${base}/dsh`, auth: 'dsh-fixture-only' } } })
    await save('authorization', { version: '1', grants: [{ conversationId: 'private:123', submitUses: 20, sendUses: 20, expiresAt: null }] })
    await save('deployment', { deployment: { target: { profilePath, credentialsPath, schemaVersion: '0.2.1-rc.2' }, modelSettings: { contextWindow: 200_000, maxTokens: 8000, reasoningEfforts: false }, namespace: 'shared' } })
  }
  await configure(save, base)
  let preview = await api('/api/accounts', { action: 'preview-legacy-adoption', accountScope: { protocolId: 'onebot', accountId: '998' } })
  await api('/api/accounts', { action: 'adopt-legacy', preview, label: 'Wrong identity' }, 503)
  assert.equal((await api('/api/accounts')).accounts instanceof Array, true)
  preview = await api('/api/accounts', { action: 'preview-legacy-adoption', accountScope: { protocolId: 'onebot', accountId: '999' } })
  accounts = await api('/api/accounts', { action: 'adopt-legacy', preview, label: 'Original' })
  const original = (accounts.accounts as unknown[]).map(object).find(entry => entry.source === 'legacy-adopted'); assert(original)
  const firstId = String(original.id)
  assert.equal(object(await dispatch(firstId, '/api/chat/access')).owner, '123')
  const accessBefore = await dispatch(secondId, '/api/chat/access'); assert.deepEqual(accessBefore.allow, [])
  const saveSecond = async (name: string, body: Record<string, unknown>) => {
    const prior = await dispatch(secondId, `/api/chat/${name}`)
    return dispatch(secondId, `/api/chat/${name}`, { revision: prior.revision, ...body })
  }
  await configure(saveSecond, otherBase)
  for (const id of [firstId, secondId]) {
    const status = await dispatch(id, '/api/chat/runtime')
    const prepared = await dispatch(id, '/api/chat/deployment/prepare', { revisions: status.revisions })
    assert.equal(prepared.state, 'prepared')
    assert.equal((await dispatch(id, '/api/chat/deployment/apply', { revisions: status.revisions, targetRevision: prepared.targetRevision })).state, 'verified')
  }
  for (const id of [firstId, secondId]) {
    accounts = await api('/api/accounts')
    const status = await dispatch(id, '/api/chat/runtime')
    accounts = await api('/api/accounts', { action: 'start', id, revision: accounts.revision, revisions: status.revisions })
    assert.equal((accounts.accounts as unknown[]).map(object).find(entry => entry.id === id)?.state, 'running')
  }
  assert.equal((await dispatch(firstId, '/api/chat/runtime')).chatReady, true)
  assert.equal((await dispatch(secondId, '/api/chat/runtime')).chatReady, true)
  await until(() => onebots.size === 1 && otherSockets.size === 1)
  accounts = await api('/api/accounts')
  await api('/api/accounts', { action: 'stop', id: firstId, revision: accounts.revision })
  assert.equal((await dispatch(firstId, '/api/chat/runtime')).state, 'stopped')
  assert.equal((await dispatch(secondId, '/api/chat/runtime')).state, 'running')
  await fixture.shutdown()
  await launch()
  await until(async () => (await dispatch(secondId, '/api/chat/runtime')).state === 'running', 10_000)
  assert.equal((await dispatch(firstId, '/api/chat/runtime')).state, 'stopped', 'an explicitly stopped adopted account cannot restore')
  await until(() => onebots.size === 0 && otherSockets.size === 1)
  assert.equal((await api('/api/chat/runtime', undefined, 409)).error, 'native_legacy_account_adopted', 'legacy root runtime cannot restore alongside its adopted account')
  assert.equal(calls.some(call => call.method === 'session/prompt'), false, 'account controls cannot manufacture a chat prompt')
  accounts = await api('/api/accounts')
  await api('/api/accounts', { action: 'stop', id: secondId, revision: accounts.revision })
  assert.equal((await dispatch(secondId, '/api/chat/runtime')).state, 'stopped')
})
