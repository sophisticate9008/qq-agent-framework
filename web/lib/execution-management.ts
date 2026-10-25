import { isRecord } from './api.ts';
import { parseExecutionJournalEntry, type ExecutionJournalEntry } from './execution-journal.ts';
export function parseExecutionDetail(input: unknown, id: string): { readonly item: ExecutionJournalEntry | null } | null {
  if (!isRecord(input) || input.native !== true || input.manualCancelAvailable !== false || input.historyReadOnly !== undefined && typeof input.historyReadOnly !== 'boolean') return null;
  const item = input.item === null ? null : parseExecutionJournalEntry(input.item);
  return input.item !== null && (!item || item.id !== id) ? null : { item };
}
export interface ExecutionReconciliationView { readonly state: 'released' | 'blocked'; readonly executionId: string; readonly isolated: boolean; readonly missingReasons: readonly string[]; readonly restartRequired: boolean }
export function parseExecutionReconciliation(input: unknown, id: string): ExecutionReconciliationView | null {
  if (!isRecord(input) || !['released', 'blocked'].includes(String(input.state)) || !isRecord(input.execution) || input.execution.id !== id || typeof input.execution.isolated !== 'boolean'
    || !Array.isArray(input.missingReasons) || input.missingReasons.length > 32 || !input.missingReasons.every(reason => typeof reason === 'string' && /^[a-z][a-z0-9_]{0,159}$/.test(reason))
    || input.automaticReplayAvailable !== false || typeof input.restartRequired !== 'boolean' || input.state === 'released' && (input.execution.isolated || input.missingReasons.length !== 0)) return null;
  return { state: input.state as 'released' | 'blocked', executionId: id, isolated: input.execution.isolated, missingReasons: [...input.missingReasons] as string[], restartRequired: input.restartRequired };
}
