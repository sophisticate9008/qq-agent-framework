import { fileURLToPath } from 'node:url';
import type { JsonObject } from '../contracts/data.ts';
import type { QzoneAction, QzonePort, QzonePublishRequest, QzoneResult } from '../contracts/qzone.ts';
import { isRecord } from '../core/values.ts';
import { validOneBotUploadSource } from './onebot-files.ts';
import { createOneBotQzoneClient } from './onebot-qzone-http.ts';

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

export function qzoneReference(value: unknown): value is string {
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

export function qzonePublishParams(request: QzonePublishRequest): JsonObject | null {
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

/** Shared NapCat/SnowLuma extension. No owner-message requirement, polling, retries or cookie storage. */
export function createOneBotQzonePort(options: OneBotQzoneOptions): QzonePort {
  const client = createOneBotQzoneClient(options);
  if (!Array.isArray(options.supportedActions) || options.supportedActions.some(action => !Object.hasOwn(actionNames, action))
    || new Set(options.supportedActions).size !== options.supportedActions.length) throw new TypeError('Invalid OneBot Qzone action selection');
  const supported = new Set(options.supportedActions);
  async function invoke<Value>(action: QzoneAction, params: JsonObject | null, signal: AbortSignal,
    decode: (data: unknown) => { readonly data: Value } | null): Promise<QzoneResult<Value>> {
    if (!supported.has(action)) return { status: 'rejected', code: 'QZONE_UNSUPPORTED' };
    if (params === null) return { status: 'rejected', code: 'QZONE_INVALID_INPUT' };
    const result = await client(actionNames[action], params, signal);
    if (result.status !== 'confirmed') return result;
    const decoded = decode(result.data);
    return decoded === null ? { status: 'unknown', code: 'QZONE_INVALID_RESPONSE' } : { status: 'confirmed', data: decoded.data };
  }

  return Object.freeze<QzonePort>({
    describe: () => Object.freeze({ actions: Object.freeze([...supported]) }),
    publish: request => invoke('publish', qzonePublishParams(request), request.signal, data => {
      if (!isRecord(data) || !qzoneReference(data.tid)) return null;
      const time = typeof data.time === 'number' && Number.isSafeInteger(data.time) && data.time >= 0 ? data.time : null;
      return { data: { postId: data.tid, publishedAt: time } };
    }),
    delete: request => invoke('delete', qzoneReference(request.postId) ? { tid: request.postId } : null, request.signal,
      data => data === null ? { data: null } : null),
  });
}
