import { isIP } from 'node:net'
import { basename, isAbsolute, normalize } from 'node:path'

export interface NativeAdapterConfiguration {
  readonly onebotHttp: {
    readonly enabled: boolean
    readonly endpoint: string
    readonly secret: string
  }
  readonly onebotWs: {
    readonly enabled: boolean
    readonly endpoint: string
    readonly secret: string
  }
  readonly dshAgent: {
    readonly enabled: boolean
    readonly endpoint: string
    readonly auth: string
    readonly localCredentialsPath?: string
  }
  readonly onebotWebhook: {
    readonly enabled: boolean
    readonly host: string
    readonly port: number
    readonly selfId: string
    readonly hmac: string
  }
}

export interface PublicAdapterConfiguration {
  readonly onebotHttp: {
    readonly enabled: boolean
    readonly endpoint: string
    readonly secretConfigured: boolean
  }
  readonly onebotWs: {
    readonly enabled: boolean
    readonly endpoint: string
    readonly secretConfigured: boolean
  }
  readonly dshAgent: {
    readonly enabled: boolean
    readonly endpoint: string
    readonly authConfigured: boolean
    readonly localAuthConfigured: boolean
  }
  readonly onebotWebhook: {
    readonly enabled: boolean
    readonly host: string
    readonly port: number
    readonly selfId: string
    readonly hmacConfigured: boolean
  }
}

export interface AdapterRuntimePort {
  status(): { readonly running: boolean } | Promise<{ readonly running: boolean }>
  connect?(configuration: NativeAdapterConfiguration, signal: AbortSignal): Promise<void>
  disconnect?(): Promise<void>
  connectionStatus?(): AdapterConnectionStatus | Promise<AdapterConnectionStatus>
}

export interface AdapterConnectionStatus {
  readonly state: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'
  readonly selfId: string | null
  readonly lastError: string | null
  readonly received: number
  readonly dropped: number
  readonly chatReady: boolean
}

const LEGACY_ADAPTER_IDS = ['onebotHttp', 'dshAgent', 'onebotWebhook'] as const
const ADAPTER_IDS = [...LEGACY_ADAPTER_IDS, 'onebotWs'] as const
const MAX_ENDPOINT_LENGTH = 2_048
const MAX_CREDENTIAL_LENGTH = 4_096

function invalid(): never {
  throw new TypeError('Invalid adapter configuration')
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function keys(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!record(value) || !required.every(key => Object.hasOwn(value, key))
    || !Object.keys(value).every(key => required.includes(key) || optional.includes(key))) return invalid()
  return value
}

function loopbackHost(value: string): boolean {
  return value === 'localhost' || value === '::1'
    || isIP(value) === 4 && value.startsWith('127.')
}

export function validateAdapterEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_ENDPOINT_LENGTH) return invalid()
  if (value === '') return value
  if (!/^https?:\/\//.test(value) || /[\u0000-\u0020\u007f\\?#]/.test(value)) return invalid()
  const authority = value.slice(value.indexOf('://') + 3).split('/', 1)[0]
  if (authority.includes('@')) return invalid()
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return invalid()
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return invalid()
  if (url.protocol === 'http:') {
    const match = /^(localhost|127(?:\.[0-9]{1,3}){3}|\[::1\])(?::[0-9]{1,5})?$/.exec(authority)
    if (match === null || !loopbackHost(match[1] === '[::1]' ? '::1' : match[1])) return invalid()
  } else if (url.protocol !== 'https:') {
    return invalid()
  }
  return value
}

export function validateOneBotWebSocketEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_ENDPOINT_LENGTH) return invalid()
  if (value === '') return value
  if (!/^wss?:\/\//.test(value)) return invalid()
  validateAdapterEndpoint(value.replace(/^ws/, 'http'))
  return value
}

function credential(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_CREDENTIAL_LENGTH
    || value !== '' && !/^[\x21-\x7e]+$/.test(value)) return invalid()
  return value
}

function mergeCredential(current: string, value: Record<string, unknown>, key: string, clearKey: string): string {
  const next = Object.hasOwn(value, key) ? credential(value[key]) : ''
  if (Object.hasOwn(value, clearKey) && typeof value[clearKey] !== 'boolean') return invalid()
  if (value[clearKey] === true) {
    if (next !== '') return invalid()
    return ''
  }
  return next === '' ? current : next
}

