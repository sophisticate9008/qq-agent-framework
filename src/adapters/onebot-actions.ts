import type { JsonObject } from '../core/types.ts';
import { isRecord, snapshot } from '../core/values.ts';
import { classifyOneBotResponse } from './onebot-response.ts';
import { normalizeSenderDisplayName } from '../contracts/sender-display-name.ts';

export const ONEBOT_READ_ACTIONS = Object.freeze(['get_image', 'get_record', 'get_msg', 'get_forward_msg', 'get_file', 'get_group_file_url', 'get_private_file_url'] as const);
export type OneBotReadAction = typeof ONEBOT_READ_ACTIONS[number];
export type OneBotReadResult<Value> = { readonly status: 'confirmed'; readonly data: Value }
  | { readonly status: 'rejected' | 'unknown'; readonly code: string };
export interface OneBotAssetInfo { readonly file?: string; readonly url?: string; readonly name?: string; readonly size?: number }
export interface OneBotForwardNode {
  readonly senderId: string;
  readonly senderName?: string;
  readonly time: number | null;
  readonly message: readonly JsonObject[];
}
export interface OneBotMessageInfo {
  readonly messageId: string;
  readonly userId: string;
  readonly displayName?: string;
  readonly conversationId: string;
  readonly message: readonly JsonObject[];
}
export interface OneBotActionPort {
  describe(): { readonly actions: readonly OneBotReadAction[] };
  getImage(request: { readonly file: string; readonly signal: AbortSignal }): Promise<OneBotReadResult<OneBotAssetInfo>>;
  getRecord(request: { readonly file: string; readonly outFormat?: 'mp3' | 'wav' | 'ogg' | 'flac'; readonly signal: AbortSignal }): Promise<OneBotReadResult<OneBotAssetInfo>>;
  getFile(request: { readonly fileId: string; readonly signal: AbortSignal }): Promise<OneBotReadResult<OneBotAssetInfo>>;
  getGroupFile?(request: { readonly groupId: string; readonly fileId: string; readonly busId?: number; readonly signal: AbortSignal }): Promise<OneBotReadResult<OneBotAssetInfo>>;
  getPrivateFile?(request: { readonly userId: string; readonly fileId: string; readonly fileHash?: string; readonly signal: AbortSignal }): Promise<OneBotReadResult<OneBotAssetInfo>>;
  getForward(request: { readonly id: string; readonly signal: AbortSignal }): Promise<OneBotReadResult<{ readonly messages: readonly OneBotForwardNode[] }>>;
  getMessage(request: { readonly messageId: string; readonly conversationId: string; readonly signal: AbortSignal }): Promise<OneBotReadResult<OneBotMessageInfo>>;
}

