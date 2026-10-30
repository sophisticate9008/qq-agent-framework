import { MIGRATION_PROTOCOL, validMigrationTargetSelection } from '../contracts/dsh-session-migration.ts'
import type { ForkPreviewRequest, ForkPreviewResult, ForkWithPresetRequest, ForkWithPresetResult } from '../contracts/dsh-session-migration.ts'
import { BRIDGE_PLUGIN_PROTOCOL, validIdentifier } from '../contracts/dsh-bridge.ts'
import type { DshBridgePluginDescription } from './dsh-tool-scope.ts'

export type DshSessionMigrationPreviewRequest = ForkPreviewRequest
export type DshSessionMigrationRequest = ForkWithPresetRequest
export type DshSessionMigrationReceipt = ForkWithPresetResult
export type DshSessionMigrationPreview = ForkPreviewResult & (
  { readonly state: 'available'; readonly sourceCursor: number; readonly sourceDigest: string; readonly targetRevision: string }
  | { readonly state: 'blocked' }
)

export interface DshSessionMigrationPort {
  forkPreview(request: DshSessionMigrationPreviewRequest, signal: AbortSignal): Promise<DshSessionMigrationPreview>
  forkWithPreset(request: DshSessionMigrationRequest, signal: AbortSignal): Promise<DshSessionMigrationReceipt>
  inspectMigration(request: DshSessionMigrationRequest, signal: AbortSignal): Promise<DshSessionMigrationReceipt>
}

export type DshSessionMigrationMethod = 'bridgePlugin/forkPreview' | 'bridgePlugin/forkWithPreset' | 'bridgePlugin/inspectMigration'
const methods: readonly DshSessionMigrationMethod[] = ['bridgePlugin/forkPreview', 'bridgePlugin/forkWithPreset', 'bridgePlugin/inspectMigration']
const previewKeys = ['migrationId', 'sourceSessionId', 'expectedPreset', 'targetPreset'] as const
const requestKeys = [...previewKeys, 'issuerEpoch', 'expectedCursor', 'expectedSourceDigest', 'expectedTargetRevision'] as const

function proof(condition: unknown, code = 'DSH_MIGRATION_INVALID_RESPONSE'): asserts condition {
  if (!condition) throw new Error(code)
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  proof(value !== null && typeof value === 'object' && !Array.isArray(value))
  const parsed = value as Record<string, unknown>
  proof(Object.keys(parsed).length === keys.length + Number(Object.hasOwn(parsed, 'targetSelection'))
    && keys.every(key => Object.hasOwn(parsed, key)) && (parsed.targetSelection === undefined || validMigrationTargetSelection(parsed.targetSelection)))
  return parsed
}

function sameTarget(left: unknown, right: DshSessionMigrationPreviewRequest['targetSelection']): boolean {
  return left === undefined ? right === undefined : validMigrationTargetSelection(left) && right !== undefined
    && left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort
    && left.contextLimits.contextWindow === right.contextLimits.contextWindow
    && left.contextLimits.maxTokens === right.contextLimits.maxTokens && left.contextLimits.headroomTokens === right.contextLimits.headroomTokens
}

function cursor(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function hash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) }

function reasons(value: unknown): readonly string[] {
  proof(Array.isArray(value) && value.length <= 64 && value.every(validIdentifier) && new Set(value).size === value.length)
  return [...value] as string[]
}

function previewRequest(request: DshSessionMigrationPreviewRequest): DshSessionMigrationPreviewRequest {
  const value = object(request, previewKeys)
  proof(previewKeys.every(key => validIdentifier(value[key])), 'DSH_MIGRATION_INVALID_REQUEST')
  return { migrationId: request.migrationId, sourceSessionId: request.sourceSessionId,
    expectedPreset: request.expectedPreset, targetPreset: request.targetPreset,
    ...(request.targetSelection === undefined ? {} : { targetSelection: structuredClone(request.targetSelection) }) }
}

