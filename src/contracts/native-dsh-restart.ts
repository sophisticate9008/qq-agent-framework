import { isNativeSessionActionTarget, type NativeSessionActionTarget } from './native-session-actions.ts'
import { isNativeApplicationId } from './native-application.ts'
import { isNativeConfigurationRevisions, type NativeConfigurationRevisions } from './native-revisions.ts'

export const NATIVE_DSH_RESTART_PATH = '/api/chat/dsh/restart'
export interface NativeDshRestartRequest {
  readonly deleteSession?: NativeSessionActionTarget
  readonly operationId: string
  readonly revisions: NativeConfigurationRevisions
}
export interface NativeDshRestartOperation {
  readonly schema: 1
  readonly deleteSession?: NativeSessionActionTarget
  readonly id: string
  readonly state: 'running' | 'completed' | 'blocked' | 'unknown'
  readonly phase: null | 'stop' | 'restart' | 'verify' | 'restore'
  readonly phaseState: 'pending' | 'in-flight' | 'confirmed'
  readonly revisions: NativeConfigurationRevisions
  readonly wasRunning: boolean
  readonly restartExecutionVerified: boolean
  readonly createdAt: number
  readonly updatedAt: number
  readonly reasons: readonly string[]
}
export interface NativeDshRestartSnapshot {
  readonly schema: 1
  readonly available: boolean
  readonly missingReasons: readonly string[]
  readonly operation: NativeDshRestartOperation | null
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const reasons = (value: unknown): value is readonly string[] => Array.isArray(value) && value.length <= 64
  && value.every(reason => typeof reason === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(reason))
export function parseNativeDshRestartRequest(value: unknown): NativeDshRestartRequest | null {
  return record(value) && Object.keys(value).length === (value.deleteSession === undefined ? 2 : 3) && (value.deleteSession === undefined || isNativeSessionActionTarget(value.deleteSession)) && isNativeApplicationId(value.operationId)
    && isNativeConfigurationRevisions(value.revisions) ? { operationId: value.operationId, revisions: value.revisions, ...(isNativeSessionActionTarget(value.deleteSession) ? { deleteSession: value.deleteSession } : {}) } : null
}
export function parseNativeDshRestartOperation(value: unknown): NativeDshRestartOperation | null {
  if (!record(value) || value.deleteSession !== undefined && !isNativeSessionActionTarget(value.deleteSession) || value.schema !== 1 || !isNativeApplicationId(value.id)
    || !['running', 'completed', 'blocked', 'unknown'].includes(String(value.state))
    || value.phase !== null && !['stop', 'restart', 'verify', 'restore'].includes(String(value.phase))
    || !['pending', 'in-flight', 'confirmed'].includes(String(value.phaseState))
    || !isNativeConfigurationRevisions(value.revisions) || typeof value.wasRunning !== 'boolean'
    || typeof value.restartExecutionVerified !== 'boolean' || !reasons(value.reasons)
    || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.updatedAt)
    || typeof value.createdAt !== 'number' || value.createdAt < 0 || typeof value.updatedAt !== 'number' || value.updatedAt < value.createdAt
    || value.state === 'completed' && (value.phase !== 'restore' || value.phaseState !== 'confirmed' || value.reasons.length !== 0)) return null
  return { schema: 1, ...(isNativeSessionActionTarget(value.deleteSession) ? { deleteSession: value.deleteSession } : {}), id: value.id, state: value.state as NativeDshRestartOperation['state'],
    phase: value.phase as NativeDshRestartOperation['phase'], phaseState: value.phaseState as NativeDshRestartOperation['phaseState'],
    revisions: value.revisions, wasRunning: value.wasRunning, restartExecutionVerified: value.restartExecutionVerified,
    createdAt: value.createdAt, updatedAt: value.updatedAt, reasons: value.reasons }
}
export function parseNativeDshRestartSnapshot(value: unknown): NativeDshRestartSnapshot | null {
  if (!record(value) || value.schema !== 1 || typeof value.available !== 'boolean' || !reasons(value.missingReasons)) return null
  const operation = value.operation === null ? null : parseNativeDshRestartOperation(value.operation)
  return operation === null && value.operation !== null ? null
    : { schema: 1, available: value.available, missingReasons: value.missingReasons, operation }
}
