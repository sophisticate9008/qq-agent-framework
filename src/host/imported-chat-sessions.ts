import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'

const MAX_DOCUMENT_BYTES = 1_048_576
const MAX_SESSIONS = 1_000

export interface ImportedChatSession {
  readonly key: string
  readonly sessionId: string
  readonly owner: boolean
}

export interface ImportedChatSessionsSnapshot {
  readonly revision: string
  readonly sessions: readonly ImportedChatSession[]
  readonly resetAvailable: false
  readonly next: null
  readonly historyReadOnly: true
  readonly source: 'imported'
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function readImportedChatSessions(directory: string): ImportedChatSessionsSnapshot | null {
  let descriptor: number | undefined
  try {
    const filename = join(directory, 'imported-chat-sessions.json')
    descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = fstatSync(descriptor)
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600
      || before.size < 1 || before.size > MAX_DOCUMENT_BYTES) return null
    const buffer = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < buffer.length) {
      const received = readSync(descriptor, buffer, length, buffer.length - length, null)
      if (received === 0) break
      length += received
    }
    const after = fstatSync(descriptor)
    const pathname = lstatSync(filename)
    if (length !== before.size || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || pathname.isSymbolicLink() || pathname.dev !== after.dev || pathname.ino !== after.ino
      || pathname.size !== after.size || pathname.mtimeMs !== after.mtimeMs || pathname.ctimeMs !== after.ctimeMs) return null
    const content = buffer.subarray(0, length)
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content))
    if (!record(value) || Object.keys(value).length !== 3 || value.schema !== 1
      || !Number.isSafeInteger(value.importedAt) || Number(value.importedAt) < 0
      || !Array.isArray(value.sessions) || value.sessions.length > MAX_SESSIONS) return null
    const sessions: ImportedChatSession[] = []
    const keys = new Set<string>()
    for (const entry of value.sessions) {
      if (!record(entry) || Object.keys(entry).length !== 3
        || typeof entry.key !== 'string' || !/^(?:group|private):[1-9][0-9]{0,15}$/.test(entry.key)
        || typeof entry.sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(entry.sessionId)
        || typeof entry.owner !== 'boolean' || entry.owner && !entry.key.startsWith('private:')
        || keys.has(entry.key)) return null
      keys.add(entry.key)
      sessions.push(Object.freeze({ key: entry.key, sessionId: entry.sessionId, owner: entry.owner }))
    }
    return Object.freeze({ revision: createHash('sha256').update(content).digest('hex'),
      sessions: Object.freeze(sessions), resetAvailable: false, next: null, historyReadOnly: true, source: 'imported' })
  } catch {
    return null
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}
