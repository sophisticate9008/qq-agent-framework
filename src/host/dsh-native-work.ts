import type { DshWorkPort } from '../adapters/dsh-work.ts'
import type { DshWorkAddress, DshWorkMediaReference, DshWorkSnapshot, DshWorkUsageStep } from '../contracts/dsh-work.ts'
import type { MessageContent } from '../contracts/messages.ts'
import { normalizeContent } from '../core/content.ts'
import { assert } from '../core/values.ts'
import { withDeadline } from './deadlines.ts'
import type { NativeWorkBackend, NativeWorkBackendAddress } from './native-work.ts'
import type { NativeWorkConfiguration } from './native-work-configuration.ts'

export function createDshNativeWorkBackend(options: {
  readonly port: DshWorkPort
  readonly issuerEpoch: string
  readonly generation: (parentSessionId: string) => number | null
  /** Map the framework provider identity to the verified DSH provider route. */
  readonly resolveTarget: (configuration: Readonly<NativeWorkConfiguration>, signal: AbortSignal) => Promise<{
    modelProvider: string; model: string; agentPreset: string; reasoningEffort?: string
  }>
  readonly registerResultAsset?: (request: { readonly address: DshWorkAddress; readonly asset: DshWorkMediaReference;
    readonly signal: AbortSignal }) => Promise<MessageContent>
  readonly recordUsage?: (request: { readonly address: DshWorkAddress; readonly steps: readonly DshWorkUsageStep[]; readonly provider?: string }) => void
  readonly pollIntervalMs?: number
}): NativeWorkBackend {
  const interval = options.pollIntervalMs ?? 100
  assert(Number.isSafeInteger(interval) && interval >= 10 && interval <= 5000,
    'INVALID_WORK_BACKEND_OPTIONS', 'Work polling requires a bounded interval.')
  function address(request: NativeWorkBackendAddress): DshWorkAddress {
    assert(options.generation(request.parentSessionId) === request.generation,
      'WORK_PARENT_UNAVAILABLE', 'Work control requires the current original parent generation.')
    return { issuerEpoch: options.issuerEpoch, id: request.id, childId: request.childId,
      parentSessionId: request.parentSessionId, generation: request.generation }
  }
  async function mapResult(value: NonNullable<DshWorkSnapshot['result']>, workAddress: DshWorkAddress, signal: AbortSignal) {
    const output: MessageContent[] = []
    for (const block of value.output) {
      signal.throwIfAborted()
      if (block.type === 'text') {
        for (let offset = 0; offset < block.text.length; offset += 8000) output.push({ type: 'text', text: block.text.slice(offset, offset + 8000) })
      } else {
        assert(options.registerResultAsset, 'WORK_MEDIA_REGISTRATION_UNAVAILABLE', 'A scoped SDK attachment registrar is required for this work result.')
        const registered = await options.registerResultAsset({ address: workAddress, asset: block, signal })
        assert(registered.type === block.kind, 'WORK_MEDIA_REGISTRATION_INVALID', 'The registered work media kind changed.')
        output.push(...normalizeContent([registered]))
      }
    }
    assert(output.length <= 256, 'WORK_OUTPUT_LIMIT', 'The registered work result exceeds its content limit.')
    return { stopReason: value.stopReason, output }
  }
  return Object.freeze<NativeWorkBackend>({
    async verify(request) {
      assert(options.generation(request.parentSessionId) !== null, 'WORK_PARENT_UNAVAILABLE', 'The parent session is no longer current.')
      const target = await options.resolveTarget(request.configuration, request.signal)
      assert(await options.port.verify({ issuerEpoch: options.issuerEpoch, parentSessionId: request.parentSessionId, ...target, fullAccess: request.configuration.fullAccess }, request.signal),
        'NATIVE_WORK_BACKEND_UNAVAILABLE', 'A continuable SDK spawn provider and selected preset are required.')
    },
    async start(request) {
      const generation = options.generation(request.parentSessionId)
      assert(generation !== null, 'WORK_PARENT_UNAVAILABLE', 'The parent session is no longer current.')
      assert(request.generation === undefined || request.generation === generation,
        'WORK_PARENT_UNAVAILABLE', 'The requested parent generation is no longer current.')
      const target = await options.resolveTarget(request.configuration, request.signal)
      const address: DshWorkAddress = { issuerEpoch: options.issuerEpoch, id: request.id, childId: request.childId,
        parentSessionId: request.parentSessionId, generation }
      assert(options.generation(request.parentSessionId) === generation, 'WORK_PARENT_UNAVAILABLE', 'The parent generation changed during preflight.')
      const initial = await options.port.start({ ...address, ...target, fullAccess: request.configuration.fullAccess, task: request.task, context: request.context,
        timeoutMs: request.configuration.timeoutMs }, request.signal)
      const lifetime = new AbortController()
      const result = withDeadline({ signal: lifetime.signal, timeoutMs: request.configuration.timeoutMs, code: 'WORK_RESULT_UNKNOWN', run: async signal => {
        let current = initial
        for (;;) {
          if (current.usage?.length) options.recordUsage?.({ address, steps: current.usage, ...(request.configuration.provider ? { provider: request.configuration.provider } : {}) })
          assert(current.state !== 'unknown', 'WORK_RESULT_UNKNOWN', 'The remote work result is uncertain and cannot be replayed.')
          if (current.state === 'completed' && current.result) return mapResult(current.result, address, signal)
          await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(signal.reason) }
            const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, interval)
            signal.addEventListener('abort', abort, { once: true })
            if (signal.aborted) abort()
          })
          current = await options.port.inspect(address, signal)
        }
      } })
      let disposal: Promise<void> | undefined
      return { childId: address.childId, result,
        dispose(): Promise<void> {
          disposal ??= (async () => {
            lifetime.abort()
            await withDeadline({ signal: new AbortController().signal, timeoutMs: 5000, code: 'WORK_STOP_UNKNOWN',
              run: signal => options.port.interrupt(address, signal) })
          })()
          return disposal
        } }
    },
    async inspect(request) {
      const value = await options.port.inspect(address(request), request.signal)
      if (value.usage?.length) options.recordUsage?.({ address: address(request), steps: value.usage })
      return { state: value.state, result: value.result ? await mapResult(value.result, address(request), request.signal) : null }
    },
    followup(request) {
      return options.port.followup({ ...address(request), requestId: request.requestId, text: request.text, delivery: request.delivery }, request.signal)
    },
    interrupt(request) { return options.port.interrupt(address(request), request.signal) }
  })
}
