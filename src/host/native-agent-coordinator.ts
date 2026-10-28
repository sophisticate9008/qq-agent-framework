import { createHash } from 'node:crypto'
import type { DshJsonRpcPort, DshPresetBinding } from '../adapters/dsh-jsonrpc.ts'
import type { ChatSessionDefinition } from '../contracts/chat-session.ts'
import { parseNativeReplyDecision } from '../contracts/native-reply-decision.ts'
import type { JsonObject } from '../core/types.ts'
import { errorCode, FrameworkError } from '../core/values.ts'
import type { AgentAdapter, AgentEvent, DurableStore, SessionBinding } from './types.ts'
import type { NativeChatConfiguration } from './native-chat-configuration.ts'
import type { createBridgeHost } from './bridge.ts'
import type { createNativeExecutionController, NativeExecutionRecord } from './native-execution.ts'
import type { createNativeExecutionClaims } from './native-execution-claims.ts'
import type { createNativeFrameworkTools } from './native-framework-tools.ts'
import type { createNativeMessageSources } from './native-message-sources.ts'
import type { createNativeActivity } from './native-activity.ts'
import type { LifecycleCheckpoint } from './lifecycle-hooks.ts'
import type { NativeGuardPhase } from './native-configuration-guard.ts'
import { nativeAuthorizationMode } from './native-access.ts'
import { digest, json, object } from './data.ts'
import { mapNativeExecutionObservation } from './native-event-mapping.ts'
import { recordNativeExecutionInput } from './native-execution-summary.ts'

