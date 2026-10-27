import { FRAMEWORK_MEDIA_WIRE_BYTES, frameworkImageBytes, type FrameworkToolProjectedResult } from '../contracts/framework-media.ts'
import { createHash } from 'node:crypto'
import type { FrameworkToolCall, FrameworkToolDefinition, FrameworkToolResult } from '../contracts/framework-tools.ts'
import type { EffectRequest, EffectScope, JsonValue } from '../core/types.ts'
import { assert, errorCode, identifier, reference, snapshot } from '../core/values.ts'
import { withDeadline } from './deadlines.ts'

export interface FrameworkToolRegistryOptions {
  /** Resolve the current authoritative QQ binding and source; never trust caller scope. */
  readonly resolveScope: (call: Readonly<FrameworkToolCall>, signal: AbortSignal) => Promise<Readonly<EffectScope> | null>
  /** Must enter the host engine's feature invocation and policy path. */
  readonly invoke: (capability: string, request: EffectRequest) => Promise<JsonValue>
  readonly projectResult?: (definition: Readonly<FrameworkToolDefinition>, value: JsonValue, scope: Readonly<EffectScope>,
    signal: AbortSignal) => FrameworkToolProjectedResult | Promise<FrameworkToolProjectedResult>
  readonly maxCalls?: number
}

