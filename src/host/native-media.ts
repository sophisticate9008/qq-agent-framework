import { recordNativeMediaRead, mediaObservationCode } from './native-media-diagnostics.ts';
import { normalizeOneBotContent, type OneBotIncomingAsset, type OneBotAssetResolutionRequest } from '../adapters/onebot.ts';
import type { OneBotActionPort } from '../adapters/onebot-actions.ts';
import type { EffectAdapter, EffectRequest, JsonObject } from '../core/types.ts';
import { assert, isRecord, reference, snapshot } from '../core/values.ts';
import { digest, json, object } from './data.ts';
import type { DurableStore } from './types.ts';
import type { NativeMediaContentReader, NativeMediaTranscriber } from '../contracts/native-media.ts';
import { FRAMEWORK_MEDIA_PROTOCOL, FRAMEWORK_MEDIA_IMAGE_BYTES, type FrameworkImageMediaType } from '../contracts/framework-media.ts';

const namespace = 'native-chat.media';
/** Registration records protocol facts. It does not fetch URLs, open paths, or approve outgoing resources. */
export function createNativeMediaRegistry(options: {
  readonly store: DurableStore;
  readonly accountId: string;
  readonly clock?: () => number;
  readonly protocol?: Pick<OneBotActionPort, 'getForward' | 'describe'>;
  readonly contentReader?: NativeMediaContentReader;
  readonly transcriber?: NativeMediaTranscriber;
  readonly authorize: (conversationId: string, signal: AbortSignal) => Promise<void>;
}) {
  assert(reference(options.accountId), 'INVALID_MEDIA_ACCOUNT', 'A verified protocol account is required.');
  const clock = options.clock ?? Date.now;
  function read(assetId: string, conversationId: string) {
    assert(reference(assetId) && reference(conversationId), 'INVALID_MEDIA_REFERENCE', 'A scoped media reference is required.');
    const record = options.store.read(namespace, assetId);
    assert(record, 'NATIVE_MEDIA_UNAVAILABLE', 'This media registration has expired or is unavailable.');
    const value = object(record.value);
    assert(value.schema === 1 && value.accountId === options.accountId && value.conversationId === conversationId
      && typeof value.expiresAt === 'number' && value.expiresAt > clock(),
    'NATIVE_MEDIA_UNAVAILABLE', 'This media is not available in the current conversation.');
    return value;
  }
  function metadata(value: JsonObject) {
    const readingAvailable = value.kind === 'forward' ? options.protocol?.describe().actions.includes('get_forward_msg') === true
      : options.contentReader !== undefined && (value.kind !== 'audio' || options.transcriber !== undefined);
    return snapshot({ assetId: value.assetId, kind: value.kind, messageId: value.messageId,
      conversationId: value.conversationId, name: value.name, registeredAt: value.registeredAt,
      expiresAt: value.expiresAt, contentRead: value.contentRead === true, state: value.contentRead === true ? 'expanded' : 'registered',
      bytesRead: value.bytesRead === true, readingAvailable,
      interpretation: value.kind === 'image' ? 'requires-current-model-image-input' : value.kind === 'audio' ? 'requires-transcriber' : 'text-content',
      missingReasons: readingAvailable ? [] : [value.kind === 'audio' ? 'native_media_transcriber_not_connected' : 'native_media_reader_not_connected'] });
  }
  function imageType(data: Uint8Array): FrameworkImageMediaType | null {
    const bytes = Buffer.from(data);
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
    if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return null;
  }
  async function readContent(assetId: string, value: JsonObject, request: EffectRequest): Promise<JsonObject> {
    const kind = value.kind;
    assert(kind === 'image' || kind === 'audio' || kind === 'file', 'NATIVE_MEDIA_READER_UNAVAILABLE', 'This media kind has no content reader.');
    const unavailable = (reason: string): JsonObject => ({ schema: FRAMEWORK_MEDIA_PROTOCOL, contentRead: false, kind, reason });
    if (!options.contentReader) return unavailable('native_media_reader_not_connected');
    if (kind === 'audio' && !options.transcriber) return unavailable('native_media_transcriber_not_connected');
    const source = object(value.source);
    const result = await options.contentReader.read({ kind, conversationId: request.scope.conversationId, source: {
      ...(typeof source.file === 'string' ? { file: source.file } : {}), ...(typeof source.id === 'string' ? { id: source.id } : {}),
      ...(typeof source.busId === 'number' ? { busId: source.busId } : {}), ...(typeof source.fileHash === 'string' ? { fileHash: source.fileHash } : {}) }, signal: request.signal });
    await options.authorize(request.scope.conversationId, request.signal);
    read(assetId, request.scope.conversationId);
    if (result.status !== 'confirmed') return unavailable(result.status === 'unknown' ? 'native_media_read_unknown' : 'native_media_read_rejected');
    if (result.data.byteLength > 1024 * 1024) return unavailable('native_media_too_large');
    let envelope: JsonObject;
    if (kind === 'image') {
      if (result.data.byteLength > FRAMEWORK_MEDIA_IMAGE_BYTES) return unavailable('image_too_large');
      const mediaType = imageType(result.data);
      if (!mediaType) return unavailable('unsupported_image_format');
      envelope = { schema: FRAMEWORK_MEDIA_PROTOCOL, contentRead: true, kind: 'image', mediaType,
        data: Buffer.from(result.data).toString('base64') };
    } else {
      let text: string;
      if (kind === 'audio') text = (await options.transcriber!.transcribe({ assetId, conversationId: request.scope.conversationId,
        data: result.data, mediaType: result.mediaType, signal: request.signal })).text;
      else {
        const mime = result.mediaType?.split(';')[0].trim().toLowerCase();
        if (mime && !mime.startsWith('text/') && !['application/json', 'application/xml', 'application/octet-stream'].includes(mime))
          return unavailable('unsupported_file_format');
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(result.data); }
        catch { return unavailable('file_not_utf8_text'); }
      }
      if (typeof text !== 'string' || text.length > 16000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))
        return unavailable(kind === 'audio' ? 'invalid_transcription' : 'file_text_limit_or_binary');
      envelope = { schema: FRAMEWORK_MEDIA_PROTOCOL, contentRead: true, kind: 'text', sourceKind: kind, text };
    }
    await options.authorize(request.scope.conversationId, request.signal);
    request.signal.throwIfAborted(); read(assetId, request.scope.conversationId);
    const current = options.store.read(namespace, assetId)!;
    options.store.write(namespace, assetId, { ...object(current.value), bytesRead: true, contentRead: kind !== 'image' },
      { expectedRevision: current.revision, expiresAt: Number(value.expiresAt) });
    return envelope;
  }
  async function inspect(request: EffectRequest) {
    assert(isRecord(request.input) && Object.keys(request.input).length === 1 && reference(request.input.assetId),
      'INVALID_MEDIA_INPUT', 'Media inspection needs one assetId.');
    await options.authorize(request.scope.conversationId, request.signal);
    request.signal.throwIfAborted();
    return metadata(read(request.input.assetId, request.scope.conversationId));
  }
  async function readRegistered(request: EffectRequest, assetId: string, value: JsonObject): Promise<JsonObject> {
      if (value.kind !== 'forward') return readContent(assetId, value, request);
      assert(value.kind === 'forward' && options.protocol, 'NATIVE_MEDIA_READER_UNAVAILABLE', 'No content reader is connected for this media kind.');
      const source = object(value.source);
      assert(typeof source.id === 'string', 'NATIVE_MEDIA_SOURCE_UNAVAILABLE', 'This forward has no protocol reference.');
      const result = await options.protocol.getForward({ id: source.id, signal: request.signal });
      if (result.status !== 'confirmed') return { assetId, state: result.status, contentRead: false, code: result.code };
      await options.authorize(request.scope.conversationId, request.signal);
      request.signal.throwIfAborted();
      read(assetId, request.scope.conversationId);
      const nodes: JsonObject[] = [];
      let characters = 0;
      let truncated = false;
      for (const node of result.data.messages) {
        const content = await normalizeOneBotContent(node.message, { conversationId: request.scope.conversationId,
          messageId: String(value.messageId), signal: request.signal, registerIncomingAsset: registry.register });
        if (content === null) { nodes.push({ senderId: node.senderId, available: false, reason: 'unsupported_content' }); continue; }
        const candidate = { senderId: node.senderId, senderName: node.senderName ?? null, at: node.time,
          available: true, content: json(content) };
        characters += JSON.stringify(candidate).length;
        if (characters > 24_000) { truncated = true; break; }
        nodes.push(candidate);
      }
      request.signal.throwIfAborted();
      const current = options.store.read(namespace, assetId);
      assert(current, 'NATIVE_MEDIA_UNAVAILABLE', 'The media registration expired during reading.');
      options.store.write(namespace, assetId, { ...object(current.value), contentRead: true },
        { expectedRevision: current.revision, expiresAt: Number(value.expiresAt) });
      return { assetId, state: 'expanded', contentRead: true, truncated, nodes,
        sourceMeaning: 'forwarded-content-not-authenticated-current-sender',
        nestedMediaRead: false };
  }
  const effectAdapter: EffectAdapter = Object.freeze({ execute: inspect });
  const registry = Object.freeze({
    async register(asset: OneBotIncomingAsset, signal: AbortSignal): Promise<string> {
      signal.throwIfAborted();
      assert(reference(asset.messageId) && reference(asset.conversationId)
        && ['image', 'audio', 'file', 'forward'].includes(asset.kind)
        && isRecord(asset.source) && Object.keys(asset.source).every(key => ['file', 'url', 'id', 'busId', 'fileHash'].includes(key))
        && Object.entries(asset.source).every(([key, value]) => key === 'busId' ? typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 : typeof value === 'string' && value.length > 0
          && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value))
        && (asset.name === undefined || typeof asset.name === 'string' && asset.name.length <= 255),
      'INVALID_INCOMING_MEDIA', 'Incoming media requires bounded protocol facts.');
      await options.authorize(asset.conversationId, signal);
      signal.throwIfAborted();
      const assetId = `media-${digest([options.accountId, asset.conversationId, asset.messageId, asset.kind, asset.source])}`;
      const prior = options.store.read(namespace, assetId);
      if (prior) { read(assetId, asset.conversationId); return assetId; }
      assert(options.store.list(namespace, { limit: 1000 }).length < 1000,
        'NATIVE_MEDIA_BACKPRESSURE', 'Incoming media registrations have reached capacity.');
      const registeredAt = clock();
      const expiresAt = registeredAt + 24 * 60 * 60 * 1000;
      options.store.write(namespace, assetId, json({ schema: 1, assetId, accountId: options.accountId,
        conversationId: asset.conversationId, messageId: asset.messageId, kind: asset.kind,
        name: asset.name ?? null, source: asset.source, registeredAt, expiresAt }), { expectedRevision: null, expiresAt });
      return assetId;
    },
    async resolveOutgoing(request: OneBotAssetResolutionRequest) {
      await options.authorize(request.conversationId, request.signal)
      const value = read(request.assetId, request.conversationId)
      assert(value.kind === request.type && options.contentReader, 'NATIVE_MEDIA_UNAVAILABLE', 'The outgoing resource has no current scoped reader.')
      const source = object(value.source)
      const result = await options.contentReader.read({ kind: request.type, conversationId: request.conversationId, source: {
        ...(typeof source.file === 'string' ? { file: source.file } : {}), ...(typeof source.id === 'string' ? { id: source.id } : {}),
        ...(typeof source.busId === 'number' ? { busId: source.busId } : {}), ...(typeof source.fileHash === 'string' ? { fileHash: source.fileHash } : {}) }, signal: request.signal })
      await options.authorize(request.conversationId, request.signal)
      request.signal.throwIfAborted(); read(request.assetId, request.conversationId)
      assert(result.status === 'confirmed' && result.data.byteLength > 0 && result.data.byteLength <= 1024 * 1024,
        'NATIVE_MEDIA_OUTGOING_UNAVAILABLE', 'Outgoing bytes could not be verified.')
      assert(request.type !== 'image' || imageType(result.data), 'NATIVE_MEDIA_OUTGOING_UNAVAILABLE', 'Image bytes are not supported.')
      return { file: `base64://${Buffer.from(result.data).toString('base64')}` }
    },
    inspect: effectAdapter,
    read: Object.freeze<EffectAdapter>({ async execute(request): Promise<JsonObject> {
      assert(isRecord(request.input) && Object.keys(request.input).length === 1 && reference(request.input.assetId),
        'INVALID_MEDIA_INPUT', 'Media reading needs one assetId.');
      const assetId = request.input.assetId;
      await options.authorize(request.scope.conversationId, request.signal);
      request.signal.throwIfAborted();
      const value = read(assetId, request.scope.conversationId);
      try {
        const result = await readRegistered(request, assetId, value);
        const code = mediaObservationCode(result.reason ?? result.code);
        const status = result.contentRead === true ? 'confirmed' : result.state === 'unknown' || code === 'native_media_read_unknown' ? 'unknown' : 'rejected';
        try { recordNativeMediaRead(options.store, assetId, request.scope.conversationId, { at: clock(), status, code }); } catch {}
        return result;
      } catch (error) {
        const code = mediaObservationCode(isRecord(error) ? error.code : null) ?? 'NATIVE_MEDIA_READ_FAILED';
        try { recordNativeMediaRead(options.store, assetId, request.scope.conversationId, { at: clock(), status: 'unknown', code }); } catch {}
        throw error;
      }
    } }),
  });
  return registry;
}
