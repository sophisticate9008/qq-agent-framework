import { randomUUID } from 'node:crypto';
import type { QqCapabilitiesPort } from '../adapters/onebot-capabilities.ts';
import type { OneBotReadResult } from '../adapters/onebot-actions.ts';
import type { JsonObject, JsonValue } from '../contracts/data.ts';
import type { DurableStore, StoredRecord } from '../contracts/ports.ts';
import { QQ_CAPABILITIES, QQ_CAPABILITY_CATEGORIES, findQqCapability,
  type QqCapabilitiesInspection, type QqCapabilityDefinition } from '../contracts/qq-capabilities.ts';
import { decodeQqCapabilityInput, isBoundedQqJson } from '../contracts/qq-capability-input.ts';
import { isRecord } from '../contracts/values.ts';
import { FrameworkError, snapshot } from '../core/values.ts';
import { digest, json } from './data.ts';

const WRITES = 'plugin-capability.writes';
const SETTLED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RECEIPT_BYTES = 524_288;
const MAX_LIST = 1000;

export interface PluginCapabilityCatalogQuery {
  readonly id?: string;
  readonly category?: string;
  readonly search?: string;
  readonly limit?: number;
  readonly includeSchemas?: boolean;
}
export interface PluginCapabilityCatalog {
  readonly protocol: string | null;
  readonly version: string | null;
  readonly source: QqCapabilitiesInspection['source'];
  readonly categories: readonly { readonly id: string; readonly label: string; readonly description: string; readonly count: number }[];
  readonly capabilities: readonly (Omit<QqCapabilityDefinition, 'inputSchema'> & { readonly inputSchema?: JsonObject })[];
  readonly limited: boolean;
}
export interface PluginCapabilityCall {
  readonly id: string;
  readonly input: unknown;
  /** Required for writes; scoped to this plugin and account, across all capability IDs. */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}
export interface PluginCapabilityClient {
  readonly catalog: (query?: PluginCapabilityCatalogQuery) => Promise<PluginCapabilityCatalog>;
  readonly call: (request: PluginCapabilityCall) => Promise<OneBotReadResult<JsonValue>>;
}
export interface PluginCapabilityInvocation {
  readonly invocationId: string;
  readonly origin: 'plugin';
  readonly owner: string;
  readonly capabilityId: string;
  readonly write: boolean;
  readonly state: 'dispatching' | 'confirmed' | 'rejected' | 'unknown';
  readonly startedAt: number;
  readonly completedAt: number | null;
}
export interface PluginCapabilityServiceOptions {
  readonly port: QqCapabilitiesPort;
  readonly store: DurableStore;
  readonly accountId: string;
  readonly signal?: AbortSignal;
  /** A host-verified inventory from the same concrete protocol instance. */
  readonly inventory?: QqCapabilitiesInspection;
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value);
}
function fail(code: string): never { throw new FrameworkError(code, '插件协议服务未能完成操作。'); }
function rejection(code: string): OneBotReadResult<JsonValue> { return { status: 'rejected', code }; }
function receipt(value: unknown): OneBotReadResult<JsonValue> | null {
  if (!isRecord(value)) return null;
  if (value.status === 'confirmed' && isBoundedQqJson(value.data, 100_000)) return { status: 'confirmed', data: value.data };
  if ((value.status === 'unknown' || value.status === 'rejected') && typeof value.code === 'string' && value.code.length <= 256)
    return { status: value.status, code: value.code };
  return null;
}
function persistedReceipt(result: OneBotReadResult<JsonValue>): OneBotReadResult<JsonValue> {
  return Buffer.byteLength(JSON.stringify(result)) <= MAX_RECEIPT_BYTES ? result : {
    status: 'confirmed', data: { resultOmitted: true, code: 'PLUGIN_CAPABILITY_RECEIPT_LIMIT' },
  };
}
function invocation(value: unknown): PluginCapabilityInvocation | null {
  if (!isRecord(value) || !identifier(value.invocationId) || !identifier(value.owner) || typeof value.capabilityId !== 'string'
    || !findQqCapability(value.capabilityId) || typeof value.write !== 'boolean'
    || !['dispatching', 'confirmed', 'rejected', 'unknown'].includes(String(value.state))
    || typeof value.startedAt !== 'number' || !Number.isSafeInteger(value.startedAt) || value.startedAt < 0
    || value.completedAt !== null && (typeof value.completedAt !== 'number' || !Number.isSafeInteger(value.completedAt) || value.completedAt < 0)) return null;
  return { invocationId: value.invocationId, origin: 'plugin', owner: value.owner, capabilityId: value.capabilityId,
    write: value.write, state: value.state as PluginCapabilityInvocation['state'], startedAt: value.startedAt,
    completedAt: value.completedAt as number | null };
}

