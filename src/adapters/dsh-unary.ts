import { randomUUID } from 'node:crypto'
import { snapshot } from '../core/values.ts'
import type { JsonObject, JsonValue } from '../contracts/data.ts'
import { DshAdapterError, type DshPortResult } from './dsh.ts'
import type { DshFrameworkToolMethod } from './dsh-framework-tools.ts'
import type { DshWorkMethod } from './dsh-work.ts'
import { dshFailure as failure, dshRecord as record } from './dsh-stream-common.ts'

export function createDshUnaryTransport(options: { readonly base: URL; readonly auth: string; readonly initialCookie: string | undefined;
  readonly authenticationProvider: ((mode: 'none' | 'answer', signal: AbortSignal) => Promise<string>) | undefined;
  readonly timeoutMs: number; readonly maxBytes: number; readonly lifetime: AbortController }) {
  const { base, auth, authenticationProvider, timeoutMs, maxBytes, lifetime } = options
  const rejected = (code: string): DshPortResult<never> => ({ ok: false, error: { code } })
  let cookie = options.initialCookie
  let pendingRpc = 0
  let authentication: Promise<string> | undefined
  let interactionCookie: string | undefined
  let interactionAuthentication: Promise<string> | undefined

  const limited = async <Value>(operation: (signal: AbortSignal) => Promise<Value>, signal: AbortSignal): Promise<Value> => {
    const deadline = new AbortController()
    const combined = AbortSignal.any([signal, lifetime.signal, deadline.signal])
    const timer = setTimeout(() => deadline.abort(), timeoutMs)
    try {
      combined.throwIfAborted()
      return await new Promise<Value>((resolve, reject) => {
        const abort = (): void => reject(failure(deadline.signal.aborted ? 'DSH_TIMEOUT' : 'DSH_ABORTED'))
        combined.addEventListener('abort', abort, { once: true })
        Promise.resolve().then(() => {
          combined.throwIfAborted()
          return operation(combined)
        }).then(resolve, reject).finally(() => combined.removeEventListener('abort', abort))
      })
    } catch (error) {
      if (error instanceof DshAdapterError) throw error
      throw failure(combined.aborted ? 'DSH_ABORTED' : 'DSH_TRANSPORT_UNKNOWN')
    } finally {
      clearTimeout(timer)
    }
  }

  const readJson = async (response: Response): Promise<unknown> => {
    const reader = response.body?.getReader()
    if (!reader) throw failure('DSH_INVALID_RESPONSE')
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        length += chunk.value.byteLength
        if (length > maxBytes) throw failure('DSH_RESPONSE_TOO_LARGE')
        chunks.push(chunk.value)
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }

  const authenticate = async (signal: AbortSignal, interactions: 'none' | 'answer' = 'none'): Promise<string> => {
    signal.throwIfAborted()
    if (authenticationProvider !== undefined) {
      const credential = await limited(combined => authenticationProvider(interactions, combined), signal)
      if (typeof credential !== 'string' || credential.length > 4_096 || !/^[A-Za-z0-9_-]+=[A-Za-z0-9_.~-]+$/.test(credential)) throw failure('DSH_AUTH_REJECTED')
      return credential
    }
    if (interactions === 'answer' && auth.startsWith('cookie:')) throw failure('DSH_INTERACTIONS_REQUIRE_TOKEN')
    const cached = interactions === 'answer' ? interactionCookie : cookie
    if (cached !== undefined) return cached
    if ((interactions === 'answer' ? interactionAuthentication : authentication) === undefined) {
      const exchange = limited(async authSignal => {
        const url = new URL('connect', base)
        url.searchParams.set('token', auth)
        url.searchParams.set('interactions', interactions)
        const response = await fetch(url, { redirect: 'manual', signal: authSignal })
        try {
          if (response.status !== 302) throw failure('DSH_AUTH_REJECTED')
          const location = response.headers.get('location')
          if (location === null || new URL(location, url).href !== new URL('api/remote.mux', base).href) {
            throw failure('DSH_AUTH_REJECTED')
          }
          const cookies = response.headers.getSetCookie()
          if (cookies.length !== 1) throw failure('DSH_AUTH_REJECTED')
          const selected = cookies[0]!.split(';', 1)[0]!
          if (!/^[A-Za-z0-9_-]+=[A-Za-z0-9_.~-]+$/.test(selected)) throw failure('DSH_AUTH_REJECTED')
          if (interactions === 'answer') interactionCookie = selected
          else cookie = selected
          return selected
        } finally {
          await response.body?.cancel().catch(() => undefined)
        }
      }, lifetime.signal)
      if (interactions === 'answer') interactionAuthentication = exchange
      else authentication = exchange
      void exchange.catch(() => {
        if (interactions === 'answer') {
          if (interactionAuthentication === exchange) interactionAuthentication = undefined
        } else if (authentication === exchange) authentication = undefined
      })
    }
    const pending = interactions === 'answer' ? interactionAuthentication : authentication
    return limited(async () => pending!, signal)
  }

  const rpc = async (method: DshWorkMethod | DshFrameworkToolMethod | '$events/result' | 'session/create' | 'session/selectModel' | 'session/modelCatalog' | 'session/prompt' | 'session/cancel' | 'settings/describe' | 'agentPresets/list' | 'agentPresets/read' | 'credentials/describe' | 'bridgePlugin/inspectToolInventory' | 'bridgePlugin/describe' | 'bridgePlugin/inspectScope' | 'bridgePlugin/claimReceipts' | 'bridgePlugin/forkPreview' | 'bridgePlugin/forkWithPreset' | 'bridgePlugin/inspectMigration' | 'bridgePlugin/inspectExecution' | 'bridgePlugin/inspectSessionStorage', input: JsonObject | undefined, signal: AbortSignal, direct = false): Promise<DshPortResult<JsonValue>> => {
    if (pendingRpc >= 32) throw failure('DSH_RPC_BACKPRESSURE')
    pendingRpc += 1
    try {
      return await limited(async combined => {
        const credential = await authenticate(combined, method === '$events/result' ? 'answer' : 'none')
        combined.throwIfAborted()
        const rpcId = randomUUID()
        const response = await fetch(new URL(`api/${method}`, base), {
          method: 'POST', redirect: 'error', signal: combined,
          headers: { 'content-type': 'application/json', cookie: credential },
          body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: input === undefined ? {} : direct ? input : { request: input } } }),
        })
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined)
          throw failure(response.status === 401 || response.status === 403 ? 'DSH_AUTH_REJECTED' : 'DSH_HTTP_UNKNOWN')
        }
        const envelope = await readJson(response)
        combined.throwIfAborted()
        if (!record(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId || !record(envelope.result)) {
          throw failure('DSH_INVALID_RESPONSE')
        }
        const result = envelope.result
        if (method === '$events/result' && result.ok === true && !Object.hasOwn(result, 'value')) return { ok: true, value: null }
        if (result.ok === false && record(result.error) && typeof result.error.code === 'string'
          && typeof result.error.message === 'string' && record(result.error.details)) {
          if (method === '$events/result') return rejected('DSH_INTERACTION_REJECTED')
          if (method === 'session/modelCatalog'
            && ['gateway/method-unavailable', 'gateway/service-unavailable', 'gateway/definition-unavailable'].includes(result.error.code)) {
            return rejected('DSH_MODEL_CAPABILITIES_UNVERIFIED')
          }
          if (method.startsWith('bridgePlugin/')) {
            if (['gateway/method-unavailable', 'gateway/service-unavailable', 'gateway/definition-unavailable'].includes(result.error.code)) {
              return rejected('DSH_PLUGIN_UNAVAILABLE')
            }
            if (['remote-access/denied', 'bridgePlugin/operator-required'].includes(result.error.code)) throw failure('DSH_PLUGIN_AUTH_REJECTED')
          }
          if (!new Set([
            'gateway/bad-request', 'gateway/input-invalid', 'gateway/method-not-found',
            'session/not-found', 'session/agent-busy', 'session/model-unavailable', 'session/attachment-invalid',
            'session/provider-models-unavailable', 'session/provider-credentials-unavailable',
            'session/conflict', 'session/writer-held', 'agent-preset/conflict',
          ]).has(result.error.code)) throw failure('DSH_RPC_UNKNOWN')
          return rejected('DSH_RPC_REJECTED')
        }
        if (result.ok !== true || !Object.hasOwn(result, 'value')) throw failure('DSH_INVALID_RESPONSE')
        return { ok: true, value: snapshot(result.value) as JsonValue }
      }, signal)
    } finally {
      pendingRpc -= 1
    }
  }

  return Object.freeze({ limited, authenticate, rpc })
}
