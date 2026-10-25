import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DshWorkAddress, DshWorkMediaReference } from '../contracts/dsh-work.ts';
import type { MessageContent } from '../contracts/messages.ts';
import type { OneBotAssetResolutionRequest } from '../adapters/onebot.ts';
import type { DshWorkPort } from '../adapters/dsh-work.ts';
import { assert } from '../core/values.ts';
import { ensurePrivateDirectory } from '../storage/private-json.ts';
import type { DurableStore } from './types.ts';
import { digest, json, object } from './data.ts';

/** SDK attachments are a distinct source; their opaque IDs never become protocol paths. */
export function createNativeWorkAssets(options: {
  readonly directory: string; readonly store: DurableStore; readonly accountId: string;
  readonly port: DshWorkPort;
  readonly parent: (sessionId: string) => { conversationId: string; generation: number } | null;
  readonly authorize: (conversationId: string, signal: AbortSignal) => Promise<void>;
}) {
  const directory = join(options.directory, 'work-assets');
  const namespace = 'native-work.assets';
  let tail: Promise<unknown> = Promise.resolve();
  async function bytes(filename: string, size: number, hash: string): Promise<Buffer> {
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      assert(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600 && stat.size === size && size <= 8 * 1024 * 1024,
        'WORK_ASSET_INVALID', 'The registered attachment file is invalid.');
      const value = await handle.readFile();
      assert(createHash('sha256').update(value).digest('hex') === hash, 'WORK_ASSET_CHANGED', 'The registered attachment bytes changed.');
      return value;
    } finally { await handle.close(); }
  }
  function binding(address: DshWorkAddress) {
    const current = options.parent(address.parentSessionId);
    assert(current?.generation === address.generation, 'WORK_PARENT_UNAVAILABLE', 'The original work parent is no longer current.');
    return current;
  }
  return Object.freeze({
    register(request: { readonly address: DshWorkAddress; readonly asset: DshWorkMediaReference; readonly signal: AbortSignal }): Promise<MessageContent> {
      const operation = tail.catch(() => undefined).then(async () => {
        const { address, asset, signal } = request;
        const parent = binding(address);
        await options.authorize(parent.conversationId, signal);
        assert(options.port.readAsset, 'WORK_MEDIA_READER_UNAVAILABLE', 'The SDK attachment reader is unavailable.');
        const resolved = await options.port.readAsset({ ...address, attachmentId: asset.attachmentId, kind: asset.kind }, signal);
        signal.throwIfAborted(); binding(address);
        await options.authorize(parent.conversationId, signal);
        assert(digest(resolved.asset) === digest(asset) && resolved.data.byteLength === asset.bytes,
          'WORK_ASSET_CHANGED', 'The SDK attachment metadata changed.');
        const hash = createHash('sha256').update(resolved.data).digest('hex');
        const assetId = `work-asset-${digest([options.accountId, parent.conversationId, address.id, address.childId,
          address.parentSessionId, address.generation, asset, hash])}`;
        const filename = join(directory, assetId);
        const prior = options.store.read(namespace, assetId);
        if (!prior) {
          await ensurePrivateDirectory(directory);
          const files = await readdir(directory);
          assert(files.length < 256, 'WORK_ASSET_BACKPRESSURE', 'The work asset directory reached its file limit.');
          let total = 0;
          for (const file of files) {
            assert(/^work-asset-[a-f0-9]{64}$/.test(file), 'WORK_ASSET_DIRECTORY_INVALID', 'The work asset directory contains an unknown entry.');
            const stat = await lstat(join(directory, file));
            assert(stat.isFile() && !stat.isSymbolicLink(), 'WORK_ASSET_DIRECTORY_INVALID', 'The work asset directory contains an invalid entry.');
            total += stat.size;
          }
          assert(total + resolved.data.byteLength <= 64 * 1024 * 1024, 'WORK_ASSET_BACKPRESSURE', 'The work asset byte limit was reached.');
          const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { await handle.writeFile(resolved.data); await handle.sync(); } finally { await handle.close(); }
          signal.throwIfAborted(); binding(address);
          options.store.write(namespace, assetId, json({ schema: 1, assetId, accountId: options.accountId,
            conversationId: parent.conversationId, parentSessionId: address.parentSessionId, generation: address.generation,
            kind: asset.kind, name: asset.name ?? null, bytes: asset.bytes, hash, createdAt: Date.now(), expiresAt: Date.now() + 86400000 }), { expectedRevision: null });
        } else await bytes(filename, asset.bytes, hash);
        return asset.kind === 'file' ? { type: 'file' as const, assetId, name: asset.name! } : { type: 'image' as const, assetId };
      });
      tail = operation;
      return operation;
    },
    async resolve(request: OneBotAssetResolutionRequest) {
      assert(/^work-asset-[a-f0-9]{64}$/.test(request.assetId), 'WORK_ASSET_UNAVAILABLE', 'This is not a registered work asset.');
      await options.authorize(request.conversationId, request.signal);
      const record = options.store.read(namespace, request.assetId);
      assert(record, 'WORK_ASSET_UNAVAILABLE', 'The work asset is unavailable.');
      const value = object(record.value);
      const parent = typeof value.parentSessionId === 'string' ? options.parent(value.parentSessionId) : null;
      assert(value.schema === 1 && value.accountId === options.accountId && value.conversationId === request.conversationId
        && value.parentSessionId === request.sessionId && value.generation === request.generation && parent?.generation === request.generation
        && parent.conversationId === request.conversationId && value.kind === request.type && Number(value.expiresAt) > Date.now(),
      'WORK_ASSET_SCOPE_MISMATCH', 'The attachment belongs to a different or expired work scope.');
      const filename = join(directory, request.assetId);
      const data = await bytes(filename, Number(value.bytes), String(value.hash));
      await options.authorize(request.conversationId, request.signal);
      assert(options.parent(String(value.parentSessionId))?.generation === request.generation, 'WORK_PARENT_UNAVAILABLE', 'The parent changed during asset reading.');
      request.signal.throwIfAborted();
      return { file: `base64://${data.toString('base64')}` };
    }
  });
}
