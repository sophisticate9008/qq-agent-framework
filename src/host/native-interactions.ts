import { randomUUID } from 'node:crypto'
import type { JsonValue } from '../core/types.ts'
import { FrameworkError, isRecord, snapshot } from '../core/values.ts'
import type { DshInteractionEvent, DshInteractionPort, DshPortResult } from '../adapters/dsh.ts'
import { withDeadline } from './deadlines.ts'
import type { NativeActivityState } from './native-activity.ts'
import type { SessionBinding } from './types.ts'
import { redactNativeText } from './native-redacted-text.ts'

export type NativeInteractionEvent = DshInteractionEvent
export type NativeInteractionStatus = 'pending' | 'submitting' | 'answered' | 'approved' | 'denied'
  | 'rejected' | 'unknown' | 'expired' | 'disconnected'
export interface NativeInteractionQuestion {
  readonly id: string
  readonly text: string
  readonly options: readonly string[]
}
export interface NativeInteractionEntry {
  readonly id: string
  readonly revision: number
  readonly kind: 'question' | 'approval'
  readonly status: NativeInteractionStatus
  readonly sessionId: string
  readonly conversationId: string
  readonly generation: number
  readonly createdAt: number
  readonly expiresAt: number
  readonly summary: string
  readonly questions: readonly NativeInteractionQuestion[]
  readonly toolName: string | null
}
export type NativeInteractionPort = Pick<DshInteractionPort, 'respondInteraction'>
export interface NativeInteractionBinding extends Readonly<SessionBinding> { readonly expiresAt?: number }
export interface NativeInteractionMount {
  readonly port: NativeInteractionPort
  readonly resolveSession: (sessionId: string) => NativeInteractionBinding | undefined
  readonly guard: (binding: Readonly<SessionBinding>, signal: AbortSignal) => Promise<void>
  readonly signal: AbortSignal
  readonly epoch: string
}
export interface NativeInteractionResponse {
  readonly id: string
  readonly revision: number
  readonly action: 'reply' | 'approve' | 'deny'
  readonly reply?: string
}
export type NativeInteractions = ReturnType<typeof createNativeInteractions>
interface InteractionRow {
  entry: NativeInteractionEntry
  mount: NativeInteractionMount
  eventId: string
  clientId: string
  key: string
  bindingExpiresAt: number | null
  timer: ReturnType<typeof setTimeout>
}

function fail(code: string): never { throw new FrameworkError(code, 'Native interaction operation is unavailable or stale.') }
function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
}
function questions(input: readonly JsonValue[]): readonly NativeInteractionQuestion[] | null {
  if (input.length === 0 || input.length > 8) return null
  const result: NativeInteractionQuestion[] = []
  for (const question of input) {
    if (!isRecord(question) || !text(question.id, 128) || !text(question.question, 2_000)
      || result.some(value => value.id === question.id)) return null
    const options: string[] = []
    if (question.options !== undefined) {
      if (!Array.isArray(question.options) || question.options.length > 16) return null
      for (const option of question.options) {
        const label = typeof option === 'string' ? option : isRecord(option) ? option.label : null
        if (!text(label, 200)) return null
        options.push(label)
      }
    }
    result.push({ id: question.id, text: question.question, options })
  }
  return snapshot(result)
}

