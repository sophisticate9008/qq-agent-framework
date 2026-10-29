import type { DurableStore } from '../contracts/ports.ts'
import { pluginModelIdentifier } from '../contracts/plugin-model.ts'
import { assert, isRecord, snapshot } from '../core/values.ts'
import { createNativeUsage, type NativeUsageQuery } from './native-usage.ts'

export interface PluginUsageQuery extends Omit<NativeUsageQuery, 'conversationId'> {}
type NativeUsageReader = ReturnType<typeof createNativeUsage>
export type PluginUsagePage = ReturnType<NativeUsageReader['list']>
export type PluginUsageSummary = ReturnType<NativeUsageReader['summary']>
export interface PluginUsageClient {
  /** Actual ledger records attributed to this plugin, including its old shared sessions. */
  list(query?: PluginUsageQuery): PluginUsagePage
  summary(query?: PluginUsageQuery): PluginUsageSummary
}

/** Uses the host's existing ledger and decoder; it never creates a parallel usage journal. */
export function createPluginUsageService(options: {
  readonly store: DurableStore
  readonly signal?: AbortSignal
  readonly maxScan?: number
}) {
  const usage = createNativeUsage({ store: options.store, maxScan: options.maxScan ?? 10_000 })
  return Object.freeze({
    forPlugin(owner: string, lifetime: AbortSignal, assertActive: () => void = () => {}): PluginUsageClient {
      assert(pluginModelIdentifier(owner) && owner.length <= 153, 'PLUGIN_USAGE_OWNER_INVALID', 'A bounded host-injected plugin owner is required.')
      const signal = options.signal ? AbortSignal.any([options.signal, lifetime]) : lifetime
      const active = () => { signal.throwIfAborted(); assertActive(); signal.throwIfAborted() }
      const queryForOwner = (query: PluginUsageQuery): NativeUsageQuery => {
        assert(isRecord(query) && Object.keys(query).every(key => ['sessionId', 'provider', 'model', 'since', 'until', 'limit', 'after'].includes(key)),
          'PLUGIN_USAGE_QUERY_INVALID', 'Only bounded usage filters are supported.')
        // The ledger's per-turn caller attribution is authoritative. An owned
        // binding or shared session alone never permits reading its other turns.
        return { ...query, conversationId: `plugin:${owner}` }
      }
      active()
      return Object.freeze<PluginUsageClient>({
        list(query = {}) {
          active()
          const result = usage.list(queryForOwner(query))
          active()
          return snapshot(result)
        },
        summary(query = {}) {
          active()
          const result = usage.summary(queryForOwner(query))
          active()
          return snapshot(result)
        },
      })
    },
  })
}
export type PluginUsageService = ReturnType<typeof createPluginUsageService>
