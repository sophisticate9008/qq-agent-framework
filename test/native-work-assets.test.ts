import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteStore } from '../src/storage/sqlite.ts';
import { createNativeWorkAssets } from '../src/host/native-work-assets.ts';
import type { DshWorkPort } from '../src/adapters/dsh-work.ts';
import type { DshWorkMediaReference } from '../src/contracts/dsh-work.ts';

test('SDK result assets survive registry reconstruction and remain bound to account, parent, generation and verified bytes', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'work-assets-'));
  const store = createSqliteStore({ filename: ':memory:' });
  context.after(async () => { store.close(); await rm(directory, { force: true, recursive: true }); });
  const data = Buffer.from('bounded file result');
  const asset: DshWorkMediaReference = { type: 'media-reference', kind: 'file', attachmentId: 'attachment', name: 'report.txt', bytes: data.length };
  const port: DshWorkPort = { async verify() { return true; }, async start() { throw new Error('unexpected'); },
    async inspect() { throw new Error('unexpected'); }, async interrupt() {}, async followup() { return { messageId: 'unused' }; },
    async readAsset() { return { asset, data }; } };
  let generation = 1;
  let allowed = true;
  const options = { directory, store, accountId: '999', port,
    parent: () => ({ conversationId: 'private:123', generation }),
    authorize: async () => { assert(allowed); } };
  const address = { issuerEpoch: 'epoch', id: 'work', childId: 'child', parentSessionId: 'parent', generation: 1 };
  const signal = new AbortController().signal;
  const registry = createNativeWorkAssets(options);
  const registered = await registry.register({ address, asset, signal });
  assert.equal(registered.type, 'file'); assert('assetId' in registered);
  const request = { assetId: registered.assetId, type: 'file' as const, conversationId: 'private:123', sessionId: 'parent', generation: 1, signal };
  const restored = createNativeWorkAssets(options);
  assert.deepEqual(await restored.resolve(request), { file: `base64://${data.toString('base64')}` });
  assert.deepEqual(await restored.register({ address, asset, signal }), registered);
  await assert.rejects(restored.resolve({ ...request, conversationId: 'group:456' }), { code: 'WORK_ASSET_SCOPE_MISMATCH' });
  await assert.rejects(createNativeWorkAssets({ ...options, accountId: '998' }).resolve(request), { code: 'WORK_ASSET_SCOPE_MISMATCH' });
  generation = 2;
  await assert.rejects(restored.resolve(request), { code: 'WORK_ASSET_SCOPE_MISMATCH' });
  generation = 1; allowed = false;
  await assert.rejects(restored.resolve(request));
  allowed = true;
  const filename = join(directory, 'work-assets', registered.assetId);
  await writeFile(filename, Buffer.alloc(data.length, 65), { mode: 0o600 });
  await assert.rejects(restored.resolve(request), { code: 'WORK_ASSET_CHANGED' });
  await unlink(filename);
  const target = join(directory, 'outside'); await writeFile(target, data, { mode: 0o600 });
  await symlink(target, filename);
  await assert.rejects(restored.resolve(request));
});
