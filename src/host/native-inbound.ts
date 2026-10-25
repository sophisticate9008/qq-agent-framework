import type { AccountScope } from '../contracts/account-scope.ts'
import type { OneBotWebSocketOptions } from '../adapters/onebot-websocket.ts'
import { validateOneBotProtocolEventData } from '../adapters/onebot-events.ts'
import { mapOneBotProtocolObservation } from './native-event-mapping.ts'
import { isOneBotControlContent, normalizeOneBotMessage, type OneBotIncomingAsset } from '../adapters/onebot.ts'
import type { JsonObject } from '../core/types.ts'
import { FrameworkError } from '../core/values.ts'
import type { createBridgeHost } from './bridge.ts'
import type { NativeChatConfiguration } from './native-chat-configuration.ts'
import type { createNativeMediaRegistry } from './native-media.ts'
import type { createNativeExecutionController } from './native-execution.ts'
import type { createNativeInbox } from './native-inbox.ts'
import type { createNativeMessageSources } from './native-message-sources.ts'
import type { createNativeInteractionMessages } from './native-interaction-messages.ts'
import type { createNativeQuotedContext } from './native-quoted-context.ts'
import type { NativeChatInputPackageService } from './default-native-packages.ts'
import type { createNativeActivity } from './native-activity.ts'
import type { createControlCommands } from './control-commands.ts'
import type { LifecycleCheckpoint } from './lifecycle-hooks.ts'
import type { InboundMessage } from './types.ts'
import { nativeParticipation, type NativeParticipationReason } from './native-chat-input.ts'
import { buildChatSessionDefinition } from './chat-plans.ts'
import { digest, json, object } from './data.ts'
import { withDeadline } from './deadlines.ts'

