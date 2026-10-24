import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const ACCESS_TOKEN_BYTES = 32
const MAX_ACCESS_SESSIONS = 256

interface StoredAccessSession {
  readonly expiresAt: number
}

export interface AccessSession {
  readonly token: string
  readonly expiresAt: number
}

export interface AccessSessionStore {
  issue(administratorToken: string): AccessSession | null
  authenticate(accessToken: string, administratorToken: string | null): number | null
  revoke(accessToken: string): boolean
  clear(): void
  activeCount(administratorToken: string | null): number
}

export interface AccessSessionStoreOptions {
  readonly ttlMs: number
  readonly clock?: () => number
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function equalDigest(left: Buffer | null, right: Buffer | null): boolean {
  if (left === null || right === null) return left === right
  return timingSafeEqual(left, right)
}

export function createAccessSessionStore({
  ttlMs,
  clock = Date.now
}: AccessSessionStoreOptions): AccessSessionStore {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs must be a positive integer')
  if (typeof clock !== 'function') throw new TypeError('clock must be a function')

  const sessions = new Map<string, StoredAccessSession>()
  let administratorTokenHash: Buffer | null = null

  const purgeExpired = (currentTime: number): void => {
    for (const [tokenHash, session] of sessions) {
      if (session.expiresAt <= currentTime) sessions.delete(tokenHash)
    }
  }

  const synchronizeAdministrator = (administratorToken: string | null): number => {
    const currentTime = clock()
    const nextHash = administratorToken === null ? null : digest(administratorToken)
    if (!equalDigest(administratorTokenHash, nextHash)) {
      sessions.clear()
      administratorTokenHash = nextHash
    }
    purgeExpired(currentTime)
    return currentTime
  }

  return Object.freeze({
    issue(administratorToken: string): AccessSession | null {
      const currentTime = synchronizeAdministrator(administratorToken)
      if (sessions.size >= MAX_ACCESS_SESSIONS) return null

      let token: string
      let tokenHash: string
      do {
        token = randomBytes(ACCESS_TOKEN_BYTES).toString('base64url')
        tokenHash = digest(token).toString('base64url')
      } while (sessions.has(tokenHash))

      const expiresAt = currentTime + ttlMs
      sessions.set(tokenHash, Object.freeze({ expiresAt }))
      return Object.freeze({ token, expiresAt })
    },
    authenticate(accessToken: string, administratorToken: string | null): number | null {
      synchronizeAdministrator(administratorToken)
      if (administratorToken === null) return null
      return sessions.get(digest(accessToken).toString('base64url'))?.expiresAt ?? null
    },
    revoke(accessToken: string): boolean {
      purgeExpired(clock())
      return sessions.delete(digest(accessToken).toString('base64url'))
    },
    clear(): void {
      sessions.clear()
      administratorTokenHash = null
    },
    activeCount(administratorToken: string | null): number {
      synchronizeAdministrator(administratorToken)
      return sessions.size
    }
  })
}
