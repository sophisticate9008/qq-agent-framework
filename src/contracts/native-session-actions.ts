export interface NativeSessionActionTarget {
  readonly key: string; readonly sessionId: string; readonly generation: number; readonly bindingRevision: string
}
export function isNativeSessionActionTarget(value: unknown): value is NativeSessionActionTarget {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return Object.keys(entry).length === 4 && typeof entry.key === 'string' && /^(?:group|private):[1-9][0-9]{0,19}$/.test(entry.key)
    && typeof entry.sessionId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(entry.sessionId)
    && typeof entry.generation === 'number' && Number.isSafeInteger(entry.generation) && entry.generation > 0
    && typeof entry.bindingRevision === 'string' && /^[a-f0-9]{64}$/.test(entry.bindingRevision)
}
