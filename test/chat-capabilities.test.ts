import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { createDshJsonRpcPort } from '../src/adapters/dsh-jsonrpc.ts'
import { composeChatCapabilityPreset, createChatCapabilityService, validateChatCapabilityApprovalRequest, validateChatCapabilityCompositionApproval } from '../src/host/chat-capabilities.ts'
import type { ChatCapabilityCompositionRequest } from '../src/host/chat-capabilities.ts'
import type { JsonObject } from '../src/core/types.ts'

const basePreset = { entryId: 'base-chat', config: { id: 'base-chat', plugins: [
  { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'Selected identity.', complete: true } },
] } }

async function fixture(context: TestContext) {
  const documents = new Map<string, string>([
    ['user-tools', JSON.stringify([{ id: 'user-tool', name: '@example/user-tool', config: { mode: 'declared' } }])],
    ['whole-agent', JSON.stringify([{ id: 'other-persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'Other identity' } }])],
    ['dynamic', '- id: dynamic\n  name: "@example/tool"\n  disabled: !!js process.platform === "win32"\n'],
    ['isolated', JSON.stringify([{ id: 'tools-group', name: 'cordis:group', group: true, isolate: { exampleService: true }, config: [
      { id: 'scope-tool', name: '@example/scoped-tool', config: {} },
    ] }])],
  ])
  const calls: string[] = []
  let broken = false
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { rpcId: string; method: string; payload: { args: { agentPreset?: string } } }
    calls.push(input.method)
    assert.equal(request.headers.cookie, 'operator=fixture')
    assert.equal(request.url, `/api/${input.method}`)
    assert(['agentPresets/list', 'agentPresets/read'].includes(input.method))
    const value = input.method === 'agentPresets/list'
      ? { presets: [...documents.keys()].map(id => ({ id, name: id, isDefault: false,
        ...(broken && id === 'user-tools' ? { broken: 'private-diagnostic-do-not-return' } : {}) })) }
      : { agentPreset: input.payload.args.agentPreset, content: documents.get(input.payload.args.agentPreset!) }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'server-response', rpcId: input.rpcId, result: { ok: true, value } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()) }))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const client = createDshJsonRpcPort({ endpoint: `http://127.0.0.1:${address.port}`, auth: 'cookie:operator=fixture' })
  context.after(() => client.close())
  return { client, documents, calls, broken(value: boolean) { broken = value } }
}

const signal = () => new AbortController().signal

test('capability catalog enumerates actual DSH declarations but never claims effective tools or owner authorization', async context => {
  const data = await fixture(context)
  const service = createChatCapabilityService({ client: data.client })
  const catalog = await service.catalog(signal())
  assert.equal(catalog.presets.length, 4)
  assert.equal(catalog.presets.find(preset => preset.presetId === 'user-tools')?.composable, true)
  assert.equal(catalog.presets.find(preset => preset.presetId === 'whole-agent')?.composable, false)
  assert(catalog.presets.find(preset => preset.presetId === 'dynamic')?.missingReasons.includes('capability_yaml_or_expression_unsupported'))
  assert.equal(catalog.mounted, false)
  assert.equal(catalog.effectiveToolScopeVerified, false)
  assert.equal(catalog.externalToolAuthorizationVerified, false)
  data.broken(true)
  assert(!JSON.stringify(await service.catalog(signal())).includes('private-diagnostic-do-not-return'))
  assert(data.calls.every(method => ['agentPresets/list', 'agentPresets/read'].includes(method)))
})

async function composition(context: TestContext, approve = true) {
  const data = await fixture(context)
  const service = createChatCapabilityService({ client: data.client, ...(approve ? {
    authorize: async () => ({ approvalId: 'explicit-owner-approval', authority: 'owner' as const,
      externalTools: 'separate-runtime-authorization-required' as const }),
  } : {}) })
  const metadata = (await service.catalog(signal())).presets.find(preset => preset.presetId === 'user-tools')!
  const request: ChatCapabilityCompositionRequest = { selection: metadata, basePreset,
    target: { profilePath: '/explicit-independent/cordis.patch.yml', expectedRevision: 'a'.repeat(64), presetId: 'composed-chat' } }
  return { ...data, service, request }
}

test('safe composition preserves persona and uses explicit owner callback plus actual declaration readback', async context => {
  const data = await composition(context)
  const prepared = await data.service.prepare(data.request, signal())
  assert.equal(prepared.summary.ready, true)
  let mutations = 0
  const result = await prepared.applyDeclaration(async request => {
    mutations++
    assert.equal(request.profilePath, '/explicit-independent/cordis.patch.yml')
    assert.equal(request.expectedRevision, 'a'.repeat(64))
    assert.equal(request.approvalId, 'explicit-owner-approval')
    const plugins = request.preset.config.plugins as JsonObject[]
    assert.deepEqual(plugins[0], basePreset.config.plugins[0])
    assert.equal(plugins[1]?.name, '@example/user-tool')
    data.documents.set('composed-chat', JSON.stringify(plugins))
    return { status: 'committed', backupId: 'fixture-private-backup' }
  }, signal())
  assert.equal(result.state, 'declaration-verified')
  assert.equal(result.mounted, false)
  assert.equal(result.effectiveToolScopeVerified, false)
  assert.equal(result.externalToolAuthorizationVerified, false)
  await prepared.applyDeclaration(async () => { mutations++; return { status: 'unknown' } }, signal())
  assert.equal(mutations, 1)
})