function text(value: unknown, max = 4096): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
}
function id(value: unknown, signed = false): string | null {
  const result = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof result === 'string' && result.length <= 32 && (signed ? /^-?[1-9]\d*$/ : /^[1-9]\d*$/).test(result) ? result : null;
}
export function decodeOneBotMessageSegments(value: unknown): readonly JsonObject[] | null {
  if (typeof value === 'string') return value.length > 0 && value.length <= 8000 ? [{ type: 'text', data: { text: value } }] : null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return null;
  const result: JsonObject[] = [];
  for (const segment of value) {
    if (!isRecord(segment) || !text(segment.type, 64) || !isRecord(segment.data)) return null;
    // Keep canonical scalar facts. Protocol implementations also add raw/native
    // objects and nullable decorations; those never enter model-facing content.
    const data: JsonObject = {};
    if (Object.keys(segment.data).length > 32) return null;
    for (const [key, field] of Object.entries(segment.data)) {
      if (!text(key, 64)) return null;
      if (field === null || typeof field === 'object') continue;
      if (typeof field !== 'string' && typeof field !== 'number' && typeof field !== 'boolean'
        || typeof field === 'number' && !Number.isFinite(field) || typeof field === 'string' && field.length > 8000) return null;
      data[key] = field;
    }
    if (segment.type === 'text' && typeof data.text !== 'string'
      || segment.type === 'at' && data.qq !== 'all' && id(data.qq) === null
      || segment.type === 'reply' && id(data.id, true) === null
      || segment.type === 'forward' && text(data.id, 512) === null
      || segment.type === 'face' && !(typeof data.id === 'number' && Number.isSafeInteger(data.id) && data.id >= 0 && data.id <= 99999
        || typeof data.id === 'string' && /^(0|[1-9]\d{0,4})$/.test(data.id))) return null;
    result.push({ type: String(segment.type), data });
  }
  return snapshot(result);
}
function asset(value: unknown): OneBotAssetInfo | null {
  if (!isRecord(value)) return null;
  const file = text(value.file ?? value.file_path);
  const url = text(value.url);
  if (file === null && url === null) return null;
  if (url !== null) {
    try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null; }
    catch { return null; }
  }
  if (value.size !== undefined && (typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0)) return null;
  const name = text(value.file_name ?? value.name, 255);
  return { ...(file === null ? {} : { file }), ...(url === null ? {} : { url }),
    ...(name === null ? {} : { name }), ...(typeof value.size === 'number' ? { size: value.size } : {}) };
}
function forward(value: unknown): { readonly messages: readonly OneBotForwardNode[] } | null {
  if (!isRecord(value)) return null;
  const nodes = value.messages ?? value.message;
  if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > 32) return null;
  const messages: OneBotForwardNode[] = [];
  for (const raw of nodes) {
    if (!isRecord(raw)) return null;
    const node = raw.type === 'node' && isRecord(raw.data) ? raw.data : raw;
    const sender = isRecord(node.sender) ? node.sender : {};
    const senderId = id(node.uin ?? node.user_id ?? sender.user_id);
    const message = decodeOneBotMessageSegments(node.content ?? node.message);
    if (senderId === null || message === null || [node.uin, node.user_id, sender.user_id]
      .some(value => value !== undefined && id(value) !== senderId)) return null;
    const senderName = text(node.name ?? node.nickname ?? sender.nickname, 255);
    if (node.time !== undefined && (typeof node.time !== 'number' || !Number.isSafeInteger(node.time) || node.time < 0)) return null;
    messages.push({ senderId, ...(senderName === null ? {} : { senderName }), time: typeof node.time === 'number' ? node.time : null, message });
  }
  return snapshot({ messages });
}
function message(value: unknown, expectedId: string, conversationId: string): OneBotMessageInfo | null {
  if (!isRecord(value) || !isRecord(value.sender)) return null;
  const messageId = id(value.message_id, true);
  const userId = id(value.sender.user_id);
  const groupId = id(value.group_id);
  const peerId = id(value.user_id ?? value.target_id ?? value.sender.user_id);
  const scope = value.message_type === 'group' && groupId !== null ? `group:${groupId}`
    : value.message_type === 'private' && peerId !== null ? `private:${peerId}` : null;
  const content = decodeOneBotMessageSegments(value.message);
  if (messageId !== expectedId || userId === null || scope !== conversationId || content === null
    || value.user_id !== undefined && id(value.user_id) !== userId
    || value.message_type === 'private' && userId !== peerId) return null;
  const displayName = (scope.startsWith('group:') ? normalizeSenderDisplayName(value.sender.card) : undefined)
    ?? normalizeSenderDisplayName(value.sender.nickname);
  return snapshot({ messageId, userId, conversationId, message: content,
    ...(displayName === undefined ? {} : { displayName }) });
}

