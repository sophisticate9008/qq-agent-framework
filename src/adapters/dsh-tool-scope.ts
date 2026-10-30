import { parseNativeToolInventory, type NativeToolInventory } from '../contracts/native-tool-inventory.ts'
import { DSH_EXECUTION_EVIDENCE_PROTOCOL, type DshExecutionEvidence, type DshExecutionEvidenceRequest } from '../contracts/dsh-execution-evidence.ts'
import { readDshExecutionEvidence } from './dsh-execution-evidence.ts'
export { createDshToolScopeReader } from './dsh-tool-scope-reader.ts'
export type { DshScopedAgent, DshToolScopeRequest, DshToolScopeRuntime } from './dsh-tool-scope-reader.ts'
import { BRIDGE_PLUGIN_PROTOCOL, RECEIPT_LIMITS, validIdentifier } from '../contracts/dsh-bridge.ts'
import type { ClaimReceipt, ClaimReceiptPage, ClaimReceiptQuery } from '../contracts/dsh-bridge.ts'
import type { DshToolScopeRequest } from './dsh-tool-scope-reader.ts'

export type { ClaimReceipt, ClaimReceiptPage, ClaimReceiptQuery }

export interface DshBridgePluginDescription {
  readonly protocol: typeof BRIDGE_PLUGIN_PROTOCOL
  readonly pluginVersion: '1.4.1' | '1.5.0' | '1.5.1'
  readonly sdkVersion: '0.2.1-rc.2'
  readonly issuerEpoch: string
  readonly authentication: 'dsh-owner-peer'
  readonly durableReceipts: false
  readonly claimMeaning: 'inbox-claimed-not-completed'
  readonly retention: typeof RECEIPT_LIMITS
  readonly externalToolAuthorizationVerified: false
  readonly migrationApiVersion?: 1 | 2
  readonly migrationProtocol?: string
  readonly frameworkToolProtocol?: 'qq-bridge-framework.tools/1'
  readonly executionEvidenceProtocol?: typeof DSH_EXECUTION_EVIDENCE_PROTOCOL
  readonly workProtocol?: 'qq-bridge-framework.work/1'
  readonly methods?: readonly string[]
}

export interface DshBridgePluginPort {
  describe(signal: AbortSignal): Promise<DshBridgePluginDescription>
  inspectScope(request: DshToolScopeRequest, issuerEpoch: string, signal: AbortSignal): Promise<DshBridgeScopeInspection>
  inspectToolInventory?(issuerEpoch: string, signal: AbortSignal): Promise<NativeToolInventory>
  inspectExecution?(request: DshExecutionEvidenceRequest, issuerEpoch: string, signal: AbortSignal): Promise<DshExecutionEvidence>
  claimReceipts(request: ClaimReceiptQuery & { readonly issuerEpoch: string }, signal: AbortSignal): Promise<ClaimReceiptPage>
}

export type DshBridgeScopeInspection = {
  readonly protocol: typeof BRIDGE_PLUGIN_PROTOCOL
  readonly issuerEpoch: string
  readonly state: 'verified-scope'
  readonly sessionId: string
  readonly agentPreset: string
  readonly names: readonly string[]
  readonly items?: readonly { readonly name: string; readonly description: string | null }[]
  readonly schemaFingerprint: string
  readonly scope: 'current-agent-model-wire-schemas'
  readonly effectiveToolScopeVerified: true
  readonly externalToolAuthorizationVerified: false
  readonly declarationRevisionVerified: false
} | {
  readonly protocol: typeof BRIDGE_PLUGIN_PROTOCOL
  readonly issuerEpoch: string
  readonly state: 'unverified'
  readonly effectiveToolScopeVerified: false
  readonly missingReasons: readonly string[]
}

type PluginMethod = 'bridgePlugin/inspectToolInventory' | 'bridgePlugin/inspectExecution' | 'bridgePlugin/describe' | 'bridgePlugin/inspectScope' | 'bridgePlugin/claimReceipts'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DSH_PLUGIN_INVALID_RESPONSE')
  return value as Record<string, unknown>
}

function requireProof(condition: unknown): asserts condition {
  if (!condition) throw new Error('DSH_PLUGIN_INVALID_RESPONSE')
}

