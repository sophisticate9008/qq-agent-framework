import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, link, mkdtemp, readdir, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNativeAppearanceService } from '../src/host/native-appearance.ts';
import { createNativeAppearanceRoutes } from '../src/admin/native-appearance.ts';
import { createAdminServer } from '../src/admin/server.ts';
import { inspectAppearanceImage } from '../src/host/native-appearance-image.ts';
import { parseNativeAppearancePreview, parseNativeAppearanceRequest, parseNativeAppearanceSnapshot } from '../src/contracts/native-appearance.ts';
import { parseNativeMediaReadEnvelope } from '../src/contracts/framework-media.ts';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHd8AAAAASUVORK5CYII=';
const signal = () => new AbortController().signal;
const upload = { action: 'upload' as const, name: '测试角色参考', description: '手工图像资料，不是人设身份', mediaType: 'image/png' as const, data: png };
async function personas(directory: string): Promise<void> {
  await writeFile(join(directory, 'chat-personas.json'), JSON.stringify({ schema: 1, personas: [{ id: 'persona-a', name: '角色A', identity: '测试身份', style: '测试表达' }, { id: 'persona-b', name: '角色B', identity: '测试身份', style: '测试表达' }] }), { mode: 0o600 });
}

test('appearance empty reads and previews never create storage, and configuration rejects arbitrary paths and non-images', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'appearance-read-')); context.after(() => rm(directory, { recursive: true, force: true }));
  const service = createNativeAppearanceService({ directory: join(directory, 'not-created') });
  assert.equal((await service.snapshot()).assets.length, 0); assert.equal(await service.context('persona-a'), null);
  assert.deepEqual(await readdir(directory), []);
  assert.equal(parseNativeAppearanceRequest({ ...upload, revision: 'a'.repeat(64), filename: '/tmp/file' }), null);
  assert.equal(parseNativeAppearanceRequest({ ...upload, revision: 'a'.repeat(64), mediaType: 'image/svg+xml' }), null);
  assert.equal(inspectAppearanceImage(Buffer.from('<svg onload="alert(1)"/>')), null);
  const oversized = Buffer.from(png, 'base64'); oversized.writeUInt32BE(100_000, 16); assert.equal(inspectAppearanceImage(oversized), null);
  await assert.rejects(service.preview('11111111-1111-4111-8111-111111111111', 1, signal()));
  assert.deepEqual(await readdir(directory), []);
});

