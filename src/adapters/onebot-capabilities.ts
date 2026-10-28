import type { JsonObject, JsonValue } from '../contracts/data.ts';
import { QQ_CAPABILITIES, findQqCapability, type QqCapabilitiesInspection } from '../contracts/qq-capabilities.ts';
import { decodeQqCapabilityInput, isBoundedQqJson } from '../contracts/qq-capability-input.ts';
import { isRecord } from '../contracts/values.ts';
import type { OneBotReadResult } from './onebot-actions.ts';
import { classifyOneBotResponse } from './onebot-response.ts';

export interface OneBotCapabilitiesOptions {
  readonly endpoint: string;
  readonly accessToken?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}
export interface QqCapabilitiesPort {
  readonly inspect: (signal: AbortSignal) => Promise<OneBotReadResult<QqCapabilitiesInspection>>;
  readonly call: (request: { readonly id: string; readonly input: unknown; readonly signal: AbortSignal }) => Promise<OneBotReadResult<JsonValue>>;
}

const RESPONSE_BYTES = 4 * 1024 * 1024;
const STREAM_ACTIONS = new Set(QQ_CAPABILITIES.filter(capability => capability.transport === 'stream').map(capability => capability.id));
const KNOWN_NAPCAT_VERSIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '4.18.41': Object.freeze(QQ_CAPABILITIES.map(capability => capability.id)),
});
function waitFor<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> {
  if (signal.aborted) { void operation.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
async function readBody(response: Response, signal: AbortSignal): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new RangeError('response-size');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new TypeError('response-body');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await waitFor(reader.read(), signal);
      if (part.done) break;
      total += part.value.byteLength;
      if (total > RESPONSE_BYTES) throw new RangeError('response-size');
      chunks.push(part.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}
function decodeEnvelope(value: unknown, returnsVoid: boolean): OneBotReadResult<JsonValue> {
  const status = classifyOneBotResponse(value);
  if (status !== 'confirmed') return { status, code: 'QQ_CAPABILITY_NOT_CONFIRMED' };
  if (!isRecord(value)) return { status: 'unknown', code: 'QQ_CAPABILITY_INVALID_RESPONSE' };
  if (!Object.hasOwn(value, 'data')) return returnsVoid
    ? { status: 'confirmed', data: null } : { status: 'unknown', code: 'QQ_CAPABILITY_INVALID_RESPONSE' };
  return isBoundedQqJson(value.data, 100_000)
    ? { status: 'confirmed', data: value.data }
    : { status: 'unknown', code: 'QQ_CAPABILITY_INVALID_RESPONSE' };
}
function decodeResponse(text: string, action: string): OneBotReadResult<JsonValue> {
  const capability = findQqCapability(action);
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch {
    if (!STREAM_ACTIONS.has(action)) return { status: 'unknown', code: 'QQ_CAPABILITY_INVALID_JSON' };
    // NapCat HTTP stream actions send JSON envelopes separated by a blank line.
    const packets = text.trim().split(/\r?\n\s*\r?\n/);
    if (packets.length > 256) return { status: 'unknown', code: 'QQ_CAPABILITY_STREAM_LIMIT' };
    const events: JsonValue[] = [];
    for (const packet of packets) {
      let envelope: unknown;
      try { envelope = JSON.parse(packet); }
      catch { return { status: 'unknown', code: 'QQ_CAPABILITY_INVALID_JSON' }; }
      const result = decodeEnvelope(envelope, false);
      if (result.status !== 'confirmed') return result;
      events.push(result.data);
    }
    const result = events.pop();
    if (!isRecord(result) || result.type !== 'response') return { status: 'unknown', code: 'QQ_CAPABILITY_STREAM_INCOMPLETE' };
    return { status: 'confirmed', data: { events, result } };
  }
  const result = decodeEnvelope(parsed, capability?.returnsVoid ?? false);
  if (result.status === 'confirmed' && action.startsWith('download_file_') && STREAM_ACTIONS.has(action)
    && (!isRecord(result.data) || result.data.type !== 'response')) {
    return { status: 'unknown', code: 'QQ_CAPABILITY_STREAM_INCOMPLETE' };
  }
  return result;
}

/** Fixed catalog transport. Caller identity and conversation/resource policy belong to the host. */
export function createOneBotCapabilitiesPort(options: OneBotCapabilitiesOptions): QqCapabilitiesPort {
  const base = new URL(options.endpoint);
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash
    || /[\s\\?#]/.test(options.endpoint) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000
    || options.accessToken !== undefined && !/^[\x21-\x7e]{1,4096}$/.test(options.accessToken)) {
    throw new TypeError('Invalid OneBot capabilities configuration');
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.accessToken) headers.set('authorization', `Bearer ${options.accessToken}`);
  let inspection: QqCapabilitiesInspection | null = null;
  async function request(action: string, input: JsonObject, callerSignal: AbortSignal): Promise<OneBotReadResult<JsonValue>> {
    if (callerSignal.aborted) return { status: 'rejected', code: 'QQ_CAPABILITY_ABORTED' };
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)]);
    try {
      const response = await waitFor((options.fetch ?? globalThis.fetch)(new URL(action, base), {
        method: 'POST', headers, body: JSON.stringify(input), redirect: 'error', signal,
      }), signal);
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return { status: [401, 403, 404, 405].includes(response.status) ? 'rejected' : 'unknown', code: 'QQ_CAPABILITY_HTTP_FAILED' };
      }
      return decodeResponse(await readBody(response, signal), action);
    } catch (error) {
      return { status: 'unknown', code: error instanceof RangeError ? 'QQ_CAPABILITY_RESPONSE_LIMIT'
        : signal.aborted ? 'QQ_CAPABILITY_ABORTED_UNKNOWN' : 'QQ_CAPABILITY_TRANSPORT_UNKNOWN' };
    }
  }
  async function inspect(signal: AbortSignal): Promise<OneBotReadResult<QqCapabilitiesInspection>> {
    inspection = null;
    const result = await request('get_version_info', {}, signal);
    if (result.status !== 'confirmed') return result;
    if (!isRecord(result.data) || typeof result.data.app_name !== 'string' || result.data.app_name.length > 128
      || result.data.app_version !== undefined && (typeof result.data.app_version !== 'string' || result.data.app_version.length > 128)) {
      return { status: 'unknown', code: 'QQ_CAPABILITY_INVALID_VERSION' };
    }
    const protocol = result.data.app_name;
    const version = typeof result.data.app_version === 'string' ? result.data.app_version : null;
    const known = /^napcat(?:\.onebot)?$/i.test(protocol) && version !== null
      && Object.hasOwn(KNOWN_NAPCAT_VERSIONS, version.replace(/^v/, ''))
      ? KNOWN_NAPCAT_VERSIONS[version.replace(/^v/, '')] : undefined;
    const reported = result.data.supported_actions ?? result.data.actions;
    const reportedIds = Array.isArray(reported) && reported.length <= 1024 && reported.every(id => typeof id === 'string')
      ? QQ_CAPABILITIES.filter(capability => reported.includes(capability.id)).map(capability => capability.id) : null;
    inspection = Object.freeze({
      protocol, version, source: reportedIds ? 'reported-actions' : known ? 'napcat-version-map' : 'unverified',
      supportedIds: Object.freeze(reportedIds ?? known ?? ['get_version_info']),
    });
    return { status: 'confirmed', data: inspection };
  }
  return {
    inspect,
    async call({ id, input, signal }) {
      const capability = findQqCapability(id);
      if (!capability) return { status: 'rejected', code: 'QQ_CAPABILITY_NOT_REGISTERED' };
      const normalized = decodeQqCapabilityInput(capability, input);
      if (!normalized) return { status: 'rejected', code: 'QQ_CAPABILITY_INVALID_INPUT' };
      if (signal.aborted) return { status: 'rejected', code: 'QQ_CAPABILITY_ABORTED' };
      if (!inspection) {
        const result = await inspect(signal);
        if (result.status !== 'confirmed') return { status: 'rejected', code: 'QQ_CAPABILITY_SUPPORT_UNVERIFIED' };
      }
      if (!inspection?.supportedIds.includes(id)) return { status: 'rejected', code: 'QQ_CAPABILITY_UNSUPPORTED' };
      // One request only, including writes whose outcome becomes unknown on timeout.
      return request(id, normalized, signal);
    },
  };
}