export function createFrameworkToolRegistry(options: FrameworkToolRegistryOptions) {
  const definitions = new Map<string, { definition: FrameworkToolDefinition; validate: (input: JsonValue) => JsonValue }>()
  const calls = new Map<string, { fingerprint: string; result: Promise<FrameworkToolResult> }>()
  const lifetime = new AbortController()
  const maxCalls = options.maxCalls ?? 4096
  assert(Number.isSafeInteger(maxCalls) && maxCalls > 0 && maxCalls <= 65536,
    'INVALID_TOOL_OPTIONS', 'Tool call retention must be bounded.')
  let closed = false

  return Object.freeze({
    register(value: FrameworkToolDefinition, validate: (input: JsonValue) => JsonValue): () => void {
      const definition = snapshot(value)
      assert(!closed && /^qaf_[a-z][a-z0-9_]{0,79}$/.test(definition.name)
        && identifier(definition.featureId) && identifier(definition.capability)
        && definition.description.length > 0 && definition.description.length <= 4000
        && definition.parameters.type === 'object' && definition.parameters.additionalProperties === false
        && Number.isSafeInteger(definition.timeoutMs)
        && definition.timeoutMs >= 10 && definition.timeoutMs <= 300000 && !definitions.has(definition.name),
      'INVALID_FRAMEWORK_TOOL', 'A tool needs a unique name, fixed capability, schema and deadline.')
      const entry = { definition, validate }
      definitions.set(definition.name, entry)
      return () => { if (definitions.get(definition.name) === entry) definitions.delete(definition.name) }
    },
    describe(): readonly FrameworkToolDefinition[] { return Object.freeze([...definitions.values()].map(entry => entry.definition)) },
    async execute(raw: FrameworkToolCall, signal: AbortSignal): Promise<FrameworkToolResult> {
      let call: FrameworkToolCall
      try {
        call = snapshot(raw)
        assert(Object.keys(call).sort().join(',') === 'expiresAt,generation,id,input,name,requestId,sessionId,turn,userMessageId'
          && reference(call.id) && reference(call.sessionId) && reference(call.requestId) && reference(call.userMessageId)
          && Number.isSafeInteger(call.generation) && call.generation > 0 && Number.isSafeInteger(call.turn) && call.turn >= 0
          && Number.isSafeInteger(call.expiresAt)
          && Buffer.byteLength(JSON.stringify(call)) <= 65536,
        'INVALID_TOOL_CALL', 'A tool call needs bounded input and an exact session identity.')
      } catch { return { status: 'rejected', code: 'INVALID_TOOL_CALL' } }
      const key = JSON.stringify([call.sessionId, call.id])
      const fingerprint = createHash('sha256').update(JSON.stringify(call)).digest('hex')
      const prior = calls.get(key)
      if (prior) return prior.fingerprint === fingerprint ? prior.result : { status: 'rejected', code: 'TOOL_CALL_CONFLICT' }
      if (closed || calls.size >= maxCalls) return { status: 'rejected', code: closed ? 'TOOL_REGISTRY_CLOSED' : 'TOOL_CALL_CAPACITY' }
      const entry = definitions.get(call.name)
      if (!entry) return { status: 'rejected', code: 'TOOL_UNAVAILABLE' }
      const result = (async (): Promise<FrameworkToolResult> => {
        let invoked = false
        try {
          const timeoutMs = Math.min(entry.definition.timeoutMs, call.expiresAt - Date.now())
          assert(timeoutMs > 0, 'TOOL_CALL_EXPIRED', 'The tool request expired.')
          return await withDeadline({ signal: AbortSignal.any([signal, lifetime.signal]), timeoutMs,
            code: 'TOOL_EXECUTION_UNKNOWN', run: async currentSignal => {
              const scope = await options.resolveScope(call, currentSignal)
              assert(scope && scope.sessionId === call.sessionId && reference(scope.conversationId)
                && reference(scope.eventId) && scope.generation === call.generation,
              'TOOL_SOURCE_UNAVAILABLE', 'No current trusted QQ source is bound to this tool call.')
              assert(definitions.get(call.name) === entry && !closed, 'TOOL_UNAVAILABLE', 'The tool was withdrawn.')
              const input = snapshot(entry.validate(call.input))
              currentSignal.throwIfAborted()
              invoked = true
              const value = snapshot(await options.invoke(entry.definition.capability,
                { input, scope: snapshot({ ...scope, featureId: entry.definition.featureId }), signal: currentSignal }))
              const projected = snapshot(options.projectResult ? await options.projectResult(entry.definition, value, scope, currentSignal) : { value })
              currentSignal.throwIfAborted()
              assert(Buffer.byteLength(JSON.stringify(projected.value)) <= 262144 && Buffer.byteLength(JSON.stringify(projected)) <= FRAMEWORK_MEDIA_WIRE_BYTES,
                'TOOL_RESULT_TOO_LARGE', 'The tool result exceeds its limit.')
              assert(projected.content === undefined || projected.content.length <= 8 && projected.content.every(block =>
                block.type === 'text' ? typeof block.text === 'string' && block.text.length <= 16000
                  : block.type === 'image' && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(block.mediaType)
                    && frameworkImageBytes(block.data) !== null), 'INVALID_FRAMEWORK_MEDIA_RESULT', 'Invalid structured tool content.')
              return { status: 'confirmed', ...projected }
            } })
        } catch (error) {
          const code = errorCode(error, 'TOOL_EXECUTION_UNKNOWN')
          const rejected = !invoked || ['POLICY_DENIED', 'CAPABILITY_DENIED', 'FEATURE_DISABLED', 'CAPABILITY_UNAVAILABLE',
            'NATIVE_WORK_PREPARATION_REJECTED', 'ASSISTANT_CONFIGURATION_CHANGED',
            'INVALID_CONVERSATION_INPUT', 'CONVERSATION_SCOPE_INVALID', 'CONVERSATION_SCOPE_MISMATCH',
            'POKE_SCOPE_MISMATCH', 'POKE_TARGET_NOT_MEMBER', 'RECALL_MESSAGE_SCOPE_MISMATCH', 'INVALID_STICKER_INPUT',
            'BUDGET_EXHAUSTED', 'POLICY_PAUSED', 'NATIVE_MESSAGE_SOURCE_NOT_OWNER', 'INVALID_MEDIA_INPUT',
            'NATIVE_MEDIA_UNAVAILABLE', 'NATIVE_MEDIA_READER_UNAVAILABLE', 'REMINDER_INVALID', 'REMINDER_NOT_FOUND',
            'REMINDER_CONFLICT', 'MEMORY_INVALID', 'MEMORY_SOURCE_INVALID', 'MEMORY_SOURCE_SCOPE_MISMATCH',
            'MEMORY_ACCESS_DENIED', 'MEMORY_OWNER_REQUIRED', 'INVALID_APPEARANCE_REFERENCE', 'APPEARANCE_NOT_FOUND',
            'APPEARANCE_PERSONA_NOT_FOUND', 'APPEARANCE_BINDING_MISMATCH', 'APPEARANCE_BINDING_CHANGED',
            'NATIVE_APPEARANCE_UNAVAILABLE', 'NATIVE_APPEARANCE_BINDING_CHANGED'].includes(code)
          return { status: rejected ? 'rejected' : 'unknown', code }
        }
      })()
      calls.set(key, { fingerprint, result })
      return result
    },
    close(): void { closed = true; lifetime.abort(); definitions.clear() }
  })
}
