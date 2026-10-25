import { isDshWorkOutput } from '../contracts/dsh-work.ts'
import type { DshWorkMediaReference, DshWorkAddress, DshWorkSnapshot, DshWorkStart, DshWorkTarget } from '../contracts/dsh-work.ts'
import { DshAdapterError } from './dsh.ts'
import { isRecord, reference, snapshot } from '../core/values.ts'

export type DshWorkMethod = 'bridgePlugin/verifyWork' | 'bridgePlugin/startWork' | 'bridgePlugin/inspectWork'
  | 'bridgePlugin/followupWork' | 'bridgePlugin/interruptWork' | 'bridgePlugin/readWorkAsset'
export interface DshWorkPort {
  verify(request: DshWorkTarget & { issuerEpoch: string }, signal: AbortSignal): Promise<boolean>
  start(request: DshWorkStart, signal: AbortSignal): Promise<DshWorkSnapshot>
  inspect(request: DshWorkAddress, signal: AbortSignal): Promise<DshWorkSnapshot>
  followup(request: DshWorkAddress & { requestId: string; text: string; delivery: 'queue' | 'steer' }, signal: AbortSignal): Promise<{ messageId: string }>
  readAsset?(request: DshWorkAddress & { kind: 'image' | 'file'; attachmentId: string }, signal: AbortSignal): Promise<{ asset: DshWorkMediaReference; data: Uint8Array }>
  interrupt(request: DshWorkAddress, signal: AbortSignal): Promise<void>
}

export function createDshWorkPort(invoke: (method: DshWorkMethod, request: unknown, signal: AbortSignal) => Promise<unknown>): DshWorkPort {
  const invalid = (): never => { throw new DshAdapterError('DSH_WORK_INVALID_RESPONSE', 'The SDK work result could not be verified.') }
  async function read(method: 'bridgePlugin/startWork' | 'bridgePlugin/inspectWork', address: DshWorkAddress, signal: AbortSignal) {
    const value = snapshot(await invoke(method, address, signal))
    if (!isRecord(value) || value.schema !== 1 || Object.entries(address).some(([key, expected]) =>
      ['issuerEpoch', 'id', 'parentSessionId', 'childId', 'generation'].includes(key) && value[key] !== expected)
      || !['starting', 'running', 'completed', 'unknown'].includes(String(value.state))
      || value.error !== null && (typeof value.error !== 'string' || !/^[A-Z][A-Z_]{1,63}$/.test(value.error))
      || value.result !== null && (!isRecord(value.result) || !reference(value.result.stopReason)
        || !Array.isArray(value.result.output) || value.result.output.length > 256
        || value.result.output.some(block => !isDshWorkOutput(block)))
      || value.state === 'completed' && value.result === null || Buffer.byteLength(JSON.stringify(value)) > 262144) return invalid()
    return value as unknown as DshWorkSnapshot
  }
  return Object.freeze<DshWorkPort>({
    async verify(request, signal) {
      const value = await invoke('bridgePlugin/verifyWork', request, signal)
      if (!isRecord(value) || value.schema !== 1 || value.issuerEpoch !== request.issuerEpoch || typeof value.available !== 'boolean'
        || value.provider !== 'spawn' || value.continuable !== true || value.externalToolAuthorizationVerified !== false) return invalid()
      return value.available
    },
    start: (request, signal) => read('bridgePlugin/startWork', request, signal),
    inspect: (request, signal) => read('bridgePlugin/inspectWork', request, signal),
    async followup(request, signal) {
      const value = await invoke('bridgePlugin/followupWork', request, signal)
      if (!isRecord(value) || !reference(value.messageId)) return invalid()
      return { messageId: value.messageId }
    },
    async readAsset(request, signal) {
      const chunks: Buffer[] = []
      let offset = 0
      let asset: DshWorkMediaReference | undefined
      for (;;) {
        signal.throwIfAborted()
        const value = await invoke('bridgePlugin/readWorkAsset', { ...request, offset, limit: 192 * 1024 }, signal)
        if (!isRecord(value) || value.schema !== 1 || Object.entries(request).some(([key, expected]) =>
          ['issuerEpoch', 'id', 'parentSessionId', 'childId', 'generation'].includes(key) && value[key] !== expected)
          || !isDshWorkOutput(value.asset) || value.asset.type !== 'media-reference'
          || value.asset.attachmentId !== request.attachmentId || value.asset.kind !== request.kind
          || value.offset !== offset || typeof value.data !== 'string' || value.data.length > 262144
          || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)
          || asset !== undefined && JSON.stringify(asset) !== JSON.stringify(value.asset)) return invalid()
        asset = value.asset
        const chunk = Buffer.from(value.data, 'base64')
        const end = offset + chunk.length
        if (chunk.length < 1 || end > asset.bytes || end > 8 * 1024 * 1024
          || (end === asset.bytes ? value.nextOffset !== null : value.nextOffset !== end)) return invalid()
        chunks.push(chunk)
        if (value.nextOffset === null) return { asset, data: Buffer.concat(chunks) }
        offset = end
      }
    },
    async interrupt(request, signal) {
      const value = await invoke('bridgePlugin/interruptWork', request, signal)
      if (!isRecord(value) || value.accepted !== true) return invalid()
    }
  })
}
