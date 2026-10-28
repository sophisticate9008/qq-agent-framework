import { createHash } from 'node:crypto';
import type { FrameworkImageMediaType } from '../contracts/framework-media.ts';
import type { NativeImageReferenceReader, NativeMediaContentReader } from '../contracts/native-media.ts';
import { isNativeAccessScope } from '../contracts/native-access.ts';
import { assert, FrameworkError, isRecord } from '../core/values.ts';
import type { JsonObject } from '../core/types.ts';
import type { DurableStore } from './types.ts';
import { NATIVE_MEDIA_NAMESPACE } from './native-media-diagnostics.ts';

const assetPattern = /^media-[a-f0-9]{64}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const maxImageBytes = 8 * 1024 * 1024;

export function nativeImageType(data: Uint8Array): FrameworkImageMediaType | null {
  const bytes = Buffer.from(data);
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Aliases identify actual model attachments, while downloads retain original registered bytes. */
export function createNativeImageReferences(options: {
  readonly store: DurableStore;
  readonly accountId: string;
  readonly clock: () => number;
  readonly contentReader?: NativeMediaContentReader;
  readonly authorize: (conversationId: string, signal: AbortSignal) => Promise<void>;
}) {
  function registered(assetId: string, conversationId: string): JsonObject {
    const row = options.store.read(NATIVE_MEDIA_NAMESPACE, assetId);
    assert(row, 'NATIVE_IMAGE_REFERENCE_NOT_FOUND', '当前会话未找到该图片登记（可能已清理）。');
    const value = row.value;
    assert(isRecord(value) && value.schema === 1 && value.assetId === assetId,
      'NATIVE_IMAGE_REFERENCE_READ_FAILED', '图片登记内容无效。');
    assert(value.accountId === options.accountId && value.conversationId === conversationId,
      'NATIVE_IMAGE_REFERENCE_SCOPE_MISMATCH', '该图片登记不属于当前账号和会话。');
    assert(Number.isSafeInteger(value.expiresAt), 'NATIVE_IMAGE_REFERENCE_READ_FAILED', '图片登记有效期无效。');
    assert(Number(value.expiresAt) > options.clock(), 'NATIVE_IMAGE_REFERENCE_EXPIRED', '该图片登记已过期。');
    assert(value.kind === 'image' && isRecord(value.source), 'NATIVE_IMAGE_REFERENCE_READ_FAILED', '该登记不是可读取的图片。');
    return value as JsonObject;
  }
  function resolve(referenceId: string, conversationId: string): string {
    if (assetPattern.test(referenceId)) return referenceId;
    const hash = referenceId.replace(/^sha256:/, '').toLowerCase();
    assert(hashPattern.test(hash), 'INVALID_MEDIA_REFERENCE', '图片引用须为登记编号或图片附件 SHA256。');
    for (const row of options.store.list(NATIVE_MEDIA_NAMESPACE, { limit: 1000 })) {
      const value = row.value;
      if (isRecord(value) && value.schema === 1 && value.accountId === options.accountId
        && value.conversationId === conversationId && value.kind === 'image' && assetPattern.test(row.key)
        && Array.isArray(value.imageHashes) && value.imageHashes.slice(0, 4).includes(hash)) return row.key;
    }
    throw new FrameworkError('NATIVE_IMAGE_REFERENCE_NOT_FOUND', '当前会话未找到该图片附件指纹的登记（可能已清理）。');
  }
  const readImage: NativeImageReferenceReader['readImage'] = async request => {
    assert(isNativeAccessScope(request.conversationId) && typeof request.referenceId === 'string',
      'INVALID_MEDIA_REFERENCE', '图片读取需要当前会话和登记引用。');
    request.signal.throwIfAborted();
    await options.authorize(request.conversationId, request.signal);
    request.signal.throwIfAborted();
    const assetId = resolve(request.referenceId, request.conversationId);
    const value = registered(assetId, request.conversationId);
    assert(options.contentReader, 'NATIVE_IMAGE_REFERENCE_READ_FAILED', '当前未接入图片内容读取服务。');
    const source = value.source as JsonObject;
    let result: Awaited<ReturnType<NativeMediaContentReader['read']>>;
    try {
      result = await options.contentReader.read({ kind: 'image', conversationId: request.conversationId,
        source: { ...(typeof source.url === 'string' ? { url: source.url } : {}),
          ...(typeof source.file === 'string' ? { file: source.file } : {}), ...(typeof source.id === 'string' ? { id: source.id } : {}),
          ...(typeof source.busId === 'number' ? { busId: source.busId } : {}), ...(typeof source.fileHash === 'string' ? { fileHash: source.fileHash } : {}) },
        signal: request.signal });
    } catch {
      request.signal.throwIfAborted();
      throw new FrameworkError('NATIVE_IMAGE_REFERENCE_READ_FAILED', '已找到图片登记，但未能读取原图。');
    }
    await options.authorize(request.conversationId, request.signal);
    request.signal.throwIfAborted();
    const current = registered(assetId, request.conversationId);
    assert(result.status === 'confirmed' && result.data.byteLength > 0 && result.data.byteLength <= maxImageBytes,
      'NATIVE_IMAGE_REFERENCE_READ_FAILED', '原图读取失败或超出 8 MiB 上限。');
    const mediaType = nativeImageType(result.data);
    assert(mediaType, 'NATIVE_IMAGE_REFERENCE_READ_FAILED', '原图格式不受支持。');
    return { assetId, data: Uint8Array.from(result.data), mediaType,
      sha256: createHash('sha256').update(result.data).digest('hex'), expiresAt: Number(current.expiresAt) };
  };
  return Object.freeze({ readImage,
    rememberImage(assetId: string, conversationId: string, data: Uint8Array): void {
      registered(assetId, conversationId);
      const row = options.store.read(NATIVE_MEDIA_NAMESPACE, assetId)!;
      const value = row.value as JsonObject;
      const hash = createHash('sha256').update(data).digest('hex');
      const hashes = Array.isArray(value.imageHashes) ? value.imageHashes.filter((entry): entry is string => typeof entry === 'string' && hashPattern.test(entry)) : [];
      if (hashes.includes(hash)) return;
      options.store.write(NATIVE_MEDIA_NAMESPACE, assetId, { ...value, imageHashes: [...hashes, hash].slice(-4) },
        { expectedRevision: row.revision, expiresAt: Number(value.expiresAt) });
    }
  });
}
