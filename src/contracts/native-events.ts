export const NATIVE_EVENT_PROTOCOL = 'qbf.events/1' as const
export const NATIVE_EVENT_STATUSES = {
  runtime: ['starting','running','stopping','stopped','error'],
  connection: ['connecting','connected','disconnected','error','unknown'],
  message: ['received','queued','accepted','rejected','suppressed','sent','unknown'],
  execution: ['accepted','progress','completed','failed','cancelled','timed-out','unknown','reconciled','recovered'],
  tool: ['started','progress','completed','failed','cancelled','unknown'],
  work: ['started','progress','completed','failed','cancelled','unknown'],
} as const
export type NativeEventKind = keyof typeof NATIVE_EVENT_STATUSES
export type NativeEventSource = 'native' | 'dsh' | 'onebot' | 'host'
export interface NativeEventCorrelation {
  readonly protocolId?: string
  readonly accountId?: string
  readonly conversationId?: string
  readonly sessionId?: string
  readonly childSessionId?: string
  readonly generation?: number
  readonly executionId?: string
  readonly requestId?: string
  readonly userMessageId?: string
  readonly turn?: number
  readonly step?: number
  readonly sourceSequence?: number
  readonly toolCallId?: string
  readonly workId?: string
}
export type NativeEventInput = { [Kind in NativeEventKind]: {
  readonly source: NativeEventSource
  readonly kind: Kind
  readonly status: (typeof NATIVE_EVENT_STATUSES)[Kind][number]
  readonly correlation: NativeEventCorrelation
} }[NativeEventKind]
export interface NativeEventCursor { readonly epoch: string; readonly sequence: number }
export type NativeObservationEvent = NativeEventInput & {
  readonly schema: 1
  readonly protocol: typeof NATIVE_EVENT_PROTOCOL
  readonly cursor: NativeEventCursor
  readonly at: number
}
export interface NativeEventFilter {
  readonly protocolId?: string
  readonly sources?: readonly NativeEventSource[]
  readonly kinds?: readonly NativeEventKind[]
  readonly statuses?: readonly NativeEventInput['status'][]
  readonly conversationId?: string
  readonly accountId?: string
  readonly sessionId?: string
  readonly executionId?: string
  readonly requestId?: string
  readonly workId?: string
  readonly toolCallId?: string
}
export interface NativeEventPage {
  readonly schema: 1
  readonly protocol: typeof NATIVE_EVENT_PROTOCOL
  readonly events: readonly NativeObservationEvent[]
  readonly nextCursor: NativeEventCursor
  readonly oldestCursor: NativeEventCursor
  readonly latestCursor: NativeEventCursor
  readonly gap: 'none' | 'retention' | 'epoch'
  readonly retention: 'process'
  readonly capacity: number
}
export type NativeEventNotification = { readonly type: 'event'; readonly event: NativeObservationEvent }
  | { readonly type: 'gap'; readonly reason: 'retention'|'epoch'; readonly oldestCursor: NativeEventCursor; readonly latestCursor: NativeEventCursor }

const record = (value: unknown): value is Record<string,unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export const nativeEventIdentifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
export function isNativeEventCursor(value: unknown): value is NativeEventCursor {
  return record(value) && Object.keys(value).sort().join(',') === 'epoch,sequence' && nativeEventIdentifier(value.epoch) && integer(value.sequence)
}
export function isNativeEventCorrelation(value: unknown): value is NativeEventCorrelation {
  if (!record(value)) return false
  const identifiers = ['accountId','conversationId','sessionId','childSessionId','executionId','requestId','userMessageId','toolCallId','workId']
  return Object.entries(value).every(([key,item]) => key === 'accountId' ? typeof item === 'string' && item.length >= 1 && item.length <= 128 && !/[\s\x00-\x1f\x7f]/.test(item)
    : key === 'protocolId' ? typeof item === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(item) : identifiers.includes(key) ? nativeEventIdentifier(item)
    : ['generation','turn','step','sourceSequence'].includes(key) && integer(item,key === 'generation' ? 1 : 0))
}
export function isNativeEventInput(value: unknown): value is NativeEventInput {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'correlation,kind,source,status'
    || !['native','dsh','onebot','host'].includes(String(value.source)) || !Object.hasOwn(NATIVE_EVENT_STATUSES,String(value.kind))
    || !isNativeEventCorrelation(value.correlation)) return false
  return (NATIVE_EVENT_STATUSES[value.kind as NativeEventKind] as readonly string[]).includes(String(value.status))
}
export function isNativeObservationEvent(value: unknown): value is NativeObservationEvent {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'at,correlation,cursor,kind,protocol,schema,source,status') return false
  const {schema,protocol,cursor,at,...input} = value
  return schema === 1 && protocol === NATIVE_EVENT_PROTOCOL && isNativeEventCursor(cursor) && integer(at) && isNativeEventInput(input)
}
export function isNativeEventFilter(value: unknown): value is NativeEventFilter {
  if (!record(value)) return false
  return Object.entries(value).every(([key,item]) => key === 'sources' ? Array.isArray(item) && item.length <= 4
    && new Set(item).size === item.length && item.every(source => ['native','dsh','onebot','host'].includes(source))
    : key === 'kinds' ? Array.isArray(item) && item.length <= 6 && new Set(item).size === item.length && item.every(kind => Object.hasOwn(NATIVE_EVENT_STATUSES,kind))
    : key === 'statuses' ? Array.isArray(item) && item.length <= 32 && new Set(item).size === item.length
      && item.every(status => Object.values(NATIVE_EVENT_STATUSES).some(statuses => (statuses as readonly unknown[]).includes(status)))
    : key === 'accountId' || key === 'protocolId' ? isNativeEventCorrelation({[key]:item})
    : ['conversationId','sessionId','executionId','requestId','workId','toolCallId'].includes(key) && nativeEventIdentifier(item))
}

export function isNativeEventPage(value: unknown): value is NativeEventPage {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'capacity,events,gap,latestCursor,nextCursor,oldestCursor,protocol,retention,schema'
    || value.schema !== 1 || value.protocol !== NATIVE_EVENT_PROTOCOL || value.retention !== 'process'
    || !integer(value.capacity,1) || value.capacity > 1000 || !['none','retention','epoch'].includes(String(value.gap))
    || !isNativeEventCursor(value.nextCursor) || !isNativeEventCursor(value.oldestCursor) || !isNativeEventCursor(value.latestCursor)
    || value.nextCursor.epoch !== value.latestCursor.epoch || value.oldestCursor.epoch !== value.latestCursor.epoch
    || value.oldestCursor.sequence > value.latestCursor.sequence || value.nextCursor.sequence > value.latestCursor.sequence
    || value.nextCursor.sequence < Math.max(0,value.oldestCursor.sequence-1)
    || !Array.isArray(value.events) || value.events.length > Math.min(256,value.capacity)) return false
  let previous = Math.max(0,value.oldestCursor.sequence-1)
  for (const event of value.events) {
    if (!isNativeObservationEvent(event) || event.cursor.epoch !== value.latestCursor.epoch
      || event.cursor.sequence <= previous || event.cursor.sequence > value.nextCursor.sequence) return false
    previous = event.cursor.sequence
  }
  return true
}
