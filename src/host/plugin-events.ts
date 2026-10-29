import type { DurableStore } from '../contracts/ports.ts'
import type { NativeEventCursor, NativeEventFilter, NativeEventNotification, NativeEventPage, NativeObservationEvent } from '../contracts/native-events.ts'
import { isNativeEventFilter, isNativeEventPage, isNativeObservationEvent } from '../contracts/native-events.ts'
import { pluginModelIdentifier } from '../contracts/plugin-model.ts'
import { assert, FrameworkError, isRecord, snapshot } from '../core/values.ts'
import type { createNativeEventObserver } from './native-events.ts'

export type PluginEventFilter = Pick<NativeEventFilter, 'sources' | 'kinds' | 'statuses' | 'sessionId' | 'requestId' | 'toolCallId'>
export interface PluginEventQuery {
  readonly after?: NativeEventCursor
  readonly filter?: PluginEventFilter
  readonly limit?: number
}
export interface PluginEventSubscription extends Omit<PluginEventQuery, 'limit'> {
  readonly signal?: AbortSignal
  readonly capacity?: number
}
export interface PluginEventsClient {
  /** Shared host lifecycle and verifiably attributed plugin metadata; never QQ message bodies. */
  read(query?: PluginEventQuery): NativeEventPage
  subscribe(query?: PluginEventSubscription): AsyncIterableIterator<NativeEventNotification>
}
export type PluginEventsObserver = Pick<ReturnType<typeof createNativeEventObserver>, 'read' | 'subscribe'>

/** Filters the actual host observer. This factory creates no isolated event bus or writer. */
export function createPluginEventsService(options: {
  readonly observer: PluginEventsObserver
  readonly store: Pick<DurableStore, 'read'>
  readonly signal?: AbortSignal
}) {
  const project = (owner: string, event: NativeObservationEvent): NativeObservationEvent | null => {
    if (!isNativeObservationEvent(event)) return null
    if (event.kind === 'runtime') return snapshot({ ...event, correlation: {} })
    const sessionId = event.correlation.sessionId
    if (!sessionId) return null
    const stored = options.store.read('plugin-model.executions', sessionId)
    if (!stored || !isRecord(stored.value) || stored.value.schema !== 1 || stored.value.owner !== owner
      || !pluginModelIdentifier(stored.value.requestId)
      || stored.value.sessionId !== undefined && stored.value.sessionId !== sessionId) return null
    const requestId = stored.value.requestId
    if (event.correlation.requestId !== undefined) {
      if (event.correlation.requestId !== requestId) return null
    } else {
      // A session can be shared by QQ and several plugins. Its ownership alone
      // never proves which caller produced a particular turn or tool event.
      const usage = stored.value.usage
      if (!['completed', 'failed'].includes(String(stored.value.state)) || !isRecord(usage)
        || event.correlation.turn === undefined || String(usage.turn) !== String(event.correlation.turn)) return null
    }
    return snapshot({ ...event, correlation: { sessionId, requestId,
      ...(event.correlation.turn === undefined ? {} : { turn: event.correlation.turn }),
      ...(event.correlation.step === undefined ? {} : { step: event.correlation.step }),
      ...(event.correlation.sourceSequence === undefined ? {} : { sourceSequence: event.correlation.sourceSequence }),
      ...(event.correlation.toolCallId === undefined ? {} : { toolCallId: event.correlation.toolCallId }) } })
  }
  const filter = (value: PluginEventFilter | undefined): PluginEventFilter => {
    const parsed = value ?? {}
    assert(isNativeEventFilter(parsed) && Object.keys(parsed).every(key => ['sources', 'kinds', 'statuses', 'sessionId', 'requestId', 'toolCallId'].includes(key)),
      'PLUGIN_EVENTS_FILTER_INVALID', 'Only bounded metadata filters are supported.')
    return snapshot(parsed)
  }
  return Object.freeze({
    forPlugin(owner: string, lifetime: AbortSignal, assertActive: () => void = () => {}): PluginEventsClient {
      assert(pluginModelIdentifier(owner), 'PLUGIN_EVENTS_OWNER_INVALID', 'A host-injected plugin owner is required.')
      const lifetimeSignal = options.signal ? AbortSignal.any([lifetime, options.signal]) : lifetime
      const active = () => { lifetimeSignal.throwIfAborted(); assertActive(); lifetimeSignal.throwIfAborted() }
      active()
      return Object.freeze<PluginEventsClient>({
        read(query = {}) {
          active()
          assert(isRecord(query) && Object.keys(query).every(key => ['after', 'filter', 'limit'].includes(key)),
            'PLUGIN_EVENTS_QUERY_INVALID', 'Only bounded observation queries are supported.')
          const page = options.observer.read({ ...query, filter: filter(query.filter) })
          assert(isNativeEventPage(page), 'PLUGIN_EVENTS_SOURCE_INVALID', 'The host observation page is invalid.')
          const events = page.events.flatMap(event => { const visible = project(owner, event); return visible ? [visible] : [] })
          active()
          // Cursors and gaps retain the actual host retention window. Filtering
          // out events is not evidence that nothing else happened in the host.
          return snapshot({ ...page, events })
        },
        subscribe(query = {}) {
          active()
          assert(isRecord(query) && Object.keys(query).every(key => ['after', 'filter', 'signal', 'capacity'].includes(key)),
            'PLUGIN_EVENTS_QUERY_INVALID', 'Only bounded observation subscriptions are supported.')
          const signal = query.signal ? AbortSignal.any([lifetimeSignal, query.signal]) : lifetimeSignal
          signal.throwIfAborted()
          const source = options.observer.subscribe({ ...query, filter: filter(query.filter), signal })
          let reading = false
          let closed = false
          return {
            [Symbol.asyncIterator]() { return this },
            async next(): Promise<IteratorResult<NativeEventNotification>> {
              active(); signal.throwIfAborted()
              if (closed) return { done: true, value: undefined }
              assert(!reading, 'PLUGIN_EVENTS_SUBSCRIPTION_BUSY', 'Only one pending event read is supported.')
              reading = true
              try {
                for (;;) {
                  const item = await source.next()
                  active(); signal.throwIfAborted()
                  if (item.done) { closed = true; return { done: true, value: undefined } }
                  if (item.value.type === 'gap') return { done: false, value: snapshot({ type: 'gap', reason: item.value.reason,
                    oldestCursor: item.value.oldestCursor, latestCursor: item.value.latestCursor }) }
                  const visible = project(owner, item.value.event)
                  if (visible) return { done: false, value: { type: 'event', event: visible } }
                }
              } catch (error) {
                closed = true
                await source.return?.()
                throw error
              } finally { reading = false }
            },
            async return(): Promise<IteratorResult<NativeEventNotification>> {
              closed = true
              await source.return?.()
              return { done: true, value: undefined }
            },
            async throw(): Promise<IteratorResult<NativeEventNotification>> {
              closed = true
              await source.return?.()
              throw new FrameworkError('PLUGIN_EVENTS_SUBSCRIPTION_CLOSED', 'The plugin closed its observation subscription.')
            },
          }
        },
      })
    },
  })
}
export type PluginEventsService = ReturnType<typeof createPluginEventsService>
