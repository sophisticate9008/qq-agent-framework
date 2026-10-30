import type { DurableStore, StoredRecord } from '../contracts/ports.ts';
import type { JsonObject } from '../core/types.ts';
import { assert, errorCode } from '../core/values.ts';
import { digest, object } from './data.ts';
import { withDeadline } from './deadlines.ts';
import type { CalendarTriggerMetadata } from './triggers.ts';
import type { PluginScheduledOccurrence } from './plugin-scheduler.ts';

/** Claim synchronously; the accepted work belongs to the host, not the HTTP connection. */
export function runImmediatePluginSchedule(options: {
  readonly store: DurableStore;
  readonly record: StoredRecord;
  readonly override: StoredRecord | null;
  readonly rule: CalendarTriggerMetadata;
  readonly identity: { readonly owner: string; readonly id: string; readonly payload: JsonObject };
  readonly paused: boolean;
  readonly revision: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly clock: () => number;
  readonly run: (occurrence: PluginScheduledOccurrence) => void | Promise<void>;
}): Promise<void> {
  const { store, record, override, rule, identity, clock } = options;
  assert(store.compareAndSetBatch, 'PLUGIN_SCHEDULER_MANAGEMENT_UNAVAILABLE', 'Atomic schedule execution is required.');
  const now = clock(), deadlineAt = now + Math.min(rule.windowMs, options.timeoutMs);
  const id = `calendar:${digest({ manual: true, ruleId: record.key, generation: rule.generation, revision: options.revision })}`;
  const intent = { schema: 1, owner: identity.owner, id: identity.id, paused: options.paused,
    operation: { kind: 'run-now', state: 'running' } } as const;
  const occurrence = { schema: 1, id, ruleId: record.key, generation: rule.generation, scheduledAt: now, startedAt: now,
    deadlineAt, trigger: 'manual', coalescedCount: 0, payloadDigest: digest(identity.payload), status: 'running', errorCode: null, updatedAt: now };
  const claimed = store.compareAndSetBatch([
    { kind: 'write', namespace: 'plugin-scheduler.calendar-triggers', key: record.key, expectedRevision: record.revision,
      value: { ...object(record.value), evaluatedThrough: Math.max(rule.evaluatedThrough, rule.schedule.kind === 'once' ? rule.schedule.at : now), updatedAt: now } },
    { kind: 'write', namespace: 'plugin-scheduler.management', key: record.key, expectedRevision: override?.revision ?? null, value: intent },
    { kind: 'write', namespace: 'plugin-scheduler.calendar-trigger-occurrences', key: id, expectedRevision: null, value: occurrence },
  ]);
  const control = claimed[1], history = claimed[2];
  assert(control && history, 'PLUGIN_SCHEDULER_STORED_INVALID', 'Manual execution was not claimed.');
  return Promise.resolve().then(async () => {
    let status: 'completed' | 'failed' | 'unknown' = 'completed', code: string | null = null;
    try {
      await withDeadline({ signal: options.signal, timeoutMs: deadlineAt - now, code: 'PLUGIN_SCHEDULER_RUN_TIMEOUT_UNKNOWN',
        run: signal => options.run({ id, ruleId: identity.id, scope: identity.owner, generation: rule.generation,
          scheduledAt: now, deadlineAt, coalescedCount: 0, payload: identity.payload, signal }) });
    } catch (error) {
      code = errorCode(error, 'PLUGIN_SCHEDULER_RUN_FAILED');
      status = /UNKNOWN|ABORT|TIMEOUT/.test(code) ? 'unknown' : 'failed';
    }
    const settledAt = clock();
    store.compareAndSetBatch!([
      { kind: 'write', namespace: 'plugin-scheduler.calendar-trigger-occurrences', key: id, expectedRevision: history.revision,
        value: { ...occurrence, status, errorCode: code, updatedAt: settledAt }, ...(status === 'unknown' ? {} : { expiresAt: settledAt + 7 * 86_400_000 }) },
      { kind: 'write', namespace: 'plugin-scheduler.management', key: record.key, expectedRevision: control.revision,
        value: { ...intent, operation: status === 'unknown' ? { kind: 'run-now', state: 'unknown' } : null } },
    ]);
  });
}
