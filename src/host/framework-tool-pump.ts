import type { DshFrameworkToolPort } from '../adapters/dsh-framework-tools.ts'
import type { FrameworkToolCall, FrameworkToolPendingCall, FrameworkToolResult } from '../contracts/framework-tools.ts'
import { assert, errorCode } from '../core/values.ts'
import { withDeadline } from './deadlines.ts'

/** One explicitly started owner connection; connection failure stops it without replay. */
export function createFrameworkToolPump(options: {
  readonly port: DshFrameworkToolPort
  readonly issuerEpoch: string
  readonly accepts: (pending: Readonly<FrameworkToolPendingCall>) => boolean
  readonly execute: (call: Readonly<FrameworkToolCall>, signal: AbortSignal) => Promise<FrameworkToolResult>
  readonly pollIntervalMs?: number
  readonly onFault?: (code: string) => void
}) {
  const interval = options.pollIntervalMs ?? 100
  assert(Number.isSafeInteger(interval) && interval >= 10 && interval <= 5000,
    'INVALID_TOOL_PUMP_OPTIONS', 'Tool polling must have a bounded interval.')
  const lifetime = new AbortController()
  const active = new Map<string, { controller: AbortController; operation: Promise<void> }>()
  const seen = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let started = false
  let state: 'idle' | 'running' | 'unknown' | 'closed' = 'idle'
  let lastError: string | null = null
  let poll: Promise<void> | undefined
  function fault(error: unknown): void { try { options.onFault?.(errorCode(error, 'TOOL_CHANNEL_UNKNOWN')) } catch {} }
  function stop(): void { lifetime.abort(); clearTimeout(timer); for (const entry of active.values()) entry.controller.abort() }
  function fail(error: unknown): void {
    if (lifetime.signal.aborted) return
    state = 'unknown'; lastError = errorCode(error, 'TOOL_CHANNEL_UNKNOWN'); fault(error); stop()
  }
  async function tick(): Promise<void> {
    try {
      const pending = await options.port.poll({ issuerEpoch: options.issuerEpoch }, lifetime.signal)
      if (lifetime.signal.aborted) return
      const tickets = new Set(pending.map(entry => entry.ticket))
      for (const [ticket, entry] of active) if (!tickets.has(ticket)) entry.controller.abort()
      for (const item of pending) {
        // Polling is shared by bridge instances. Only the lease owner may settle a ticket.
        if (seen.has(item.ticket) || !options.accepts(item)) continue
        assert(seen.size < 4096, 'TOOL_CALL_CAPACITY', 'Restart the explicit tool projection after retained calls reach capacity.')
        seen.add(item.ticket)
        const controller = new AbortController()
        const signal = AbortSignal.any([lifetime.signal, controller.signal])
        const operation = (async () => {
          const result = await options.execute(item.call, signal)
          if (!signal.aborted) await options.port.complete({ issuerEpoch: options.issuerEpoch, ticket: item.ticket, result }, signal)
        })().catch(error => {
          // A withdrawn or expired ticket cancels only this call. It does not
          // invalidate other conversations sharing the healthy polling channel.
          if (!signal.aborted) fail(error)
        }).finally(() => active.delete(item.ticket))
        active.set(item.ticket, { controller, operation })
      }
    } catch (error) {
      fail(error)
    }
    finally { if (!lifetime.signal.aborted) timer = setTimeout(run, interval) }
  }
  function run(): void { poll = tick() }
  return Object.freeze({
    status() { return Object.freeze({ state, pending: active.size, lastError }) },
    start(): void { assert(!started && !lifetime.signal.aborted, 'TOOL_PUMP_CLOSED', 'A tool owner connection can only be started once.'); started = true; state = 'running'; run() },
    async close(signal: AbortSignal): Promise<void> {
      stop()
      if (state !== 'unknown') state = 'closed'
      await withDeadline({ signal, timeoutMs: 5000, code: 'TOOL_CHANNEL_STOP_UNKNOWN',
        run: () => Promise.all([poll, ...[...active.values()].map(entry => entry.operation)]).then(() => undefined) })
    }
  })
}
