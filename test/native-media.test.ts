import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeMediaRegistry } from '../src/host/native-media.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';
import { readNativeMediaDiagnostics } from '../src/host/native-media-diagnostics.ts';
import { parseNativeMediaDiagnostics } from '../src/contracts/native-media-diagnostics.ts';

const signal = new AbortController().signal;
const asset = { kind: 'image' as const, messageId: '123', conversationId: 'group:456',
  source: { url: 'https://media.example.test/private/image?token=untrusted-source' } };
const scope = { conversationId: 'group:456', featureId: 'fixture', eventId: '123', version: '1.0.0' };

test('incoming media registration is scoped, idempotent and does not expose or fetch source locations', async () => {
  const store = createSqliteStore({ filename: ':memory:' });
  let authorizations = 0;
  const registry = createNativeMediaRegistry({ store, accountId: '999',
    async authorize() { authorizations++; } });
  try {
    const assetId = await registry.register(asset, signal);
    assert.equal(await registry.register(asset, signal), assetId);
    const metadata = await registry.inspect.execute({ input: { assetId }, scope, signal });
    assert.equal(JSON.stringify(metadata).includes('untrusted-source'), false);
    assert.equal(JSON.stringify(metadata).includes('https://'), false);
    assert.equal((metadata as { contentRead: boolean }).contentRead, false);
    assert.equal(store.list('native-chat.media').length, 1);
    assert.equal(authorizations, 3);
    await assert.rejects(async () => registry.inspect.execute({ input: { assetId }, scope: { ...scope, conversationId: 'group:789' }, signal }),
      { code: 'NATIVE_MEDIA_UNAVAILABLE' });
    const otherAccount = createNativeMediaRegistry({ store, accountId: '998', async authorize() {} });
    await assert.rejects(async () => otherAccount.inspect.execute({ input: { assetId }, scope, signal }),
      { code: 'NATIVE_MEDIA_UNAVAILABLE' });
  } finally { store.close(); }
});

test('revoked access and expired registration cannot be inspected or silently reregistered', async () => {
  const store = createSqliteStore({ filename: ':memory:' });
  let now = Date.now();
  let allowed = true;
  const registry = createNativeMediaRegistry({ store, accountId: '999', clock: () => now,
    async authorize() { assert(allowed, 'Access was revoked'); } });
  try {
    const assetId = await registry.register(asset, signal);
    allowed = false;
    await assert.rejects(registry.register({ ...asset, messageId: '124' }, signal), /revoked/);
    await assert.rejects(async () => registry.inspect.execute({ input: { assetId }, scope, signal }), /revoked/);
    allowed = true; now += 24 * 60 * 60 * 1000;
    await assert.rejects(async () => registry.inspect.execute({ input: { assetId }, scope, signal }), { code: 'NATIVE_MEDIA_UNAVAILABLE' });
    await assert.rejects(registry.register(asset, signal), { code: 'NATIVE_MEDIA_UNAVAILABLE' });
  } finally { store.close(); }
});

