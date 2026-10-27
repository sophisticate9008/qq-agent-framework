import { fileURLToPath } from 'node:url';
import type { JsonObject } from '../contracts/data.ts';
import type { QzoneAction, QzonePort, QzonePublishRequest, QzoneResult } from '../contracts/qzone.ts';
import { isRecord } from '../core/values.ts';
import { validOneBotUploadSource } from './onebot-files.ts';
import { classifyOneBotResponse } from './onebot-response.ts';

export interface OneBotQzoneOptions {
  readonly endpoint: string;
  readonly accessToken?: string;
  /** Set from the installed implementation's supported extensions, not OneBot v11 alone. */
  readonly supportedActions: readonly QzoneAction[];
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

const actionNames = { publish: 'send_qzone_msg', delete: 'delete_qzone_msg' } as const;
const rights = { public: 1, friends: 4, allow: 16, self: 64, deny: 128 } as const;

function reference(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(value);
}

function imageSource(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.startsWith('base64://')) return validOneBotUploadSource(value);
  if (value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === 'file:') return !url.search && !url.hash && validOneBotUploadSource(fileURLToPath(url));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch { return false; }
}

function publishParams(request: QzonePublishRequest): JsonObject | null {
  if (typeof request.content !== 'string' || request.content.trim().length === 0 || request.content.length > 32768
    || !isRecord(request.visibility) || typeof request.visibility.kind !== 'string'
    || !Object.hasOwn(rights, request.visibility.kind)) return null;
  if (request.images !== undefined && (!Array.isArray(request.images) || request.images.length > 32
    || !request.images.every(imageSource))) return null;
  const visibility = request.visibility;
  const result: JsonObject = { content: request.content, ugc_right: rights[visibility.kind] };
  if (visibility.kind === 'allow' || visibility.kind === 'deny') {
    if (!Array.isArray(visibility.userIds) || visibility.userIds.length === 0 || visibility.userIds.length > 1000
      || !visibility.userIds.every((id: unknown) => typeof id === 'string' && /^[1-9]\d{0,15}$/.test(id)
        && Number.isSafeInteger(Number(id)))) return null;
    result.target_uins = [...new Set(visibility.userIds)].map(Number);
  }
  if (request.images !== undefined) result.images = [...request.images];
  // Framework request-size bounds, not claims about the remote platform's image/text limits.
  return Buffer.byteLength(JSON.stringify(result)) <= 16 * 1024 * 1024 ? result : null;
}

function waitFor<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> {
  if (signal.aborted) { void operation.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

/** Shared NapCat/SnowLuma extension. No owner-message requirement, polling, retries or cookie storage. */
export function createOneBotQzonePort(options: OneBotQzoneOptions): QzonePort {
  const base = new URL(options.endpoint);
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash
    || /[\s\\?#]/.test(options.endpoint) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000
    || options.accessToken !== undefined && !/^[\x21-\x7e]{1,4096}$/.test(options.accessToken)
    || !Array.isArray(options.supportedActions) || options.supportedActions.some(action => !Object.hasOwn(actionNames, action))
    || new Set(options.supportedActions).size !== options.supportedActions.length) {
    throw new TypeError('Invalid OneBot Qzone configuration');
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const supported = new Set(options.supportedActions);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.accessToken) headers.set('authorization', `Bearer ${options.accessToken}`);

  async function invoke<Value>(action: QzoneAction, params: JsonObject | null, callerSignal: AbortSignal,
    decode: (data: unknown) => { readonly data: Value } | null): Promise<QzoneResult<Value>> {
    if (!supported.has(action)) return { status: 'rejected', code: 'QZONE_UNSUPPORTED' };
    if (params === null) return { status: 'rejected', code: 'QZONE_INVALID_INPUT' };
    if (callerSignal.aborted) return { status: 'rejected', code: 'QZONE_ABORTED' };
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)]);
    try {
      const response = await waitFor(fetchImplementation(new URL(actionNames[action], base), {
        method: 'POST', headers, redirect: 'error', body: JSON.stringify(params), signal,
      }), signal);
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return { status: [401, 403, 404, 405].includes(response.status) ? 'rejected' : 'unknown', code: 'QZONE_HTTP_FAILED' };
      }
      if (!response.body) return { status: 'unknown', code: 'QZONE_INVALID_RESPONSE' };
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await waitFor(reader.read(), signal);
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 65536) return { status: 'unknown', code: 'QZONE_RESPONSE_TOO_LARGE' };
          chunks.push(part.value);
        }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const status = classifyOneBotResponse(body);
      if (status !== 'confirmed') return { status, code: 'QZONE_NOT_CONFIRMED' };
      const decoded = decode(isRecord(body) ? body.data : undefined);
      return decoded === null ? { status: 'unknown', code: 'QZONE_INVALID_RESPONSE' } : { status: 'confirmed', data: decoded.data };
    } catch {
      return { status: 'unknown', code: signal.aborted ? 'QZONE_ABORTED_UNKNOWN' : 'QZONE_TRANSPORT_UNKNOWN' };
    }
  }

  return Object.freeze<QzonePort>({
    describe: () => Object.freeze({ actions: Object.freeze([...supported]) }),
    publish: request => invoke('publish', publishParams(request), request.signal, data => {
      if (!isRecord(data) || !reference(data.tid)) return null;
      const time = typeof data.time === 'number' && Number.isSafeInteger(data.time) && data.time >= 0 ? data.time : null;
      return { data: { postId: data.tid, publishedAt: time } };
    }),
    delete: request => invoke('delete', reference(request.postId) ? { tid: request.postId } : null, request.signal,
      data => data === null ? { data: null } : null),
  });
}
