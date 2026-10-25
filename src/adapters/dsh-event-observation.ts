import type { DshSessionEvent } from './dsh.ts'
import { isNativeEventCorrelation, isNativeEventInput, nativeEventIdentifier, type NativeEventCorrelation, type NativeEventInput } from '../contracts/native-events.ts'
import { isRecord, snapshot } from '../core/values.ts'

/** Maps a fixed protocol vocabulary; no model content, tool arguments, raw error or result body is copied. */
export function mapDshObservation(frame: DshSessionEvent, correlation: NativeEventCorrelation = {}): NativeEventInput | null {
  if (frame.type !== 'session/event' || !nativeEventIdentifier(frame.sessionId) || !isNativeEventCorrelation(correlation)
    || correlation.sessionId !== undefined && correlation.sessionId !== frame.sessionId) return null
  const data = frame.event.data
  if (!isRecord(data)) return null
  if (!Number.isSafeInteger(data.turn) || Number(data.turn) < 1) return null
  if (correlation.turn !== undefined && correlation.turn !== data.turn) return null
  if (['step/start','step/end','tool/call','tool/result'].includes(frame.event.type)
    && (!Number.isSafeInteger(data.step) || Number(data.step) < 0)) return null
  const address = {...correlation,sessionId:frame.sessionId,...(Number.isSafeInteger(frame.event.seq) && Number(frame.event.seq)>=0 ? {sourceSequence:Number(frame.event.seq)}:{})}
  const coordinates = {...address,...(Number.isSafeInteger(data.turn) && Number(data.turn) >= 0 ? {turn:Number(data.turn)}:{}),
    ...(Number.isSafeInteger(data.step) && Number(data.step) >= 0 ? {step:Number(data.step)}:{})}
  let input: unknown
  if (frame.event.type === 'turn/start') input = {source:'dsh',kind:'execution',status:'accepted',correlation:coordinates}
  else if (['step/start','step/end'].includes(frame.event.type)) input = {source:'dsh',kind:'execution',status:'progress',correlation:coordinates}
  else if (frame.event.type === 'turn/end' && isRecord(data.reason)) {
    const status = data.reason.kind === 'completed' ? 'completed' : data.reason.kind === 'error' ? 'failed'
      : data.reason.kind === 'aborted' ? 'cancelled' : ['interrupted','forked','blocked','max-tokens'].includes(String(data.reason.kind)) ? 'unknown' : null
    if (status) input = {source:'dsh',kind:'execution',status,correlation:coordinates}
  } else if (frame.event.type === 'tool/call' && nativeEventIdentifier(data.callId))
    input = {source:'dsh',kind:'tool',status:'started',correlation:{...coordinates,toolCallId:data.callId}}
  else if (frame.event.type === 'tool/result' && isRecord(data.message) && data.message.role === 'tool'
    && (data.message.isError === undefined || typeof data.message.isError === 'boolean') && nativeEventIdentifier(data.message.toolCallId))
    input = {source:'dsh',kind:'tool',status:data.message.isError === true ? 'failed':'completed',correlation:{...coordinates,toolCallId:data.message.toolCallId}}
  return isNativeEventInput(input) ? snapshot(input) : null
}