test('media content reading uses registered protocol references, genuine image bytes, bounded UTF8 text and an explicit audio transcriber', async () => {
  const store = createSqliteStore({ filename: ':memory:' });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=', 'base64');
  let mode: 'image' | 'file' | 'binary' | 'large' = 'image';
  let reads = 0;
  let transcriptions = 0;
  let allowed = true;
  const contentReader = { async read(request: { source: { file?: string; id?: string } }) {
    reads++; assert.equal('url' in request.source, false);
    return { status: 'confirmed' as const, data: mode === 'image' ? png : mode === 'large' ? Buffer.alloc(500000)
      : mode === 'binary' ? Buffer.from([0, 255, 1]) : Buffer.from('准确的UTF8文件正文'), mediaType: mode === 'image' ? 'image/png' : 'text/plain' };
  } };
  const registry = createNativeMediaRegistry({ store, accountId: '999', contentReader, authorize: async () => { assert(allowed); } });
  try {
    const imageId = await registry.register({ ...asset, source: { file: 'opaque-image-id', url: 'http://127.0.0.1/never-directly-read' } }, signal);
    const image = await registry.read.execute({ input: { assetId: imageId }, scope, signal });
    assert.deepEqual(image, { schema: 'qq-agent-framework.media-read/1', contentRead: true, kind: 'image', mediaType: 'image/png', data: png.toString('base64') });
    const inspected = await registry.inspect.execute({ input: { assetId: imageId }, scope, signal });
    assert.equal((inspected as { contentRead: boolean }).contentRead, false, 'fetching image bytes does not claim model interpretation');
    assert.equal((inspected as { bytesRead: boolean }).bytesRead, true);
    const imageView = readNativeMediaDiagnostics(store, { conversationId: scope.conversationId, running: true, transcriber: false });
    assert(parseNativeMediaDiagnostics(imageView));
    assert.equal(imageView.items[0].contentRead, false); assert.equal(imageView.items[0].lastRead?.status, 'confirmed');
    assert(!JSON.stringify(imageView).includes('opaque-image-id'));
    mode = 'file';
    const fileId = await registry.register({ ...asset, kind: 'file', source: { id: 'opaque-file-id' } }, signal);
    assert.deepEqual(await registry.read.execute({ input: { assetId: fileId }, scope, signal }), {
      schema: 'qq-agent-framework.media-read/1', contentRead: true, kind: 'text', sourceKind: 'file', text: '准确的UTF8文件正文' });
    mode = 'binary';
    assert.equal((await registry.read.execute({ input: { assetId: fileId }, scope, signal }) as { contentRead: boolean }).contentRead, false);
    mode = 'large';
    assert.equal((await registry.read.execute({ input: { assetId: imageId }, scope, signal }) as { reason: string }).reason, 'image_too_large');
    const audioId = await registry.register({ ...asset, kind: 'audio', source: { file: 'opaque-audio-id' } }, signal);
    const before = reads;
    assert.equal((await registry.read.execute({ input: { assetId: audioId }, scope, signal }) as { contentRead: boolean }).contentRead, false);
    assert.equal(reads, before, 'no transcriber means no needless audio download');
    const beforeProjection = store.stats?.({ limit: 10 });
    const diagnostics = readNativeMediaDiagnostics(store, { conversationId: scope.conversationId, running: true, transcriber: false });
    assert.deepEqual(store.stats?.({ limit: 10 }), beforeProjection);
    assert(parseNativeMediaDiagnostics(diagnostics));
    assert.equal(diagnostics.items.find(item => item.assetId === audioId)?.lastRead?.code, 'native_media_transcriber_not_connected');
    assert.equal(diagnostics.items.find(item => item.assetId === fileId)?.lastRead?.status, 'rejected');
    assert.equal(readNativeMediaDiagnostics(store, { conversationId: 'group:789', running: true, transcriber: false }).items.length, 0);
    assert.equal(readNativeMediaDiagnostics(store, { conversationId: scope.conversationId, running: false, transcriber: false, limit: 1 }).coverage, 'partial');
    mode = 'file';
    const transcribing = createNativeMediaRegistry({ store, accountId: '999', contentReader, authorize: async () => { assert(allowed); },
      transcriber: { async transcribe(request) { transcriptions++; assert.equal(request.conversationId, scope.conversationId); return { text: '真实转录适配器返回的正文' }; } } });
    assert.deepEqual(await transcribing.read.execute({ input: { assetId: audioId }, scope, signal }), {
      schema: 'qq-agent-framework.media-read/1', contentRead: true, kind: 'text', sourceKind: 'audio', text: '真实转录适配器返回的正文' });
    assert.equal(transcriptions, 1);
    allowed = false;
    await assert.rejects(async () => transcribing.read.execute({ input: { assetId: audioId }, scope, signal }));
    assert.equal(transcriptions, 1);
  } finally { store.close(); }
});
