import { validateOneBotProtocolEventData, type OneBotProtocolEvent } from '../adapters/onebot-events.ts'
import type { FrameworkToolCall, FrameworkToolResult } from '../contracts/framework-tools.ts'
import { isNativeEventInput,
  type NativeEventInput } from '../contracts/native-events.ts'
import type { NativeWorkView } from '../contracts/native-work.ts'
import { snapshot } from '../core/values.ts'
import type { AdapterConnectionStatus } from './adapter-configuration.ts'
import type { NativeExecutionRecord } from './native-execution.ts'

export { mapDshObservation } from '../adapters/dsh-event-observation.ts'

export function mapOneBotConnectionObservation(status: AdapterConnectionStatus, accountId?: string): NativeEventInput | null {
  const input = {source:'onebot',kind:'connection',status:status.state === 'reconnecting' ? 'connecting':status.state,
    correlation:accountId === undefined ? {} : {accountId}}
  return isNativeEventInput(input) ? snapshot(input) : null
}

export function mapOneBotProtocolObservation(event: OneBotProtocolEvent): NativeEventInput | null {
  if (!validateOneBotProtocolEventData(event.type,event.data)) return null
  const status = event.type === 'protocol.connection.lifecycle' ? event.data.phase === 'connect' ? 'connected'
    : event.data.phase === 'disable' ? 'disconnected':'connecting'
    : event.type === 'protocol.connection.heartbeat' ? event.data.online === true && event.data.good === true ? 'connected':'error' : null
  const input = {source:'onebot',kind:'connection',status,correlation:{accountId:event.data.accountId}}
  return isNativeEventInput(input) ? snapshot(input) : null
}

export function mapNativeExecutionObservation(execution: NativeExecutionRecord): NativeEventInput | null {
  const status = execution.status === 'prepared' || execution.status === 'submitting' ? 'accepted'
    : execution.status === 'running' ? 'progress' : execution.status === 'timed-out' ? 'timed-out'
    : execution.isolated ? 'unknown' : execution.externalStatus === 'cancelled' ? 'cancelled'
    : execution.status === 'rejected' ? 'failed':execution.status
  const input = {source:'host',kind:'execution',status,correlation:{conversationId:execution.binding.conversationId,sessionId:execution.binding.sessionId,generation:execution.binding.generation,
    ...(execution.binding.accountScope ? {accountId:execution.binding.accountScope.accountId,protocolId:execution.binding.accountScope.protocolId}:{}),executionId:execution.id,requestId:execution.requestId,
    ...(execution.userMessage ? {userMessageId:execution.userMessage.messageId}:{}),...(execution.turn ? {turn:Number(execution.turn.id)}:{})}}
  return isNativeEventInput(input) ? snapshot(input) : null
}

export function mapNativeWorkObservation(work: NativeWorkView): NativeEventInput | null {
  const input = {source:'host',kind:'work',status:work.status === 'starting' ? 'started':work.status === 'running' ? 'progress':work.status,
    correlation:{conversationId:work.conversationId,sessionId:work.parentSessionId,childSessionId:work.childId,generation:work.generation,workId:work.id}}
  return isNativeEventInput(input) ? snapshot(input) : null
}

export function mapNativeToolObservation(call: FrameworkToolCall, result?: FrameworkToolResult, conversationId?: string): NativeEventInput | null {
  const input = {source:'host',kind:'tool',status:result === undefined ? 'started':result.status === 'confirmed' ? 'completed':result.status === 'rejected' ? 'failed':'unknown',
    correlation:{sessionId:call.sessionId,generation:call.generation,requestId:call.requestId,userMessageId:call.userMessageId,turn:call.turn,toolCallId:call.id,
      ...(conversationId === undefined ? {}:{conversationId})}}
  return isNativeEventInput(input) ? snapshot(input) : null
}