/** Host supplies plugin identity once; protocol parameters cannot impersonate another caller. */
export function createPluginCapabilityService(options: PluginCapabilityServiceOptions) {
  if (typeof options.accountId !== 'string' || options.accountId.length < 1 || options.accountId.length > 256
    || /[\x00-\x1f\x7f]/.test(options.accountId)) fail('PLUGIN_CAPABILITY_INVALID_ACCOUNT');
  let inventory = options.inventory ? snapshot(options.inventory) : null;
  const current = new Map<string, PluginCapabilityInvocation>();
  const recent: PluginCapabilityInvocation[] = [];
  const combine = (lifetime: AbortSignal, signal?: AbortSignal) => AbortSignal.any([
    lifetime, ...(options.signal ? [options.signal] : []), ...(signal ? [signal] : []),
  ]);
  const inspect = async (signal: AbortSignal): Promise<QqCapabilitiesInspection | null> => {
    if (inventory) return inventory;
    const result = await options.port.inspect(signal);
    if (result.status === 'confirmed') inventory = snapshot(result.data);
    return inventory;
  };
  function replay(record: StoredRecord, fingerprint: string, owner: string): OneBotReadResult<JsonValue> {
    if (!isRecord(record.value) || record.value.schema !== 1 || record.value.accountId !== options.accountId || record.value.owner !== owner)
      return rejection('PLUGIN_CAPABILITY_INVALID_RECORD');
    if (record.value.fingerprint !== fingerprint) return rejection('PLUGIN_CAPABILITY_IDEMPOTENCY_CONFLICT');
    return receipt(record.value.result) ?? { status: 'unknown', code: 'PLUGIN_CAPABILITY_ALREADY_DISPATCHED' };
  }
  function remember(entry: PluginCapabilityInvocation): void {
    current.delete(entry.invocationId);
    recent.push(entry);
    if (recent.length > 100) recent.shift();
  }
  return Object.freeze({
    /** Read-only operation metadata, with no protocol input, credential, or response body. */
    list(query: { readonly owner?: string; readonly limit?: number } = {}): {
      readonly invocations: readonly PluginCapabilityInvocation[]; readonly limited: boolean;
    } {
      if (query.owner !== undefined && !identifier(query.owner)) fail('PLUGIN_CAPABILITY_INVALID_OWNER');
      const limit = query.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST) fail('PLUGIN_CAPABILITY_INVALID_LIMIT');
      const rows = options.store.list(WRITES, { limit: MAX_LIST });
      const entries = new Map<string, PluginCapabilityInvocation>();
      for (const row of rows) {
        if (!isRecord(row.value) || row.value.accountId !== options.accountId) continue;
        const entry = invocation(row.value);
        if (entry) entries.set(entry.invocationId, entry.state === 'dispatching' && !current.has(entry.invocationId)
          ? { ...entry, state: 'unknown' } : entry);
      }
      for (const entry of [...recent, ...current.values()]) entries.set(entry.invocationId, entry);
      const selected = [...entries.values()].filter(entry => query.owner === undefined || entry.owner === query.owner)
        .sort((left, right) => right.startedAt - left.startedAt);
      return snapshot({ invocations: selected.slice(0, limit), limited: rows.length === MAX_LIST || selected.length > limit });
    },
    forPlugin(owner: string, lifetime: AbortSignal, assertActive?: () => void): PluginCapabilityClient {
      if (!identifier(owner)) fail('PLUGIN_CAPABILITY_INVALID_OWNER');
      const guard = (signal: AbortSignal) => { signal.throwIfAborted(); assertActive?.(); signal.throwIfAborted(); };
      return Object.freeze({
        async catalog(query: PluginCapabilityCatalogQuery = {}): Promise<PluginCapabilityCatalog> {
          const signal = combine(lifetime);
          guard(signal);
          if (query.id !== undefined && typeof query.id !== 'string' || query.category !== undefined && typeof query.category !== 'string'
            || query.search !== undefined && (typeof query.search !== 'string' || query.search.length > 128)
            || query.includeSchemas !== undefined && typeof query.includeSchemas !== 'boolean') fail('PLUGIN_CAPABILITY_INVALID_QUERY');
          const limit = query.limit ?? 100;
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > QQ_CAPABILITIES.length) fail('PLUGIN_CAPABILITY_INVALID_LIMIT');
          const actual = await inspect(signal);
          guard(signal);
          const supported = new Set(actual?.supportedIds ?? []);
          const available = QQ_CAPABILITIES.filter(capability => supported.has(capability.id));
          const search = query.search?.trim().toLocaleLowerCase() ?? '';
          const selected = available.filter(capability => (query.id === undefined || capability.id === query.id)
            && (query.category === undefined || capability.category === query.category)
            && (!search || `${capability.id} ${capability.description}`.toLocaleLowerCase().includes(search)));
          const expanded = query.id !== undefined || query.category !== undefined || Boolean(search) || query.includeSchemas === true;
          return snapshot({ protocol: actual?.protocol ?? null, version: actual?.version ?? null, source: actual?.source ?? 'unverified',
            categories: QQ_CAPABILITY_CATEGORIES.map(category => ({ ...category, count: available.filter(capability => capability.category === category.id).length })),
            capabilities: expanded ? selected.slice(0, limit).map(capability => {
              if (query.id !== undefined || query.includeSchemas) return capability;
              const { inputSchema: _schema, ...summary } = capability;
              return summary;
            }) : [], limited: expanded && selected.length > limit });
        },
        async call(request: PluginCapabilityCall): Promise<OneBotReadResult<JsonValue>> {
          const signal = combine(lifetime, request.signal);
          guard(signal);
          const capability = findQqCapability(request.id);
          if (!capability) return rejection('QQ_CAPABILITY_NOT_REGISTERED');
          const input = decodeQqCapabilityInput(capability, request.input);
          if (!input) return rejection('QQ_CAPABILITY_INVALID_INPUT');
          if (request.idempotencyKey !== undefined && !identifier(request.idempotencyKey)) return rejection('PLUGIN_CAPABILITY_INVALID_KEY');
          if (capability.write && request.idempotencyKey === undefined) return rejection('PLUGIN_CAPABILITY_KEY_REQUIRED');
          const fingerprint = digest([capability.id, input]);
          const key = capability.write ? digest([options.accountId, owner, request.idempotencyKey]) : null;
          if (key) {
            const previous = options.store.read(WRITES, key);
            if (previous) return replay(previous, fingerprint, owner);
          }
          const actual = await inspect(signal);
          guard(signal);
          if (!actual?.supportedIds.includes(capability.id)) return rejection('QQ_CAPABILITY_UNSUPPORTED');
          let record: StoredRecord | null = null;
          const entry: PluginCapabilityInvocation = { invocationId: randomUUID(), origin: 'plugin', owner,
            capabilityId: capability.id, write: capability.write, state: 'dispatching', startedAt: Date.now(), completedAt: null };
          if (key) {
            const previous = options.store.read(WRITES, key);
            if (previous) return replay(previous, fingerprint, owner);
            try {
              record = options.store.write(WRITES, key, json({ schema: 1, accountId: options.accountId, fingerprint, ...entry }), { expectedRevision: null });
            } catch {
              const concurrent = options.store.read(WRITES, key);
              return concurrent ? replay(concurrent, fingerprint, owner) : rejection('PLUGIN_CAPABILITY_STORAGE_UNAVAILABLE');
            }
          }
          current.set(entry.invocationId, entry);
          let result: OneBotReadResult<JsonValue>;
          try { result = receipt(await options.port.call({ id: capability.id, input, signal }))
            ?? { status: 'unknown', code: 'PLUGIN_CAPABILITY_INVALID_RECEIPT' }; }
          catch { result = { status: 'unknown', code: 'PLUGIN_CAPABILITY_RESULT_UNKNOWN' }; }
          if (capability.write) result = persistedReceipt(result);
          const completed: PluginCapabilityInvocation = { ...entry, state: result.status, completedAt: Date.now() };
          if (record && key) {
            try {
              options.store.write(WRITES, key, json({ schema: 1, accountId: options.accountId, fingerprint, ...completed, result }), {
                expectedRevision: record.revision, ...(result.status === 'unknown' ? {} : { expiresAt: Date.now() + SETTLED_TTL_MS }),
              });
            } catch {
              remember({ ...completed, state: 'unknown' });
              return { status: 'unknown', code: 'PLUGIN_CAPABILITY_RECEIPT_NOT_SAVED' };
            }
          }
          remember(completed);
          return result;
        },
      });
    },
  });
}
export type PluginCapabilityService = ReturnType<typeof createPluginCapabilityService>;
