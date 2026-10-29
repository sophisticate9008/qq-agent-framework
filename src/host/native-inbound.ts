import type { AccountScope } from '../contracts/account-scope.ts'
import type { OneBotWebSocketOptions } from '../adapters/onebot-websocket.ts'
import { projectOneBotNoticeForChat, validateOneBotProtocolEventData } from '../adapters/onebot-events.ts'
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
import { nativeActivityContent, type createNativeActivity } from './native-activity.ts'
import type { createControlCommands } from './control-commands.ts'
import type { LifecycleCheckpoint } from './lifecycle-hooks.ts'
import type { InboundMessage } from './types.ts'
import { nativeParticipation, type NativeParticipationReason } from './native-chat-input.ts'
import { nativeChatWakeKind } from './native-chat-wake.ts'
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
  readonly feedbackBusy?: (conversationId: string) => boolean
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
  readonly onDispatched?: (requestId: string, accepted: boolean) => void
}) {
  const runtime = options.resources
  const { activity, controlDefinitions, getControlCommands, checkpoint, guard, safeCode } = options
  const participationReasons = new Map<string, NativeParticipationReason>()
  const groupWakes = new Map<string, readonly { readonly messageId: string; readonly actor: string; readonly reason: NativeParticipationReason }[]>()
  const preparedReadCursors = new Map<string, number>()
  const inputSequences = new Map<string, number>()
  const admissionTimes = new Map<string, number>()
  const activeConversations = new Map<string, number>()
  const activationTimes = new Map<string, number>()
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
      const chatNotice = projectOneBotNoticeForChat(normalized)
      if (chatNotice && current === runtime.host && runtime.lifetime === generation && !signal.aborted)
        await handlers.onEvent?.(chatNotice, { ...context, signal })
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
        return
      }
      if (!normalizedMessage || normalizedMessage.isSelf || runtime.closed || context.signal.aborted) return
      if (normalizedMessage.receivedAt < Date.now() - 7 * 24 * 60 * 60 * 1000) return
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
        await checkpoint('message.rejected', { conversationId: message.conversationId, messageId: message.id,
          reason: 'access_denied' }, context.signal)
        return
      }
      const wakeKind = nativeChatWakeKind(message.id, message.content, context.selfId)
      // Preserve a pure mention as a contact signal, including when QQ supplies no trailing space.
      const content = wakeKind ? message.content : message.content.filter(part => part.type !== 'mention' || part.userId !== context.selfId)
      const activityContent = nativeActivityContent(content)
      if (!wakeKind && await runtime.interactionMessages?.receive({ ...message, content }, context.signal)) {
        received++
        activity.record('received', message.conversationId, activityContent)
        return
      }
      if (content.length === 0) {
        rejected++
        lastReceipt = { status: 'rejected', errorCode: 'NATIVE_CHAT_TEXT_ONLY' }
        if (message.directed || message.conversationId.startsWith('private:')) activity.record('unsupported', message.conversationId)
        return
      }
      received++
      activity.record('received', message.conversationId, activityContent)
      const history = current.history.snapshot(message.conversationId, { afterSequence: 0, limit: 100 })
      const configuration = runtime.configuration
      const personaId = configuredDefinition(configuration)?.personaId
      const persona = configuration.personas.find(value => value.id === personaId)
      const inputSettings = await readInputConfiguration(message.conversationId, persona?.name)
      const initialParticipation = nativeParticipation({ ...message, content }, history.messages,
        { ...inputSettings.effective, activatedAt: activationTimes.get(message.conversationId) }, admittedAt)
      const quotedMessages = inputSettings.effective.wakeOnReply && !['direct', 'nickname', 'reply'].includes(initialParticipation)
        ? await runtime.quotedContext?.read(message, history.messages, context.signal) : undefined
      if (current !== runtime.host || runtime.lifetime !== generation || context.signal.aborted) return
      const participation = nativeParticipation({ ...message, content }, history.messages,
        { ...inputSettings.effective, activatedAt: activationTimes.get(message.conversationId), quotedMessages }, admittedAt)
      if (['direct', 'nickname', 'reply'].includes(participation)
        && !history.messages.some(entry => entry.id === message.id)
        && !runtime.inbox?.contains(message.conversationId, message.id)) {
        // Activate on the call itself, before model submission or reply delivery.
        // This account owns the map; the conversation key never crosses accounts.
        for (const [conversationId, activatedAt] of activationTimes) {
          if (admittedAt - activatedAt > 300_000 || !allowed(configuration, conversationId)) activationTimes.delete(conversationId)
        }
        const activatedAt = Math.max(activationTimes.get(message.conversationId) ?? admittedAt, admittedAt)
        activationTimes.delete(message.conversationId)
        if (activationTimes.size >= 1_024) {
          const oldest = activationTimes.keys().next().value
          if (oldest !== undefined) activationTimes.delete(oldest)
        }
        activationTimes.set(message.conversationId, activatedAt)
      }
      // A busy model is not another group wake. Outside the actual call window,
      // ordinary chatter stays in history without chaining new model requests.
      const incoming = { ...message, content, directed: participation !== 'ambient' }
      participationReasons.set(digest([message.conversationId, message.id, 'prompt']), participation)
      // Release the protocol callback after durable admission, before model preparation/submission.
      // Otherwise subsequent QQ corrections remain stuck in the WebSocket queue.
      if (incoming.directed) {
        try {
          await guard(message.conversationId, context.signal, false, 'admission')
          if (!runtime.inbox || runtime.lifetime !== generation || generation!.signal.aborted) failure('NATIVE_CHAT_STOPPED')
          const historySequence = runtime.inbox.contains(message.conversationId, message.id) ? undefined
            : current.history.append(message.conversationId, { id: message.id, actor: message.userId,
              ...(message.displayName === undefined ? {} : { displayName: message.displayName }),
              content, receivedAt: message.receivedAt })
          runtime.inbox.enqueue({ message: incoming, admittedAt, deadlineAt: admittedAt + configuration.execution.turnTimeoutMs,
            ...(historySequence === undefined ? {} : { historySequence }),
            trigger: participation === 'direct' ? message.conversationId.startsWith('private:') ? 'private' : 'mention'
              : participation === 'ambient' ? 'observation' : participation })
          lastReceipt = { status: 'queued', errorCode: null }
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

  async function dispatchIncoming(message: InboundMessage, incoming: InboundMessage, admittedAt: number, signal: AbortSignal,
    historySequence?: number) {
    const current = runtime.host
    const generation = runtime.lifetime
    const requestId = digest([message.conversationId, message.id, 'prompt'])
    if (!current || !runtime.configuration || runtime.state !== 'running' || !generation || generation.signal.aborted) {
      participationReasons.delete(requestId)
      groupWakes.delete(requestId)
      return { status: 'rejected' as const, eventId: message.id, errorCode: 'NATIVE_CHAT_STOPPED' }
    }
    if (admissionTimes.size >= 256 && !admissionTimes.has(requestId)) {
      participationReasons.delete(requestId)
      groupWakes.delete(requestId)
      rejected++
      lastReceipt = { status: 'rejected', errorCode: 'NATIVE_CHAT_ADMISSION_BACKPRESSURE' }
      if (incoming.directed) activity.record('backpressure', message.conversationId)
      return { status: 'rejected' as const, eventId: message.id, errorCode: 'NATIVE_CHAT_ADMISSION_BACKPRESSURE' }
    }
    const ownsAdmission = !admissionTimes.has(requestId)
    if (historySequence !== undefined) inputSequences.set(requestId, historySequence)
    admissionTimes.set(requestId, admissionTimes.get(requestId) ?? admittedAt)
    activeConversations.set(message.conversationId, (activeConversations.get(message.conversationId) ?? 0) + 1)
    let releaseSource: (() => void) | undefined
    let accepted = false
    try {
      const remaining = admissionTimes.get(requestId)! + runtime.configuration!.execution.turnTimeoutMs - Date.now()
      if (remaining <= 0) {
        rejected++
        lastReceipt = { status: 'rejected', errorCode: 'NATIVE_CHAT_DEADLINE_EXPIRED' }
        if (incoming.directed) activity.record('deadline', message.conversationId)
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
        run: signal => current.receive(incoming, { signal, ...(historySequence === undefined ? {} : { historySequence }) }) })
      const readCursor = preparedReadCursors.get(requestId)
      accepted = receipt.status === 'accepted'
      if (receipt.status === 'accepted' && readCursor !== undefined && current === runtime.host && runtime.lifetime === generation) {
        const prior = current.history.snapshot(message.conversationId)
        current.history.markRead(message.conversationId, Math.max(prior.readThrough, readCursor))
      }
      if (receipt.status === 'rejected') rejected++
      if (receipt.status === 'unknown') unknown++
      lastReceipt = { status: receipt.status, errorCode: receipt.errorCode ?? null }
      if (incoming.directed && receipt.status !== 'accepted' && !activity.requestFailureReported(requestId))
        activity.record(receipt.status, message.conversationId, undefined, {}, receipt.errorCode)
      return receipt
    } catch (error) {
      unknown++
      lastReceipt = { status: 'unknown', errorCode: safeCode(error) }
      if (incoming.directed && !activity.requestFailureReported(requestId)) activity.record(lastReceipt.errorCode === 'NATIVE_CHAT_DEADLINE_EXPIRED' ? 'deadline' : 'unknown',
        message.conversationId, undefined, {}, lastReceipt.errorCode ?? undefined)
      return { status: 'unknown' as const, eventId: message.id, errorCode: lastReceipt.errorCode }
    } finally {
      options.onDispatched?.(requestId, accepted)
      activity.finishRequest(requestId)
      const remainingActive = (activeConversations.get(message.conversationId) ?? 1) - 1
      if (remainingActive) activeConversations.set(message.conversationId, remainingActive)
      else activeConversations.delete(message.conversationId)
      releaseSource?.()
      if (ownsAdmission) admissionTimes.delete(requestId)
      participationReasons.delete(requestId)
      groupWakes.delete(requestId)
      inputSequences.delete(requestId)
      preparedReadCursors.delete(requestId)
    }
  }

  return Object.freeze({ handlers, dispatchIncoming, readInputConfiguration,
    // Called only after the durable command registry admits a first execution.
    // A selector probe, replayed receipt or ordinary denied message is not a new row.
    controlReceived(message: Readonly<InboundMessage>) {
      received++
      activity.record('received', message.conversationId, nativeActivityContent(message.content), { userMessageId: message.id })
    },
    isProcessing: (conversationId: string) => activeConversations.has(conversationId),
    status: () => ({ activeConversations: activeConversations.size, received, rejected, unknown, droppedWhileStopped, lastReceipt }),
    admittedAt: (requestId: string) => admissionTimes.get(requestId),
    inputSequence: (requestId: string) => inputSequences.get(requestId),
    preparedReadCursor(requestId: string, sequence: number) { preparedReadCursors.set(requestId, sequence) },
    participation: (requestId: string) => participationReasons.get(requestId),
    observationActive(conversationId: string, continuationMs: number, at = Date.now()) {
      const activatedAt = activationTimes.get(conversationId)
      return activatedAt !== undefined && continuationMs > 0 && at >= activatedAt && at - activatedAt <= continuationMs
    },
    setParticipation(requestId: string, reason: NativeParticipationReason) { participationReasons.set(requestId, reason) },
    groupWake: (requestId: string) => groupWakes.get(requestId),
    setGroupWake(requestId: string, wake: readonly { readonly messageId: string; readonly actor: string; readonly reason: NativeParticipationReason }[]) {
      if (groupWakes.size >= 256 && !groupWakes.has(requestId)) groupWakes.delete(groupWakes.keys().next().value!)
      groupWakes.set(requestId, wake.slice(-16))
    },
    clear() { participationReasons.clear(); groupWakes.clear(); inputSequences.clear(); preparedReadCursors.clear(); admissionTimes.clear(); activationTimes.clear() }
  })
}
