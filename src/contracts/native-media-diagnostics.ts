export const NATIVE_MEDIA_DIAGNOSTICS_PATH = '/api/chat/media';
export interface NativeMediaReadObservation { readonly at: number; readonly status: 'confirmed' | 'rejected' | 'unknown'; readonly code: string | null }
export interface NativeMediaDiagnosticItem {
  readonly assetId: string; readonly kind: 'image' | 'audio' | 'file' | 'forward'; readonly messageId: string;
  readonly registeredAt: number; readonly expiresAt: number; readonly contentRead: boolean; readonly bytesRead: boolean;
  readonly readingAvailable: boolean; readonly missingReasons: readonly string[]; readonly lastRead: NativeMediaReadObservation | null;
}
export interface NativeMediaDiagnostics {
  readonly schema: 1; readonly conversationId: string; readonly observedAt: number; readonly running: boolean;
  readonly coverage: 'complete' | 'partial' | 'absent' | 'unavailable'; readonly items: readonly NativeMediaDiagnosticItem[];
  readonly capabilities: { readonly image: boolean; readonly audio: boolean; readonly file: boolean; readonly forward: boolean; readonly quote: boolean };
  readonly quote: (NativeMediaReadObservation & { readonly messageId: string }) | null;
}
const record = (input: unknown): input is Record<string, unknown> => input !== null && typeof input === 'object' && !Array.isArray(input);
const exact = (input: Record<string, unknown>, keys: readonly string[]) => Object.keys(input).length === keys.length && keys.every(key => Object.hasOwn(input, key));
const time = (input: unknown): input is number => typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 && input <= 8_640_000_000_000_000;
const reference = (input: unknown): input is string => typeof input === 'string' && input.length > 0 && input.length <= 512 && !/[\x00-\x1f\x7f]/.test(input);
const code = (input: unknown): input is string => typeof input === 'string' && /^[A-Za-z][A-Za-z0-9_:-]{0,159}$/.test(input);
function observation(input: unknown, quote = false): NativeMediaReadObservation | null {
  if (!record(input) || !exact(input, quote ? ['messageId', 'at', 'status', 'code'] : ['at', 'status', 'code']) || !time(input.at) || !['confirmed', 'rejected', 'unknown'].includes(String(input.status)) || input.code !== null && !code(input.code) || quote && !reference(input.messageId)) return null;
  return { at: input.at, status: input.status as NativeMediaReadObservation['status'], code: input.code as string | null };
}
export function parseNativeMediaDiagnostics(input: unknown): NativeMediaDiagnostics | null {
  if (!record(input) || !exact(input, ['schema', 'conversationId', 'observedAt', 'running', 'coverage', 'items', 'capabilities', 'quote']) || input.schema !== 1
    || typeof input.conversationId !== 'string' || !/^(?:group|private):[1-9][0-9]{0,31}$/.test(input.conversationId) || !time(input.observedAt) || typeof input.running !== 'boolean'
    || !['complete', 'partial', 'absent', 'unavailable'].includes(String(input.coverage)) || !Array.isArray(input.items) || input.items.length > 100 || Object.keys(input.items).length !== input.items.length
    || !record(input.capabilities) || !exact(input.capabilities, ['image', 'audio', 'file', 'forward', 'quote']) || Object.values(input.capabilities).some(value => typeof value !== 'boolean')) return null;
  const items: NativeMediaDiagnosticItem[] = []; const seen = new Set<string>();
  for (const item of input.items) {
    if (!record(item) || !exact(item, ['assetId', 'kind', 'messageId', 'registeredAt', 'expiresAt', 'contentRead', 'bytesRead', 'readingAvailable', 'missingReasons', 'lastRead'])
      || typeof item.assetId !== 'string' || !/^media-[a-f0-9]{64}$/.test(item.assetId) || seen.has(item.assetId) || !['image', 'audio', 'file', 'forward'].includes(String(item.kind)) || !reference(item.messageId)
      || !time(item.registeredAt) || !time(item.expiresAt) || item.expiresAt <= item.registeredAt || typeof item.contentRead !== 'boolean' || typeof item.bytesRead !== 'boolean' || typeof item.readingAvailable !== 'boolean'
      || !Array.isArray(item.missingReasons) || item.missingReasons.length > 16 || !item.missingReasons.every(code)) return null;
    const lastRead = item.lastRead === null ? null : observation(item.lastRead); if (item.lastRead !== null && !lastRead) return null;
    seen.add(item.assetId); items.push({ assetId: item.assetId, kind: item.kind as NativeMediaDiagnosticItem['kind'], messageId: item.messageId, registeredAt: item.registeredAt, expiresAt: item.expiresAt, contentRead: item.contentRead, bytesRead: item.bytesRead, readingAvailable: item.readingAvailable, missingReasons: [...item.missingReasons] as string[], lastRead });
  }
  const quote = input.quote === null ? null : observation(input.quote, true); if (input.quote !== null && !quote) return null;
  return { schema: 1, conversationId: input.conversationId, observedAt: input.observedAt, running: input.running, coverage: input.coverage as NativeMediaDiagnostics['coverage'], items,
    capabilities: { image: input.capabilities.image as boolean, audio: input.capabilities.audio as boolean, file: input.capabilities.file as boolean, forward: input.capabilities.forward as boolean, quote: input.capabilities.quote as boolean },
    quote: quote && record(input.quote) ? { ...quote, messageId: input.quote.messageId as string } : null };
}