export function createNativeInteractions(options: { readonly state: () => NativeActivityState; readonly sensitiveValues?: () => readonly string[] }) {
  let mount: NativeInteractionMount | undefined
  const rows = new Map<string, InteractionRow>()
  const operations = new Set<Promise<DshPortResult<JsonValue>>>()
  let admissions = 0
  let dropped = 0

  function update(row: InteractionRow, status: NativeInteractionStatus) {
    row.entry = snapshot({ ...row.entry, status, revision: row.entry.revision + 1 })
    if (status !== 'pending' && status !== 'submitting') clearTimeout(row.timer)
  }
  function disconnect(current: NativeInteractionMount) {
    if (mount === current) mount = undefined
    for (const row of rows.values()) if (row.mount === current) {
      if (row.entry.status === 'pending') update(row, 'disconnected')
      else if (row.entry.status === 'submitting') update(row, 'unknown')
    }
  }
  function owns(row: InteractionRow, binding: NativeInteractionBinding | undefined) {
    return binding !== undefined && binding.sessionId === row.entry.sessionId
      && binding.conversationId === row.entry.conversationId && binding.generation === row.entry.generation
      && (row.bindingExpiresAt === null || binding.expiresAt === row.bindingExpiresAt)
  }
  function refresh() {
    for (const row of rows.values()) if (row.entry.status === 'pending' || row.entry.status === 'submitting') {
      let valid = false
      try { valid = mount === row.mount && !row.mount.signal.aborted && owns(row, row.mount.resolveSession(row.entry.sessionId)) } catch {}
      if (!valid || Date.now() >= row.entry.expiresAt) update(row, row.entry.status === 'submitting' ? 'unknown' : 'expired')
    }
  }
  function current(row: InteractionRow) {
    if (mount !== row.mount || mount.signal.aborted || options.state() !== 'running') fail('INTERACTION_UNAVAILABLE')
    const binding = mount.resolveSession(row.entry.sessionId)
    if (!owns(row, binding) || Date.now() >= row.entry.expiresAt) {
      update(row, row.entry.status === 'submitting' ? 'unknown' : 'expired')
      fail('INTERACTION_EXPIRED')
    }
    return binding!
  }

  return Object.freeze({
    mount(configuration: NativeInteractionMount): () => void {
      if (!text(configuration.epoch, 256) || configuration.signal.aborted
        || typeof configuration.port.respondInteraction !== 'function' || typeof configuration.resolveSession !== 'function'
        || typeof configuration.guard !== 'function') fail('INTERACTION_UNAVAILABLE')
      if (mount) disconnect(mount)
      mount = Object.freeze({ ...configuration })
      const captured = mount
      const release = () => disconnect(captured)
      captured.signal.addEventListener('abort', release, { once: true })
      return () => { captured.signal.removeEventListener('abort', release); release() }
    },
    observe(event: NativeInteractionEvent, epoch: string, expiresAt = Date.now() + 300_000): void {
      try {
        const active = mount
        if (!active || active.signal.aborted || active.epoch !== epoch || !['starting', 'running'].includes(options.state())) return
        const binding = active.resolveSession(event.sessionId)
        if (!binding || binding.sessionId !== event.sessionId || !/^(?:group|private):[1-9][0-9]{0,31}$/.test(binding.conversationId)
          || !text(binding.sessionId, 256) || !Number.isSafeInteger(binding.generation) || binding.generation < 1
          || binding.expiresAt !== undefined && (!Number.isSafeInteger(binding.expiresAt) || binding.expiresAt <= Date.now())) return
        if (event.type === 'interaction/closed') {
          for (const row of rows.values()) if (row.mount === active && row.entry.sessionId === event.sessionId
            && (event.eventId === undefined || row.eventId === event.eventId)) {
            if (row.entry.status === 'pending') update(row, 'disconnected')
            else if (row.entry.status === 'submitting') update(row, 'unknown')
          }
          return
        }
        if (!text(event.eventId, 256) || !text(event.clientId, 256)) return
        const key = JSON.stringify([binding.sessionId, binding.generation, event.eventId])
        if ([...rows.values()].some(row => row.key === key)) return
        const projected = event.type === 'question/requested' ? questions(event.questions) : []
        if (projected === null) return
        refresh()
        if (rows.size >= 100) {
          const removable = [...rows.values()].find(row => !['pending', 'submitting', 'unknown'].includes(row.entry.status))
          if (!removable) { dropped++; return }
          clearTimeout(removable.timer)
          rows.delete(removable.entry.id)
        }
        const createdAt = Date.now()
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= createdAt) return
        const entry: NativeInteractionEntry = snapshot({ id: randomUUID(), revision: 1,
          kind: event.type === 'question/requested' ? 'question' : 'approval', status: 'pending',
          sessionId: binding.sessionId, conversationId: binding.conversationId, generation: binding.generation,
          createdAt, expiresAt: Math.min(createdAt + 300_000, expiresAt, binding.expiresAt ?? Number.MAX_SAFE_INTEGER),
          summary: event.type === 'question/requested' ? '有个问题等待回复。'
            : (redactNativeText(event.reason, options.sensitiveValues?.())?.slice(0, 240) || '需要确认这一次工具操作。'), questions: projected,
          toolName: event.type === 'approval/requested' && typeof event.toolName === 'string'
            && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(event.toolName) ? event.toolName : null })
        const timer = setTimeout(() => {
          const row = rows.get(entry.id)
          if (row?.entry.status === 'pending') update(row, 'expired')
          else if (row?.entry.status === 'submitting') update(row, 'unknown')
        }, Math.max(1, entry.expiresAt - Date.now()))
        timer.unref()
        rows.set(entry.id, { entry, mount: active, key, eventId: event.eventId, clientId: event.clientId,
          bindingExpiresAt: binding.expiresAt ?? null, timer })
      } catch { dropped++ }
    },
    snapshot() {
      refresh()
      const state = options.state()
      const available = state === 'running' && mount !== undefined && !mount.signal.aborted
      return snapshot({ source: 'native-chat' as const, retention: 'process' as const, capacity: 100 as const,
        state, available, unavailableReason: available ? null : state !== 'running' ? 'runtime-not-running' as const
          : 'interaction-port-unavailable' as const, dropped,
        items: [...rows.values()].reverse().map(row => row.entry) })
    },
    async respond(request: NativeInteractionResponse, signal: AbortSignal): Promise<NativeInteractionEntry> {
      const row = rows.get(request.id)
      if (!row) fail('INTERACTION_NOT_FOUND')
      if (row.entry.revision !== request.revision || !['pending'].includes(row.entry.status)) fail('INTERACTION_STALE')
      if (request.action === 'reply' ? row.entry.kind !== 'question' || !text(request.reply, 8_000)
        : row.entry.kind !== 'approval' || !['approve', 'deny'].includes(request.action)) fail('INTERACTION_INVALID_RESPONSE')
      if (operations.size + admissions >= 4) fail('INTERACTION_BUSY')
      signal.throwIfAborted()
      const binding = current(row)
      update(row, 'submitting')
      admissions++
      let admissionHeld = true
      let dispatched = false
      try {
        const result = await withDeadline({ signal: AbortSignal.any([signal, row.mount.signal]),
          timeoutMs: Math.max(1, Math.min(5_000, row.entry.expiresAt - Date.now())), code: 'INTERACTION_RESPONSE_UNKNOWN',
          async run(controlSignal) {
            await row.mount.guard(binding, controlSignal)
            current(row)
            controlSignal.throwIfAborted()
            if (row.entry.status !== 'submitting') fail('INTERACTION_STALE')
            const value = request.action === 'reply'
              ? { answers: row.entry.questions.map(question => question.options.includes(request.reply!)
                ? { id: question.id, selected: [request.reply!] }
                : { id: question.id, selected: [] as string[], custom: request.reply! }) }
              : request.action === 'approve' ? 'allowed-once' as const : 'rejected' as const
            dispatched = true
            const pending = row.mount.port.respondInteraction({ sessionId: row.entry.sessionId,
              clientId: row.clientId, eventId: row.eventId, outcome: { kind: 'result', value }, signal: controlSignal })
            operations.add(pending)
            admissions--
            admissionHeld = false
            void pending.finally(() => operations.delete(pending)).catch(() => undefined)
            return pending
          } })
        if (row.entry.status === 'submitting') update(row, result.ok ? request.action === 'reply' ? 'answered'
          : request.action === 'approve' ? 'approved' : 'denied' : 'rejected')
      } catch {
        if (row.entry.status === 'submitting') update(row, dispatched ? 'unknown' : 'rejected')
      } finally {
        if (admissionHeld) admissions--
      }
      return snapshot(row.entry)
    }
  })
}
