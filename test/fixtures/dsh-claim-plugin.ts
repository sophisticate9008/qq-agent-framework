import { BRIDGE_PLUGIN_PROTOCOL, RECEIPT_LIMITS, createClaimReceiptJournal } from '../../packages/dsh-bridge-plugin/src/receipts.ts'

export function createDshClaimPluginFixture() {
  let journal = createClaimReceiptJournal()
  const turns = new Map<string, number>()
  return Object.freeze({
    restart() { journal = createClaimReceiptJournal() },
    accepted(sessionId: string, requestId: string) {
      const turn = (turns.get(sessionId) ?? 0) + 1
      turns.set(sessionId, turn)
      journal.record({ sessionId, requestId, userMessageId: `user-${requestId}`, turn })
    },
    invoke(method: string, request: Record<string, unknown>): unknown {
      if (method === 'bridgePlugin/describe') return { protocol: BRIDGE_PLUGIN_PROTOCOL, pluginVersion: '0.1.0',
        sdkVersion: '0.2.1-rc.2', issuerEpoch: journal.issuerEpoch, authentication: 'dsh-owner-peer',
        durableReceipts: false, claimMeaning: 'inbox-claimed-not-completed', externalToolAuthorizationVerified: false,
        retention: RECEIPT_LIMITS }
      if (method === 'bridgePlugin/claimReceipts') return journal.read({ sessionId: String(request.sessionId),
        ...(request.issuerEpoch === undefined ? {} : { issuerEpoch: String(request.issuerEpoch) }),
        ...(request.after === undefined ? {} : { after: Number(request.after) }),
        ...(request.limit === undefined ? {} : { limit: Number(request.limit) }) })
      throw new Error('Unsupported local fake plugin method')
    }
  })
}
