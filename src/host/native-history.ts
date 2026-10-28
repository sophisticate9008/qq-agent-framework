import { readNativeMediaDiagnostics } from './native-media-diagnostics.ts';
import { assertAccountStore } from '../storage/account-scope.ts';
import type { AccountScope } from '../contracts/account-scope.ts';
import { createNativeUsageMaintenance } from './native-usage-maintenance.ts';
import { readNativeExecutionRecovery } from './native-execution-recovery.ts';
import { readNativeDiagnosticHistory } from './native-diagnostics.ts';
import { join } from 'node:path';
import { assert } from '../core/values.ts';
import { openReadonlySqliteStore } from '../storage/sqlite-readonly.ts';
import { object } from './data.ts';
import { createNativeExecutionController } from './native-execution.ts';
import { createNativeUsage } from './native-usage.ts';
import { readSessionMetadata } from './sessions.ts';
import { readNativeInboxSummary } from './native-inbox.ts';
import { createNativeWorkHistoryReader } from './native-work-history.ts';

export type NativeUsageReader = Pick<ReturnType<typeof createNativeUsage>,
  'snapshot' | 'pricing' | 'summary' | 'recent' | 'list' | 'series'>
  & Partial<Pick<ReturnType<typeof createNativeUsage>, 'sessionLedgers'>>;
export interface NativeHistoryReader {
  readonly media: (options: Parameters<typeof readNativeMediaDiagnostics>[1]) => ReturnType<typeof readNativeMediaDiagnostics>;
  readonly usageMaintenance: Pick<ReturnType<typeof createNativeUsageMaintenance>, 'get' | 'export' | 'list'>;
  readonly executionRecovery: (id: string) => ReturnType<typeof readNativeExecutionRecovery>;
  readonly diagnostics: (conversationId: string) => ReturnType<typeof readNativeDiagnosticHistory>;
  readonly work: ReturnType<typeof createNativeWorkHistoryReader>;
  readonly inbox: { readonly summary: () => ReturnType<typeof readNativeInboxSummary> };
  readonly sessions: { readonly list: (options?: { limit?: number; after?: string }) => ReturnType<typeof readSessionMetadata> };
  readonly usage: NativeUsageReader;
  readonly executions: Pick<ReturnType<typeof createNativeExecutionController>, 'list' | 'get' | 'inspect' | 'listForDisplay'>;
}

export function readNativeHistory<Result>(directory: string, read: (history: NativeHistoryReader) => Result, accountScope?: AccountScope): Result {
  assert(typeof read === 'function' && !['AsyncFunction', 'AsyncGeneratorFunction', 'GeneratorFunction'].includes(read.constructor.name),
    'NATIVE_HISTORY_SYNC_REQUIRED', 'History callbacks must finish synchronously without awaiting.');
  const store = openReadonlySqliteStore(join(directory, 'native-chat.sqlite'));
  try {
    return store.withSnapshot(() => {
      assertAccountStore(store, accountScope);
      const identity = store.read('native-chat.meta', 'session-definition');
      assert(identity && /^[a-f0-9]{64}$/.test(String(object(identity.value).identity)),
        'NATIVE_HISTORY_IDENTITY_MISSING', 'History requires an existing native framework identity.');
      const usage = createNativeUsage({ store });
      const maintenance = createNativeUsageMaintenance({ store });
      const executions = createNativeExecutionController({ store });
      return read(Object.freeze({ media: (options: Parameters<typeof readNativeMediaDiagnostics>[1]) => readNativeMediaDiagnostics(store, options), usageMaintenance: Object.freeze({ get: maintenance.get, export: maintenance.export, list: maintenance.list }), executionRecovery: (id: string) => readNativeExecutionRecovery(store, id), diagnostics: (conversationId: string) => readNativeDiagnosticHistory(store, conversationId), work: createNativeWorkHistoryReader(store), inbox: Object.freeze({ summary: () => readNativeInboxSummary(store) }), sessions: Object.freeze({ list: (options?: { limit?: number; after?: string }) =>
        readSessionMetadata(store, options) }),
      usage: Object.freeze({ snapshot: usage.snapshot, sessionLedgers: usage.sessionLedgers, pricing: usage.pricing, summary: usage.summary,
        recent: usage.recent, list: usage.list, series: usage.series }),
      executions: Object.freeze({ list: executions.list, get: executions.get, inspect: executions.inspect, listForDisplay: executions.listForDisplay }) }));
    });
  } finally { store.close(); }
}
