import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmError, type GenerateOptions, type LlmResolvedModelInfo, type PreparedAdapterCall, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

export interface PluginContextSelection { readonly provider: string; readonly model: string; readonly contextWindow?: number }

/** Separate SDK adapter routes expose a helper's capacity to both request logging and basic compaction. */
export function createPluginModelContexts(ctx: Context) {
  const routes = new Map<string, { readonly provider: string; readonly release: () => void }>()
  const originals = new Map<string, string>()
  let closed = false
  const routeName = (selection: PluginContextSelection) => `qbf-plugin-context-${createHash('sha256')
    .update(JSON.stringify([selection.provider, selection.model, selection.contextWindow])).digest('hex').slice(0, 32)}`
  const ensure = async (selection: PluginContextSelection, signal: AbortSignal): Promise<string> => {
    if (closed) throw new TypeError('Plugin context routes are closed')
    signal.throwIfAborted()
    const window = selection.contextWindow
    if (window === undefined) return selection.provider
    const llm = ctx.get('llm')
    if (!llm) throw new TypeError('Model runtime is unavailable')
    const bounded = (info: Readonly<LlmResolvedModelInfo>, provider: string): LlmResolvedModelInfo => {
      if (!info.context || info.context.contextWindow < window) throw new TypeError('Plugin context exceeds the verified source model capacity')
      return { ...info, provider, context: { contextWindow: window },
        ...(info.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: Math.min(info.defaultMaxTokens, Math.floor(window / 4)) }) }
    }
    const key = JSON.stringify([selection.provider, selection.model, window])
    // Verify current source capacity even when its auxiliary route already exists.
    bounded(await llm.resolveModelInfo(selection.provider, selection.model, signal), selection.provider)
    signal.throwIfAborted()
    if (closed) throw new TypeError('Plugin context routes are closed')
    const prior = routes.get(key)
    if (prior) return prior.provider
    if (routes.size >= 64) throw new TypeError('Plugin context route capacity is exhausted')
    const provider = routeName(selection)
    class ContextAdapter extends LlmAdapter {
      override providerRetryPolicy() { return llm!.providerRetryPolicy(selection.provider) }
      override imageRequestPricing(_provider: string, model: string) { return llm!.imageRequestPricing(selection.provider, model) }
      override imageRequestTarget(_provider: string, model: string, image: ImageAttachmentRef) { return llm!.imageRequestTarget(selection.provider, model, image) }
      override async resolveModel(route: string, model: string, current?: AbortSignal) {
        if (model !== selection.model) throw new TypeError('Plugin context route model mismatch')
        return bounded(await llm!.resolveModelInfo(selection.provider, model, current), route)
      }
      override async prepareCall(route: string, model: string, current?: AbortSignal): Promise<PreparedAdapterCall> {
        if (model !== selection.model) throw new TypeError('Plugin context route model mismatch')
        const source = await llm!.resolveModelInfo(selection.provider, model, current)
        const metadata = bounded(source, route)
        return { model: metadata, stream: options => this.forward(options, source) }
      }
      private async *forward(options: GenerateOptions, observed: LlmResolvedModelInfo): AsyncIterable<StreamChunk> {
        const { provider: _route, model, reasoningEffort, maxTokens, temperature, stop } = options
        const prepared = await llm!.prepareCall({ provider: selection.provider, model,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }), ...(maxTokens === undefined ? {} : { maxTokens }),
          ...(temperature === undefined ? {} : { temperature }), ...(stop === undefined ? {} : { stop }) }, options.signal,
        (controls, actual) => {
          // Reject changed capabilities before provider I/O. The original SDK handle
          // still pins the actual adapter generation, connection and authentication.
          if (JSON.stringify(actual) !== JSON.stringify(observed)) throw new LlmError('Source model metadata changed before helper dispatch', 'INVALID_PREPARED_CALL')
          bounded(actual, provider)
          return controls
        })
        yield* prepared.stream({ ...options, ...prepared.config })
      }
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const call = await this.prepareCall(provider, options.model, options.signal)
        yield* call.stream(options)
      }
    }
    const release = llm.registerAdapter([provider], new ContextAdapter())
    routes.set(key, { provider, release }); originals.set(provider, selection.provider)
    return provider
  }
  return Object.freeze({ ensure, originalProvider: (provider: string, stored?: PluginContextSelection) => originals.get(provider)
    ?? (stored?.contextWindow !== undefined && provider === routeName(stored) ? stored.provider : provider),
    close() { closed = true; for (const route of routes.values()) route.release(); routes.clear(); originals.clear() } })
}