/** Live read-only resource view; identity checks fence every awaited admission against stop/restart. */
export interface NativeInboundResources {
  readonly state: 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
  readonly closed: boolean
  readonly host: ReturnType<typeof createBridgeHost> | undefined
  readonly lifetime: AbortController | undefined
  readonly configuration: NativeChatConfiguration | undefined
  readonly media: ReturnType<typeof createNativeMediaRegistry> | undefined
  readonly executions: ReturnType<typeof createNativeExecutionController> | undefined
  readonly inbox: ReturnType<typeof createNativeInbox> | undefined
  readonly messageSources: ReturnType<typeof createNativeMessageSources> | undefined
  readonly interactionMessages: ReturnType<typeof createNativeInteractionMessages> | undefined
  readonly quotedContext: ReturnType<typeof createNativeQuotedContext> | undefined
  readonly inputPackage: NativeChatInputPackageService | undefined
}
function failure(code: string): never { throw new FrameworkError(code, 'Inbound admission could not complete safely.') }
function allowed(configuration: NativeChatConfiguration, conversationId: string): boolean {
  return configuration.access.allow.includes(conversationId) && !configuration.access.deny.includes(conversationId)
}
function configuredDefinition(configuration: NativeChatConfiguration) {
  const plan = configuration.catalog.plans.find(value => value.id === configuration.catalog.activePlanId)
  const persona = configuration.personas.find(value => value.id === plan?.personaId)
  return plan && persona ? buildChatSessionDefinition(plan, persona) : null
}
export function createNativeInboundController(options: {
  readonly accountScope?: AccountScope
  readonly expectedSelfId?: string
  readonly resources: NativeInboundResources
  readonly activity: ReturnType<typeof createNativeActivity>
  readonly controlDefinitions: readonly unknown[]
  readonly getControlCommands: () => Promise<ReturnType<typeof createControlCommands>>
  readonly checkpoint: (point: LifecycleCheckpoint, data: JsonObject, signal: AbortSignal) => Promise<void>
  readonly guard: (conversationId: string, signal: AbortSignal, recheck: boolean, phase: 'protocol' | 'admission') => Promise<void>
  readonly safeCode: (error: unknown) => string
}) {
  const runtime = options.resources
  const { activity, controlDefinitions, getControlCommands, checkpoint, guard, safeCode } = options
  const participationReasons = new Map<string, NativeParticipationReason>()
  const preparedReadCursors = new Map<string, number>()
  const admissionTimes = new Map<string, number>()
  let received = 0
  let rejected = 0
  let unknown = 0
  let droppedWhileStopped = 0
  let lastReceipt: { status: string; errorCode: string | null } | null = null
  function readInputConfiguration(conversationId: string, personaName?: string) {
    if (!runtime.inputPackage) failure('NATIVE_CHAT_INPUT_PACKAGE_UNAVAILABLE')
    return runtime.inputPackage.read(conversationId, personaName)
  }
  const handlers: Pick<OneBotWebSocketOptions, 'onEvent' | 'onProtocolEvent'> = {
    async onProtocolEvent(event, context) {
      const current = runtime.host
      const generation = runtime.lifetime
      if (runtime.closed || runtime.state !== 'running' || !current || !generation || generation.signal.aborted || context.signal.aborted) return
      if (options.expectedSelfId !== undefined && context.selfId !== options.expectedSelfId) return
      const normalized = { ...event, ...(options.accountScope ? { accountScope: options.accountScope } : {}) }
      if (normalized.data.selfId !== context.selfId || normalized.conversationId !== normalized.data.conversationId
        || !validateOneBotProtocolEventData(normalized.type, normalized.data)) return
      const signal = AbortSignal.any([context.signal, generation.signal])
      if (!normalized.conversationId.startsWith('protocol:onebot:')) await guard(normalized.conversationId, signal, false, 'protocol')
      if (current !== runtime.host || runtime.lifetime !== generation || signal.aborted) return
      await current.dispatchEvent(normalized, { signal })
      try { const observation = mapOneBotProtocolObservation(normalized); if (observation) activity.observe(observation) } catch {}
    },
    async onEvent(event, context) {
      const admittedAt = context.receivedAt
      if (runtime.closed || context.signal.aborted || options.expectedSelfId !== undefined && context.selfId !== options.expectedSelfId) return
      const media = runtime.state === 'running' && String(object(event).user_id) !== context.selfId ? runtime.media : undefined
      let mediaConversationId: string | null = null
      let normalizedMessage: Awaited<ReturnType<typeof normalizeOneBotMessage>>
      try {
        normalizedMessage = await normalizeOneBotMessage(event, { selfId: context.selfId, signal: context.signal,
          ...(media ? { registerIncomingAsset: (asset: OneBotIncomingAsset, signal: AbortSignal) => {
            mediaConversationId = asset.conversationId
            return media.register(asset, signal)
          } } : {}) })
      } catch (error) {
        if (mediaConversationId === null || !(error instanceof FrameworkError) || error.code !== 'NATIVE_CHAT_ACCESS_DENIED') throw error
        rejected++
        lastReceipt = { status: 'rejected', errorCode: error.code }
        activity.record('rejected', mediaConversationId)
        return
      }
      if (!normalizedMessage || normalizedMessage.isSelf || runtime.closed || context.signal.aborted) return
      const message: InboundMessage = { ...normalizedMessage, ...(options.accountScope ? { accountScope: options.accountScope } : {}) }
      await checkpoint('message.normalized', { message: json(message), chatState: runtime.state }, context.signal)
      if (controlDefinitions.length > 0 && isOneBotControlContent(event)) {
        const registry = await getControlCommands()
        const result = await registry.dispatchNormalized(message, context.signal)
        if (result.handled) return
      }
      const current = runtime.host
      const generation = runtime.lifetime
      if (runtime.state !== 'running' || current === undefined || generation?.signal.aborted || context.signal.aborted) {
        droppedWhileStopped++
        return
      }
      if (current !== runtime.host || runtime.lifetime !== generation || context.signal.aborted) return
      if (!runtime.configuration || !allowed(runtime.configuration, message.conversationId)) {
        rejected++
        lastReceipt = { status: 'rejected', errorCode: 'NATIVE_CHAT_ACCESS_DENIED' }
        activity.record('rejected', message.conversationId)
        await checkpoint('message.rejected', { conversationId: message.conversationId, messageId: message.id,
          reason: 'access_denied' }, context.signal)
        return
      }
      const content = message.content.filter(part => part.type !== 'mention' || part.userId !== context.selfId)
      const activityContent = message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
      if (await runtime.interactionMessages?.receive({ ...message, content }, context.signal)) {
        received++
        activity.record('received', message.conversationId, activityContent)
        return
      }
      if (content.length === 0) {
        rejected++
        lastReceipt = { status: 'rejected', errorCode: 'NATIVE_CHAT_TEXT_ONLY' }
        activity.record('unsupported', message.conversationId)
        return
      }
      received++
      activity.record('received', message.conversationId, activityContent)
      const history = current.history.snapshot(message.conversationId, { afterSequence: 0, limit: 100 })
      const configuration = runtime.configuration
      const personaId = configuredDefinition(configuration)?.personaId
      const persona = configuration.personas.find(value => value.id === personaId)
      const inputSettings = await readInputConfiguration(message.conversationId, persona?.name)
      const quotedMessages = inputSettings.effective.enabled && inputSettings.effective.wakeOnReply
        ? await runtime.quotedContext?.read(message, history.messages, context.signal) : undefined
      if (current !== runtime.host || runtime.lifetime !== generation || context.signal.aborted) return
      const currentExecution = runtime.executions?.forConversation(message.conversationId)
      const activeSender = currentExecution ? history.messages.find(entry =>
        digest([message.conversationId, entry.id, 'prompt']) === currentExecution.requestId)?.actor : undefined
      const participation = nativeParticipation({ ...message, content }, history.messages,
        { ...inputSettings.effective, activeSender, quotedMessages }, admittedAt)
      const incoming = { ...message, content, directed: inputSettings.effective.enabled && participation !== 'ambient' }
      participationReasons.set(digest([message.conversationId, message.id, 'prompt']), participation)
      const execution = runtime.executions?.forConversation(message.conversationId)
      if (incoming.directed && (execution || runtime.inbox?.hasPending(message.conversationId) || runtime.inbox?.contains(message.conversationId, message.id))) {
        try {
          await guard(message.conversationId, context.signal, false, 'admission')
          if (!runtime.inbox || runtime.lifetime !== generation || generation!.signal.aborted) failure('NATIVE_CHAT_STOPPED')
          if (execution && (execution.status === 'unknown' || execution.deadlineReached
            || execution.externalStatus === 'unknown' || execution.cancelStatus !== 'not-requested')) failure('NATIVE_INBOX_EXECUTION_UNCONFIRMED')
          runtime.inbox.enqueue({ message: incoming, admittedAt, deadlineAt: admittedAt + configuration.execution.turnTimeoutMs,
            trigger: participation === 'direct' ? message.conversationId.startsWith('private:') ? 'private' : 'mention'
              : participation === 'ambient' ? undefined : participation })
          current.history.append(message.conversationId, { id: message.id, actor: message.userId,
            content, receivedAt: message.receivedAt })
          lastReceipt = { status: 'queued', errorCode: null }
          activity.record('queued', message.conversationId)
        } catch (error) {
          rejected++
          lastReceipt = { status: 'rejected', errorCode: safeCode(error) }
          activity.record('rejected', message.conversationId)
        } finally { participationReasons.delete(digest([message.conversationId, message.id, 'prompt'])) }
        return
      }
      await dispatchIncoming(message, incoming, admittedAt, context.signal)
    }
  }

  async function dispatchIncoming(message: InboundMessage, incoming: InboundMessage, admittedAt: number, signal: AbortSignal) {
    const current = runtime.host
    const generation = runtime.lifetime
    if (!current || !runtime.configuration || runtime.state !== 'running' || !generation || generation.signal.aborted) {
      return { status: 'rejected' as const, eventId: message.id, errorCode: 'NATIVE_CHAT_STOPPED' }
    }
    const requestId = digest([message.conversationId, message.id, 'prompt'])
    if (admissionTimes.size >= 256 && !admissionTimes.has(requestId)) {
      rejected++
      lastReceipt = { status: 'rejected', errorCode: 'NATIVE_CHAT_ADMISSION_BACKPRESSURE' }
      activity.record('backpressure', message.conversationId)
      return { status: 'rejected' as const, eventId: message.id, errorCode: 'NATIVE_CHAT_ADMISSION_BACKPRESSURE' }
    }
    const ownsAdmission = !admissionTimes.has(requestId)
    admissionTimes.set(requestId, admissionTimes.get(requestId) ?? admittedAt)
    let releaseSource: (() => void) | undefined
    try {
      const inputSettings = await readInputConfiguration(incoming.conversationId)
      if (!inputSettings.effective.enabled && incoming.directed) {
        return { status: 'rejected' as const, eventId: message.id, errorCode: 'NATIVE_CHAT_INPUT_DISABLED' }
      }
      const remaining = admissionTimes.get(requestId)! + runtime.configuration!.execution.turnTimeoutMs - Date.now()
      if (remaining <= 0) {
        rejected++
        lastReceipt = { status: 'rejected', errorCode: 'NATIVE_CHAT_DEADLINE_EXPIRED' }
        activity.record('deadline', message.conversationId)
        return { status: 'rejected' as const, eventId: message.id, errorCode: 'NATIVE_CHAT_DEADLINE_EXPIRED' }
      }
      if (!runtime.messageSources) failure('NATIVE_MESSAGE_SOURCE_UNAVAILABLE')
      releaseSource = runtime.messageSources.capture(message, { receivedAt: admissionTimes.get(requestId)!,
        expiresAt: admissionTimes.get(requestId)! + runtime.configuration!.execution.turnTimeoutMs, signal: generation!.signal })
      await checkpoint('message.admitted', { message: json(message) }, signal)
      const remainingAfterHooks = admissionTimes.get(requestId)! + runtime.configuration!.execution.turnTimeoutMs - Date.now()
      if (remainingAfterHooks <= 0) failure('NATIVE_CHAT_DEADLINE_EXPIRED')
      const receipt = await withDeadline({ signal: AbortSignal.any([signal, generation!.signal]),
        timeoutMs: remainingAfterHooks, code: 'NATIVE_CHAT_DEADLINE_EXPIRED',
        run: signal => current.receive(incoming, { signal }) })
      const readCursor = preparedReadCursors.get(requestId)
      if (receipt.status === 'accepted' && readCursor !== undefined && current === runtime.host && runtime.lifetime === generation) {
        const prior = current.history.snapshot(message.conversationId)
        current.history.markRead(message.conversationId, Math.max(prior.readThrough, readCursor))
      }
      if (receipt.status === 'rejected') rejected++
      if (receipt.status === 'unknown') unknown++
      lastReceipt = { status: receipt.status, errorCode: receipt.errorCode ?? null }
      activity.record(receipt.status, message.conversationId)
      return receipt
    } catch (error) {
      unknown++
      lastReceipt = { status: 'unknown', errorCode: safeCode(error) }
      activity.record(lastReceipt.errorCode === 'NATIVE_CHAT_DEADLINE_EXPIRED' ? 'deadline' : 'unknown', message.conversationId)
      return { status: 'unknown' as const, eventId: message.id, errorCode: lastReceipt.errorCode }
    } finally {
      releaseSource?.()
      if (ownsAdmission) admissionTimes.delete(requestId)
      participationReasons.delete(requestId)
      preparedReadCursors.delete(requestId)
    }
  }

  return Object.freeze({ handlers, dispatchIncoming, readInputConfiguration,
    status: () => ({ received, rejected, unknown, droppedWhileStopped, lastReceipt }),
    admittedAt: (requestId: string) => admissionTimes.get(requestId),
    preparedReadCursor(requestId: string, sequence: number) { preparedReadCursors.set(requestId, sequence) },
    participation: (requestId: string) => participationReasons.get(requestId),
    continuation(requestId: string) { participationReasons.set(requestId, 'continuation') },
    clear() { participationReasons.clear(); preparedReadCursors.clear(); admissionTimes.clear() }
  })
}