function outbound(value: unknown, secretKey: string, validateEndpoint = validateAdapterEndpoint): {
  readonly enabled: boolean
  readonly endpoint: string
  readonly credential: string
} {
  const parsed = keys(value, ['enabled', 'endpoint', secretKey])
  if (typeof parsed.enabled !== 'boolean') return invalid()
  const endpoint = validateEndpoint(parsed.endpoint)
  if (parsed.enabled && endpoint === '') return invalid()
  return { enabled: parsed.enabled, endpoint, credential: credential(parsed[secretKey]) }
}

function localCredentialsPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096
    || !isAbsolute(value) || normalize(value) !== value || basename(value) !== '.credentials.yaml'
    || /[\u0000-\u001f\u007f\\]/.test(value)) return invalid()
  return value
}

function dshAgent(value: unknown): NativeAdapterConfiguration['dshAgent'] {
  const parsed = keys(value, ['enabled', 'endpoint', 'auth'], ['localCredentialsPath'])
  const channel = outbound({ enabled: parsed.enabled, endpoint: parsed.endpoint, auth: parsed.auth }, 'auth')
  const path = Object.hasOwn(parsed, 'localCredentialsPath') ? localCredentialsPath(parsed.localCredentialsPath) : undefined
  if (path !== undefined && channel.credential !== '') return invalid()
  return Object.freeze({ enabled: channel.enabled, endpoint: channel.endpoint, auth: channel.credential,
    ...(path === undefined ? {} : { localCredentialsPath: path }) })
}

function webhook(value: unknown): NativeAdapterConfiguration['onebotWebhook'] {
  const parsed = keys(value, ['enabled', 'host', 'port', 'selfId', 'hmac'])
  if (typeof parsed.enabled !== 'boolean' || typeof parsed.host !== 'string' || !loopbackHost(parsed.host)
    || typeof parsed.port !== 'number' || !Number.isSafeInteger(parsed.port)
    || parsed.port < 0 || parsed.port > 65_535
    || typeof parsed.selfId !== 'string'
    || parsed.selfId !== '' && !/^[1-9][0-9]{0,31}$/.test(parsed.selfId)) return invalid()
  const hmac = credential(parsed.hmac)
  if (parsed.enabled && (parsed.port === 0 || parsed.selfId === '' || hmac === '')) return invalid()
  return Object.freeze({
    enabled: parsed.enabled, host: parsed.host, port: parsed.port, selfId: parsed.selfId, hmac
  })
}

export function createDefaultAdapterConfiguration(): NativeAdapterConfiguration {
  return Object.freeze({
    onebotHttp: Object.freeze({ enabled: false, endpoint: '', secret: '' }),
    onebotWs: Object.freeze({ enabled: false, endpoint: '', secret: '' }),
    dshAgent: Object.freeze({ enabled: false, endpoint: '', auth: '' }),
    onebotWebhook: Object.freeze({ enabled: false, host: '127.0.0.1', port: 0, selfId: '', hmac: '' })
  })
}

export function validateAdapterConfiguration(value: unknown): NativeAdapterConfiguration {
  const parsed = keys(value, LEGACY_ADAPTER_IDS, ['onebotWs'])
  const onebotHttp = outbound(parsed.onebotHttp, 'secret')
  const onebotWs = Object.hasOwn(parsed, 'onebotWs')
    ? outbound(parsed.onebotWs, 'secret', validateOneBotWebSocketEndpoint)
    : { enabled: false, endpoint: '', credential: '' }
  const dsh = dshAgent(parsed.dshAgent)
  const onebotWebhook = webhook(parsed.onebotWebhook)
  if (onebotWs.enabled && onebotWebhook.enabled) return invalid()
  return Object.freeze({
    onebotHttp: Object.freeze({
      enabled: onebotHttp.enabled, endpoint: onebotHttp.endpoint, secret: onebotHttp.credential
    }),
    onebotWs: Object.freeze({ enabled: onebotWs.enabled, endpoint: onebotWs.endpoint, secret: onebotWs.credential }),
    dshAgent: dsh,
    onebotWebhook
  })
}

