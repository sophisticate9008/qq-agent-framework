import { readToolRegistrationSource, withToolRegistration, type ToolRegistrationSource } from './tool-registration.js'
import { materializeFrameworkMedia, renderFrameworkMedia, validateFrameworkContent } from './framework-media.js'
import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assertObjectJsonSchema, validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { validIdentifier } from './receipts.js'
import { trimFrameworkChatTools } from './chat-tool-surface.js'

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
interface ToolSpec {
  readonly registrationSource?: ToolRegistrationSource
  readonly name: string
  readonly description: string
  readonly parameters: unknown
  readonly timeoutMs: number
}
export interface FrameworkToolInstall {
  readonly issuerEpoch: string
  readonly sessionId: string
  readonly generation: number
  readonly tools: readonly ToolSpec[]
}
export type FrameworkToolOutcome = { readonly status: 'confirmed'; readonly value: JsonValue; readonly content?: readonly ({readonly type:'text';readonly text:string}|{readonly type:'image';readonly mediaType:'image/png'|'image/jpeg'|'image/webp'|'image/gif';readonly data:string})[] }
  | { readonly status: 'rejected' | 'unknown'; readonly code: string }
export interface FrameworkToolCompletion {
  readonly issuerEpoch: string
  readonly ticket: string
  readonly result: FrameworkToolOutcome
}
interface Claim { readonly requestId: string; readonly userMessageId: string; readonly turn: number }
interface Lease {
  readonly id: string
  readonly agent: Agent
  readonly generation: number
  readonly names: readonly string[]
  readonly disposers: (() => void)[]
  readonly seen: Set<string>
  readonly roots: Map<string, Claim & { readonly name: string }>
}
interface Pending {
  readonly lease: Lease
  readonly wire: { readonly ticket: string; readonly leaseId: string; readonly call: {
    readonly id: string; readonly sessionId: string; readonly generation: number; readonly requestId: string
    readonly userMessageId: string; readonly turn: number; readonly name: string; readonly input: JsonValue; readonly expiresAt: number
  } }
  completing?: boolean
  finish(result: unknown): void
}

function json(value: unknown, maxBytes = 262144): JsonValue {
  let count = 0
  function check(item: unknown, depth: number): void {
    if (++count > 16384 || depth > 24) throw new TypeError('Invalid framework tool data')
    if (item === null || typeof item === 'boolean' || typeof item === 'string' || typeof item === 'number' && Number.isFinite(item)) return
    if (!item || typeof item !== 'object' || !Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype) throw new TypeError('Invalid framework tool data')
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (Array.isArray(item) && key === 'length') continue
      if (!('value' in descriptor) || !descriptor.enumerable) throw new TypeError('Invalid framework tool data')
      check(descriptor.value, depth + 1)
    }
  }
  check(value, 0)
  const text = JSON.stringify(value)
  if (Buffer.byteLength(text) > maxBytes) throw new TypeError('Framework tool data exceeds its bound')
  return JSON.parse(text) as JsonValue
}

/** A real delivery decision ends its tool step; validation failures remain repairable. */
function replyConcludesTurn(result: unknown): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result) || !('status' in result)) return false
  if (result.status === 'unknown') return true
  if (result.status !== 'confirmed' || !('value' in result) || !result.value || typeof result.value !== 'object' || Array.isArray(result.value)) return false
  const value = result.value
  return 'status' in value && (value.status === 'sent' || value.status === 'confirmed' || value.status === 'unknown'
    || value.status === 'rejected' && 'errorCode' in value && value.errorCode === 'AGENT_MESSAGE_SUPPRESSED')
}

