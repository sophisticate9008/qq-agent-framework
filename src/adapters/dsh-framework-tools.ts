import type { FrameworkToolDefinition, FrameworkToolPendingCall, FrameworkToolResult } from '../contracts/framework-tools.ts'
import { DshAdapterError } from './dsh.ts'
import { isRecord, reference, snapshot } from '../core/values.ts'
import { projectDshToolSchema } from './dsh-tool-schema.ts'

export type DshFrameworkToolMethod = 'bridgePlugin/installFrameworkTools' | 'bridgePlugin/withdrawFrameworkTools'
  | 'bridgePlugin/pollFrameworkTools' | 'bridgePlugin/completeFrameworkTool' | 'bridgePlugin/inspectFrameworkTools'
export interface DshFrameworkToolPort {
  inspect(request: { issuerEpoch: string; sessionId: string }, signal: AbortSignal): Promise<{
    sessionId: string; generation: number; leaseId: string; names: readonly string[]
  } | null>
  install(request: { issuerEpoch: string; sessionId: string; generation: number; tools: readonly FrameworkToolDefinition[] }, signal: AbortSignal):
    Promise<{ leaseId: string; sessionId: string; generation: number; names: readonly string[] }>
  withdraw(request: { issuerEpoch: string; sessionId: string; leaseId: string }, signal: AbortSignal): Promise<boolean>
  poll(request: { issuerEpoch: string }, signal: AbortSignal): Promise<readonly FrameworkToolPendingCall[]>
  complete(request: { issuerEpoch: string; ticket: string; result: FrameworkToolResult }, signal: AbortSignal): Promise<boolean>
}

export function createDshFrameworkToolPort(invoke: (method: DshFrameworkToolMethod, request: unknown, signal: AbortSignal) => Promise<unknown>): DshFrameworkToolPort {
  const invalid = (): never => { throw new DshAdapterError('DSH_TOOL_INVALID_RESPONSE', 'The framework tool channel could not be verified.') }
  const epoch = (value: unknown, expected: string) => isRecord(value) && value.schema === 1 && value.issuerEpoch === expected
  return Object.freeze<DshFrameworkToolPort>({
    async inspect(request, signal) {
      const value = snapshot(await invoke('bridgePlugin/inspectFrameworkTools', request, signal))
      if (!epoch(value, request.issuerEpoch) || !isRecord(value) || !Object.hasOwn(value, 'projection')) return invalid()
      if (value.projection === null) return null
      const projection = value.projection
      if (!isRecord(projection) || projection.sessionId !== request.sessionId || !reference(projection.leaseId)
        || !Number.isSafeInteger(projection.generation) || Number(projection.generation) < 1
        || !Array.isArray(projection.names) || projection.names.length > 32 || !projection.names.every(reference)
        || new Set(projection.names).size !== projection.names.length) return invalid()
      return { sessionId: request.sessionId, generation: Number(projection.generation), leaseId: projection.leaseId, names: projection.names }
    },
    async install(request, signal) {
      const wire = { ...request, tools: request.tools.map(tool => ({ ...tool, parameters: projectDshToolSchema(tool.parameters) })) }
      const value = snapshot(await invoke('bridgePlugin/installFrameworkTools', wire, signal))
      if (!epoch(value, request.issuerEpoch) || !isRecord(value) || !reference(value.leaseId)
        || value.sessionId !== request.sessionId || value.generation !== request.generation || !Array.isArray(value.names)
        || JSON.stringify([...value.names].sort()) !== JSON.stringify(request.tools.map(tool => tool.name).sort())) return invalid()
      return { leaseId: value.leaseId, sessionId: request.sessionId, generation: request.generation, names: value.names as string[] }
    },
    async withdraw(request, signal) {
      const value = await invoke('bridgePlugin/withdrawFrameworkTools', request, signal)
      if (!isRecord(value) || value.schema !== 1 || typeof value.withdrawn !== 'boolean') return invalid()
      return value.withdrawn
    },
    async poll(request, signal) {
      const value = snapshot(await invoke('bridgePlugin/pollFrameworkTools', request, signal))
      if (!epoch(value, request.issuerEpoch) || !isRecord(value) || !Array.isArray(value.calls) || value.calls.length > 128
        || Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) return invalid()
      for (const entry of value.calls) {
        if (!isRecord(entry) || !reference(entry.ticket) || !reference(entry.leaseId) || !isRecord(entry.call)) return invalid()
        const call = entry.call
        if (Object.keys(call).sort().join(',') !== 'expiresAt,generation,id,input,name,requestId,sessionId,turn,userMessageId'
          || !reference(call.id) || !reference(call.sessionId) || !reference(call.name) || !reference(call.requestId) || !reference(call.userMessageId)
          || !Number.isSafeInteger(call.generation) || Number(call.generation) < 1 || !Number.isSafeInteger(call.turn) || Number(call.turn) < 0
          || !Number.isSafeInteger(call.expiresAt) || !Object.hasOwn(call, 'input')) return invalid()
      }
      return value.calls as unknown as readonly FrameworkToolPendingCall[]
    },
    async complete(request, signal) {
      const value = await invoke('bridgePlugin/completeFrameworkTool', request, signal)
      if (!isRecord(value) || value.schema !== 1 || typeof value.accepted !== 'boolean') return invalid()
      return value.accepted
    }
  })
}