export interface NativeAgentResources {
  readonly lifetime: AbortController | undefined
  readonly configuration: NativeChatConfiguration | undefined
  readonly host: ReturnType<typeof createBridgeHost> | undefined
  readonly executions: ReturnType<typeof createNativeExecutionController> | undefined
  readonly claims: ReturnType<typeof createNativeExecutionClaims> | undefined
  readonly frameworkTools: ReturnType<typeof createNativeFrameworkTools> | undefined
  readonly messageSources: ReturnType<typeof createNativeMessageSources> | undefined
  readonly pluginEpoch: string | null
}
function failure(code: string): never { throw new FrameworkError(code, 'The current agent execution could not be verified.') }
function fingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
/** Session transport has one generation; executions and source claims become available during preparation. */
export function createNativeAgentCoordinator(options: {
  readonly resources: NativeAgentResources
  readonly sourceAgent: AgentAdapter
  readonly dsh: DshJsonRpcPort
  readonly store: DurableStore
  readonly controller: AbortController
  readonly definition: ChatSessionDefinition
  readonly configuration: NativeChatConfiguration
  readonly identity: string
  readonly presetBindings: readonly DshPresetBinding[]
  readonly activity: ReturnType<typeof createNativeActivity>
  readonly bindingForSession: (sessionId: string) => SessionBinding | undefined
  readonly admittedAt: (requestId: string) => number | undefined
  readonly recordUsage: (event: AgentEvent) => void
  readonly onReplyAttempted?: (requestId: string) => boolean
  readonly onReplySuppressed?: (requestId: string) => void
  readonly onReplyFailed?: (requestId: string, known: boolean) => void
  readonly checkpoint: (point: LifecycleCheckpoint, data: JsonObject, signal: AbortSignal) => Promise<void>
  readonly guard: (conversationId: string, signal: AbortSignal, recheck?: boolean, phase?: NativeGuardPhase) => Promise<void>
}): AgentAdapter {
  const runtime = options.resources
  const { sourceAgent, dsh, store, controller, definition, configuration, identity, presetBindings,
    activity, bindingForSession, checkpoint, guard } = options
  const configuredSessions = new Set<string>()
  const observedMessages = new Set<string>()
  function observeExecution(record: Parameters<typeof mapNativeExecutionObservation>[0]) {
    try { const event = mapNativeExecutionObservation(record); if (event) activity.observe(event) } catch {}
  }
  function matchingReply(binding: SessionBinding, requestId: string) {
    const pending = runtime.host?.replies.get(binding.conversationId)
    return pending?.sessionId === binding.sessionId && pending.generation === binding.generation
      && digest([binding.conversationId, pending.requestId, 'prompt']) === requestId ? pending : null
  }
  function settleSilent(execution: NativeExecutionRecord, decision: ReturnType<typeof parseNativeReplyDecision> = null) {
    const binding = execution.binding
    const pending = matchingReply(binding, execution.requestId)
    if (pending) runtime.host!.replies.suppress(binding, pending.requestId)
    if (options.onReplyAttempted?.(execution.requestId)) return
    const previous = store.read('native-chat.reply-decisions', execution.id)
    if (previous) return
    store.write('native-chat.reply-decisions', execution.id, { schema: 1, executionId: execution.id,
      conversationId: binding.conversationId, sessionId: binding.sessionId, generation: binding.generation,
      messageId: pending?.requestId ?? null, state: decision?.state ?? 'silent', reason: decision?.reason ?? 'no-explicit-send' },
    { expectedRevision: null, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 })
    options.onReplySuppressed?.(execution.requestId)
    // Final text is private regardless of legacy control syntax. A malformed
    // silence reason is diagnostic data, not a failed QQ send or user warning.
    activity.record('reply_suppressed', binding.conversationId)
  }
        const inspectToolScope = async (request: Parameters<AgentAdapter['submit']>[0], binding: NonNullable<ReturnType<typeof bindingForSession>>) => {
          if (!definition.capabilitySelection) return false
          if (!store || !dsh?.bridgePlugin || runtime.pluginEpoch === null) failure('NATIVE_CHAT_TOOL_SCOPE_UNVERIFIED')
          const kind = binding.conversationId.startsWith('group:') ? 'group' : 'private'
          const matches = presetBindings.filter(candidate => digest(candidate.definition) === digest(definition)
            && (candidate.conversationKind === undefined || candidate.conversationKind === kind))
          if (matches.length !== 1) failure('NATIVE_CHAT_TOOL_SCOPE_UNVERIFIED')
          const agentPreset = matches[0]!.agentPreset
          const key = fingerprint([identity, binding.conversationId, binding.sessionId, binding.generation])
          const previous = store.read('native-chat.tool-scopes', key)
          const observed = previous ? object(previous.value) : null
          if (observed && (observed.schema !== 1 || observed.identity !== identity || observed.agentPreset !== agentPreset
            || observed.sessionId !== binding.sessionId || observed.conversationId !== binding.conversationId
            || observed.generation !== binding.generation || !Array.isArray(observed.names) || observed.names.length > 256
            || !observed.names.every(name => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(name))
            || new Set(observed.names).size !== observed.names.length
            || typeof observed.schemaFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(observed.schemaFingerprint))) {
            failure('NATIVE_CHAT_TOOL_SCOPE_INVALID')
          }
          const scope = await dsh.bridgePlugin.inspectScope({ sessionId: request.sessionId, expectedPreset: agentPreset,
            ...(observed ? { expectedNames: observed.names as string[], expectedSchemaFingerprint: observed.schemaFingerprint as string } : {}) },
          runtime.pluginEpoch, request.signal).catch(() => {
            request.signal.throwIfAborted()
            failure('NATIVE_CHAT_TOOL_SCOPE_UNVERIFIED')
          })
          request.signal.throwIfAborted()
          if (scope.state !== 'verified-scope') failure(scope.missingReasons.includes('dsh_tool_scope_changed')
            ? 'NATIVE_CHAT_TOOL_SCOPE_CHANGED' : 'NATIVE_CHAT_TOOL_SCOPE_UNVERIFIED')
          if (!previous) store.write('native-chat.tool-scopes', key, { schema: 1, identity, agentPreset,
            sessionId: binding.sessionId, conversationId: binding.conversationId, generation: binding.generation,
            names: [...scope.names], schemaFingerprint: scope.schemaFingerprint }, { expectedRevision: null })
          return scope.names.length > 0
        }
        return {
          async createSession(request) { await guard(request.conversationId, request.signal, false, 'submit'); return sourceAgent.createSession(request) },
          async submit(request) {
            const binding = bindingForSession(request.sessionId)
            if (!binding) failure('SESSION_STALE')
            await checkpoint('agent.submitting', { conversationId: binding.conversationId,
              sessionId: request.sessionId, generation: binding.generation, requestId: request.requestId,
              content: json(request.content) }, request.signal)
            await guard(binding.conversationId, request.signal, false, 'submit')
            if (!runtime.executions || !runtime.claims || !runtime.configuration || runtime.pluginEpoch === null) failure('NATIVE_CHAT_EXECUTION_UNAVAILABLE')
            if (!configuredSessions.has(request.sessionId) && dsh.configureSession) {
              if (runtime.executions.active().some(execution => execution.binding.sessionId === request.sessionId)) failure('NATIVE_CHAT_BUSY')
              await dsh.configureSession({ sessionId: request.sessionId, conversationId: binding.conversationId, signal: request.signal })
              configuredSessions.add(request.sessionId)
            }
            let delegatesTools: boolean
            try {
              delegatesTools = await inspectToolScope(request, binding)
              await runtime.frameworkTools?.project(binding, request.signal)
            }
            catch (error) {
              activity.record('tool_projection_failed', binding.conversationId, undefined,
                { requestId: request.requestId }, errorCode(error, 'TOOL_PROJECTION_UNKNOWN'))
              // Preparation failed before sourceAgent.submit. This is a known
              // rejection, not an uncertain model execution or global failure.
              return { status: 'rejected' as const }
            }
            const baseline = await runtime.claims.baseline(request.sessionId, request.signal)
            if (definition.capabilitySelection) await guard(binding.conversationId, request.signal, false, 'submit')
            request.signal.throwIfAborted()
            if (delegatesTools && nativeAuthorizationMode(configuration.authorization) === 'counted') {
              if (!runtime.host) failure('NATIVE_CHAT_EXECUTION_UNAVAILABLE')
              const reservation = runtime.host.policy.reserve({ ...(runtime.host.accountScope ? { accountScope: runtime.host.accountScope } : {}), featureId: 'agent-relay', conversationId: binding.conversationId,
                capability: 'agent.tools.delegate' })
              runtime.host.policy.begin(reservation)
            }
            const execution = runtime.executions.admit({ binding: { conversationId: binding.conversationId,
              sessionId: request.sessionId, generation: binding.generation }, requestId: request.requestId,
              policyRevision: runtime.configuration.revisions.execution, admittedAt: options.admittedAt(request.requestId) ?? Date.now() })
            recordNativeExecutionInput(store, execution)
            observeExecution(execution)
            if (execution.status !== 'prepared') return { status: 'unknown' }
            runtime.claims.attach(execution, baseline)
            const result = await runtime.executions.submit(execution.id, ({ signal }) => {
              runtime.messageSources?.retain({ requestId: request.requestId, sessionId: request.sessionId, generation: binding.generation })
              return sourceAgent.submit({ ...request, signal: AbortSignal.any([signal, request.signal]) })
            })
            observeExecution(result)
            if (result.externalStatus === 'accepted') activity.record('accepted', binding.conversationId)
            if (result.status !== 'running') runtime.messageSources?.releaseExecution({ requestId: request.requestId,
              sessionId: request.sessionId, generation: binding.generation })
            await checkpoint('agent.submitted', { conversationId: binding.conversationId, sessionId: request.sessionId,
              requestId: request.requestId, status: result.externalStatus }, request.signal).catch(() => {})
            return { status: result.externalStatus === 'accepted' || result.externalStatus === 'completed' ? 'accepted'
              : result.externalStatus === 'rejected' ? 'rejected' : 'unknown' }
          },
          async follow(request) {
            const unregister = dsh!.registerInteractionSession(request.sessionId)
            try {
              const stop = await sourceAgent.follow({ ...request, async onEvent(event) {
            if (controller.signal.aborted || runtime.lifetime !== controller || request.signal.aborted) return
            const binding = bindingForSession(event.sessionId)
            if (!binding || !runtime.executions) return
            const waiting = runtime.executions.forConversation(binding.conversationId)
            if (event.data?.terminal === true) {
              if (waiting) observeExecution(runtime.executions.lost(waiting.id))
              if (waiting) options.onReplyFailed?.(waiting.requestId, false)
              activity.record('follow_lost', binding.conversationId)
              await request.onEvent(event)
              return
            }
            const turn = event.data?.turn
            if (typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0 || typeof turn === 'string' && turn.length > 0) {
              if (waiting) await runtime.claims?.poll(waiting.id)
              if (controller.signal.aborted || runtime.lifetime !== controller) return
              const scope = { conversationId: binding.conversationId, sessionId: event.sessionId, generation: binding.generation }
              const execution = runtime.executions.forTurn(scope, String(turn))
              if (!execution) return
              // Shared sessions also emit plugin turns. Only a claimed QQ turn belongs in the QQ ledger.
              options.recordUsage(event)
              event = { ...event, data: { ...event.data, nativeRequestId: execution.requestId } }
              const reason = event.data?.reason
              const aborted = reason !== null && typeof reason === 'object' && !Array.isArray(reason) && reason.kind === 'aborted'
                && reason.reason !== null && typeof reason.reason === 'object' && !Array.isArray(reason.reason) && reason.reason.kind === 'user'
              const observed = runtime.executions.observe(execution.id, { eventId: `${event.type}:${event.id}`, binding: scope, turnId: String(turn),
                kind: event.type === 'message' || event.type === 'completed' ? 'completed'
                  : event.type === 'failed' ? aborted ? 'cancelled' : 'failed' : 'progress' })
              observeExecution(observed.execution)
              if (event.type === 'message' && observed.decision !== 'deliver') return
              if (event.type === 'message') {
                if (observedMessages.size >= 512) observedMessages.delete(observedMessages.values().next().value!)
                observedMessages.add(execution.requestId)
                const pending = matchingReply(binding, execution.requestId)
                // Only host-authored work feedback uses final text as a presentation result.
                // QQ turns speak through qaf_reply; final text is never a fallback send.
                const feedback = pending?.requestId.startsWith('work-feedback:')
                  ? store.read('native-work.feedback', pending.requestId) : null
                const value = feedback ? object(feedback.value) : null
                const workFeedback = value?.schema === 1 && value.conversationId === binding.conversationId
                  && value.parentSessionId === binding.sessionId && value.generation === binding.generation
                const workRow = workFeedback && value?.final === false && typeof value.workId === 'string'
                  ? store.read('native-work.executions', value.workId) : null
                const currentWork = workRow ? object(workRow.value) : null
                const staleProgress = workFeedback && value?.final === false && (!currentWork
                  || currentWork.conversationId !== binding.conversationId || currentWork.parentSessionId !== binding.sessionId
                  || currentWork.generation !== binding.generation || !['starting', 'running'].includes(String(currentWork.status)))
                const decision = parseNativeReplyDecision(event.content ?? [])
                if (!workFeedback || decision || staleProgress) {
                  settleSilent(execution, decision ?? (staleProgress ? { state: 'silent', reason: 'no-useful-addition' } : null))
                  runtime.host?.releaseDeliveryRequest(execution.requestId)
                  return
                }
              }
              if (event.type === 'failed') {
                const pending = matchingReply(binding, execution.requestId)
                if (pending) runtime.host!.replies.suppress(binding, pending.requestId)
                options.onReplyFailed?.(execution.requestId, true)
                runtime.host?.releaseDeliveryRequest(execution.requestId)
                activity.record(aborted ? 'agent_cancelled' : 'agent_failed', binding.conversationId,
                  undefined, {}, typeof event.data?.code === 'string' ? event.data.code : undefined)
              }
              if (event.type === 'completed') {
                if (!observedMessages.has(execution.requestId) && observed.decision === 'deliver') settleSilent(execution)
                observedMessages.delete(execution.requestId)
                runtime.host?.releaseDeliveryRequest(execution.requestId)
              }
            } else if (event.type === 'message') return
            await request.onEvent(event)
              } })
              return async () => { unregister(); await stop() }
            } catch (error) { unregister(); throw error }
          },
          cancel: sourceAgent.cancel
        }
}
