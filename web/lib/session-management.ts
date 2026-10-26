import { parseSessionSnapshot as parseBaseSnapshot, parseSessionResetResult as parseBaseResetResult, type ManagedSession as BaseSession, type SessionSnapshot as BaseSnapshot } from './activity.ts';

export interface ManagedSession extends BaseSession {
  readonly generation?: number;
}

export interface SessionSnapshot extends BaseSnapshot {
  readonly sessions: readonly ManagedSession[];
  readonly resetUnavailableReason?: string;
  readonly deleteAvailable?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function hasSessionResetTarget(session: ManagedSession): session is ManagedSession & { readonly generation: number; readonly bindingRevision: string } {
  return /^(?:group|private):[1-9][0-9]{0,19}$/.test(session.key)
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(session.sessionId)
    && typeof session.generation === 'number' && Number.isSafeInteger(session.generation) && session.generation > 0
    && typeof session.bindingRevision === 'string' && /^[a-f0-9]{64}$/.test(session.bindingRevision);
}

export function parseSessionSnapshot(value: unknown): SessionSnapshot | null {
  const base = parseBaseSnapshot(value);
  if (!base || !isRecord(value) || !Array.isArray(value.sessions)) return null;
  const entries: unknown[] = value.sessions;
  const sessions: ManagedSession[] = [];
  for (const [index, session] of base.sessions.entries()) {
    const entry = entries[index];
    if (!isRecord(entry)) return null;
    if (entry.generation !== undefined && (typeof entry.generation !== 'number' || !Number.isSafeInteger(entry.generation) || entry.generation < 1)) return null;
    if (entry.bindingRevision !== undefined && (typeof entry.bindingRevision !== 'string' || !/^[a-f0-9]{64}$/.test(entry.bindingRevision))) return null;
    sessions.push({ ...session, ...(typeof entry.generation === 'number' ? { generation: entry.generation } : {}),
      ...(typeof entry.bindingRevision === 'string' ? { bindingRevision: entry.bindingRevision } : {}) });
  }
  const resetAvailable = base.resetAvailable === true && sessions.every(hasSessionResetTarget);
  return { ...base, sessions, resetAvailable, deleteAvailable: value.deleteAvailable === true,
    ...(typeof value.resetUnavailableReason === 'string' && value.resetUnavailableReason.length <= 128
      ? { resetUnavailableReason: value.resetUnavailableReason } : {}) };
}

export function parseSessionResetResult(value: unknown, target: ManagedSession) {
  if (!isRecord(value) || !hasSessionResetTarget(target) || value.previousGeneration !== target.generation
    || value.nextGeneration !== target.generation + 1 || value.historyPreserved !== true || value.contextReset !== true) return null;
  return parseBaseResetResult(value, target.key, target.sessionId);
}