function outboundPatch(
  currentCredential: string,
  value: unknown,
  secretKey: string,
  clearKey: string
): Record<string, unknown> {
  const parsed = keys(value, ['enabled', 'endpoint'], [secretKey, clearKey])
  return {
    enabled: parsed.enabled,
    endpoint: parsed.endpoint,
    [secretKey]: mergeCredential(currentCredential, parsed, secretKey, clearKey)
  }
}

function dshPatch(current: NativeAdapterConfiguration['dshAgent'], value: unknown): Record<string, unknown> {
  const parsed = keys(value, ['enabled', 'endpoint'], ['auth', 'clearAuth', 'localCredentialsPath'])
  const manual = Object.hasOwn(parsed, 'auth') ? credential(parsed.auth) : ''
  if (Object.hasOwn(parsed, 'clearAuth') && typeof parsed.clearAuth !== 'boolean') return invalid()
  const hasPath = Object.hasOwn(parsed, 'localCredentialsPath')
  const path = hasPath ? parsed.localCredentialsPath === '' ? undefined : localCredentialsPath(parsed.localCredentialsPath)
    : current.localCredentialsPath
  if (manual !== '' && (parsed.clearAuth === true || hasPath && path !== undefined)) return invalid()
  const nextPath = manual !== '' || parsed.clearAuth === true && !hasPath ? undefined : path
  const auth = hasPath && path !== undefined || parsed.clearAuth === true ? '' : manual !== '' ? manual : current.auth
  return { enabled: parsed.enabled, endpoint: parsed.endpoint, auth,
    ...(nextPath === undefined ? {} : { localCredentialsPath: nextPath }) }
}

export function updateAdapterConfiguration(current: NativeAdapterConfiguration, patch: unknown): NativeAdapterConfiguration {
  const previous = validateAdapterConfiguration(current)
  const updates = keys(patch, [], ADAPTER_IDS)
  if (Object.keys(updates).length === 0) return invalid()
  let onebotWebhook: unknown = previous.onebotWebhook
  if (Object.hasOwn(updates, 'onebotWebhook')) {
    const parsed = keys(updates.onebotWebhook, ['enabled', 'host', 'port', 'selfId'], ['hmac', 'clearHmac'])
    onebotWebhook = {
      enabled: parsed.enabled, host: parsed.host, port: parsed.port, selfId: parsed.selfId,
      hmac: mergeCredential(previous.onebotWebhook.hmac, parsed, 'hmac', 'clearHmac')
    }
  }
  return validateAdapterConfiguration({
    onebotHttp: Object.hasOwn(updates, 'onebotHttp')
      ? outboundPatch(previous.onebotHttp.secret, updates.onebotHttp, 'secret', 'clearSecret')
      : previous.onebotHttp,
    onebotWs: Object.hasOwn(updates, 'onebotWs')
      ? outboundPatch(previous.onebotWs.secret, updates.onebotWs, 'secret', 'clearSecret')
      : previous.onebotWs,
    dshAgent: Object.hasOwn(updates, 'dshAgent')
      ? dshPatch(previous.dshAgent, updates.dshAgent)
      : previous.dshAgent,
    onebotWebhook
  })
}

export function publicAdapterConfiguration(value: NativeAdapterConfiguration): PublicAdapterConfiguration {
  const configuration = validateAdapterConfiguration(value)
  return Object.freeze({
    onebotHttp: Object.freeze({
      enabled: configuration.onebotHttp.enabled,
      endpoint: configuration.onebotHttp.endpoint,
      secretConfigured: configuration.onebotHttp.secret !== ''
    }),
    onebotWs: Object.freeze({
      enabled: configuration.onebotWs.enabled,
      endpoint: configuration.onebotWs.endpoint,
      secretConfigured: configuration.onebotWs.secret !== ''
    }),
    dshAgent: Object.freeze({
      enabled: configuration.dshAgent.enabled,
      endpoint: configuration.dshAgent.endpoint,
      authConfigured: configuration.dshAgent.auth !== '' || configuration.dshAgent.localCredentialsPath !== undefined,
      localAuthConfigured: configuration.dshAgent.localCredentialsPath !== undefined
    }),
    onebotWebhook: Object.freeze({
      enabled: configuration.onebotWebhook.enabled,
      host: configuration.onebotWebhook.host,
      port: configuration.onebotWebhook.port,
      selfId: configuration.onebotWebhook.selfId,
      hmacConfigured: configuration.onebotWebhook.hmac !== ''
    })
  })
}
