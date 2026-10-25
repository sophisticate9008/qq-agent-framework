import { createHash } from 'node:crypto';
import { FrameworkError, assert, isRecord } from '../core/values.ts';
import type { DurableStore, StoredRecord, DurableCasMutation } from '../contracts/ports.ts';
import { NATIVE_USAGE_MAINTENANCE_ROWS, parseNativeUsageMaintenanceOperation, parseNativeUsageMaintenanceScope, isNativeUsageMaintenanceId,
  type NativeUsageMaintenanceOperation, type NativeUsageMaintenanceRequest, type NativeUsageMaintenanceScope, type NativeUsageExport, type NativeUsageMaintenanceListQuery, type NativeUsageMaintenanceListSnapshot } from '../contracts/native-usage-maintenance.ts';
import { NATIVE_USAGE_TURNS_NAMESPACE, NATIVE_USAGE_ARCHIVE_NAMESPACE, NATIVE_USAGE_RETIRED_NAMESPACE, readNativeUsageStoredTurn } from './native-usage.ts';
import { digest, json, object } from './data.ts';

const namespace = 'native-usage.maintenance';
const PREVIEW_TTL_MS = 10 * 60_000;
interface Reference { readonly key: string; readonly revision: number; readonly fingerprint: string }
function fail(code: string): never { throw new FrameworkError(code, code); }
function operation(record: StoredRecord): NativeUsageMaintenanceOperation {
  const { references: _references, ...value } = object(record.value);
  const parsed = parseNativeUsageMaintenanceOperation({ ...value, revision: record.revision });
  if (!parsed) fail('USAGE_MAINTENANCE_CORRUPT'); return parsed;
}
function references(record: StoredRecord): readonly Reference[] {
  const value = object(record.value).references;
  if (!Array.isArray(value) || value.length > NATIVE_USAGE_MAINTENANCE_ROWS) fail('USAGE_MAINTENANCE_CORRUPT');
  return value.map(item => {
    if (!isRecord(item) || Object.keys(item).sort().join(',') !== 'fingerprint,key,revision' || typeof item.key !== 'string' || !/^[a-f0-9]{64}$/.test(item.key)
      || typeof item.revision !== 'number' || !Number.isSafeInteger(item.revision) || item.revision < 1 || typeof item.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(item.fingerprint)) fail('USAGE_MAINTENANCE_CORRUPT');
    return { key: item.key, revision: item.revision, fingerprint: item.fingerprint };
  });
}
export function createNativeUsageMaintenance(options: { readonly store: DurableStore; readonly clock?: () => number }) {
  const { store } = options; const clock = options.clock ?? Date.now;
  function now(): number { const value = clock(); assert(Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000 - PREVIEW_TTL_MS, 'USAGE_MAINTENANCE_CLOCK_INVALID', 'A bounded clock is required.'); return value; }
  function scope(input: NativeUsageMaintenanceScope): NativeUsageMaintenanceScope { const value = parseNativeUsageMaintenanceScope(input); if (!value) fail('USAGE_MAINTENANCE_INVALID'); return value; }
  function get(id: string): NativeUsageMaintenanceOperation | null { if (!isNativeUsageMaintenanceId(id)) fail('USAGE_MAINTENANCE_INVALID'); const record = store.read(namespace, id); return record ? operation(record) : null; }
  function scan(input: NativeUsageMaintenanceScope, source: 'active' | 'archive', protectUnknown: boolean) {
    const filter = scope(input); const selected: StoredRecord[] = []; let protectedUnknown = 0; let scanned = 0; let selectedBytes = 0; let after = filter.after;
    const selectedNamespace = source === 'archive' ? NATIVE_USAGE_ARCHIVE_NAMESPACE : NATIVE_USAGE_TURNS_NAMESPACE;
    outer: while (scanned < 1000 && selected.length < NATIVE_USAGE_MAINTENANCE_ROWS) {
      const limit = Math.min(128, 1000 - scanned); const batch = store.list(selectedNamespace, { limit, ...(after ? { after } : {}) });
      for (const row of batch) {
        const rowBytes = Buffer.byteLength(JSON.stringify(row.value));
        if (selected.length > 0 && selectedBytes + rowBytes > 6 * 1024 * 1024) break outer;
        scanned++; after = row.key; const turn = readNativeUsageStoredTurn(row);
        if (turn.recordedAt < filter.since || turn.recordedAt >= filter.until || filter.conversationId !== undefined && turn.conversationId !== filter.conversationId
          || filter.provider !== undefined && turn.provider !== filter.provider || filter.model !== undefined && turn.model !== filter.model) continue;
        if (protectUnknown && turn.status === 'unknown') protectedUnknown++; else { selected.push(row); selectedBytes += rowBytes; }
        if (selected.length === NATIVE_USAGE_MAINTENANCE_ROWS || scanned === 1000) break outer;
      }
      if (batch.length < limit) break;
    }
    const more = after !== undefined && store.list(selectedNamespace, { limit: 1, after }).length > 0;
    return { selected, protectedUnknown, partial: more, next: more ? after ?? null : null };
  }
  function blocked(record: StoredRecord, reason: string): NativeUsageMaintenanceOperation {
    const value = object(record.value);
    try { return operation(store.write(namespace, record.key, json({ ...value, state: 'blocked', missingReasons: [reason] }), { expectedRevision: record.revision, expiresAt: null })); }
    catch (error) { const current = store.read(namespace, record.key); if (current && operation(current).state === 'completed') return operation(current); throw error; }
  }
  return Object.freeze({
    get,
    list(query: NativeUsageMaintenanceListQuery = {}): NativeUsageMaintenanceListSnapshot {
      const limit = query.limit ?? 20;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20 || Object.keys(query).some(key => !['limit', 'after'].includes(key)) || query.after !== undefined && !isNativeUsageMaintenanceId(query.after)) fail('USAGE_MAINTENANCE_INVALID');
      const records = store.list(namespace, { limit: limit + 1, ...(query.after ? { after: query.after } : {}) });
      const operations = records.slice(0, limit).map(record => { const value = operation(record); return { id: value.id, kind: value.kind, state: value.state, scope: value.scope, createdAt: value.createdAt, expiresAt: value.expiresAt }; });
      const next = records.length > limit ? operations.at(-1)?.id ?? null : null;
      return { schema: 1, operations, next, partial: next !== null };
    },
    preview(request: Extract<NativeUsageMaintenanceRequest, { readonly action: 'preview' }>): NativeUsageMaintenanceOperation {
      if (!isNativeUsageMaintenanceId(request.operationId) || !['archive', 'clear'].includes(request.kind)) fail('USAGE_MAINTENANCE_INVALID');
      const filter = scope(request.scope); const previous = store.read(namespace, request.operationId);
      if (previous) { const current = operation(previous); if (current.kind !== request.kind || digest(current.scope) !== digest(filter)) fail('USAGE_MAINTENANCE_CONFLICT'); return current; }
      if (!store.compareAndSetBatch) fail('USAGE_MAINTENANCE_UNAVAILABLE');
      const timestamp = now(); const page = scan(filter, 'active', true);
      const rows = page.selected.map(record => { const turn = readNativeUsageStoredTurn(record); assert(turn.status !== 'unknown', 'USAGE_MAINTENANCE_CORRUPT', 'Unknown turns cannot be cleared.'); return { cursor: record.key, conversationId: turn.conversationId, provider: turn.provider, model: turn.model, status: turn.status, recordedAt: turn.recordedAt }; });
      const value = { schema: 1, id: request.operationId, kind: request.kind, state: 'prepared', scope: filter, createdAt: timestamp, expiresAt: timestamp + PREVIEW_TTL_MS,
        rows, affected: 0, protectedUnknown: page.protectedUnknown, partial: page.partial, next: page.next, completedAt: null, missingReasons: [], automaticReplayAvailable: false,
        references: page.selected.map(record => ({ key: record.key, revision: record.revision, fingerprint: object(record.value).fingerprint })) };
      try { return operation(store.write(namespace, request.operationId, json(value), { expectedRevision: null, expiresAt: timestamp + PREVIEW_TTL_MS })); }
      catch (error) {
        if (!(error instanceof FrameworkError) || error.code !== 'STORE_CONFLICT') throw error;
        const winner = get(request.operationId); if (!winner || winner.kind !== request.kind || digest(winner.scope) !== digest(filter)) fail('USAGE_MAINTENANCE_CONFLICT'); return winner;
      }
    },
    confirm(request: Extract<NativeUsageMaintenanceRequest, { readonly action: 'confirm' }>): NativeUsageMaintenanceOperation {
      if (!isNativeUsageMaintenanceId(request.operationId) || !Number.isSafeInteger(request.revision) || request.revision < 1 || request.confirm !== true) fail('USAGE_MAINTENANCE_INVALID');
      const record = store.read(namespace, request.operationId); if (!record) fail('USAGE_MAINTENANCE_NOT_FOUND'); const current = operation(record);
      if (current.state === 'completed') return current;
      if (record.revision !== request.revision) fail('USAGE_MAINTENANCE_CONFLICT');
      if (current.state !== 'prepared') return current;
      if (now() < current.createdAt) return blocked(record, 'usage_clock_regressed');
      if (now() >= current.expiresAt) return blocked(record, 'usage_preview_expired');
      if (!store.compareAndSetBatch) fail('USAGE_MAINTENANCE_UNAVAILABLE');
      const refs = references(record); if (refs.length !== current.rows.length) fail('USAGE_MAINTENANCE_CORRUPT');
      const timestamp = now(); const mutations: DurableCasMutation[] = [];
      for (const reference of refs) {
        const source = store.read(NATIVE_USAGE_TURNS_NAMESPACE, reference.key);
        if (!source || source.revision !== reference.revision || object(source.value).fingerprint !== reference.fingerprint) return blocked(record, 'usage_preview_changed');
        const turn = readNativeUsageStoredTurn(source); if (turn.status === 'unknown') return blocked(record, 'usage_unknown_evidence_protected');
        mutations.push({ kind: 'write', namespace: current.kind === 'archive' ? NATIVE_USAGE_ARCHIVE_NAMESPACE : NATIVE_USAGE_RETIRED_NAMESPACE,
          key: source.key, expectedRevision: null, value: current.kind === 'archive' ? source.value : json({ schema: 1, fingerprint: reference.fingerprint, retiredAt: timestamp, operationId: current.id }) });
        mutations.push({ kind: 'delete', namespace: NATIVE_USAGE_TURNS_NAMESPACE, key: source.key, expectedRevision: source.revision });
      }
      mutations.push({ kind: 'write', namespace, key: current.id, expectedRevision: record.revision,
        value: json({ ...object(record.value), state: 'completed', affected: refs.length, completedAt: timestamp, missingReasons: [] }), expiresAt: null });
      try { const saved = store.compareAndSetBatch(mutations).at(-1); if (!saved) fail('USAGE_MAINTENANCE_UNKNOWN'); return operation(saved); }
      catch (error) { if (error instanceof FrameworkError && error.code === 'STORE_CONFLICT') return blocked(record, 'usage_preview_changed'); throw error; }
    },
    export(input: NativeUsageMaintenanceScope, source: 'active' | 'archive' = 'active'): NativeUsageExport {
      if (!['active', 'archive'].includes(source)) fail('USAGE_MAINTENANCE_INVALID');
      const filter = scope(input); const page = scan(filter, source, false); const exportedAt = now();
      const value = { schema: 1, source, scope: filter, records: page.selected.map(record => readNativeUsageStoredTurn(record)), partial: page.partial, next: page.next,
        exportedAt, coverage: 'selected-ledger-rows-only', executionEvidenceIncluded: false };
      const data = JSON.stringify(value, null, 2); const bytes = Buffer.byteLength(data); if (bytes > 1024 * 1024) fail('USAGE_EXPORT_TOO_LARGE');
      const sha256 = createHash('sha256').update(data).digest('hex');
      return { schema: 1, source, scope: filter, format: 'json', mediaType: 'application/json', fileName: `usage-${source}-${sha256.slice(0, 16)}.json`, data, bytes, sha256,
        records: page.selected.length, partial: page.partial, next: page.next, exportedAt };
    }
  });
}