test('appearance versions persist independently and explicit exact-version binding controls actual image reads', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'appearance-domain-')); context.after(() => rm(directory, { recursive: true, force: true })); await personas(directory);
  const service = createNativeAppearanceService({ directory, now: () => 100 });
  const initial = await service.snapshot();
  const first = await service.execute({ ...upload, revision: initial.revision }, signal()); const asset = first.assets[0]; assert(asset);
  const preview = await service.preview(asset.id, 1, signal()); assert(parseNativeAppearancePreview(preview)); assert.equal(preview.image.data, png);
  assert.equal(preview.image.width, 1); assert.equal(preview.image.height, 1); assert.equal(preview.image.bytes, Buffer.from(png, 'base64').length);
  assert.equal(JSON.stringify(preview).includes(directory), false);
  const binding = await service.execute({ action: 'bind', revision: first.revision, personaId: 'persona-a', assetId: asset.id, version: 1 }, signal());
  const active = await service.context('persona-a'); assert(active); assert.equal(active.source, 'manual-upload'); assert.equal(active.bindingGeneration, 1);
  assert.equal(parseNativeMediaReadEnvelope(await service.read({ personaId: 'persona-a', assetId: asset.id, version: 1, signal: signal() }))?.contentRead, true);
  await assert.rejects(service.read({ personaId: 'persona-b', assetId: asset.id, version: 1, signal: signal() }), { code: 'APPEARANCE_BINDING_MISMATCH' });
  const second = await service.execute({ ...upload, revision: binding.revision, assetId: asset.id, description: '第二版图像说明' }, signal());
  assert.equal(second.assets[0]?.versions.length, 2); assert.equal((await service.context('persona-a'))?.version, 1);
  const changed = await service.execute({ action: 'bind', revision: second.revision, personaId: 'persona-a', assetId: asset.id, version: 2 }, signal());
  assert.equal((await service.context('persona-a'))?.bindingGeneration, 2);
  await assert.rejects(service.read({ personaId: 'persona-a', assetId: asset.id, version: 1, signal: signal() }), { code: 'APPEARANCE_BINDING_MISMATCH' });
  await assert.rejects(service.execute({ action: 'remove', revision: changed.revision, assetId: asset.id }, signal()), { code: 'APPEARANCE_IN_USE' });
  const released = await service.execute({ action: 'unbind', revision: changed.revision, personaId: 'persona-a' }, signal());
  assert.equal(released.bindings[0]?.generation, 3); assert.equal(await service.context('persona-a'), null);
  const removed = await service.execute({ action: 'remove', revision: released.revision, assetId: asset.id }, signal()); assert.equal(removed.assets.length, 0);
  assert.deepEqual(await readdir(join(directory, 'appearance-blobs')), []);
  const recreated = createNativeAppearanceService({ directory }); assert.deepEqual(await recreated.snapshot(), removed);
  assert.equal((await stat(join(directory, 'chat-appearance.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, 'appearance-blobs'))).mode & 0o777, 0o700);
});

test('appearance CAS conflicts, image corruption, unsafe files and aborted reads never release image bytes', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'appearance-private-')); context.after(() => rm(directory, { recursive: true, force: true })); await personas(directory);
  const service = createNativeAppearanceService({ directory }); const initial = await service.snapshot();
  const saved = await service.execute({ ...upload, revision: initial.revision }, signal()); const asset = saved.assets[0]; assert(asset);
  await assert.rejects(service.execute({ ...upload, revision: initial.revision }, signal()), /chat_revision_conflict/);
  await assert.rejects(service.execute({ ...upload, data: Buffer.from('<svg/>').toString('base64'), revision: saved.revision }, signal()), { code: 'APPEARANCE_IMAGE_INVALID' });
  const bound = await service.execute({ action: 'bind', revision: saved.revision, personaId: 'persona-a', assetId: asset.id, version: 1 }, signal()); assert(parseNativeAppearanceSnapshot(bound));
  const path = join(directory, 'appearance-blobs', `${asset.id}-v1-${asset.versions[0]?.sha256}.image`); const original = await readFile(path);
  const aborted = new AbortController(); aborted.abort(); await assert.rejects(service.read({ personaId: 'persona-a', assetId: asset.id, version: 1, signal: aborted.signal }), { name: 'AbortError' });
  await chmod(path, 0o644); await assert.rejects(service.preview(asset.id, 1, signal())); await chmod(path, 0o600);
  await link(path, `${path}.linked`); await assert.rejects(service.preview(asset.id, 1, signal())); await unlink(`${path}.linked`);
  const tampered = Buffer.from(original); tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1; await writeFile(path, tampered);
  await assert.rejects(service.preview(asset.id, 1, signal())); await unlink(path);
  const outside = join(directory, 'outside.png'); await writeFile(outside, original, { mode: 0o600 }); await symlink(outside, path); await assert.rejects(service.preview(asset.id, 1, signal()));
});

test('appearance management HTTP uploads and previews actual bounded bytes without modifying identity or exposing paths', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'appearance-http-')); context.after(() => rm(directory, { recursive: true, force: true })); await personas(directory);
  const originalPersonas = await readFile(join(directory, 'chat-personas.json'), 'utf8');
  const server = createAdminServer({ token: 'appearance-fixture-token-1234567890', snapshot: () => ({}), routes: createNativeAppearanceRoutes({ directory }) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); context.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert(address && typeof address !== 'string'); const origin = `http://127.0.0.1:${address.port}`;
  const headers = { origin, authorization: 'Bearer appearance-fixture-token-1234567890', 'content-type': 'application/json' };
  const initial = parseNativeAppearanceSnapshot(await (await fetch(`${origin}/api/chat/appearance`, { headers })).json()); assert(initial);
  const response = await fetch(`${origin}/api/chat/appearance`, { method: 'POST', headers, body: JSON.stringify({ ...upload, revision: initial.revision }) }); assert.equal(response.status, 200);
  const saved = parseNativeAppearanceSnapshot(await response.json()); assert(saved?.assets[0]);
  const preview = await fetch(`${origin}/api/chat/appearance?assetId=${saved.assets[0].id}&version=1&preview=1`, { headers }); assert.equal(preview.status, 200);
  const body: unknown = await preview.json(); assert.equal(parseNativeAppearancePreview(body)?.image.data, png); assert.equal(JSON.stringify(body).includes(directory), false);
  assert.equal((await fetch(`${origin}/api/chat/appearance?preview=1&assetId=../../secret&version=1`, { headers })).status, 400);
  assert.equal(await readFile(join(directory, 'chat-personas.json'), 'utf8'), originalPersonas);
});