/** Trusted host I/O port. Callers must resolve an authorized scoped handle before using source pointers. */
export function createOneBotActionPort(options: {
  readonly endpoint: string;
  readonly accessToken?: string;
  readonly allowedActions?: readonly OneBotReadAction[];
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}): OneBotActionPort {
  let base: URL;
  try { base = new URL(options.endpoint.endsWith('/') ? options.endpoint : `${options.endpoint}/`); }
  catch { throw new TypeError('Invalid OneBot action port configuration'); }
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash
    || /[\s\\?#]/.test(options.endpoint) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000
    || options.accessToken !== undefined && (!text(options.accessToken, 4096) || !/^[\x21-\x7e]+$/.test(options.accessToken))) {
    throw new TypeError('Invalid OneBot action port configuration');
  }
  const actions = options.allowedActions ?? ONEBOT_READ_ACTIONS.filter(action => !['get_file', 'get_group_file_url', 'get_private_file_url'].includes(action));
  if (!Array.isArray(actions) || new Set(actions).size !== actions.length || actions.some(action => !ONEBOT_READ_ACTIONS.includes(action))) {
    throw new TypeError('Invalid OneBot action selection');
  }
  const allowed = new Set(actions);
  async function invoke<Value>(action: OneBotReadAction, parameters: JsonObject | null, signal: AbortSignal,
    decode: (value: unknown) => Value | null): Promise<OneBotReadResult<Value>> {
    if (parameters === null) return { status: 'rejected', code: 'ONEBOT_ACTION_INVALID_INPUT' };
    if (!allowed.has(action)) return { status: 'rejected', code: 'ONEBOT_ACTION_UNSUPPORTED' };
    if (signal.aborted) return { status: 'rejected', code: 'ONEBOT_ACTION_ABORTED' };
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([signal, deadline]);
    const perform = async (): Promise<OneBotReadResult<Value>> => { try {
      if (combined.aborted) return { status: 'unknown', code: 'ONEBOT_ACTION_ABORTED_UNKNOWN' };
      const response = await (options.fetch ?? globalThis.fetch)(new URL(action, base), { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}) },
        body: JSON.stringify(parameters), signal: combined });
      if (!response.ok) { await response.body?.cancel(); return { status: response.status >= 400 && response.status < 500 ? 'rejected' : 'unknown', code: 'ONEBOT_ACTION_HTTP_FAILED' }; }
      const reader = response.body?.getReader();
      if (!reader) return { status: 'unknown', code: 'ONEBOT_ACTION_INVALID_RESPONSE' };
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      let body: unknown;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 1024 * 1024) return { status: 'unknown', code: 'ONEBOT_ACTION_RESPONSE_TOO_LARGE' };
          chunks.push(part.value);
        }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const classified = classifyOneBotResponse(body);
      if (classified !== 'confirmed') return { status: classified, code: 'ONEBOT_ACTION_NOT_CONFIRMED' };
      const decoded = decode(isRecord(body) ? body.data : undefined);
      return decoded === null ? { status: 'unknown', code: 'ONEBOT_ACTION_INVALID_RESPONSE' } : { status: 'confirmed', data: decoded };
    } catch { return { status: 'unknown', code: combined.aborted ? 'ONEBOT_ACTION_ABORTED_UNKNOWN' : 'ONEBOT_ACTION_TRANSPORT_UNKNOWN' }; } };
    let abort: () => void = () => {};
    const aborted = new Promise<OneBotReadResult<Value>>(resolve => {
      abort = () => resolve({ status: 'unknown', code: 'ONEBOT_ACTION_ABORTED_UNKNOWN' });
      if (combined.aborted) abort();
      else combined.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([perform(), aborted]); }
    finally { combined.removeEventListener('abort', abort); }
  }
  return Object.freeze({
    describe: () => Object.freeze({ actions: Object.freeze([...allowed]) }),
    getImage: request => invoke('get_image', text(request.file) ? { file: request.file } : null, request.signal, asset),
    getRecord: request => invoke('get_record', text(request.file) && (request.outFormat === undefined || ['mp3', 'wav', 'ogg', 'flac'].includes(request.outFormat))
      ? { file: request.file, out_format: request.outFormat ?? 'mp3' } : null, request.signal, asset),
    getFile: request => invoke('get_file', text(request.fileId, 512) ? { file_id: request.fileId } : null, request.signal, asset),
    getGroupFile: request => invoke('get_group_file_url', id(request.groupId) && text(request.fileId, 512)
      && (request.busId === undefined || Number.isSafeInteger(request.busId) && request.busId >= 0)
      ? { group_id: request.groupId, file_id: request.fileId, ...(request.busId === undefined ? {} : { busid: request.busId }) } : null, request.signal, asset),
    getPrivateFile: request => invoke('get_private_file_url', id(request.userId) && text(request.fileId, 512)
      && (request.fileHash === undefined || text(request.fileHash, 512))
      ? { user_id: request.userId, file_id: request.fileId, ...(request.fileHash === undefined ? {} : { file_hash: request.fileHash }) } : null, request.signal, asset),
    getForward: request => invoke('get_forward_msg', text(request.id, 512) ? { id: request.id } : null, request.signal, forward),
    getMessage: request => invoke('get_msg', id(request.messageId, true) && /^(?:group|private):[1-9]\d{0,31}$/.test(request.conversationId)
      ? { message_id: request.messageId } : null, request.signal, value => message(value, request.messageId, request.conversationId)),
  } satisfies OneBotActionPort);
}
