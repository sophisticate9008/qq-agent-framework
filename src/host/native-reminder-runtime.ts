import { join } from 'node:path';
import { FrameworkError } from '../core/values.ts';
import { createSqliteStore, type SqliteStore } from '../storage/sqlite.ts';
import { openReadonlySqliteStore } from '../storage/sqlite-readonly.ts';
import type { DurableStore } from '../contracts/ports.ts';
import type { EffectRequest } from '../core/types.ts';
import type { createBridgeHost } from './bridge.ts';
import { createNativeReminderService, readNativeReminderHistory, readNativeReminders,
  type NativeReminderReadOptions, type NativeReminderService } from './native-reminders.ts';
import { digest } from './data.ts';

/** Reminder configuration has its own lifetime; stopping chat stops delivery, not configuration editing. */
export function createNativeReminderRuntime(options: {
  readonly directory: string;
  readonly currentHost: () => ReturnType<typeof createBridgeHost> | undefined;
  readonly running: () => boolean;
  readonly authorizeConfiguration: (conversationId: string, signal: AbortSignal) => Promise<void>;
  readonly guard: (conversationId: string, signal: AbortSignal) => Promise<void>;
  readonly authorizeToolRequest: (request: EffectRequest) => Promise<void>;
}) {
  const filename = join(options.directory, 'native-reminders.sqlite');
  let store: SqliteStore | undefined;
  let service: NativeReminderService | undefined;
  let closed = false;
  const empty: Pick<DurableStore, 'read' | 'list'> = { read: () => null, list: () => [] };
  function fail(code: string): never { throw new FrameworkError(code, 'The reminder runtime is unavailable.'); }
  function read<Result>(projection: (store: Pick<DurableStore, 'read' | 'list'>) => Result): Result {
    if (closed) fail('NATIVE_CHAT_CLOSED');
    if (store) return projection(store);
    let existing: ReturnType<typeof openReadonlySqliteStore>;
    try { existing = openReadonlySqliteStore(filename); }
    catch (error) {
      if (error instanceof FrameworkError && error.code === 'STORE_NOT_FOUND') return projection(empty);
      throw error;
    }
    try { return existing.withSnapshot(() => projection(existing)); } finally { existing.close(); }
  }
  function getService(): NativeReminderService {
    if (closed) fail('NATIVE_CHAT_CLOSED');
    if (service) return service;
    store ??= createSqliteStore({ filename });
    service = createNativeReminderService({ store,
      authorizeConfiguration: options.authorizeConfiguration,
      guard: options.guard, authorizeToolRequest: options.authorizeToolRequest,
      async dispatch(event, signal) {
        const host = options.currentHost();
        if (!host || !options.running() || !service) fail('NATIVE_CHAT_STOPPED');
        await options.guard(event.conversationId, signal);
        const rule = service.read(String(event.data.ruleId));
        const occurrence = rule.lastOccurrence;
        if (!options.running() || options.currentHost() !== host || !rule.configuration.enabled || rule.state === 'cancelled'
          || rule.generation !== event.data.generation || rule.configuration.conversationId !== event.conversationId
          || !occurrence || occurrence.id !== event.id || occurrence.id !== event.data.occurrenceId
          || occurrence.status !== 'dispatching' || occurrence.generation !== rule.generation
          || occurrence.conversationId !== event.conversationId || occurrence.scheduledAt !== event.data.scheduledAt)
          fail('REMINDER_INVALID_EVENT');
        signal.throwIfAborted();
        // Explicitly enabling this persisted rule authorizes one send for this occurrence only.
        const id = `reminder-occurrence:${digest([event.id, rule.id, rule.generation, event.conversationId])}`;
        if (host.policy.describe().grants.some(grant => grant.id === id)) fail('REMINDER_DELIVERY_UNKNOWN');
        host.policy.grant({ ...(host.accountScope ? { accountScope: host.accountScope } : {}), id, featureId: 'reminder', conversationId: event.conversationId,
          capabilities: ['messaging.send'], maxUses: { 'messaging.send': 1 }, expiresAt: Date.now() + 30_000 });
        try { return await host.dispatchEvent({ ...event, ...(host.accountScope ? { accountScope: host.accountScope } : {}) }, { signal }); }
        finally { host.policy.revoke(id); }
      } });
    return service;
  }
  return Object.freeze({
    service: getService,
    read(readOptions: NativeReminderReadOptions = {}) { return read(store => readNativeReminders(store, readOptions)); },
    history(readOptions: NativeReminderReadOptions & { readonly ruleId?: string } = {}) {
      return read(store => readNativeReminderHistory(store, readOptions));
    },
    status() { return service?.status() ?? { running: false }; },
    async stop() { await service?.stop(); },
    async close() { closed = true; await service?.stop(); store?.close(); store = undefined; }
  });
}