function watermark(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function createDshBridgePluginPort(invoke: (method: PluginMethod, request: Record<string, unknown> | undefined, signal: AbortSignal) => Promise<unknown>): DshBridgePluginPort {
  const port: DshBridgePluginPort = Object.freeze<DshBridgePluginPort>({
    async describe(signal) {
      const value = object(await invoke('bridgePlugin/describe', undefined, signal))
      requireProof(value.protocol === BRIDGE_PLUGIN_PROTOCOL && (value.pluginVersion === '1.4.1' || value.pluginVersion === '1.5.0' || value.pluginVersion === '1.5.1') && value.sdkVersion === '0.2.1-rc.2'
        && validIdentifier(value.issuerEpoch) && value.authentication === 'dsh-owner-peer' && value.durableReceipts === false
        && value.claimMeaning === 'inbox-claimed-not-completed' && value.externalToolAuthorizationVerified === false)
      const retention = object(value.retention)
      requireProof(Object.entries(RECEIPT_LIMITS).every(([key, expected]) => retention[key] === expected))
      if (value.executionEvidenceProtocol !== undefined) requireProof(value.executionEvidenceProtocol === DSH_EXECUTION_EVIDENCE_PROTOCOL)
      if (value.migrationApiVersion !== undefined) requireProof(value.migrationApiVersion === 1 || value.migrationApiVersion === 2)
      if (value.migrationProtocol !== undefined) requireProof(validIdentifier(value.migrationProtocol))
      if (value.frameworkToolProtocol !== undefined) requireProof(value.frameworkToolProtocol === 'qq-bridge-framework.tools/1')
      if (value.workProtocol !== undefined) requireProof(value.workProtocol === 'qq-bridge-framework.work/1')
      if (value.methods !== undefined) requireProof(Array.isArray(value.methods) && value.methods.length <= 32
        && value.methods.every(validIdentifier) && new Set(value.methods).size === value.methods.length)
      return { protocol: BRIDGE_PLUGIN_PROTOCOL, pluginVersion: value.pluginVersion, sdkVersion: '0.2.1-rc.2', issuerEpoch: value.issuerEpoch,
        authentication: 'dsh-owner-peer', durableReceipts: false, claimMeaning: 'inbox-claimed-not-completed',
        retention: RECEIPT_LIMITS, externalToolAuthorizationVerified: false,
        ...(value.executionEvidenceProtocol === undefined ? {} : { executionEvidenceProtocol: DSH_EXECUTION_EVIDENCE_PROTOCOL }),
        ...(value.migrationApiVersion === undefined ? {} : { migrationApiVersion: value.migrationApiVersion as 1 | 2 }),
        ...(value.migrationProtocol === undefined ? {} : { migrationProtocol: value.migrationProtocol as string }),
        ...(value.frameworkToolProtocol === undefined ? {} : { frameworkToolProtocol: 'qq-bridge-framework.tools/1' as const }),
        ...(value.workProtocol === undefined ? {} : { workProtocol: 'qq-bridge-framework.work/1' as const }),
        ...(value.methods === undefined ? {} : { methods: [...value.methods as string[]] }) }
    },
    async inspectToolInventory(issuerEpoch, signal) {
      const value = object(await invoke('bridgePlugin/inspectToolInventory', undefined, signal))
      requireProof(value.protocol === BRIDGE_PLUGIN_PROTOCOL && value.issuerEpoch === issuerEpoch)
      return parseNativeToolInventory(value)
    },
    async inspectExecution(request, issuerEpoch, signal) {
      const description = await port.describe(signal)
      requireProof(description.issuerEpoch === issuerEpoch && description.executionEvidenceProtocol === DSH_EXECUTION_EVIDENCE_PROTOCOL
        && description.methods?.includes('bridgePlugin/inspectExecution'))
      return readDshExecutionEvidence(request, issuerEpoch, signal, (input, currentSignal) => invoke('bridgePlugin/inspectExecution', input, currentSignal))
    },
    async inspectScope(request, issuerEpoch, signal) {
      requireProof(validIdentifier(request.sessionId) && validIdentifier(request.expectedPreset) && validIdentifier(issuerEpoch))
      const value = object(await invoke('bridgePlugin/inspectScope', { ...request }, signal))
      requireProof(value.protocol === BRIDGE_PLUGIN_PROTOCOL && value.issuerEpoch === issuerEpoch)
      if (value.state === 'unverified') {
        requireProof(value.effectiveToolScopeVerified === false && Array.isArray(value.missingReasons) && value.missingReasons.length === 1
          && ['dsh_live_agent_scope_missing', 'dsh_tool_scope_changed', 'dsh_tool_scope_invalid'].includes(value.missingReasons[0]))
        return { protocol: BRIDGE_PLUGIN_PROTOCOL, issuerEpoch, state: 'unverified', effectiveToolScopeVerified: false,
          missingReasons: [...value.missingReasons] as string[] }
      }
      requireProof(value.state === 'verified-scope' && value.sessionId === request.sessionId && value.agentPreset === request.expectedPreset
        && value.scope === 'current-agent-model-wire-schemas' && value.effectiveToolScopeVerified === true
        && value.externalToolAuthorizationVerified === false && value.declarationRevisionVerified === false
        && Array.isArray(value.names) && value.names.length <= 256 && value.names.every(validIdentifier)
        && new Set(value.names).size === value.names.length && typeof value.schemaFingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.schemaFingerprint))
      const names = [...value.names].sort() as string[]
      requireProof((request.expectedNames === undefined || JSON.stringify([...request.expectedNames].sort()) === JSON.stringify(names))
        && (request.expectedSchemaFingerprint === undefined || request.expectedSchemaFingerprint === value.schemaFingerprint))
      let items: readonly { readonly name: string; readonly description: string | null }[] | undefined
      if (Object.hasOwn(value, 'items')) {
        requireProof(Array.isArray(value.items) && value.items.length === names.length)
        const parsed = value.items.map((raw: unknown) => {
          const item = object(raw)
          requireProof(Object.hasOwn(item, 'name') && Object.hasOwn(item, 'description') && Object.keys(item).length === 2
            && validIdentifier(item.name) && (item.description === null
              || typeof item.description === 'string' && item.description.length <= 2000))
          return { name: item.name, description: item.description }
        })
        requireProof(new Set(parsed.map(item => item.name)).size === names.length
          && parsed.every(item => names.includes(item.name)))
        items = parsed.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
      }
      return { protocol: BRIDGE_PLUGIN_PROTOCOL, issuerEpoch, state: 'verified-scope', sessionId: request.sessionId,
        agentPreset: request.expectedPreset, names, ...(items === undefined ? {} : { items }),
        schemaFingerprint: value.schemaFingerprint, scope: 'current-agent-model-wire-schemas',
        effectiveToolScopeVerified: true, externalToolAuthorizationVerified: false, declarationRevisionVerified: false }
    },
    async claimReceipts(request, signal): Promise<ClaimReceiptPage> {
      requireProof(validIdentifier(request.sessionId) && validIdentifier(request.issuerEpoch)
        && (request.after === undefined || watermark(request.after))
        && (request.limit === undefined || watermark(request.limit) && request.limit >= 1 && request.limit <= RECEIPT_LIMITS.maxPage))
      const value = object(await invoke('bridgePlugin/claimReceipts', { ...request }, signal))
      requireProof(value.protocol === BRIDGE_PLUGIN_PROTOCOL && validIdentifier(value.issuerEpoch) && value.sessionId === request.sessionId
        && watermark(value.oldestAvailableAfter) && watermark(value.head) && value.oldestAvailableAfter <= value.head
        && watermark(value.nextAfter) && value.nextAfter >= value.oldestAvailableAfter && value.nextAfter <= value.head
        && value.absenceProven === false && typeof value.hasMore === 'boolean' && Array.isArray(value.receipts))
      const retention = object(value.retention)
      requireProof(Object.entries(RECEIPT_LIMITS).every(([key, expected]) => retention[key] === expected))
      const base = { protocol: BRIDGE_PLUGIN_PROTOCOL, issuerEpoch: value.issuerEpoch, sessionId: request.sessionId,
        oldestAvailableAfter: value.oldestAvailableAfter, head: value.head, nextAfter: value.nextAfter,
        retention: RECEIPT_LIMITS, absenceProven: false as const }
      if (value.state === 'unknown-epoch' || value.state === 'cursor-gap') {
        requireProof(value.receipts.length === 0 && value.hasMore === false && value.nextAfter === value.head)
        requireProof(value.state === 'unknown-epoch' ? value.issuerEpoch !== request.issuerEpoch
          : value.issuerEpoch === request.issuerEpoch && request.after !== undefined
            && (request.after < value.oldestAvailableAfter || request.after > value.head))
        return value.state === 'unknown-epoch'
          ? { ...base, state: 'unknown-epoch', receipts: [], hasMore: false }
          : { ...base, state: 'cursor-gap', receipts: [], hasMore: false }
      }
      let previous = request.after ?? value.oldestAvailableAfter
      requireProof(value.state === 'page' && value.issuerEpoch === request.issuerEpoch && previous >= value.oldestAvailableAfter
        && previous <= value.head && value.receipts.length <= (request.limit ?? RECEIPT_LIMITS.maxPage)
        && value.coverage === (request.after === undefined ? 'retained-window-only' : 'after-cursor'))
      const receipts: ClaimReceipt[] = value.receipts.map(raw => {
        const receipt = object(raw)
        requireProof(receipt.kind === 'dsh.agent-inbox-claimed' && receipt.issuerEpoch === value.issuerEpoch
          && watermark(receipt.receiptSeq) && receipt.receiptSeq > previous && receipt.receiptSeq <= base.head
          && receipt.evidenceId === `${base.issuerEpoch}:${receipt.receiptSeq}` && receipt.sessionId === request.sessionId
          && validIdentifier(receipt.requestId) && validIdentifier(receipt.userMessageId) && watermark(receipt.turn))
        previous = receipt.receiptSeq
        return { kind: 'dsh.agent-inbox-claimed', issuerEpoch: base.issuerEpoch, receiptSeq: receipt.receiptSeq,
          evidenceId: `${base.issuerEpoch}:${receipt.receiptSeq}`, sessionId: request.sessionId,
          requestId: receipt.requestId, userMessageId: receipt.userMessageId, turn: receipt.turn }
      })
      requireProof(value.hasMore ? receipts.length > 0 && value.nextAfter === previous && value.nextAfter < value.head : value.nextAfter === value.head)
      return { ...base, state: 'page', coverage: request.after === undefined ? 'retained-window-only' : 'after-cursor', receipts, hasMore: value.hasMore }
    },
  })
  return port
}
