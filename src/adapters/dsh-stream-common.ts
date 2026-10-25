import { DshAdapterError } from './dsh.ts'
export function dshFailure(code: string): DshAdapterError { return new DshAdapterError(code, 'DSH network operation did not complete safely.') }
export function dshRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
export function dshIdentifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value) }
export interface DshBoundedOperation { <Value>(operation: (signal: AbortSignal) => Promise<Value>, signal: AbortSignal): Promise<Value> }
export function createDshCallbackBudget(maxCallbacks: number, limited: DshBoundedOperation) {
  let active = 0
  return Object.freeze({ get active() { return active },
    async deliver<Value>(event: Value, callback: (event: Value) => Promise<void> | void, signal: AbortSignal, code: string): Promise<void> {
      if (active >= maxCallbacks) throw dshFailure(code)
      active++
      let started = false
      try {
        await limited(async () => { started = true; try { await callback(event) } finally { active-- } }, signal)
      } finally { if (!started) active-- }
    }
  })
}
export type DshCallbackBudget = ReturnType<typeof createDshCallbackBudget>
