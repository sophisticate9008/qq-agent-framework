import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { validIdentifier } from './receipts.js'
import { validWorkOutput, type WorkOutput } from './work-output.js'
import type { WorkStart } from './work.js'

export interface WorkJournalRecord {
  readonly schema: 1
  readonly fingerprint: string
  readonly address: { readonly id: string; readonly parentSessionId: string; readonly childId: string; readonly generation: number }
  readonly target: { readonly modelProvider: string; readonly model: string; readonly agentPreset: string; readonly reasoningEffort?: string; readonly timeoutMs: number }
  readonly state: 'starting' | 'running' | 'completed' | 'unknown'
  readonly result: { readonly stopReason: string; readonly output: readonly WorkOutput[] } | null
  readonly error: string | null
  readonly acceptedMessageId: string | null
  readonly followupRequestId: string | null
}

export function workFingerprint(request: WorkStart): string {
  const { issuerEpoch: _issuerEpoch, ...identity } = request
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

function valid(value: unknown): value is WorkJournalRecord {
  if (!value || typeof value !== 'object' || !('schema' in value) || value.schema !== 1
    || !('fingerprint' in value) || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)
    || !('address' in value) || !value.address || typeof value.address !== 'object'
    || !('target' in value) || !value.target || typeof value.target !== 'object'
    || !('state' in value) || !['starting', 'running', 'completed', 'unknown'].includes(String(value.state))
    || !('result' in value) || !('error' in value) || !('acceptedMessageId' in value) || !('followupRequestId' in value)) return false
  const address = value.address as Record<string, unknown>
  const target = value.target as Record<string, unknown>
  if (Object.keys(address).sort().join(',') !== 'childId,generation,id,parentSessionId'
    || ![address.id, address.parentSessionId, address.childId].every(validIdentifier)
    || address.childId === address.parentSessionId || !Number.isSafeInteger(address.generation) || Number(address.generation) < 1
    || ![target.modelProvider, target.model, target.agentPreset].every(validIdentifier)
    || target.reasoningEffort !== undefined && !validIdentifier(target.reasoningEffort)
    || !Number.isSafeInteger(target.timeoutMs) || Number(target.timeoutMs) < 10 || Number(target.timeoutMs) > 300000
    || value.error !== null && (typeof value.error !== 'string' || !/^[A-Z][A-Z_]{1,63}$/.test(value.error))
    || value.acceptedMessageId !== null && !validIdentifier(value.acceptedMessageId)
    || value.followupRequestId !== null && !validIdentifier(value.followupRequestId)) return false
  if (value.result !== null) {
    if (typeof value.result !== 'object' || !('stopReason' in value.result) || !validIdentifier(value.result.stopReason)
      || !('output' in value.result) || !Array.isArray(value.result.output) || value.result.output.length > 256
      || value.result.output.some(block => !validWorkOutput(block))
      || Buffer.byteLength(JSON.stringify(value.result.output)) > 262144) return false
  }
  return value.state !== 'completed' || value.result !== null
}

export function createWorkJournal(directory: string) {
  if (!isAbsolute(directory) || resolve(directory) !== directory) throw new TypeError('Work storage must use a canonical absolute directory')
  async function ready(): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const metadata = await lstat(directory)
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700
      || metadata.uid !== process.getuid?.() || await realpath(directory) !== directory) throw new TypeError('Work storage is unavailable')
  }
  const filename = (id: string) => join(directory, `${createHash('sha256').update(id).digest('hex')}.json`)
  async function syncDirectory(): Promise<void> {
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await handle.sync() } finally { await handle.close() }
  }
  async function read(id: string): Promise<WorkJournalRecord | null> {
    if (!validIdentifier(id)) throw new TypeError('Invalid work identity')
    await ready()
    for (let attempt = 0; attempt < 3; attempt++) {
      const handle = await open(filename(id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
        throw error
      })
      if (!handle) return null
      try {
        const before = await handle.stat()
        if (!before.isFile() || before.size > 512 * 1024 || (before.mode & 0o777) !== 0o600
          || before.uid !== process.getuid?.()) throw new TypeError('Work journal is unavailable')
        const text = await handle.readFile('utf8')
        const after = await handle.stat()
        const path = await lstat(filename(id))
        if (before.ino !== path.ino || before.dev !== path.dev || before.size !== after.size
          || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.nlink !== 1 || path.nlink !== 1) continue
        const value: unknown = JSON.parse(text)
        if (!valid(value) || value.address.id !== id) throw new TypeError('Work journal cannot be interpreted safely')
        return value
      } finally { await handle.close() }
    }
    throw new TypeError('Work journal changed during read; inspect it again')
  }
  return Object.freeze({ read,
    async reserve(record: WorkJournalRecord): Promise<void> {
      if (!valid(record)) throw new TypeError('Invalid durable work record')
      await ready()
      if ((await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length >= 10000) throw new TypeError('Durable work retention capacity is occupied')
      const handle = await open(filename(record.address.id), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await handle.writeFile(JSON.stringify(record)); await handle.sync() } finally { await handle.close() }
      await syncDirectory()
    },
    async write(record: WorkJournalRecord): Promise<void> {
      if (!valid(record)) throw new TypeError('Invalid durable work result')
      const before = await read(record.address.id)
      if (!before || before.fingerprint !== record.fingerprint || JSON.stringify(before.address) !== JSON.stringify(record.address)) throw new TypeError('Work ownership changed')
      const temporary = `${filename(record.address.id)}.${randomUUID()}.tmp`
      let owned = false
      try {
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        owned = true
        try { await handle.writeFile(JSON.stringify(record)); await handle.sync() } finally { await handle.close() }
        await rename(temporary, filename(record.address.id)); owned = false
        await syncDirectory()
      } finally { if (owned) await unlink(temporary).catch(() => {}) }
    }
  })
}

export type WorkJournal = ReturnType<typeof createWorkJournal>