test('composition refuses unapproved changes, changed source revisions and fake successful write receipts', async context => {
  const noApproval = await composition(context, false)
  const unapproved = await noApproval.service.prepare(noApproval.request, signal())
  let calls = 0
  assert.equal((await unapproved.applyDeclaration(async () => { calls++; return { status: 'unknown' } }, signal())).state, 'blocked')
  assert.equal(calls, 0)
  const data = await composition(context)
  const prepared = await data.service.prepare(data.request, signal())
  data.documents.set('user-tools', '[]')
  const drift = await prepared.applyDeclaration(async () => { calls++; return { status: 'unknown' } }, signal())
  assert.equal(drift.state, 'unverified')
  assert.equal(calls, 0)
  const another = await composition(context)
  const notWritten = await another.service.prepare(another.request, signal())
  const receiptOnly = await notWritten.applyDeclaration(async () => ({ status: 'committed', backupId: 'not-proof-of-loaded-declaration' }), signal())
  assert.equal(receiptOnly.state, 'unverified')
  assert.equal(receiptOnly.mounted, false)
})

test('composition rejects persona, authority mutation, named realms, aliases and unknown loader semantics', async context => {
  const data = await composition(context)
  for (const plugins of [
    [{ id: 'persona-extra', name: '@deepseek-ai/dsh-persona' }],
    [{ id: 'llm-extra', name: '@deepseek-ai/dsh-llm-pi-ai', config: {} }],
    [{ id: 'authority', name: '@deepseek-ai/dsh-credentials-local', config: {} }],
    [{ id: 'named-realm', name: '@example/tool', isolate: { tools: 'shared-global-realm' } }],
    [{ id: 'inject', name: '@example/tool', intercept: { tools: true } }],
    [{ id: 'persona', name: '@example/duplicate-id' }],
  ]) {
    data.documents.set('user-tools', JSON.stringify(plugins))
    const selected = (await data.service.catalog(signal())).presets.find(preset => preset.presetId === 'user-tools')!
    const prepared = await data.service.prepare({ ...data.request, selection: selected }, signal())
    assert.equal(prepared.summary.ready, false)
  }
  data.documents.set('user-tools', '- &tool {id: tool, name: "@example/tool"}\n- *tool\n')
  const catalog = await data.service.catalog(signal())
  assert.equal(catalog.presets.find(preset => preset.presetId === 'user-tools')?.composable, false)
})

test('capability source export pins the raw revision and shared composition preserves the base entry identity', async context => {
  const data = await composition(context)
  const declaration = await data.service.readDeclaration(data.request.selection, signal())
  const composed = composeChatCapabilityPreset(basePreset, declaration)
  assert.equal(composed.entryId, basePreset.entryId)
  assert.equal(composed.config.id, basePreset.config.id)
  assert.deepEqual((composed.config.plugins as JsonObject[])[0], basePreset.config.plugins[0])
  assert.equal((composed.config.plugins as JsonObject[])[1]?.name, '@example/user-tool')
  assert.equal((basePreset.config.plugins as JsonObject[]).length, 1)
  assert(Object.isFrozen(composed.config.plugins))
  assert.throws(() => composeChatCapabilityPreset(basePreset, { ...declaration, content: '[]' }))
  data.documents.set('user-tools', '[]')
  await assert.rejects(data.service.readDeclaration(data.request.selection, signal()))
})

test('capability approval DTO binds a versioned source, exact target and final composition, never a grant or arbitrary body', () => {
  const request = { schema: 1, source: { schema: 1, presetId: 'operator/work', revision: 'a'.repeat(64) },
    compositionRevision: 'b'.repeat(64), target: { profilePath: '/private/cordis.patch.yml', credentialsPath: '/private/.credentials.yaml',
      layerPaths: ['/private/base.patch.yml'], schemaVersion: '0.2.1-rc.2' } }
  const receipt = { ...request, approvalId: 'trusted-owner-receipt', authority: 'owner', externalTools: 'separate-runtime-authorization-required' }
  assert.deepEqual(validateChatCapabilityApprovalRequest(request), request)
  assert.deepEqual(validateChatCapabilityCompositionApproval(receipt), receipt)
  for (const invalid of [
    { ...request, schema: 2 }, { ...request, compositionRevision: 'latest' }, { ...request, granted: true },
    { ...request, source: { ...request.source, revision: 'latest' } },
    { ...request, target: { ...request.target, extra: true } },
    { ...request, target: { ...request.target, layerPaths: [request.target.profilePath] } },
    { ...request, target: { ...request.target, layerPaths: ['relative.patch.yml'] } },
  ]) assert.throws(() => validateChatCapabilityApprovalRequest(invalid))
  for (const invalid of [null, {}, { ...receipt, authority: 'model' }, { ...receipt, externalTools: 'authorized' },
    { ...receipt, grant: ['work'] }, { ...receipt, body: 'private-data' }]) {
    assert.throws(() => validateChatCapabilityCompositionApproval(invalid))
  }
})
