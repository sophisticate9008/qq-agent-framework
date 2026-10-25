import { NATIVE_USAGE_MAINTENANCE_PATH, isNativeUsageMaintenanceId, parseNativeUsageMaintenanceRequest, parseNativeUsageMaintenanceScope,
  type NativeUsageMaintenanceOperation, type NativeUsageMaintenanceScope, type NativeUsageExport, type NativeUsageMaintenanceRequest, type NativeUsageMaintenanceListQuery, type NativeUsageMaintenanceListSnapshot } from '../contracts/native-usage-maintenance.ts';
import { FrameworkError } from '../core/values.ts';
import { AdminRequestError, type AdminRoute } from './server.ts';

async function operation<Value>(run: () => Value | Promise<Value>): Promise<Value> {
  try { return await run(); }
  catch (error) {
    if (error instanceof AdminRequestError) throw error;
    if (error instanceof FrameworkError) {
      if (error.code === 'STORE_NOT_FOUND') throw new AdminRequestError(409, 'usage_ledger_not_created');
      if (error.code === 'NATIVE_USAGE_MAINTENANCE_BUSY') throw new AdminRequestError(409, 'usage_maintenance_busy');
      if (error.code === 'USAGE_MAINTENANCE_INVALID') throw new AdminRequestError(400, 'invalid_usage_maintenance');
      if (error.code === 'USAGE_MAINTENANCE_NOT_FOUND') throw new AdminRequestError(404, 'usage_maintenance_not_found');
      if (error.code === 'USAGE_MAINTENANCE_CONFLICT' || error.code === 'STORE_CONFLICT') throw new AdminRequestError(409, 'usage_maintenance_conflict');
      if (error.code === 'USAGE_EXPORT_TOO_LARGE') throw new AdminRequestError(413, 'usage_export_too_large');
    }
    throw new AdminRequestError(503, 'usage_maintenance_unavailable');
  }
}
function queryScope(query: URLSearchParams): NativeUsageMaintenanceScope {
  const scope: Record<string, unknown> = {};
  for (const [key, value] of query) {
    if (!['since', 'until', 'after', 'conversationId', 'provider', 'model'].includes(key) || query.getAll(key).length !== 1) throw new AdminRequestError(400, 'invalid_query');
    if (key === 'since' || key === 'until') { if (!/^(0|[1-9]\d{0,15})$/.test(value)) throw new AdminRequestError(400, 'invalid_query'); scope[key] = Number(value); } else scope[key] = value;
  }
  const result = parseNativeUsageMaintenanceScope(scope); if (!result) throw new AdminRequestError(400, 'invalid_query'); return result;
}
export function createNativeUsageMaintenanceRoutes(options: {
  readonly list: (query: NativeUsageMaintenanceListQuery) => NativeUsageMaintenanceListSnapshot | Promise<NativeUsageMaintenanceListSnapshot>;
  readonly read: (id: string) => NativeUsageMaintenanceOperation | null | Promise<NativeUsageMaintenanceOperation | null>;
  readonly export: (scope: NativeUsageMaintenanceScope, source: 'active' | 'archive') => NativeUsageExport | Promise<NativeUsageExport>;
  readonly mutate: (request: NativeUsageMaintenanceRequest, signal: AbortSignal) => NativeUsageMaintenanceOperation | Promise<NativeUsageMaintenanceOperation>;
}): readonly AdminRoute[] {
  return Object.freeze([
    { method: 'GET', pathname: NATIVE_USAGE_MAINTENANCE_PATH, maxResponseBytes: 4 * 1024 * 1024,
      async handle({ query }: Parameters<AdminRoute['handle']>[0]) {
        const id = query.get('id');
        if (id !== null) {
          if (query.size !== 1 || !isNativeUsageMaintenanceId(id)) throw new AdminRequestError(400, 'invalid_query');
          return operation(async () => ({ schema: 1, operation: await options.read(id) }));
        }
        if (query.get('action') === 'list') {
          if ([...query.keys()].some(key => !['action', 'limit', 'after'].includes(key) || query.getAll(key).length !== 1)) throw new AdminRequestError(400, 'invalid_query');
          const limit = query.get('limit') ?? '20'; const after = query.get('after');
          if (!/^(?:[1-9]|1[0-9]|20)$/.test(limit) || after !== null && !isNativeUsageMaintenanceId(after)) throw new AdminRequestError(400, 'invalid_query');
          return operation(() => options.list({ limit: Number(limit), ...(after ? { after } : {}) }));
        }
        if (query.get('action') !== 'export' || query.getAll('action').length !== 1 || query.getAll('source').length > 1) throw new AdminRequestError(400, 'invalid_query');
        const source = query.get('source') ?? 'active'; if (source !== 'active' && source !== 'archive') throw new AdminRequestError(400, 'invalid_query');
        const rest = new URLSearchParams(query); rest.delete('action'); rest.delete('source'); const scope = queryScope(rest);
        return operation(async () => options.export(scope, source));
      } },
    { method: 'POST', pathname: NATIVE_USAGE_MAINTENANCE_PATH, maxRequestBytes: 16 * 1024,
      async handle({ query, body, signal }: Parameters<AdminRoute['handle']>[0]) {
        const request = parseNativeUsageMaintenanceRequest(body); if (query.size !== 0 || !request) throw new AdminRequestError(400, 'invalid_usage_maintenance');
        signal.throwIfAborted();
        return operation(async () => ({ schema: 1, operation: await options.mutate(request, signal) }));
      } }
  ] as const);
}
