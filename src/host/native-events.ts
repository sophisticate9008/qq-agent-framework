import { randomUUID } from 'node:crypto'
import { assert, FrameworkError, snapshot } from '../core/values.ts'
import { isNativeEventCursor, isNativeEventFilter, isNativeEventInput, NATIVE_EVENT_PROTOCOL,
  type NativeEventCursor, type NativeEventFilter, type NativeEventInput, type NativeEventNotification,
  type NativeEventPage, type NativeObservationEvent } from '../contracts/native-events.ts'

interface Subscriber { push(event: NativeObservationEvent): void; close(error?: Error): void }
function matches(event: NativeObservationEvent, filter: NativeEventFilter): boolean {
  return (!filter.sources || filter.sources.includes(event.source)) && (!filter.kinds || filter.kinds.includes(event.kind))
    && (!filter.statuses || filter.statuses.includes(event.status))
    && Object.entries(filter).every(([key,value]) => ['sources','kinds','statuses'].includes(key) || event.correlation[key as keyof typeof event.correlation] === value)
}

/** A bounded process observation stream. It neither authorizes actions nor claims durable execution receipts. */
export function createNativeEventObserver(options: { readonly now?: () => number; readonly capacity?: number; readonly epoch?: string } = {}) {
  const capacity = options.capacity ?? 100
  const epoch = options.epoch ?? randomUUID()
  assert(Number.isSafeInteger(capacity) && capacity >= 1 && capacity <= 1000 && isNativeEventCursor({epoch,sequence:0}),
    'EVENT_OPTIONS_INVALID', 'Observation retention and epoch must be bounded.')
  const now = options.now ?? Date.now
  const events: NativeObservationEvent[] = []
  const subscribers = new Set<Subscriber>()
  let sequence = 0
  let closed = false
  const cursor = (value = sequence): NativeEventCursor => Object.freeze({epoch,sequence:value})

  function read(input: { readonly after?: NativeEventCursor; readonly filter?: NativeEventFilter; readonly limit?: number } = {}): NativeEventPage {
    const filter = snapshot(input.filter ?? {})
    const limit = input.limit ?? 100
    assert(Object.keys(input).every(key => ['after','filter','limit'].includes(key)) && isNativeEventFilter(filter)
      && Number.isSafeInteger(limit) && limit >= 1 && limit <= 256 && (input.after === undefined || isNativeEventCursor(input.after)),
    'EVENT_QUERY_INVALID', 'Observation queries require a valid bounded filter and cursor.')
    const oldest = events[0]?.cursor.sequence ?? sequence
    const floor = events.length ? oldest - 1 : sequence
    const gap = input.after?.epoch !== undefined && input.after.epoch !== epoch ? 'epoch'
      : input.after && input.after.sequence < floor ? 'retention' : 'none'
    assert(!input.after || gap === 'epoch' || input.after.sequence <= sequence, 'EVENT_CURSOR_AHEAD', 'A cursor cannot address unobserved future events.')
    let scanned = input.after && gap === 'none' ? input.after.sequence : floor
    const selected: NativeObservationEvent[] = []
    for (const event of events) {
      if (event.cursor.sequence <= scanned) continue
      scanned = event.cursor.sequence
      if (matches(event,filter)) selected.push(event)
      if (selected.length === limit) break
    }
    return snapshot({schema:1,protocol:NATIVE_EVENT_PROTOCOL,events:selected,nextCursor:cursor(scanned),oldestCursor:cursor(oldest),latestCursor:cursor(),
      gap,retention:'process',capacity})
  }

  return Object.freeze({
    record(input: NativeEventInput): NativeObservationEvent {
      assert(!closed, 'EVENT_STREAM_CLOSED', 'The process observation stream has closed.')
      assert(isNativeEventInput(input), 'EVENT_INPUT_INVALID', 'Observation events contain only versioned metadata and correlation identifiers.')
      const at = now()
      assert(Number.isSafeInteger(at) && at >= 0 && sequence < Number.MAX_SAFE_INTEGER, 'EVENT_CLOCK_INVALID', 'A bounded observation clock is required.')
      const event: NativeObservationEvent = snapshot({...input,schema:1,protocol:NATIVE_EVENT_PROTOCOL,cursor:cursor(++sequence),at})
      events.push(event)
      if (events.length > capacity) events.shift()
      for (const subscriber of subscribers) subscriber.push(event)
      return event
    },
    read,
    subscribe(input: { readonly after?: NativeEventCursor; readonly filter?: NativeEventFilter; readonly signal?: AbortSignal; readonly capacity?: number } = {}): AsyncIterableIterator<NativeEventNotification> {
      assert(!closed && subscribers.size < 32, 'EVENT_SUBSCRIPTION_UNAVAILABLE', 'Process subscriptions are closed or at capacity.')
      assert(Object.keys(input).every(key => ['after','filter','signal','capacity'].includes(key)), 'EVENT_QUERY_INVALID', 'Only bounded subscription options are supported.')
      const filter = snapshot(input.filter ?? {})
      const queueCapacity = input.capacity ?? 128
      assert(isNativeEventFilter(filter) && Number.isSafeInteger(queueCapacity) && queueCapacity >= 1 && queueCapacity <= 1000,
        'EVENT_QUERY_INVALID', 'Subscription filters and queues must be bounded.')
      const queue: NativeEventNotification[] = []
      let pending: { resolve(value: IteratorResult<NativeEventNotification>): void; reject(error: Error): void } | undefined
      let stopped = false
      let failure: Error | undefined
      const close = (error?: Error) => {
        if (stopped) return
        stopped = true; failure = error; queue.length = 0
        subscribers.delete(subscriber)
        input.signal?.removeEventListener('abort',abort)
        if (pending) {
          const waiting = pending; pending = undefined; failure = undefined
          if (error) waiting.reject(error)
          else waiting.resolve({done:true,value:undefined})
        }
      }
      const enqueue = (notification: NativeEventNotification) => {
        if (stopped) return
        if (pending) { const waiting = pending; pending = undefined; waiting.resolve({done:false,value:notification}); return }
        if (queue.length >= queueCapacity) { close(new FrameworkError('EVENT_BACKPRESSURE','The observation consumer fell behind its bounded queue; resume from its last cursor.')); return }
        queue.push(notification)
      }
      const subscriber: Subscriber = { push(event) { if (matches(event,filter)) enqueue(Object.freeze({type:'event',event})) },close }
      const abort = () => close(new FrameworkError('EVENT_SUBSCRIPTION_ABORTED','The observation subscription was cancelled.'))
      // Resume synchronously before registering live delivery; no callback or await can interleave this handoff.
      if (input.after !== undefined) {
        let page = read({after:input.after,filter,limit:256})
        if (page.gap !== 'none') enqueue(snapshot({type:'gap',reason:page.gap,oldestCursor:page.oldestCursor,latestCursor:page.latestCursor}))
        for (;;) {
          for (const event of page.events) enqueue(Object.freeze({type:'event',event}))
          if (stopped || page.nextCursor.sequence === page.latestCursor.sequence) break
          page = read({after:page.nextCursor,filter,limit:256})
        }
      }
      if (!stopped) {
        subscribers.add(subscriber)
        if (input.signal?.aborted) abort()
        else input.signal?.addEventListener('abort',abort,{once:true})
      }
      const iterator: AsyncIterableIterator<NativeEventNotification> = {
        [Symbol.asyncIterator]() { return this },
        next() {
          if (failure) { const error = failure;failure = undefined;return Promise.reject(error) }
          if (stopped) return Promise.resolve({done:true,value:undefined})
          const value = queue.shift()
          if (value) return Promise.resolve({done:false,value})
          if (pending) return Promise.reject(new FrameworkError('EVENT_SUBSCRIPTION_BUSY','Only one pending observation read is supported.'))
          return new Promise<IteratorResult<NativeEventNotification>>((resolve,reject) => {pending={resolve,reject}})
        },
        return() { close();return Promise.resolve({done:true,value:undefined}) },
        throw() { close();return Promise.reject(new FrameworkError('EVENT_SUBSCRIPTION_CLOSED','The observation consumer closed with an error.')) },
      }
      return iterator
    },
    close() { if (closed) return;closed = true;for (const subscriber of subscribers) subscriber.close() },
    metrics() { return snapshot({retained:events.length,capacity,subscribers:subscribers.size,closed,latestCursor:cursor()}) },
  })
}
