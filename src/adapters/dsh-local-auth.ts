import { createHash, createHmac } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { isIP } from 'node:net'
import { isAbsolute, normalize } from 'node:path'
import { isUtf8 } from 'node:buffer'
import { parseDocument } from 'yaml'
import { FrameworkError } from '../core/values.ts'

export type DshLocalInteractionMode = 'none' | 'answer'

export interface DshLocalAuthenticationOptions {
  readonly endpoint: string
  readonly credentialsPath: string
}

export interface DshLocalAuthenticationRequest extends DshLocalAuthenticationOptions {
  readonly interactionMode: DshLocalInteractionMode
  readonly signal: AbortSignal
}

export type DshLocalAuthenticationProvider = (mode: DshLocalInteractionMode, signal: AbortSignal) => Promise<string>

function fail(code = 'DSH_LOCAL_AUTH_UNAVAILABLE'): never {
  throw new FrameworkError(code, 'Local DSH authentication did not complete safely.')
}

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) fail('DSH_LOCAL_AUTH_ABORTED')
}

function endpointUrl(value: string): URL {
  if (typeof value !== 'string' || value.length > 2_048 || !/^https?:\/\//.test(value)
    || /[\u0000-\u0020\u007f\\?#]/.test(value)) fail('DSH_LOCAL_AUTH_INVALID_ENDPOINT')
  const authority = value.slice(value.indexOf('://') + 3).split('/', 1)[0]!
  if (!/^(?:localhost|127(?:\.[0-9]{1,3}){3}|\[::1\])(?::[0-9]{1,5})?$/.test(authority)) fail('DSH_LOCAL_AUTH_INVALID_ENDPOINT')
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || url.hostname !== 'localhost' && url.hostname !== '[::1]' && !(isIP(url.hostname) === 4 && url.hostname.startsWith('127.'))
    || url.port === '0') fail('DSH_LOCAL_AUTH_INVALID_ENDPOINT')
  return url
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

interface ValidatedCookie {
  readonly revision: string
  readonly cookie: string
  readonly issuedAt: number
  readonly refreshAt: number
}

function fileRevision(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
}

async function authenticatedCookie(filename: string, authority: string, cached: ValidatedCookie | undefined,
  signal: AbortSignal): Promise<ValidatedCookie> {
  checkSignal(signal)
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' || typeof filename !== 'string'
    || !isAbsolute(filename) || filename.length > 4_096 || normalize(filename) !== filename
    || /[\u0000-\u001f\u007f]/.test(filename) || filename.endsWith('/')) fail('DSH_LOCAL_AUTH_INVALID_PATH')
  let directory: FileHandle | undefined
  let file: FileHandle | undefined
  let bytes: Buffer | undefined
  try {
    directory = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const segments = filename.slice(1).split('/')
    const basename = segments.pop()!
    for (const segment of segments) {
      checkSignal(signal)
      const previous = directory
      directory = await open(`/proc/self/fd/${previous.fd}/${segment}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      await previous.close()
    }
    checkSignal(signal)
    file = await open(`/proc/self/fd/${directory.fd}/${basename}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = await file.stat({ bigint: true })
    const mode = Number(before.mode & 0o7777n)
    if (!before.isFile() || before.uid !== BigInt(process.getuid()) || before.nlink !== 1n || mode !== 0o600 && mode !== 0o400
      || before.size < 1n || before.size > 1_048_576n) fail('DSH_LOCAL_AUTH_UNSAFE_FILE')
    const revision = fileRevision(before)
    const now = Date.now()
    const reusable = cached?.revision === revision && cached.issuedAt <= now && cached.refreshAt > now ? cached : undefined
    let bytesRead = 0
    if (!reusable) {
      bytes = Buffer.alloc(Number(before.size) + 1)
      bytesRead = (await file.read(bytes, 0, bytes.length, 0)).bytesRead
      if (BigInt(bytesRead) !== before.size) fail('DSH_LOCAL_AUTH_FILE_CHANGED')
    }
    const after = await file.stat({ bigint: true })
    const current = await lstat(filename, { bigint: true })
    if (fileRevision(after) !== revision || current.isSymbolicLink() || fileRevision(current) !== revision
      || await realpath(filename) !== filename) fail('DSH_LOCAL_AUTH_FILE_CHANGED')
    checkSignal(signal)
    if (reusable) return reusable
    const body = bytes!.subarray(0, bytesRead)
    if (!isUtf8(body)) fail('DSH_LOCAL_AUTH_INVALID_CREDENTIALS')
    const document = parseDocument(body.toString('utf8'), { strict: true, uniqueKeys: true })
    if (document.errors.length || document.warnings.length) fail('DSH_LOCAL_AUTH_INVALID_CREDENTIALS')
    const value: unknown = document.toJS({ maxAliasCount: 0 })
    if (!object(value) || !Object.hasOwn(value, 'records') || !object(value.records)
      || !Object.hasOwn(value.records, 'client-connection/browser-session')) fail('DSH_LOCAL_AUTH_INVALID_CREDENTIALS')
    const record = value.records['client-connection/browser-session']
    if (!object(record) || !Object.hasOwn(record, 'kind') || record.kind !== 'grant' || !Object.hasOwn(record, 'payload')
      || !object(record.payload) || !Object.hasOwn(record.payload, 'version') || record.payload.version !== 1
      || !Object.hasOwn(record.payload, 'secret') || typeof record.payload.secret !== 'string'
      || !/^[A-Za-z0-9_-]{43}$/.test(record.payload.secret)) fail('DSH_LOCAL_AUTH_INVALID_CREDENTIALS')
    const secret = Buffer.from(record.payload.secret, 'base64url')
    if (secret.length !== 32 || secret.toString('base64url') !== record.payload.secret) {
      secret.fill(0)
      fail('DSH_LOCAL_AUTH_INVALID_CREDENTIALS')
    }
    try {
      const issuedAt = Date.now()
      const body = Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt: issuedAt + 300_000 }), 'utf8').toString('base64url')
      const signature = createHmac('sha256', secret).update(body).digest('base64url')
      const name = `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}`
      return { revision, cookie: `${name}=v1.${body}.${signature}`, issuedAt, refreshAt: issuedAt + 240_000 }
    } finally { secret.fill(0) }
  } catch {
    checkSignal(signal)
    return fail()
  } finally {
    bytes?.fill(0)
    await file?.close().catch(() => undefined)
    await directory?.close().catch(() => undefined)
  }
}