function migrationRequest(request: DshSessionMigrationRequest): DshSessionMigrationRequest {
  const value = object(request, requestKeys)
  proof([...previewKeys, 'issuerEpoch'].every(key => validIdentifier(value[key])) && cursor(value.expectedCursor)
    && hash(value.expectedSourceDigest) && hash(value.expectedTargetRevision), 'DSH_MIGRATION_INVALID_REQUEST')
  return { migrationId: request.migrationId, sourceSessionId: request.sourceSessionId, expectedPreset: request.expectedPreset,
    targetPreset: request.targetPreset, issuerEpoch: request.issuerEpoch, expectedCursor: request.expectedCursor,
    expectedSourceDigest: request.expectedSourceDigest, expectedTargetRevision: request.expectedTargetRevision,
    ...(request.targetSelection === undefined ? {} : { targetSelection: structuredClone(request.targetSelection) }) }
}

function receipt(value: unknown, request: DshSessionMigrationRequest, inspect: boolean): DshSessionMigrationReceipt {
  const parsed = object(value, [...requestKeys, 'migrationProtocol', 'state', 'childSessionId', 'idempotency', 'missingReasons'])
  proof(parsed.migrationProtocol === MIGRATION_PROTOCOL && requestKeys.every(key => parsed[key] === request[key])
    && sameTarget(parsed.targetSelection, request.targetSelection))
  proof(parsed.state === 'completed' || parsed.state === 'rejected' || parsed.state === 'unknown' || inspect && parsed.state === 'not-found')
  proof(parsed.idempotency === 'created' || parsed.idempotency === 'replayed' || parsed.idempotency === 'conflict'
    || parsed.idempotency === 'unknown' || parsed.idempotency === 'not-found')
  proof(parsed.childSessionId === null || validIdentifier(parsed.childSessionId) && parsed.childSessionId !== request.sourceSessionId)
  const missingReasons = reasons(parsed.missingReasons)
  if (parsed.state === 'completed') proof(validIdentifier(parsed.childSessionId) && missingReasons.length === 0
    && (parsed.idempotency === 'created' || parsed.idempotency === 'replayed'))
  if (parsed.state === 'not-found') proof(parsed.childSessionId === null && parsed.idempotency === 'not-found')
  if (parsed.state === 'rejected') proof(parsed.childSessionId === null)
  if (parsed.state === 'unknown') proof(parsed.idempotency === 'unknown')
  return { ...request, migrationProtocol: MIGRATION_PROTOCOL, state: parsed.state as DshSessionMigrationReceipt['state'],
    childSessionId: parsed.childSessionId as string | null, idempotency: parsed.idempotency, missingReasons }
}

