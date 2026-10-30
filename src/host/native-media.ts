import type { MediaObservationVersion } from '../contracts/native-media-configuration.ts';
import { withDeadline } from './deadlines.ts';
import { createNativeImageReferences, nativeImageType as imageType } from './native-image-references.ts';
import { normalizeModelImage } from '../adapters/image-normalization.ts';
import { observeGif } from '../adapters/gif-observation.ts';
import { recordNativeMediaRead, mediaObservationCode } from './native-media-diagnostics.ts';
import { normalizeOneBotContent, type OneBotIncomingAsset, type OneBotAssetResolutionRequest } from '../adapters/onebot.ts';
import type { OneBotActionPort } from '../adapters/onebot-actions.ts';
import type { EffectAdapter, EffectRequest, JsonObject } from '../core/types.ts';
import { assert, isRecord, reference, snapshot } from '../core/values.ts';
import { digest, json, object } from './data.ts';
import type { DurableStore } from './types.ts';
import type { NativeMediaContentReader, NativeMediaTranscriber, NativeVideoObserver } from '../contracts/native-media.ts';
import { FRAMEWORK_MEDIA_PROTOCOL, FRAMEWORK_MEDIA_IMAGE_BYTES, parseNativeMediaReadEnvelope, type FrameworkImageMediaType } from '../contracts/framework-media.ts';

