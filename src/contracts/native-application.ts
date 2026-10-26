import { isNativeConfigurationRevisions, type NativeConfigurationRevisions } from './native-revisions.ts';

export type NativeApplicationPhase = 'stop' | 'prepare' | 'apply' | 'migrate' | 'start';
export interface NativeApplicationRequest {
  readonly operationId: string;
  readonly revisions: NativeConfigurationRevisions;
  readonly deploy: boolean;
}
export interface NativeApplicationSnapshot {
  readonly schema: 1;
  readonly id: string;
  readonly state: 'running' | 'completed' | 'blocked' | 'unknown';
  readonly phase: NativeApplicationPhase | null;
  readonly phaseState: 'pending' | 'in-flight' | 'confirmed';
  readonly revisions: NativeConfigurationRevisions;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly reasons: readonly string[];
}
export function nativeApplicationRequiresReconciliation(operation: NativeApplicationSnapshot): boolean {
  return operation.state === 'running' || operation.state === 'unknown'
    || operation.state === 'blocked' && operation.phase === 'apply' && operation.reasons.includes('pending_reload');
}
export const NATIVE_APPLICATION_PATH = '/api/chat/application';
export const isNativeApplicationId = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export function parseNativeApplicationRequest(input: unknown): NativeApplicationRequest | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  return Object.keys(value).length === 3 && isNativeApplicationId(value.operationId)
    && isNativeConfigurationRevisions(value.revisions) && typeof value.deploy === 'boolean'
    ? { operationId: value.operationId, revisions: value.revisions, deploy: value.deploy } : null;
}
export function parseNativeApplicationSnapshot(input: unknown): NativeApplicationSnapshot | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (value.schema !== 1 || !isNativeApplicationId(value.id)
    || !['running', 'completed', 'blocked', 'unknown'].includes(String(value.state))
    || value.phase !== null && !['stop', 'prepare', 'apply', 'migrate', 'start'].includes(String(value.phase))
    || !['pending', 'in-flight', 'confirmed'].includes(String(value.phaseState))
    || !isNativeConfigurationRevisions(value.revisions)
    || typeof value.createdAt !== 'number' || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
    || typeof value.updatedAt !== 'number' || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < value.createdAt
    || value.updatedAt > 8_640_000_000_000_000
    || !Array.isArray(value.reasons) || value.reasons.length > 64
    || !value.reasons.every(reason => typeof reason === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(reason))
    || value.state === 'completed' && (value.phase !== 'start' || value.phaseState !== 'confirmed' || value.reasons.length !== 0)) return null;
  return { schema: 1, id: value.id, state: value.state as NativeApplicationSnapshot['state'],
    phase: value.phase as NativeApplicationPhase | null, phaseState: value.phaseState as NativeApplicationSnapshot['phaseState'],
    revisions: value.revisions, createdAt: value.createdAt, updatedAt: value.updatedAt, reasons: value.reasons as string[] };
}

export interface NativeApplicationEnvelope {
  readonly schema: 1;
  readonly operation: NativeApplicationSnapshot | null;
}
export function parseNativeApplicationEnvelope(input: unknown): NativeApplicationEnvelope | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (value.schema !== 1 || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'operation')) return null;
  if (value.operation === null) return { schema: 1, operation: null };
  const operation = parseNativeApplicationSnapshot(value.operation);
  return operation ? { schema: 1, operation } : null;
}
