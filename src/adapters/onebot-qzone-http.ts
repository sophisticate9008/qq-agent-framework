import type { JsonObject, JsonValue } from '../contracts/data.ts';
import type { QzoneResult } from '../contracts/qzone.ts';
import { isRecord } from '../core/values.ts';
import { classifyOneBotResponse } from './onebot-response.ts';

export interface OneBotQzoneConnectionOptions {
  readonly endpoint: string;
  readonly accessToken?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
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
/** Shared bounded transport; credentials never enter returned diagnostics. No retries. */
export function createOneBotQzoneClient(options: OneBotQzoneConnectionOptions) {
  const base = new URL(options.endpoint);
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash
    || /[\s\\?#]/.test(options.endpoint) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000
    || options.accessToken !== undefined && !/^[\x21-\x7e]{1,4096}$/.test(options.accessToken)) {
    throw new TypeError('Invalid OneBot Qzone configuration');
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.accessToken) headers.set('authorization', `Bearer ${options.accessToken}`);
  return async function request(action: string, params: JsonObject, callerSignal: AbortSignal,
    maxResponseBytes = 65536): Promise<QzoneResult<JsonValue>> {
    if (callerSignal.aborted) return { status: 'rejected', code: 'QZONE_ABORTED' };
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)]);
    try {
      const response = await waitFor((options.fetch ?? globalThis.fetch)(new URL(action, base), {
        method: 'POST', headers, redirect: 'error', body: JSON.stringify(params), signal,
      }), signal);
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return { status: [401, 403, 404, 405].includes(response.status) ? 'rejected' : 'unknown', code: 'QZONE_HTTP_FAILED' };
      }
      const reader = response.body?.getReader();
      if (!reader) return { status: 'unknown', code: 'QZONE_INVALID_RESPONSE' };
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await waitFor(reader.read(), signal);
          if (part.done) break;
          size += part.value.byteLength;
          if (size > maxResponseBytes) return { status: 'unknown', code: 'QZONE_RESPONSE_TOO_LARGE' };
          chunks.push(part.value);
        }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const status = classifyOneBotResponse(body);
      if (status !== 'confirmed') return { status, code: 'QZONE_NOT_CONFIRMED' };
      if (isRecord(body) && Object.hasOwn(body, 'data')) return { status: 'confirmed', data: body.data as JsonValue };
      // NapCat's void handlers serialize undefined by omitting data. Only known void actions accept that shape.
      return ['delete_qzone_msg', 'like_qzone', 'unlike_qzone'].includes(action)
        ? { status: 'confirmed', data: null } : { status: 'unknown', code: 'QZONE_INVALID_RESPONSE' };
    } catch {
      return { status: 'unknown', code: signal.aborted ? 'QZONE_ABORTED_UNKNOWN' : 'QZONE_TRANSPORT_UNKNOWN' };
    }
  };
}