const namespace = 'native-chat.media';
/** Registration records protocol facts. It does not fetch URLs, open paths, or approve outgoing resources. */
export function createNativeMediaRegistry(options: {
  readonly store: DurableStore;
  readonly accountId: string;
  readonly clock?: () => number;
  readonly protocol?: Pick<OneBotActionPort, 'getForward' | 'describe'>;
  readonly contentReader?: NativeMediaContentReader;
  readonly transcriber?: NativeMediaTranscriber;
  readonly videoObserver?: NativeVideoObserver;
  readonly observationVersion?: (signal: AbortSignal) => Promise<MediaObservationVersion>;
  readonly observeVideo?: (signal: AbortSignal) => Promise<boolean>;
  readonly authorize: (conversationId: string, signal: AbortSignal) => Promise<void>;
}) {
  assert(reference(options.accountId), 'INVALID_MEDIA_ACCOUNT', 'A verified protocol account is required.');
  const clock = options.clock ?? Date.now;
  const imageReferences = createNativeImageReferences({ ...options, clock });
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
  async function metadata(value: JsonObject, signal: AbortSignal) {
    const videoEnabled = value.kind === 'video' && await options.observeVideo?.(signal) === true;
    signal.throwIfAborted();
    const readingAvailable = value.kind === 'video' ? videoEnabled && options.videoObserver !== undefined && options.contentReader !== undefined
      : value.kind === 'forward' ? options.protocol?.describe().actions.includes('get_forward_msg') === true
      : options.contentReader !== undefined && (value.kind !== 'audio' || options.transcriber !== undefined);
    return snapshot({ assetId: value.assetId, kind: value.kind, messageId: value.messageId,
      conversationId: value.conversationId, name: value.name, registeredAt: value.registeredAt,
      expiresAt: value.expiresAt, contentRead: value.contentRead === true, state: value.contentRead === true ? 'expanded' : 'registered',
      bytesRead: value.bytesRead === true, readingAvailable,
      interpretation: value.kind === 'video' ? 'sampled-video-frames-not-complete-video' : value.kind === 'image' ? 'requires-current-model-image-input' : value.kind === 'audio' ? 'requires-transcriber' : 'text-content',
      missingReasons: readingAvailable ? [] : [value.kind === 'video' ? !videoEnabled ? 'native_video_observation_disabled' : 'native_video_observer_not_connected' : value.kind === 'audio' ? 'native_media_transcriber_not_connected' : 'native_media_reader_not_connected'] });
  }
  async function readContent(assetId: string, value: JsonObject, request: { readonly conversationId: string; readonly signal: AbortSignal }, maxImageBytes = FRAMEWORK_MEDIA_IMAGE_BYTES, purpose: 'tool' | 'prompt' = 'tool'): Promise<JsonObject> {
    const kind = value.kind;
    assert(kind === 'image' || kind === 'audio' || kind === 'file', 'NATIVE_MEDIA_READER_UNAVAILABLE', 'This media kind has no content reader.');
    const unavailable = (reason: string): JsonObject => ({ schema: FRAMEWORK_MEDIA_PROTOCOL, contentRead: false, kind, reason });
    if (!options.contentReader) return unavailable('native_media_reader_not_connected');
    if (kind === 'audio' && !options.transcriber) return unavailable('native_media_transcriber_not_connected');
    const source = object(value.source);
    const result = await options.contentReader.read({ kind, conversationId: request.conversationId, source: {
      ...(typeof source.url === 'string' ? { url: source.url } : {}),
      ...(typeof source.file === 'string' ? { file: source.file } : {}), ...(typeof source.id === 'string' ? { id: source.id } : {}),
      ...(typeof source.busId === 'number' ? { busId: source.busId } : {}), ...(typeof source.fileHash === 'string' ? { fileHash: source.fileHash } : {}) }, signal: request.signal });
    await options.authorize(request.conversationId, request.signal);
    read(assetId, request.conversationId);
    if (result.status !== 'confirmed') {
      const rawCode = result.code.toLowerCase();
      const code = result.status === 'unknown' && !rawCode.endsWith('_unknown') ? `${rawCode.slice(0, 71)}_unknown` : rawCode;
      return unavailable(/^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : result.status === 'unknown' ? 'native_media_read_unknown' : 'native_media_read_rejected');
    }
    if (kind !== 'image' && result.data.byteLength > 1024 * 1024) return unavailable('native_media_too_large');
    let envelope: JsonObject;
    let imageData: Uint8Array | undefined;
    if (kind === 'image') {
      const mediaType = imageType(result.data);
      if (!mediaType) return unavailable('unsupported_image_format');
      // Prompt attachments have a single-image contract. Leave GIFs as scoped handles for the multi-image tool instead.
      if (mediaType === 'image/gif' && purpose === 'prompt') {
        request.signal.throwIfAborted();
        read(assetId, request.conversationId);
        const current = options.store.read(namespace, assetId)!;
        options.store.write(namespace, assetId, { ...object(current.value), bytesRead: true },
          { expectedRevision: current.revision, expiresAt: Number(value.expiresAt) });
        return unavailable('gif_requires_media_read');
      }
      const observed = mediaType === 'image/gif' ? await observeGif({ data: result.data, signal: request.signal, version: await options.observationVersion?.(request.signal) ?? 'v1' }) : null;
      request.signal.throwIfAborted();
      if (observed?.status === 'rejected') return unavailable(observed.code);
      if (observed?.status === 'animated') {
        envelope = { schema: FRAMEWORK_MEDIA_PROTOCOL, contentRead: true, kind: 'animation', durationSeconds: observed.durationSeconds,
          frameCount: observed.frameCount, loopCount: observed.loopCount, coverage: 'sampled-frames-only',
          frames: observed.frames.map(frame => ({ timeSeconds: frame.timeSeconds, ...(frame.grid ? { grid: json(frame.grid) } : {}), mediaType: frame.mediaType, data: Buffer.from(frame.data).toString('base64') })) };
        assert(parseNativeMediaReadEnvelope(envelope) && observed.frames.every(frame => imageType(frame.data) === 'image/jpeg'),
          'INVALID_NATIVE_GIF_OBSERVATION', 'The GIF observer returned invalid or excessive sampled frames.');
      } else {
        const prepared = await normalizeModelImage({ data: result.data, mediaType, maxBytes: maxImageBytes, signal: request.signal });
        if (prepared.status !== 'confirmed') return unavailable(prepared.code);
        imageData = prepared.data;
        envelope = { schema: FRAMEWORK_MEDIA_PROTOCOL, contentRead: true, kind: 'image', mediaType: prepared.mediaType,
          data: Buffer.from(prepared.data).toString('base64') };
      }
    } else {
      let text: string;
      if (kind === 'audio') text = (await options.transcriber!.transcribe({ assetId, conversationId: request.conversationId,
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
    await options.authorize(request.conversationId, request.signal);
    request.signal.throwIfAborted(); read(assetId, request.conversationId);
    if (imageData) imageReferences.rememberImage(assetId, request.conversationId, imageData);
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
    return metadata(read(request.input.assetId, request.scope.conversationId), request.signal);
  }
  async function readVideo(request: EffectRequest, assetId: string, value: JsonObject): Promise<JsonObject> {
    const unavailable = (reason: string): JsonObject => ({ schema: FRAMEWORK_MEDIA_PROTOCOL, contentRead: false, kind: 'video', reason });
    if (await options.observeVideo?.(request.signal) !== true) return unavailable('native_video_observation_disabled');
    if (!options.videoObserver || !options.contentReader) return unavailable('native_video_observer_not_connected');
    const version = await options.observationVersion?.(request.signal) ?? 'v1';
    return withDeadline({ signal: request.signal, timeoutMs: version === 'v2' ? 40_000 : 25_000, code: 'NATIVE_VIDEO_READ_TIMEOUT', run: async signal => {
      const allowed = async () => {
        await options.authorize(request.scope.conversationId, signal); signal.throwIfAborted(); read(assetId, request.scope.conversationId);
        return await options.observeVideo?.(signal) === true;
      };
      if (!await allowed()) return unavailable('native_video_observation_disabled');
      const source = object(value.source);
      const result = await options.contentReader!.read({ kind: 'video', conversationId: request.scope.conversationId,
        source: { ...(typeof source.url === 'string' ? { url: source.url } : {}), ...(typeof source.file === 'string' ? { file: source.file } : {}),
          ...(typeof source.id === 'string' ? { id: source.id } : {}), ...(typeof source.busId === 'number' ? { busId: source.busId } : {}),
          ...(typeof source.fileHash === 'string' ? { fileHash: source.fileHash } : {}) }, signal });
      if (!await allowed()) return unavailable('native_video_observation_disabled');
      if (result.status !== 'confirmed') {
        const raw = result.code.toLowerCase();
        const reason = result.status === 'unknown' && !raw.endsWith('_unknown') ? `${raw.slice(0, 71)}_unknown` : raw;
        return unavailable(/^[a-z][a-z0-9_]{0,79}$/.test(reason) ? reason : 'native_video_read_rejected');
      }
      if (result.data.byteLength < 1 || result.data.byteLength > 64 * 1024 * 1024) return unavailable('native_video_size_limit');
      const observed = await options.videoObserver!.observe({ data: result.data, signal, version });
      if (!await allowed()) return unavailable('native_video_observation_disabled');
      const envelope: JsonObject = { schema: FRAMEWORK_MEDIA_PROTOCOL, contentRead: true, kind: 'video', durationSeconds: observed.durationSeconds,
        frames: observed.frames.map(frame => ({ timeSeconds: frame.timeSeconds, ...(frame.grid ? { grid: json(frame.grid) } : {}), mediaType: frame.mediaType, data: Buffer.from(frame.data).toString('base64') })),
        audioObserved: observed.audioObserved, hasAudio: observed.hasAudio, coverage: 'sampled-frames-only' };
      assert(parseNativeMediaReadEnvelope(envelope) && observed.frames.every(frame => imageType(frame.data) === 'image/jpeg'),
        'INVALID_NATIVE_VIDEO_OBSERVATION', 'The video observer returned invalid or excessive sampled frames.');
      if (!await allowed()) return unavailable('native_video_observation_disabled');
      const current = options.store.read(namespace, assetId)!;
      options.store.write(namespace, assetId, { ...object(current.value), bytesRead: true, contentRead: true },
        { expectedRevision: current.revision, expiresAt: Number(value.expiresAt) });
      return envelope;
    } });
  }
  async function readRegistered(request: EffectRequest, assetId: string, value: JsonObject): Promise<JsonObject> {
      if (value.kind === 'video') return readVideo(request, assetId, value);
      if (value.kind !== 'forward') return readContent(assetId, value, { conversationId: request.scope.conversationId, signal: request.signal });
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
    readImage: imageReferences.readImage,
    async register(asset: OneBotIncomingAsset, signal: AbortSignal): Promise<string> {
      signal.throwIfAborted();
      assert(reference(asset.messageId) && reference(asset.conversationId)
        && ['image', 'audio', 'file', 'video', 'forward'].includes(asset.kind)
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
    async readForPrompt(request: { readonly assetId: string; readonly conversationId: string; readonly signal: AbortSignal }) {
      await options.authorize(request.conversationId, request.signal);
      request.signal.throwIfAborted();
      const value = read(request.assetId, request.conversationId);
      assert(value.kind === 'image', 'NATIVE_MEDIA_UNAVAILABLE', 'Only registered images can be attached to a prompt.');
      const result = await readContent(request.assetId, value, request, 160 * 1024, 'prompt');
      // Skipping inline GIFs is not a failed read and must not overwrite an earlier tool observation.
      if (result.contentRead === false && result.reason === 'gif_requires_media_read') return null;
      const code = mediaObservationCode(result.reason);
      try { recordNativeMediaRead(options.store, request.assetId, request.conversationId, {
        at: clock(), status: result.contentRead === true ? 'confirmed' : code?.endsWith('_unknown') ? 'unknown' : 'rejected', code }); } catch {}
      if (result.contentRead !== true || typeof result.data !== 'string') return null;
      return { mediaType: result.mediaType as FrameworkImageMediaType, data: result.data };
    },
    async resolveOutgoing(request: OneBotAssetResolutionRequest) {
      await options.authorize(request.conversationId, request.signal)
      const value = read(request.assetId, request.conversationId)
      assert((value.kind === request.type || value.kind === 'video' && request.type === 'file') && options.contentReader, 'NATIVE_MEDIA_UNAVAILABLE', 'The outgoing resource has no current scoped reader.')
      const source = object(value.source)
      const result = await options.contentReader.read({ kind: request.type, conversationId: request.conversationId, source: {
        ...(typeof source.url === 'string' ? { url: source.url } : {}),
        ...(typeof source.file === 'string' ? { file: source.file } : {}), ...(typeof source.id === 'string' ? { id: source.id } : {}),
        ...(typeof source.busId === 'number' ? { busId: source.busId } : {}), ...(typeof source.fileHash === 'string' ? { fileHash: source.fileHash } : {}) }, signal: request.signal })
      await options.authorize(request.conversationId, request.signal)
      request.signal.throwIfAborted(); read(request.assetId, request.conversationId)
      assert(result.status === 'confirmed' && result.data.byteLength > 0 && result.data.byteLength <= 8 * 1024 * 1024,
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
        const status = result.contentRead === true ? 'confirmed' : result.state === 'unknown' || code?.endsWith('_unknown') ? 'unknown' : 'rejected';
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
