import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import type { JsonObject } from '../src/core/types.ts';
import { createRenderedAssetPublisher, type RenderedAssetPublishRequest } from '../src/host/rendered-assets.ts';
import { createResourceRegistry } from '../src/host/resources.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

function chunk(type: string, data = Buffer.alloc(0)): Buffer {
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length);
  output.write(type, 4, 'ascii');
  data.copy(output, 8);
  output.writeUInt32BE(crc32(output.subarray(4, output.length - 4)), output.length - 4);
  return output;
}

function png(width = 1, height = 1, color = 255): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height, color);
  for (let row = 0; row < height; row++) pixels[row * (width * 4 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND')]);
}

function fixture(context: { after(callback: () => void): void }) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'rendered-assets-'));
  const directory = join(root, 'rendered');
  const store = createSqliteStore({ filename: ':memory:' });
  const registry = createResourceRegistry({ store, rootDirectory: root });
  context.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, directory, store, registry };
}

function request(overrides: Partial<RenderedAssetPublishRequest> = {}): RenderedAssetPublishRequest {
  return { png: png(), width: 1, height: 1, conversationId: 'group:100',
    scope: { persona: { id: 'document', version: '1.0.0' }, sessionId: 'session-one', generation: 1 },
    idempotencyKey: 'message-one:page-one', signal: new AbortController().signal, ...overrides };
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

test('publisher admission is bounded before it copies or queues more PNG work', async context => {
  const { directory, registry } = fixture(context);
  const publisher = createRenderedAssetPublisher({ directory, registry, maxPending: 1 });
  const first = publisher.publish(request());
  assert.equal(publisher.metrics().pending, 1);
  await assert.rejects(publisher.publish(request({ idempotencyKey: 'extra' })), { code: 'RENDERED_ASSET_BACKPRESSURE' });
  await first;
  assert.equal(publisher.metrics().pending, 0);
});

test('publishes complete private PNGs, approves exact conversation/persona versions, and reuses history across sessions', async context => {
  const { directory, registry } = fixture(context);
  const calls: string[] = [];
  const source = request();
  const publisher = createRenderedAssetPublisher({ directory, registry: { ...registry,
    register(input) {
      assert.equal(input.source.kind, 'file');
      if (input.source.kind === 'file') assert.deepEqual(readFileSync(input.source.path), source.png);
      calls.push('register');
      return registry.register(input);
    },
    approve(assetId) { calls.push('approve'); registry.approve(assetId); },
  } });
  const assetId = await publisher.publish(source);
  const selection = { assetId, type: 'image' as const, conversationId: source.conversationId,
    persona: 'document@1.0.0', expectedVersion: digest(source.png) };
  const filename = registry.resolve(selection);
  assert.equal(filename, join(directory, `${digest(source.png)}.png`));
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(filename).mode & 0o777, 0o600);
  assert.match(assetId, /^rendered-[a-f0-9]{64}$/);
  assert.deepEqual(calls, ['register', 'approve']);
  assert.equal(await publisher.publish(request({ scope: { persona: { id: 'document', version: '1.0.0' },
    sessionId: 'session-two', generation: 2 } })), assetId);
  assert.equal(await createRenderedAssetPublisher({ directory, registry }).publish(source), assetId);
  assert.deepEqual(calls, ['register', 'approve']);
  assert.equal(registry.resolve({ ...selection, sessionId: 'other-session', generation: 9 }), filename);
  for (const changes of [{ conversationId: 'group:other' }, { persona: 'document@2.0.0' }, { expectedVersion: 'other' }]) {
    assert.throws(() => registry.resolve({ ...selection, ...changes }), { code: 'RESOURCE_UNAVAILABLE' });
  }
  assert.equal(registry.list()[0].sessionId, null);
  assert.equal(registry.list()[0].generation, null);
  assert.equal(readdirSync(directory).length, 1);
});

