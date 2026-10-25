import { isNativeAccessScope } from './native-access.ts';

export const NATIVE_USAGE_MAINTENANCE_PATH = '/api/chat/usage/maintenance';
export const NATIVE_USAGE_MAINTENANCE_ROWS = 60;
export interface NativeUsageMaintenanceScope {
  readonly since: number; readonly until: number; readonly after?: string;
  readonly conversationId?: string; readonly provider?: string; readonly model?: string;
}
export interface NativeUsageMaintenanceRow {
  readonly cursor: string; readonly conversationId: string; readonly provider: string; readonly model: string;
  readonly status: 'completed' | 'failed'; readonly recordedAt: number;
}
export interface NativeUsageMaintenanceOperation {
  readonly schema: 1; readonly id: string; readonly revision: number; readonly kind: 'archive' | 'clear';
  readonly state: 'prepared' | 'completed' | 'blocked'; readonly scope: NativeUsageMaintenanceScope;
  readonly createdAt: number; readonly expiresAt: number; readonly completedAt: number | null;
  readonly rows: readonly NativeUsageMaintenanceRow[]; readonly affected: number; readonly protectedUnknown: number;
  readonly partial: boolean; readonly next: string | null; readonly missingReasons: readonly string[]; readonly automaticReplayAvailable: false;
}
export type NativeUsageMaintenanceRequest =
  | { readonly action: 'preview'; readonly operationId: string; readonly kind: 'archive' | 'clear'; readonly scope: NativeUsageMaintenanceScope }
  | { readonly action: 'confirm'; readonly operationId: string; readonly revision: number; readonly confirm: true };
export interface NativeUsageExport {
  readonly schema: 1; readonly source: 'active' | 'archive'; readonly scope: NativeUsageMaintenanceScope;
  readonly format: 'json'; readonly mediaType: 'application/json'; readonly fileName: string; readonly data: string;
  readonly bytes: number; readonly sha256: string; readonly records: number; readonly partial: boolean; readonly next: string | null; readonly exportedAt: number;
}
function record(input: unknown): input is Record<string, unknown> { return input !== null && typeof input === 'object' && !Array.isArray(input); }
function exact(input: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(input).length === keys.length && keys.every(key => Object.hasOwn(input, key)); }
function time(input: unknown): input is number { return typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 && input <= 8_640_000_000_000_000; }
function ref(input: unknown): input is string { return typeof input === 'string' && input.length > 0 && input.length <= 160 && !/[\x00-\x1f\x7f]/.test(input); }
function hash(input: unknown): input is string { return typeof input === 'string' && /^[a-f0-9]{64}$/.test(input); }
export function isNativeUsageMaintenanceId(input: unknown): input is string { return typeof input === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input); }
export function parseNativeUsageMaintenanceScope(input: unknown): NativeUsageMaintenanceScope | null {
  if (!record(input) || !Object.hasOwn(input, 'since') || !Object.hasOwn(input, 'until') || Object.keys(input).some(key => !['since', 'until', 'after', 'conversationId', 'provider', 'model'].includes(key))
    || !time(input.since) || !time(input.until) || input.since >= input.until || input.after !== undefined && !hash(input.after)
    || input.conversationId !== undefined && !isNativeAccessScope(input.conversationId) || input.provider !== undefined && !ref(input.provider) || input.model !== undefined && !ref(input.model)) return null;
  return input as unknown as NativeUsageMaintenanceScope;
}
export function parseNativeUsageMaintenanceRequest(input: unknown): NativeUsageMaintenanceRequest | null {
  if (!record(input) || !isNativeUsageMaintenanceId(input.operationId)) return null;
  if (input.action === 'preview') return exact(input, ['action', 'operationId', 'kind', 'scope']) && ['archive', 'clear'].includes(String(input.kind)) && parseNativeUsageMaintenanceScope(input.scope) ? input as unknown as NativeUsageMaintenanceRequest : null;
  return input.action === 'confirm' && exact(input, ['action', 'operationId', 'revision', 'confirm']) && input.confirm === true && time(input.revision) && input.revision > 0 ? input as unknown as NativeUsageMaintenanceRequest : null;
}
export function parseNativeUsageMaintenanceOperation(input: unknown): NativeUsageMaintenanceOperation | null {
  if (!record(input) || !exact(input, ['schema', 'id', 'revision', 'kind', 'state', 'scope', 'createdAt', 'expiresAt', 'completedAt', 'rows', 'affected', 'protectedUnknown', 'partial', 'next', 'missingReasons', 'automaticReplayAvailable'])
    || input.schema !== 1 || !isNativeUsageMaintenanceId(input.id) || !time(input.revision) || input.revision === 0 || !['archive', 'clear'].includes(String(input.kind)) || !['prepared', 'completed', 'blocked'].includes(String(input.state))
    || !parseNativeUsageMaintenanceScope(input.scope) || !time(input.createdAt) || !time(input.expiresAt) || input.expiresAt <= input.createdAt || input.completedAt !== null && (!time(input.completedAt) || input.completedAt < input.createdAt)
    || !Array.isArray(input.rows) || input.rows.length > NATIVE_USAGE_MAINTENANCE_ROWS || Object.keys(input.rows).length !== input.rows.length || !time(input.affected) || input.affected > input.rows.length
    || !time(input.protectedUnknown) || input.protectedUnknown > 1000 || typeof input.partial !== 'boolean' || input.next !== null && !hash(input.next)
    || !Array.isArray(input.missingReasons) || input.missingReasons.length > 32 || !input.missingReasons.every(reason => typeof reason === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(reason)) || input.automaticReplayAvailable !== false
    || input.state === 'completed' && (input.completedAt === null || input.affected !== input.rows.length || input.missingReasons.length !== 0) || input.state !== 'completed' && (input.completedAt !== null || input.affected !== 0)) return null;
  const seen = new Set<string>();
  for (const row of input.rows) {
    if (!record(row) || !exact(row, ['cursor', 'conversationId', 'provider', 'model', 'status', 'recordedAt']) || !hash(row.cursor) || seen.has(row.cursor) || !ref(row.conversationId) || !ref(row.provider) || !ref(row.model) || !['completed', 'failed'].includes(String(row.status)) || !time(row.recordedAt)) return null;
    seen.add(row.cursor);
  }
  return input as unknown as NativeUsageMaintenanceOperation;
}
export function parseNativeUsageMaintenanceEnvelope(input: unknown): { readonly schema: 1; readonly operation: NativeUsageMaintenanceOperation | null } | null {
  if (!record(input) || !exact(input, ['schema', 'operation']) || input.schema !== 1) return null;
  const operation = input.operation === null ? null : parseNativeUsageMaintenanceOperation(input.operation);
  return input.operation !== null && !operation ? null : { schema: 1, operation };
}
export function parseNativeUsageExport(input: unknown): NativeUsageExport | null {
  if (!record(input) || !exact(input, ['schema', 'source', 'scope', 'format', 'mediaType', 'fileName', 'data', 'bytes', 'sha256', 'records', 'partial', 'next', 'exportedAt']) || input.schema !== 1
    || !['active', 'archive'].includes(String(input.source)) || !parseNativeUsageMaintenanceScope(input.scope) || input.format !== 'json' || input.mediaType !== 'application/json'
    || typeof input.fileName !== 'string' || !/^usage-(active|archive)-[a-f0-9]{16}\.json$/.test(input.fileName) || typeof input.data !== 'string' || input.data.length > 1024 * 1024
    || !time(input.bytes) || input.bytes > 1024 * 1024 || new TextEncoder().encode(input.data).length !== input.bytes || !hash(input.sha256)
    || !time(input.records) || input.records > NATIVE_USAGE_MAINTENANCE_ROWS || typeof input.partial !== 'boolean' || input.next !== null && !hash(input.next) || !time(input.exportedAt)) return null;
  return input as unknown as NativeUsageExport;
}

