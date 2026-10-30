import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Presets from '@deepseek-ai/dsh-agent-preset-registry'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import Registry from '@deepseek-ai/dsh-typert-registry'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type BridgePlugin from '../dist/index.js'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    'test-untrusted': { readonly kind: 'test-untrusted' }
  }
}

type PluginReplies = {
  describe: ReturnType<BridgePlugin['describe']>
  inspectScope: ReturnType<BridgePlugin['inspectScope']>
  claimReceipts: ReturnType<BridgePlugin['claimReceipts']>
}

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

function scopeNames(value: PluginReplies['inspectScope']): readonly string[] {
  assert(value.state === 'verified-scope')
  return value.names
}

function claimNextTurn(inbox: object, turn: number): void {
  assert('claim' in inbox && typeof inbox.claim === 'function')
  inbox.claim('next-turn', turn)
}

test('actual SDK loads entry, authenticates owner calls, observes real inbox claims without model calls', async () => {
  const ctx = new Context()
  const loaderFiber = ctx.plugin(Loader)
  for (const plugin of [Agents, Sessions, Projections, SystemPrompt, Tools, Llm, Registry, RemoteAccess, Gateway]) ctx.plugin(plugin)
  ctx.plugin(Presets, { default: 'chosen' })
  ctx.plugin(AgentLoop)
  await loaderFiber.inertia
  const entryPath = import.meta.resolve('@qq-bridge-framework/dsh-bridge-plugin')
  const entryId = await ctx.loader.create({ name: entryPath })
  await ctx.loader.await()
  await new Promise<void>(resolve => setImmediate(resolve))
  try {
    assert(ctx.bridgePlugin)
    assert.throws(() => ctx.bridgePlugin.describe(), error => error instanceof Error && 'code' in error
      && error.code === 'bridgePlugin/operator-required' && /authenticated DSH owner/.test(error.message))
    const peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' })
    const invoke = async <Method extends keyof PluginReplies>(method: Method, args: Record<string, unknown> = {}, currentPeer = peer): Promise<PluginReplies[Method]> =>
      await ctx.typertGateway.invoke({ namespace: 'bridgePlugin', method, args, peer: currentPeer }) as PluginReplies[Method]
    const described = await invoke('describe')
    assert.equal(described.protocol, 'qq-bridge-framework.dsh-bridge/1')
    assert.equal(described.pluginVersion, '1.6.1')
    const nonOwner = new Peer(ctx, { principal: { kind: 'test-untrusted' }, interactions: 'none' })
    await assert.rejects(invoke('describe', {}, nonOwner))
    ctx.remoteAccess.registerPolicy('test-untrusted', { bindings: () => [{
      role: { name: 'overbroad-fixture', resource: 'global', actions: ['bridgePlugin/describe'] }, resource: { kind: 'global' },
    }] })
    await assert.rejects(invoke('describe', {}, nonOwner), /authenticated DSH owner/)
    await assert.rejects(ctx.typertGateway.invoke({ namespace: 'bridgePlugin', method: 'registerClaim', args: { request: {} }, peer }))
    await ctx.agentPresets.register({ id: 'chosen', plugins: [] })
    const tool = (name: string): ToolDefinition => ({ name, description: 'isolated fixture', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: () => [] }, execute: async () => { throw new Error('Tools must not execute') } })
    ctx.tools.register(tool('global_fixture'))
    const handle = await ctx.agents.create({ sessionId: SessionId('temporary-session'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'chosen').then(() => {}) })
    const agent = handle.agent
    assert(agent)
    agent.ctx.tools.register(tool('group_fixture'))
    const privateHandle = await ctx.agents.create({ sessionId: SessionId('temporary-private'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'chosen').then(() => {}) })
    privateHandle.agent.ctx.tools.register(tool('private_fixture'))
    await assert.rejects(ctx.agents.withInitiator(agent, () => invoke('describe')), /authenticated DSH owner/)
    const message = createUserMessage({ source: { kind: 'user', rpcId: 'actual-request', principal: { kind: 'test-private' } },
      content: [{ type: 'text', text: 'PRIVATE-MESSAGE-NOT-RETURNED' }] })
    agent.inbox.append('next-turn', message)
    const steering = createUserMessage({ source: { kind: 'user', rpcId: 'actual-steering' }, content: [] })
    agent.inbox.append('next-step', steering)
    assert.equal((await invoke('claimReceipts', { request: { sessionId: agent.id } })).receipts.length, 0)
    claimNextTurn(agent.inbox, 7)
    const claims = await invoke('claimReceipts', { request: { sessionId: agent.id } })
    assert.equal(claims.receipts.length, 2)
    assert.equal(claims.receipts[0]?.requestId, 'actual-steering')
    assert.equal(claims.receipts[1]?.requestId, 'actual-request')
    assert.equal(claims.receipts[1]?.userMessageId, message.id)
    assert.equal(claims.receipts[0]?.turn, 7)
    assert.equal(claims.receipts[0]?.sessionId, agent.session.id)
    assert(!JSON.stringify(claims).includes('PRIVATE-MESSAGE'))
    assert(!JSON.stringify(claims).includes('test-private'))
    assert.deepEqual((await invoke('claimReceipts', { request: { sessionId: 'other-session' } })).receipts, [])
    const scope = await invoke('inspectScope', { request: { sessionId: agent.id, expectedPreset: 'chosen', expectedNames: ['global_fixture', 'group_fixture'] } })
    assert(scope.state === 'verified-scope')
    assert.equal(scope.externalToolAuthorizationVerified, false)
    assert.deepEqual(scopeNames(await invoke('inspectScope', { request: { sessionId: privateHandle.agent.id, expectedPreset: 'chosen' } })),
      ['global_fixture', 'private_fixture'])
    const lift = agent.ctx.tools.restrict({ deny: ['global_fixture'] })
    assert.equal((await invoke('inspectScope', { request: { sessionId: agent.id, expectedPreset: 'chosen', expectedSchemaFingerprint: scope.schemaFingerprint } })).state, 'unverified')
    assert.deepEqual(scopeNames(await invoke('inspectScope', { request: { sessionId: agent.id, expectedPreset: 'chosen' } })), ['group_fixture'])
    lift()
    assert.equal((await invoke('inspectScope', { request: { sessionId: agent.id, expectedPreset: 'wrong' } })).state, 'unverified')
    const records = new Map<CredentialKey, CredentialRecord>()
    ctx.provide('credentials', { async modifyRecord(key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
      const updated = await mutate(records.get(key))
      if (updated !== undefined) records.set(key, updated)
      return records.get(key)
    } })
    const webFiber = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await webFiber.inertia
    const connectionFiber = ctx.plugin(Connection)
    await connectionFiber.inertia
    const origin = ctx.webServer.getOrigin()
    const body = JSON.stringify({ type: 'client-request', rpcId: 'local-test', method: 'bridgePlugin/describe', payload: { args: {} } })
    const callHttp = (headers: Record<string, string>) => fetch(`${origin}/api/bridgePlugin/describe`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })
    assert.equal((await callHttp({})).status, 401)
    assert.equal((await callHttp({ authorization: 'Bearer forged-owner' })).status, 401)
    const connectUrl = new URL(ctx.connection.authenticatedUrl(origin))
    connectUrl.pathname = '/connect'
    connectUrl.searchParams.set('interactions', 'none')
    const connected = await fetch(connectUrl, { redirect: 'manual' })
    assert.equal(connected.status, 302)
    const cookie = connected.headers.getSetCookie().map(header => header.split(';')[0]).join('; ')
    assert(cookie)
    const authenticated = await callHttp({ cookie })
    assert.equal(authenticated.status, 200)
    const response: unknown = await authenticated.json()
    assert.equal(object(object(object(response).result).value).protocol, described.protocol)
    assert.equal((await callHttp({ cookie, origin: 'https://untrusted.invalid' })).status, 403)
    agent.inbox.append('next-turn', createUserMessage({ source: { kind: 'user' }, content: [] }))
    claimNextTurn(agent.inbox, 8)
    assert.equal((await invoke('claimReceipts', { request: { sessionId: agent.id } })).head, claims.head)
    const entryFiber = ctx.loader.resolve(entryId).fiber
    assert(entryFiber)
    await entryFiber.dispose()
    ctx.loader.remove(entryId)
    await ctx.loader.create({ name: entryPath })
    await ctx.loader.await()
    assert.notEqual((await invoke('describe')).issuerEpoch, described.issuerEpoch)
    assert.equal((await invoke('claimReceipts', { request: { sessionId: agent.id, issuerEpoch: described.issuerEpoch, after: claims.head } })).state, 'unknown-epoch')
    await privateHandle.dispose()
    await handle.dispose()
    assert.equal((await invoke('inspectScope', { request: { sessionId: 'temporary-session', expectedPreset: 'chosen' } })).state, 'unverified')
    await peer.dispose()
    await assert.rejects(invoke('describe'))
  } finally {
    await ctx.fiber.dispose()
  }
})