/** The owner RPC transports calls; only the real SDK agent/tool pipeline can originate them. */
export function createFrameworkToolChannel(options: { issuerEpoch: string; getAgent(sessionId: string): Agent | undefined;
  readonly onReplyAttempt?: (agent: Agent, claim: Claim) => void }) {
  const leases = new Map<string, Lease>()
  const claims = new WeakMap<Agent, Claim>()
  const pending = new Map<string, Pending>()
  const waiters = new Set<() => void>()
  let closed = false
  function epoch(value: string): void {
    if (closed || value !== options.issuerEpoch) throw new TypeError('Framework tool channel epoch changed')
  }
  function wake(): void { for (const notify of [...waiters]) notify() }
  function page() {
    return { schema: 1 as const, issuerEpoch: options.issuerEpoch, calls: [...pending.values()].map(entry => json(entry.wire)) }
  }
  function withdraw(lease: Lease): void {
    if (leases.get(lease.agent.id) === lease) leases.delete(lease.agent.id)
    for (const dispose of lease.disposers.splice(0)) dispose()
    for (const entry of pending.values()) if (entry.lease === lease) entry.finish({ status: 'unknown', code: 'TOOL_PROJECTION_WITHDRAWN' })
  }
  return Object.freeze({
    projectedNames(agent: Agent): readonly string[] {
      const lease = leases.get(agent.id)
      return lease?.agent === agent && options.getAgent(agent.id) === agent ? lease.names : []
    },
    recordClaim(agent: Agent, claim: Claim): void {
      if (options.getAgent(agent.id) !== agent || !validIdentifier(claim.requestId) || !validIdentifier(claim.userMessageId)
        || !Number.isSafeInteger(claim.turn) || claim.turn < 0) return
      const prior = claims.get(agent)
      if (!prior || prior.turn !== claim.turn || prior.requestId !== claim.requestId || prior.userMessageId !== claim.userMessageId) {
        const lease = leases.get(agent.id)
        if (lease?.agent === agent) { lease.seen.clear(); lease.roots.clear() }
      }
      claims.set(agent, Object.freeze({ ...claim }))
    },
    recordToolCalls(agent: Agent, turn: number, content: unknown): void {
      const claim = claims.get(agent)
      const lease = leases.get(agent.id)
      if (!claim || claim.turn !== turn || lease?.agent !== agent || !Array.isArray(content)) return
      for (const block of content) {
        if (block && typeof block === 'object' && !Array.isArray(block) && block.type === 'tool-call'
          && validIdentifier(block.id) && typeof block.name === 'string' && lease.roots.size < 4096)
          lease.roots.set(block.id, { ...claim, name: block.name })
      }
    },
    clearClaim(agent: Agent): void {
      claims.delete(agent)
      const lease = leases.get(agent.id)
      if (lease?.agent === agent) { lease.seen.clear(); lease.roots.clear() }
    },
    endTurn(agent: Agent, turn: number): void {
      if (claims.get(agent)?.turn !== turn) return
      claims.delete(agent)
      const lease = leases.get(agent.id)
      if (lease?.agent === agent) { lease.seen.clear(); lease.roots.clear() }
    },
    install(request: FrameworkToolInstall) {
      epoch(request.issuerEpoch)
      if (!validIdentifier(request.sessionId) || !Number.isSafeInteger(request.generation) || request.generation < 1
        || !Array.isArray(request.tools) || request.tools.length < 1 || request.tools.length > 32
        || leases.has(request.sessionId) || leases.size >= 32) throw new TypeError('Invalid framework tool projection')
      const agent = options.getAgent(request.sessionId)
      if (!agent || agent.session.id !== request.sessionId) throw new TypeError('Framework tool agent is unavailable')
      const specs = request.tools.map(spec => {
        if (!spec || !/^qbf_[a-z][a-z0-9_]{0,79}$/.test(spec.name) || typeof spec.description !== 'string'
          || spec.description.length < 1 || spec.description.length > 4000 || !Number.isSafeInteger(spec.timeoutMs)
          || spec.timeoutMs < 10 || spec.timeoutMs > 300000) throw new TypeError('Invalid framework tool definition')
        if (spec.registrationSource !== undefined && !readToolRegistrationSource(spec.registrationSource)) throw new TypeError('Invalid tool registration source')
        const parameters = json(spec.parameters)
        assertObjectJsonSchema(parameters)
        return { ...spec, parameters }
      })
      if (new Set(specs.map(spec => spec.name)).size !== specs.length) throw new TypeError('Duplicate framework tool definition')
      const lease: Lease = { id: randomUUID(), agent, generation: request.generation, names: specs.map(spec => spec.name),
        disposers: [], seen: new Set(), roots: new Map() }
      leases.set(agent.id, lease)
      try {
        const restoreTools = trimFrameworkChatTools(agent)
        if (restoreTools) lease.disposers.push(restoreTools)
        for (const spec of specs) {
          const definition: ToolDefinition = { name: spec.name, description: spec.description, parameters: spec.parameters,
            output: { schema: { type: 'object', properties: { status: { type: 'string' }, value: {}, code: { type: 'string' }, rendered: { type: 'array' } },
              required: ['status'], additionalProperties: false }, render: (_input, value) => {
              const result = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
              const { rendered: _rendered, ...summary } = result
              return [{ type: 'text', text: JSON.stringify(summary) }, ...renderFrameworkMedia(value)]
            } },
            execute: async (args, exec): Promise<unknown> => {
              if (validateJsonSchemaValue(spec.parameters, args).length) return { status: 'rejected', code: 'INVALID_TOOL_INPUT' }
              const claim = claims.get(agent)
              const root = lease.roots.get(exec.rootCallId)
              if (leases.get(agent.id) !== lease || options.getAgent(agent.id) !== agent || exec.agent !== agent
                || agent.status !== 'running' || !claim || !root || root.turn !== claim.turn || root.requestId !== claim.requestId
                || root.userMessageId !== claim.userMessageId || exec.callId === exec.rootCallId && root.name !== spec.name
                || exec.signal.aborted) return { status: 'rejected', code: 'TOOL_SOURCE_UNAVAILABLE' }
              if (pending.size >= 128 || lease.seen.size >= 4096) return { status: 'rejected', code: 'TOOL_CALL_CAPACITY' }
              if (lease.seen.has(exec.callId)) return { status: 'unknown', code: 'TOOL_CALL_ALREADY_OBSERVED' }
              const input = json(args)
              if (Buffer.byteLength(JSON.stringify(input)) > 65536) return { status: 'rejected', code: 'TOOL_INPUT_TOO_LARGE' }
              lease.seen.add(exec.callId)
              if (spec.name === 'qbf_reply') options.onReplyAttempt?.(agent, claim)
              return new Promise<unknown>(resolve => {
                const ticket = randomUUID()
                let timer: ReturnType<typeof setTimeout>
                const abort = () => finish({ status: 'unknown', code: 'TOOL_CALL_CANCELLED' })
                const finish = (result: unknown): void => {
                  if (!pending.delete(ticket)) return
                  clearTimeout(timer)
                  exec.signal.removeEventListener('abort', abort)
                  if (spec.name === 'qbf_reply' && !exec.signal.aborted && replyConcludesTurn(result)) exec.concludeTurn()
                  resolve(result)
                }
                const wire = { ticket, leaseId: lease.id, call: { id: exec.callId, sessionId: agent.id, generation: lease.generation,
                  ...claim, name: spec.name, input, expiresAt: Date.now() + spec.timeoutMs } }
                pending.set(ticket, { lease, wire, finish })
                timer = setTimeout(() => finish({ status: 'unknown', code: 'TOOL_HOST_TIMEOUT' }), spec.timeoutMs)
                exec.signal.addEventListener('abort', abort, { once: true })
                if (exec.signal.aborted) abort()
                else wake()
              })
            } }
          lease.disposers.push(agent.ctx.tools.register(spec.registrationSource ? withToolRegistration(definition, spec.registrationSource) : definition))
        }
      } catch (error) { withdraw(lease); throw error }
      return { schema: 1 as const, issuerEpoch: options.issuerEpoch, sessionId: agent.id, leaseId: lease.id,
        generation: lease.generation, names: specs.map(spec => spec.name) }
    },
    withdraw(request: { issuerEpoch: string; sessionId: string; leaseId: string }) {
      epoch(request.issuerEpoch)
      const lease = leases.get(request.sessionId)
      if (lease?.id === request.leaseId) withdraw(lease)
      return { schema: 1 as const, withdrawn: lease?.id === request.leaseId }
    },
    inspect(request: { issuerEpoch: string; sessionId: string }) {
      epoch(request.issuerEpoch)
      if (!validIdentifier(request.sessionId)) throw new TypeError('Invalid framework tool session')
      const lease = leases.get(request.sessionId)
      if (lease && options.getAgent(request.sessionId) !== lease.agent) withdraw(lease)
      const current = leases.get(request.sessionId)
      return { schema: 1 as const, issuerEpoch: options.issuerEpoch, projection: current ? {
        sessionId: request.sessionId, generation: current.generation, leaseId: current.id,
        names: [...current.names]
      } : null }
    },
    poll(request: { issuerEpoch: string }) {
      epoch(request.issuerEpoch)
      return page()
    },
    async waitForCalls(request: { issuerEpoch: string; waitMs?: number }, signal: AbortSignal) {
      epoch(request.issuerEpoch)
      const waitMs = request.waitMs ?? 0
      if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 10000) throw new TypeError('Invalid framework tool wait')
      signal.throwIfAborted()
      if (pending.size === 0 && waitMs > 0) {
        if (waiters.size >= 32) throw new TypeError('Framework tool waiter capacity reached')
        await new Promise<void>((resolve, reject) => {
          const finish = () => {
            clearTimeout(timer)
            waiters.delete(finish)
            signal.removeEventListener('abort', abort)
            if (signal.aborted) reject(signal.reason)
            else resolve()
          }
          const abort = () => finish()
          const timer = setTimeout(finish, waitMs)
          waiters.add(finish)
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) finish()
        })
      }
      signal.throwIfAborted()
      epoch(request.issuerEpoch)
      return page()
    },
    async complete(request: FrameworkToolCompletion, signal: AbortSignal = new AbortController().signal) {
      epoch(request.issuerEpoch)
      const value = json(request.result, 512 * 1024)
      if (value === null || typeof value !== 'object' || Array.isArray(value)
        || (value.status !== 'confirmed' || !Object.hasOwn(value, 'value') || Object.keys(value).some(key => key !== 'status' && key !== 'value' && key !== 'content'))
        && (!['unknown', 'rejected'].includes(String(value.status)) || typeof value.code !== 'string'
          || !/^[A-Z][A-Z0-9_]{1,63}$/.test(value.code) || Object.keys(value).some(key => key !== 'status' && key !== 'code'))) {
        throw new TypeError('Invalid framework tool result')
      }
      if (value.status === 'confirmed' && value.content !== undefined) validateFrameworkContent(value.content)
      const entry = pending.get(request.ticket)
      if (entry?.completing) return { schema: 1 as const, accepted: false }
      if (entry && value.status === 'confirmed' && value.content !== undefined) {
        entry.completing = true
        const agent = entry.lease.agent
        const claim = claims.get(agent)
        if (options.getAgent(agent.id) !== agent || !claim || claim.requestId !== entry.wire.call.requestId
          || claim.userMessageId !== entry.wire.call.userMessageId || claim.turn !== entry.wire.call.turn) {
          entry.finish({ status: 'rejected', code: 'TOOL_MEDIA_SOURCE_CHANGED' })
        } else {
          try {
            const materialized = await materializeFrameworkMedia(agent, value.value!, value.content, signal)
            signal.throwIfAborted()
            if (pending.get(request.ticket) !== entry) return { schema: 1 as const, accepted: false }
            if (leases.get(agent.id) !== entry.lease || claims.get(agent) !== claim) {
              entry.finish({ status: 'rejected', code: 'TOOL_MEDIA_SOURCE_CHANGED' })
            } else entry.finish({ status: 'confirmed', ...materialized })
          } catch (error) {
            // Media processing failures belong to this call, not the owner RPC channel.
            if (pending.get(request.ticket) !== entry) return { schema: 1 as const, accepted: false }
            const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
              && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : 'TOOL_MEDIA_PROCESSING_FAILED'
            entry.finish({ status: 'unknown', code: signal.aborted ? 'TOOL_CALL_CANCELLED' : code })
          }
        }
      } else entry?.finish(value)
      return { schema: 1 as const, accepted: entry !== undefined }
    },
    close(): void { closed = true; wake(); for (const lease of leases.values()) withdraw(lease) }
  })
}