test('copies caller bytes before async work and separates resource identities without duplicating identical files', async context => {
  const { directory, registry } = fixture(context);
  const publisher = createRenderedAssetPublisher({ directory, registry, maxFiles: 1 });
  const bytes = png();
  const original = Buffer.from(bytes);
  const first = publisher.publish(request({ png: bytes }));
  bytes.fill(0);
  const assetId = await first;
  assert.deepEqual(readFileSync(join(directory, `${digest(original)}.png`)), original);
  const same = await Promise.all([publisher.publish(request()), publisher.publish(request())]);
  assert.deepEqual(same, [assetId, assetId]);
  const otherPersona = await publisher.publish(request({ scope: { persona: { id: 'document', version: '2.0.0' } } }));
  const otherConversation = await publisher.publish(request({ conversationId: 'group:200' }));
  assert.notEqual(otherPersona, assetId);
  assert.notEqual(otherConversation, assetId);
  assert.equal(readdirSync(directory).length, 1);
  await assert.rejects(publisher.publish(request({ png: png(1, 1, 0) })), { code: 'RENDERED_ASSET_CONFLICT' });
});

test('rejects malformed PNGs, mismatched and excessive dimensions, and oversized inputs before registration', async context => {
  const { directory, registry } = fixture(context);
  const publisher = createRenderedAssetPublisher({ directory, registry, maxFileBytes: 1024 });
  const good = png();
  const badCrc = Buffer.from(good);
  badCrc[29] ^= 1;
  const duplicateHeader = Buffer.concat([good.subarray(0, 33), good.subarray(8)]);
  const truncatedChunk = Buffer.from(good);
  truncatedChunk.writeUInt32BE(0xffffffff, 33);
  for (const changes of [
    { png: new Uint8Array() }, { png: Buffer.from('not a png') }, { png: good.subarray(0, -12) },
    { png: Buffer.concat([good, Buffer.from([0])]) }, { png: badCrc }, { png: duplicateHeader },
    { png: truncatedChunk }, { width: 2 }, { height: 2 }, { width: 0 }, { height: 8193 },
    { width: 8192, height: 8192 }, { width: 1.5 }, { png: Buffer.alloc(1025) },
    { png: Buffer.concat([good.subarray(0, 33), chunk('IEND')]) },
  ]) {
    await assert.rejects(publisher.publish(request(changes)), { code: 'RENDERED_ASSET_INVALID' });
  }
  const tiny = createRenderedAssetPublisher({ directory, registry, maxFileBytes: good.length - 1 });
  await assert.rejects(tiny.publish(request()), { code: 'RENDERED_ASSET_INVALID' });
  assert.deepEqual(registry.list(), []);
  assert.deepEqual(readdirSync(directory), []);
});

test('validates scope and options without treating identifiers as paths or grants', async context => {
  const { directory, registry, root } = fixture(context);
  const publisher = createRenderedAssetPublisher({ directory, registry });
  for (const changes of [{ conversationId: 'global' }, { conversationId: '' }, { conversationId: 'room\nsecret' },
    { idempotencyKey: '' }, { scope: { persona: { id: 'name@other', version: '1' } } },
    { scope: { persona: { id: 'name', version: '1' }, generation: 2 } }]) {
    await assert.rejects(publisher.publish(request(changes)));
  }
  for (const options of [{ maxFiles: 0 }, { maxFiles: Infinity }, { maxFiles: 10_001 }, { maxFileBytes: 0 },
    { maxFileBytes: 64 * 1024 * 1024 + 1 }, { directory: 'relative' }, { directory: join(root, 'nested', '..', 'target') + '/..' }]) {
    assert.throws(() => createRenderedAssetPublisher({ directory, registry, ...options }), { code: 'RENDERED_ASSET_INVALID' });
  }
  const assetId = await publisher.publish(request({ idempotencyKey: '../../escape', conversationId: '../room' }));
  assert.match(assetId, /^rendered-[a-f0-9]{64}$/);
  assert.deepEqual(readdirSync(root), ['rendered']);
});

