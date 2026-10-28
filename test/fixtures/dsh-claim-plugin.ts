import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { BRIDGE_PLUGIN_PROTOCOL, RECEIPT_LIMITS, createClaimReceiptJournal } from '../../packages/dsh-bridge-plugin/src/receipts.ts'
import type { JsonValue } from '../../src/contracts/data.ts'
import type { FrameworkToolPendingCall, FrameworkToolResult } from '../../src/contracts/framework-tools.ts'

export function createDshClaimPluginFixture(readJournal?: () => ReturnType<typeof createClaimReceiptJournal>) {
  let journal = createClaimReceiptJournal()
  const turns = new Map<string, number>()
  const claims = new Map<string, { requestId: string; userMessageId: string; turn: number }>()
  const leases = new Map<string, { sessionId: string; generation: number; leaseId: string; names: string[] }>()
  const calls = new Map<string, FrameworkToolPendingCall>()
  const results = new Map<string, FrameworkToolResult>()
  return Object.freeze({
    restart() { journal = createClaimReceiptJournal(); leases.clear(); calls.clear(); results.clear() },
    accepted(sessionId: string, requestId: string) {
      const turn = (turns.get(sessionId) ?? 0) + 1
      turns.set(sessionId, turn)
      const claim = { requestId, userMessageId: `user-${requestId}`, turn }
      claims.set(sessionId, claim)
      ;(readJournal?.() ?? journal).record({ sessionId, ...claim })
    },
    queue(sessionId: string, name: string, input: JsonValue) {
      const lease = leases.get(sessionId)
      const claim = claims.get(sessionId)
      assert(lease && claim && lease.names.includes(name), 'A tool call requires its installed lease and actual admitted claim')
      const ticket = randomUUID()
      calls.set(ticket, { ticket, leaseId: lease.leaseId, call: { id: randomUUID(), sessionId,
        generation: lease.generation, ...claim, name, input, expiresAt: Date.now() + 30_000 } })
      return ticket
    },
    ready(sessionId: string, name: string, requestId?: string) {
      const claim = claims.get(sessionId)
      return Boolean(leases.get(sessionId)?.names.includes(name) && claim && (requestId === undefined || claim.requestId === requestId))
    },
    result(ticket: string) { return results.get(ticket) },
    invoke(method: string, request: Record<string, unknown>): unknown {
      const currentJournal = readJournal?.() ?? journal
      if (method === 'bridgePlugin/describe') return { protocol: BRIDGE_PLUGIN_PROTOCOL, pluginVersion: '1.0.0',
        sdkVersion: '0.2.1-rc.2', issuerEpoch: currentJournal.issuerEpoch, authentication: 'dsh-owner-peer',
        durableReceipts: false, claimMeaning: 'inbox-claimed-not-completed', externalToolAuthorizationVerified: false,
        frameworkToolProtocol: 'qq-agent-framework.tools/1', retention: RECEIPT_LIMITS }
      if (method === 'bridgePlugin/claimReceipts') return currentJournal.read({ sessionId: String(request.sessionId),
        ...(request.issuerEpoch === undefined ? {} : { issuerEpoch: String(request.issuerEpoch) }),
        ...(request.after === undefined ? {} : { after: Number(request.after) }),
        ...(request.limit === undefined ? {} : { limit: Number(request.limit) }) })
      assert.equal(request.issuerEpoch, currentJournal.issuerEpoch)
      const sessionId = String(request.sessionId)
      if (method === 'bridgePlugin/installFrameworkTools') {
        assert(!leases.has(sessionId))
        assert(Array.isArray(request.tools))
        const names = request.tools.map((tool: unknown) => {
          assert(tool !== null && typeof tool === 'object' && 'name' in tool && typeof tool.name === 'string')
          return tool.name
        })
        const lease = { sessionId, generation: Number(request.generation), leaseId: randomUUID(), names }
        assert(Number.isSafeInteger(lease.generation) && lease.generation > 0)
        leases.set(sessionId, lease)
        return { schema: 1, issuerEpoch: currentJournal.issuerEpoch, ...lease }
      }
      if (method === 'bridgePlugin/inspectFrameworkTools') return { schema: 1, issuerEpoch: currentJournal.issuerEpoch, projection: leases.get(sessionId) ?? null }
      if (method === 'bridgePlugin/withdrawFrameworkTools') {
        const withdrawn = leases.get(sessionId)?.leaseId === request.leaseId
        if (withdrawn) leases.delete(sessionId)
        return { schema: 1, withdrawn }
      }
      if (method === 'bridgePlugin/pollFrameworkTools') return { schema: 1, issuerEpoch: currentJournal.issuerEpoch,
        calls: [...calls.values()].filter(call => !results.has(call.ticket)) }
      if (method === 'bridgePlugin/completeFrameworkTool') {
        const ticket = String(request.ticket)
        assert(calls.has(ticket) && !results.has(ticket))
        results.set(ticket, request.result as FrameworkToolResult)
        return { schema: 1, accepted: true }
      }
      throw new Error('Unsupported local fake plugin method')
    }
  })
}