export function createDshSessionMigrationPort(options: {
  readonly describe: (signal: AbortSignal) => Promise<DshBridgePluginDescription>
  readonly invoke: (method: DshSessionMigrationMethod, request: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
}): DshSessionMigrationPort {
  const attempts = new Map<string, string>()
  async function handshake(signal: AbortSignal, expectedEpoch?: string): Promise<string> {
    signal.throwIfAborted()
    const description = await options.describe(signal)
    signal.throwIfAborted()
    proof(description.protocol === BRIDGE_PLUGIN_PROTOCOL && description.sdkVersion === '0.2.1-rc.2'
      && ['1.4.1', '1.5.0', '1.5.1', '1.5.2', '1.5.3'].includes(description.pluginVersion)
      && description.authentication === 'dsh-owner-peer' && validIdentifier(description.issuerEpoch)
      && description.migrationProtocol === MIGRATION_PROTOCOL && description.externalToolAuthorizationVerified === false
      && Array.isArray(description.methods) && description.methods.length <= 32 && description.methods.every(validIdentifier)
      && new Set(description.methods).size === description.methods.length && methods.every(method => description.methods?.includes(method)),
    'DSH_MIGRATION_UNAVAILABLE')
    proof(expectedEpoch === undefined || description.issuerEpoch === expectedEpoch, 'DSH_MIGRATION_EPOCH_CHANGED')
    return description.issuerEpoch
  }
  return Object.freeze({
    async forkPreview(input, signal) {
      const request = previewRequest(input)
      const issuerEpoch = await handshake(signal)
      if (request.targetSelection !== undefined) proof((await options.describe(signal)).migrationApiVersion === 2, 'DSH_MIGRATION_TARGET_SELECTION_UNSUPPORTED')
      signal.throwIfAborted()
      const value = await options.invoke('bridgePlugin/forkPreview', { ...request }, signal)
      signal.throwIfAborted()
      const parsed = object(value, [...previewKeys, 'migrationProtocol', 'issuerEpoch', 'state', 'sourceCursor', 'sourceDigest', 'targetRevision', 'missingReasons'])
      proof(parsed.migrationProtocol === MIGRATION_PROTOCOL && parsed.issuerEpoch === issuerEpoch
        && sameTarget(parsed.targetSelection, request.targetSelection)
        && previewKeys.every(key => parsed[key] === request[key]) && (parsed.state === 'available' || parsed.state === 'blocked')
        && (parsed.sourceCursor === null || cursor(parsed.sourceCursor)) && (parsed.sourceDigest === null || hash(parsed.sourceDigest))
        && (parsed.targetRevision === null || hash(parsed.targetRevision)))
      const missingReasons = reasons(parsed.missingReasons)
      const base = { ...request, migrationProtocol: MIGRATION_PROTOCOL, issuerEpoch, missingReasons }
      if (parsed.state === 'available') {
        proof(cursor(parsed.sourceCursor) && hash(parsed.sourceDigest) && hash(parsed.targetRevision) && missingReasons.length === 0)
        return { ...base, state: 'available', sourceCursor: parsed.sourceCursor, sourceDigest: parsed.sourceDigest, targetRevision: parsed.targetRevision }
      }
      return { ...base, state: 'blocked', sourceCursor: parsed.sourceCursor as number | null,
        sourceDigest: parsed.sourceDigest as string | null, targetRevision: parsed.targetRevision as string | null }
    },
    async forkWithPreset(input, signal) {
      const request = migrationRequest(input)
      signal.throwIfAborted()
      const fingerprint = JSON.stringify(request)
      const previous = attempts.get(request.migrationId)
      proof(previous === undefined, previous === fingerprint ? 'DSH_MIGRATION_ALREADY_ATTEMPTED' : 'DSH_MIGRATION_CONFLICT')
      proof(attempts.size < 1024, 'DSH_MIGRATION_CAPACITY')
      attempts.set(request.migrationId, fingerprint)
      await handshake(signal, request.issuerEpoch)
      if (request.targetSelection !== undefined) proof((await options.describe(signal)).migrationApiVersion === 2, 'DSH_MIGRATION_TARGET_SELECTION_UNSUPPORTED')
      signal.throwIfAborted()
      const value = await options.invoke('bridgePlugin/forkWithPreset', { ...request }, signal)
      signal.throwIfAborted()
      return receipt(value, request, false)
    },
    async inspectMigration(input, signal) {
      const request = migrationRequest(input)
      signal.throwIfAborted()
      const previous = attempts.get(request.migrationId)
      proof(previous === undefined || previous === JSON.stringify(request), 'DSH_MIGRATION_CONFLICT')
      if (previous === undefined) {
        proof(attempts.size < 1024, 'DSH_MIGRATION_CAPACITY')
        attempts.set(request.migrationId, JSON.stringify(request))
      }
      const inspectionEpoch = await handshake(signal)
      signal.throwIfAborted()
      const value = await options.invoke('bridgePlugin/inspectMigration', { ...request }, signal)
      signal.throwIfAborted()
      await handshake(signal, inspectionEpoch)
      signal.throwIfAborted()
      return receipt(value, request, true)
    },
  } satisfies DshSessionMigrationPort)
}