export function createLocalDshAuthenticationProvider(options: DshLocalAuthenticationOptions): DshLocalAuthenticationProvider {
  const endpoint = endpointUrl(options.endpoint)
  const credentialsPath = options.credentialsPath
  const authority = endpoint.protocol === 'https:' ? endpoint.origin : endpoint.host
  let cached: ValidatedCookie | undefined
  let pending: Promise<ValidatedCookie> | undefined
  return async (mode, signal) => {
    checkSignal(signal)
    if (mode !== 'none' && mode !== 'answer') fail('DSH_LOCAL_AUTH_INVALID_MODE')
    if (!pending) {
      // Each request checks the current secure file revision. Only concurrent checks share work;
      // one caller's cancellation cannot cancel another caller's authentication.
      const operation = authenticatedCookie(credentialsPath, authority, cached, AbortSignal.timeout(10_000))
      pending = operation
      void operation.then(value => {
        cached = value
        if (pending === operation) pending = undefined
      }, () => {
        cached = undefined
        if (pending === operation) pending = undefined
      })
    }
    const operation = pending
    return new Promise<string>((resolve, reject) => {
      const abort = (): void => reject(new FrameworkError('DSH_LOCAL_AUTH_ABORTED', 'Local DSH authentication did not complete safely.'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      void operation.then(value => {
        checkSignal(signal)
        resolve(value.cookie)
      }).catch(reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }
}

export async function loadLocalDshAuthentication(request: DshLocalAuthenticationRequest): Promise<string> {
  return createLocalDshAuthenticationProvider(request)(request.interactionMode, request.signal)
}