export interface NativeUsageMaintenanceListQuery { readonly limit?: number; readonly after?: string }
export type NativeUsageMaintenanceSummary = Pick<NativeUsageMaintenanceOperation, 'id' | 'kind' | 'state' | 'scope' | 'createdAt' | 'expiresAt'>;
export interface NativeUsageMaintenanceListSnapshot { readonly schema: 1; readonly operations: readonly NativeUsageMaintenanceSummary[]; readonly next: string | null; readonly partial: boolean }
export function parseNativeUsageMaintenanceList(input: unknown): NativeUsageMaintenanceListSnapshot | null {
  if (!record(input) || !exact(input, ['schema', 'operations', 'next', 'partial']) || input.schema !== 1 || !Array.isArray(input.operations) || input.operations.length > 20
    || input.next !== null && !isNativeUsageMaintenanceId(input.next) || typeof input.partial !== 'boolean' || input.partial !== (input.next !== null)) return null;
  const seen = new Set<string>(); const operations: NativeUsageMaintenanceSummary[] = [];
  for (const item of input.operations) {
    if (!record(item) || !exact(item, ['id', 'kind', 'state', 'scope', 'createdAt', 'expiresAt']) || !isNativeUsageMaintenanceId(item.id) || seen.has(item.id)
      || !['archive', 'clear'].includes(String(item.kind)) || !['prepared', 'completed', 'blocked'].includes(String(item.state)) || !parseNativeUsageMaintenanceScope(item.scope)
      || !time(item.createdAt) || !time(item.expiresAt) || item.expiresAt <= item.createdAt) return null;
    seen.add(item.id); operations.push({ id: item.id, kind: item.kind as NativeUsageMaintenanceSummary['kind'], state: item.state as NativeUsageMaintenanceSummary['state'], scope: item.scope as unknown as NativeUsageMaintenanceScope, createdAt: item.createdAt, expiresAt: item.expiresAt });
  }
  if (input.next !== null && operations.at(-1)?.id !== input.next) return null;
  return { schema: 1, operations, next: input.next as string | null, partial: input.partial };
}