test('enforces file quota across concurrent publishers and counts pre-existing files', async context => {
  const { directory, registry } = fixture(context);
  const first = createRenderedAssetPublisher({ directory, registry, maxFiles: 1 });
  const second = createRenderedAssetPublisher({ directory, registry, maxFiles: 1 });
  const results = await Promise.allSettled([first.publish(request()), second.publish(request({
    idempotencyKey: 'different', png: png(1, 1, 0),
  }))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.equal(rejected?.status === 'rejected' ? rejected.reason.code : null, 'RENDERED_ASSET_LIMIT');
  assert.equal(readdirSync(directory).length, 1);
  const identical = await Promise.all([first.publish(request()), second.publish(request())]);
  assert.equal(identical[0], identical[1]);
  writeFileSync(join(directory, 'unmanaged-file'), 'occupied', { mode: 0o600 });
  await assert.rejects(first.publish(request()), { code: 'RENDERED_ASSET_LIMIT' });
});

test('pending, revoked, expired, and mismatched records cannot be approved or resurrected', async context => {
  const { directory, registry, store } = fixture(context);
  const publisher = createRenderedAssetPublisher({ directory, registry });
  const assetId = await publisher.publish(request());
  const record = store.read('resources', assetId)!;
  assert.equal(typeof record.value, 'object');
  const conflicts: JsonObject[] = [{ status: 'pending' }, { status: 'revoked' }, { persona: null }, { scope: 'global' },
    { version: 'wrong' }, { expiresAt: 1 }, { sessionId: 'session-one', generation: 1 }];
  for (const changes of conflicts) {
    const original = record.value as JsonObject;
    store.write('resources', assetId, { ...original, ...changes });
    await assert.rejects(publisher.publish(request()), { code: 'RENDERED_ASSET_CONFLICT' });
    const current = store.read('resources', assetId)!.value as JsonObject;
    for (const key of Object.keys(changes)) assert.equal(current[key], changes[key]);
  }
  assert.equal(readdirSync(directory).length, 1);
});

test('failure to register or approve never returns an unapproved asset and redacts paths', async context => {
  const { directory, registry } = fixture(context);
  const failedRegister = createRenderedAssetPublisher({ directory, registry: { ...registry,
    register() { throw new Error('/private/secret-path credential'); },
  } });
  await assert.rejects(failedRegister.publish(request()), error => {
    assert.doesNotMatch(String(error), /private|secret-path|credential/);
    return true;
  });
  assert.deepEqual(readdirSync(directory), []);
  const failedApprove = createRenderedAssetPublisher({ directory, registry: { ...registry,
    approve() { throw new Error('sensitive approval failure'); },
  } });
  await assert.rejects(failedApprove.publish(request()), { code: 'RENDERED_ASSET_FAILED' });
  const pending = registry.list()[0];
  assert.equal(pending.status, 'pending');
  assert.throws(() => registry.resolve({ assetId: String(pending.id), type: 'image', conversationId: 'group:100', persona: 'document@1.0.0' }),
    { code: 'RESOURCE_UNAVAILABLE' });
  await assert.rejects(createRenderedAssetPublisher({ directory, registry }).publish(request()), { code: 'RENDERED_ASSET_CONFLICT' });
});

test('registry root and file byte limits are mandatory even for trusted render output', async context => {
  const { root, registry, store } = fixture(context);
  const outside = mkdtempSync(join(realpathSync(tmpdir()), 'rendered-outside-'));
  context.after(() => rmSync(outside, { recursive: true, force: true }));
  const publisher = createRenderedAssetPublisher({ directory: outside, registry });
  await assert.rejects(publisher.publish(request()), { code: 'RESOURCE_SOURCE_DENIED' });
  assert.deepEqual(readdirSync(outside), []);
  assert.deepEqual(registry.list(), []);
  const smallerRegistry = createResourceRegistry({ store, rootDirectory: root, maxFileBytes: png().length - 1 });
  const oversized = createRenderedAssetPublisher({ directory: join(root, 'small'), registry: smallerRegistry });
  await assert.rejects(oversized.publish(request()), { code: 'RESOURCE_SOURCE_DENIED' });
  assert.deepEqual(smallerRegistry.list(), []);
});

test('cancellation before writing, during writing, after registration, and after approval never returns an asset', async context => {
  const { directory, registry } = fixture(context);
  const controller = new AbortController();
  const publisher = createRenderedAssetPublisher({ directory, registry });
  controller.abort(new Error('/private/cancellation-detail'));
  await assert.rejects(publisher.publish(request({ signal: controller.signal })), { code: 'RENDERED_ASSET_ABORTED' });
  const midWrite = new AbortController();
  const writing = publisher.publish(request({ signal: midWrite.signal }));
  midWrite.abort();
  await assert.rejects(writing, { code: 'RENDERED_ASSET_ABORTED' });
  assert.deepEqual(registry.list(), []);
  assert.deepEqual(readdirSync(directory), []);
  const afterRegister = new AbortController();
  const pendingPublisher = createRenderedAssetPublisher({ directory, registry: { ...registry,
    register(input) { const id = registry.register(input); afterRegister.abort(); return id; },
    approve() { assert.fail('Cancelled publication must not approve'); },
  } });
  await assert.rejects(pendingPublisher.publish(request({ signal: afterRegister.signal })), { code: 'RENDERED_ASSET_ABORTED' });
  assert.equal(registry.list()[0].status, 'pending');
  const afterApprove = new AbortController();
  const revokedPublisher = createRenderedAssetPublisher({ directory, registry: { ...registry,
    approve(assetId) { registry.approve(assetId); afterApprove.abort(); },
  } });
  await assert.rejects(revokedPublisher.publish(request({ idempotencyKey: 'after-approve', signal: afterApprove.signal })),
    { code: 'RENDERED_ASSET_ABORTED' });
  assert.deepEqual(registry.list().map(resource => resource.status).sort(), ['pending', 'revoked']);
});

test('rejects directory symlinks, replacement directories, file symlinks, hardlinks, corruption, and unsafe modes', async context => {
  const { root, directory, registry } = fixture(context);
  const target = join(root, 'target');
  mkdirSync(target);
  const alias = join(root, 'alias');
  symlinkSync(target, alias);
  assert.throws(() => createRenderedAssetPublisher({ directory: alias, registry }), { code: 'RENDERED_ASSET_DIRECTORY' });
  assert.throws(() => createRenderedAssetPublisher({ directory: join(alias, 'nested'), registry }), { code: 'RENDERED_ASSET_DIRECTORY' });
  assert.deepEqual(readdirSync(target), []);
  const publisher = createRenderedAssetPublisher({ directory, registry });
  const filename = join(directory, `${digest(png())}.png`);
  const outside = join(root, 'outside.png');
  writeFileSync(outside, png(), { mode: 0o600 });
  symlinkSync(outside, filename);
  await assert.rejects(publisher.publish(request()), { code: 'RENDERED_ASSET_FILE' });
  unlinkSync(filename);
  linkSync(outside, filename);
  await assert.rejects(publisher.publish(request()), { code: 'RENDERED_ASSET_FILE' });
  unlinkSync(filename);
  writeFileSync(filename, png(1, 1, 0), { mode: 0o600 });
  await assert.rejects(publisher.publish(request()), { code: 'RENDERED_ASSET_FILE' });
  assert.deepEqual(readFileSync(filename), png(1, 1, 0));
  writeFileSync(filename, png());
  chmodSync(filename, 0o644);
  await assert.rejects(publisher.publish(request()), { code: 'RENDERED_ASSET_FILE' });
  assert.deepEqual(registry.list(), []);
  renameSync(directory, join(root, 'old-directory'));
  mkdirSync(directory);
  await assert.rejects(publisher.publish(request()), { code: 'RENDERED_ASSET_DIRECTORY' });
  rmSync(directory, { recursive: true });
  symlinkSync(target, directory);
  await assert.rejects(publisher.publish(request()), { code: 'RENDERED_ASSET_DIRECTORY' });
  assert.deepEqual(readdirSync(target), []);
  assert.deepEqual(readFileSync(outside), png());
});

test('directory replacement during async writing cannot redirect output outside the pinned directory', async context => {
  const { root, directory, registry } = fixture(context);
  const publisher = createRenderedAssetPublisher({ directory, registry });
  const target = join(root, 'replacement-target');
  const original = join(root, 'original-directory');
  mkdirSync(target);
  const publishing = publisher.publish(request());
  renameSync(directory, original);
  symlinkSync(target, directory);
  await assert.rejects(publishing, { code: 'RENDERED_ASSET_DIRECTORY' });
  assert.deepEqual(readdirSync(target), []);
  assert.deepEqual(readdirSync(original), []);
  assert.deepEqual(registry.list(), []);
});

test('missing approved files and stale directory locks fail closed without rewriting or approving', async context => {
  const { directory, registry } = fixture(context);
  const publisher = createRenderedAssetPublisher({ directory, registry });
  const assetId = await publisher.publish(request());
  unlinkSync(join(directory, `${digest(png())}.png`));
  await assert.rejects(publisher.publish(request()), { code: 'RENDERED_ASSET_CONFLICT' });
  writeFileSync(join(directory, '.rendered-assets.lock'), 'operator recovery required', { mode: 0o600 });
  await assert.rejects(publisher.publish(request({ idempotencyKey: 'new-request' })), { code: 'RENDERED_ASSET_BUSY' });
  assert.equal(readFileSync(join(directory, '.rendered-assets.lock'), 'utf8'), 'operator recovery required');
  assert.equal(registry.list().find(resource => resource.id === assetId)?.status, 'approved');
});
