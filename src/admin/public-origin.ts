import { isIP } from 'node:net'

export interface AdminOriginOptions {
  readonly publicOrigin?: string
  readonly trustedLoopbackProxy?: boolean
}

export interface AdminOriginRequest {
  readonly origin?: unknown
  readonly host?: unknown
  readonly remoteAddress?: string
  readonly localAddress?: string
  readonly tls: boolean
}

export function validatePublicOrigin(value: unknown): string {
  if (value === '') return ''
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value)) throw new TypeError('Invalid public management origin')
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password
      || parsed.search || parsed.hash || value !== parsed.origin) throw new TypeError('Invalid public management origin')
    return parsed.origin
  } catch {
    throw new TypeError('Invalid public management origin')
  }
}

export function isLoopbackAddress(value: string): boolean {
  if (value.includes('%')) return false
  if (isIP(value) === 4) return value.split('.')[0] === '127'
  if (isIP(value) !== 6) return false
  const normalized = new URL(`http://[${value}]`).hostname.slice(1, -1)
  return normalized === '::1' || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(normalized)
}

export function createAdminOriginPolicy(options: AdminOriginOptions = {}) {
  const publicOrigin = validatePublicOrigin(options.publicOrigin === undefined ? '' : options.publicOrigin)
  const trusted = options.trustedLoopbackProxy === undefined ? false : options.trustedLoopbackProxy
  if (typeof trusted !== 'boolean' || trusted !== (publicOrigin !== '')) {
    throw new TypeError('Public management origin requires an explicit trusted loopback proxy')
  }
  const allowsTransport = (request: AdminOriginRequest): boolean => !trusted
    || typeof request.remoteAddress === 'string' && isLoopbackAddress(request.remoteAddress)
      && typeof request.localAddress === 'string' && isLoopbackAddress(request.localAddress)
  return Object.freeze({
    allowsTransport,
    sameOrigin(request: AdminOriginRequest): boolean {
      if (!allowsTransport(request) || typeof request.origin !== 'string') return false
      try {
        const actual = new URL(request.origin)
        if (request.origin !== actual.origin) return false
        if (trusted) return actual.origin === publicOrigin
        if (typeof request.host !== 'string' || request.host.length > 512 || /[\s\\/?#@,]/.test(request.host)) return false
        const expected = new URL(`${request.tls ? 'https' : 'http'}://${request.host}`)
        return actual.origin === expected.origin
      } catch {
        return false
      }
    },
    secureCookie(request: AdminOriginRequest): boolean {
      return request.tls || trusted && allowsTransport(request)
    },
  })
}
