import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createDshJsonRpcPort } from '../src/adapters/dsh-jsonrpc.ts'
import { BRIDGE_PLUGIN_PROTOCOL, RECEIPT_LIMITS, createClaimReceiptJournal } from '../packages/dsh-bridge-plugin/src/receipts.ts'
import { createDshBridgePluginPort, type ClaimReceiptQuery } from '../src/adapters/dsh-tool-scope.ts'

test('bridge descriptions accept released versions and reject unrecognized versions', async () => {
  const journal = createClaimReceiptJournal()
  for (const pluginVersion of ['0.1.0', '0.2.0', '1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.3.1', '1.4.0', '2.0.0']) {
    const port = createDshBridgePluginPort(async () => ({ protocol: BRIDGE_PLUGIN_PROTOCOL,
      issuerEpoch: journal.issuerEpoch, pluginVersion, sdkVersion: '0.2.1-rc.2',
      authentication: 'dsh-owner-peer', durableReceipts: false, claimMeaning: 'inbox-claimed-not-completed',
      externalToolAuthorizationVerified: false, retention: RECEIPT_LIMITS }))
    if (pluginVersion === '2.0.0') await assert.rejects(port.describe(new AbortController().signal), /DSH_PLUGIN_INVALID_RESPONSE/)
    else assert.equal((await port.describe(new AbortController().signal)).pluginVersion, pluginVersion)
  }
})

test('optional plugin client uses the authenticated fixed network port, verifies pages and fails closed on forged evidence', async context => {
  let journal = createClaimReceiptJournal()
  let transform = (value: unknown): unknown => value
  let unavailable = false
  let operatorDenied = false
  const observed: string[] = []
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.cookie, 'operator=fixture')
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const wire = JSON.parse(Buffer.concat(chunks).toString()) as {
      type: string; rpcId: string; method: string; payload: { args: { request?: Record<string, unknown> } }
    }
    assert.equal(wire.type, 'client-request')
    assert.equal(request.url, `/api/${wire.method}`)
    observed.push(wire.method)
    const input = wire.payload.args.request
    let value: unknown
    if (wire.method === 'bridgePlugin/describe') {
      assert.deepEqual(wire.payload.args, {})
      value = { protocol: BRIDGE_PLUGIN_PROTOCOL, issuerEpoch: journal.issuerEpoch, pluginVersion: '0.1.0', sdkVersion: '0.2.1-rc.2',
        authentication: 'dsh-owner-peer', durableReceipts: false, claimMeaning: 'inbox-claimed-not-completed',
        externalToolAuthorizationVerified: false, retention: RECEIPT_LIMITS }
    } else if (wire.method === 'bridgePlugin/claimReceipts') {
      assert(input)
      value = journal.read(input as unknown as ClaimReceiptQuery)
    } else {
      assert.equal(wire.method, 'bridgePlugin/inspectScope')
      assert(input)
      value = { protocol: BRIDGE_PLUGIN_PROTOCOL, issuerEpoch: journal.issuerEpoch, state: 'verified-scope',
        sessionId: input.sessionId, agentPreset: input.expectedPreset, names: ['fixture_tool'], schemaFingerprint: 'a'.repeat(64),
        scope: 'current-agent-model-wire-schemas', effectiveToolScopeVerified: true,
        externalToolAuthorizationVerified: false, declarationRevisionVerified: false }
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ type: 'server-response', rpcId: wire.rpcId, result: operatorDenied
      ? { ok: false, error: { code: 'bridgePlugin/operator-required', message: 'Owner required', details: {} } }
      : unavailable
      ? { ok: false, error: { code: 'gateway/method-unavailable', message: 'Not installed', details: {} } }
      : { ok: true, value: transform(value) } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const client = createDshJsonRpcPort({ endpoint: `http://127.0.0.1:${address.port}`, auth: 'cookie:operator=fixture' })
  context.after(() => client.close())
  const port = client.bridgePlugin
  assert(port)
  const signal = new AbortController().signal
  const description = await port.describe(signal)
  const baseline = await port.claimReceipts({ sessionId: 'group', issuerEpoch: description.issuerEpoch }, signal)
  journal.record({ sessionId: 'group', requestId: 'prompt', userMessageId: 'message', turn: 2 })
  journal.record({ sessionId: 'private', requestId: 'private-prompt', userMessageId: 'private-message', turn: 2 })
  journal.record({ sessionId: 'group', requestId: 'steer', userMessageId: 'steer-message', turn: 2 })
  const query = { sessionId: 'group', issuerEpoch: description.issuerEpoch, after: baseline.head, limit: 1 }
  const first = await port.claimReceipts(query, signal)
  assert.equal(first.state, 'page')
  assert.equal(first.hasMore, true)
  const next = await port.claimReceipts({ ...query, after: first.nextAfter }, signal)
  assert.deepEqual(next.receipts.map(receipt => receipt.requestId), ['steer'])
  assert.equal(next.absenceProven, false)
  assert.equal((await port.inspectScope({ sessionId: 'group', expectedPreset: 'selected', expectedNames: ['fixture_tool'] }, description.issuerEpoch, signal)).state, 'verified-scope')
  await assert.rejects(port.inspectScope({ sessionId: 'group', expectedPreset: 'selected', expectedNames: ['not_present'] }, description.issuerEpoch, signal), /DSH_PLUGIN_INVALID_RESPONSE/)
  const page = journal.read(query)
  for (const bad of [
    { ...page, sessionId: 'private' },
    { ...page, issuerEpoch: 'other-epoch' },
    { ...page, head: -1 },
    { ...page, nextAfter: page.head, hasMore: true },
    { ...page, receipts: [{ ...page.receipts[0], evidenceId: 'self-reported' }] },
    { ...page, receipts: [{ ...page.receipts[0], sessionId: 'private' }] },
    { ...page, receipts: [{ ...page.receipts[0], turn: NaN }] },
    { ...page, state: 'cursor-gap' },
    { ...page, protocol: 'stock-dsh' },
  ]) {
    transform = () => bad
    await assert.rejects(port.claimReceipts(query, signal), /DSH_PLUGIN_INVALID_RESPONSE/)
  }
  transform = value => value
  journal = createClaimReceiptJournal()
  const restarted = await port.claimReceipts(query, signal)
  assert.equal(restarted.state, 'unknown-epoch')
  assert.deepEqual(restarted.receipts, [])
  const current = await port.describe(signal)
  assert.equal((await port.claimReceipts({ ...query, issuerEpoch: current.issuerEpoch, after: 999 }, signal)).state, 'cursor-gap')
  await assert.rejects(port.inspectScope({ sessionId: 'group', expectedPreset: 'selected' }, description.issuerEpoch, signal), /DSH_PLUGIN_INVALID_RESPONSE/)
  const before = observed.length
  await assert.rejects(port.claimReceipts({ ...query, limit: 129 }, signal), /DSH_PLUGIN_INVALID_RESPONSE/)
  assert.equal(observed.length, before)
  unavailable = true
  await assert.rejects(port.describe(signal), { code: 'DSH_PLUGIN_UNAVAILABLE' })
  unavailable = false
  operatorDenied = true
  await assert.rejects(port.describe(signal), { code: 'DSH_PLUGIN_AUTH_REJECTED' })
  assert(observed.every(method => method.startsWith('bridgePlugin/')))
})
