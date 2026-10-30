import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, lstat, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { DshWorkAddress, DshWorkMediaReference } from '../contracts/dsh-work.ts';
import type { MessageContent } from '../contracts/messages.ts';
import type { OneBotAssetResolutionRequest } from '../adapters/onebot.ts';
import type { DshWorkPort } from '../adapters/dsh-work.ts';
import { assert, errorCode } from '../core/values.ts';
import { ensurePrivateDirectory } from '../storage/private-json.ts';
import type { DurableStore } from './types.ts';
import { digest, json, object } from './data.ts';

/** SDK attachments are a distinct source; their opaque IDs never become protocol paths. */
export function createNativeWorkAssets(options: {
  readonly directory: string; readonly store: DurableStore; readonly accountId: string;
  readonly port: DshWorkPort;
  readonly clock?: () => number;
  readonly signal?: AbortSignal;
  readonly onMaintenanceFault?: (code: string) => void;
  readonly parent: (sessionId: string) => { conversationId: string; generation: number } | null;
  readonly authorize: (conversationId: string, signal: AbortSignal) => Promise<void>;
}) {
  const directory = join(options.directory, 'work-assets');
  const namespace = 'native-work.assets';
  let tail: Promise<unknown> = Promise.resolve();
  const clock = options.clock ?? Date.now;
  const ttl = 86400000;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const operation = tail.catch(() => undefined).then(() => {
      assert(!closed && !options.signal?.aborted, 'WORK_ASSET_CLOSED', 'Work attachment storage is closed.');
      return run();
    });
    tail = operation; return operation;
  }
  async function capacity(additionalBytes = 0) {
    await ensurePrivateDirectory(directory);
    assert(await realpath(directory) === directory, 'WORK_ASSET_DIRECTORY_INVALID', 'A canonical private work asset directory is required.');
    const files = await readdir(directory);
    assert(files.length <= 1024, 'WORK_ASSET_BACKPRESSURE', 'The work asset directory exceeds its maintenance bound.');
    let count = 0; let total = 0;
    for (const [index, name] of files.entries()) {
      if (index > 0 && index % 32 === 0) await new Promise(resolve => setTimeout(resolve, 10));
      assert(/^work-asset-[a-f0-9]{64}$/.test(name), 'WORK_ASSET_DIRECTORY_INVALID', 'The work asset directory contains an unknown entry.');
      const filename = join(directory, name);
      const info = await lstat(filename);
      assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && (info.mode & 0o777) === 0o600,
        'WORK_ASSET_DIRECTORY_INVALID', 'The work asset directory contains an invalid file.');
      const row = options.store.read(namespace, name);
      const value = row ? object(row.value) : null;
      if (value) assert(value.accountId === options.accountId && value.assetId === name && Number.isSafeInteger(value.expiresAt),
        'WORK_ASSET_DIRECTORY_INVALID', 'The work asset metadata is invalid.');
      const expired = value ? Number(value.expiresAt) <= clock() : info.mtimeMs + ttl <= clock();
      if (expired) {
        await unlink(filename);
        // Retain the identity beyond byte expiry, including legacy rows without a store TTL.
        if (row && value && row.expiresAt === null) options.store.write(namespace, name, row.value,
          { expectedRevision: row.revision, expiresAt: Number(value.expiresAt) + 6 * ttl });
      } else { count++; total += info.size; }
    }
    assert(count + (additionalBytes > 0 ? 1 : 0) <= 512 && total + additionalBytes <= 128 * 1024 * 1024,
      'WORK_ASSET_BACKPRESSURE', 'The work asset count or byte limit was reached.');
  }
  const maintenance = () => enqueue(() => capacity());
  function schedule(delay: number) {
    if (closed || options.signal?.aborted) return;
    timer = setTimeout(() => { void maintenance().catch(error => {
      try { options.onMaintenanceFault?.(errorCode(error, 'WORK_ASSET_MAINTENANCE_FAILED')); } catch {}
    }).finally(() => schedule(60 * 60 * 1000)); }, delay);
    timer.unref();
  }
  options.signal?.addEventListener('abort', stopTimer, { once: true });
  function stopTimer() { clearTimeout(timer); }
  schedule(5000);
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
    maintenance,
    async close() { closed = true; stopTimer(); options.signal?.removeEventListener('abort', stopTimer); await Promise.allSettled([tail]); },
    register(request: { readonly address: DshWorkAddress; readonly asset: DshWorkMediaReference; readonly signal: AbortSignal }): Promise<MessageContent> {
      const operation = enqueue(async () => {
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
          await capacity(resolved.data.byteLength);
          const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { await handle.writeFile(resolved.data); await handle.sync(); } finally { await handle.close(); }
          signal.throwIfAborted(); binding(address);
          options.store.write(namespace, assetId, json({ schema: 1, assetId, accountId: options.accountId,
            conversationId: parent.conversationId, parentSessionId: address.parentSessionId, generation: address.generation,
            kind: asset.kind, name: asset.name ?? null, bytes: asset.bytes, hash, createdAt: clock(), expiresAt: clock() + ttl }), { expectedRevision: null, expiresAt: clock() + 7 * ttl });
        } else {
          assert(Number(object(prior.value).expiresAt) > clock(), 'WORK_ASSET_EXPIRED', 'The work attachment has expired.');
          await bytes(filename, asset.bytes, hash);
        }
        return asset.kind === 'file' ? { type: 'file' as const, assetId, name: asset.name! } : { type: 'image' as const, assetId };
      });
      tail = operation;
      return operation;
    },
    resolve(request: OneBotAssetResolutionRequest) { return enqueue(async () => {
      assert(/^work-asset-[a-f0-9]{64}$/.test(request.assetId), 'WORK_ASSET_UNAVAILABLE', 'This is not a registered work asset.');
      await options.authorize(request.conversationId, request.signal);
      const record = options.store.read(namespace, request.assetId);
      assert(record, 'WORK_ASSET_UNAVAILABLE', 'The work asset is unavailable.');
      const value = object(record.value);
      const parent = typeof value.parentSessionId === 'string' ? options.parent(value.parentSessionId) : null;
      assert(value.schema === 1 && value.accountId === options.accountId && value.conversationId === request.conversationId
        && value.parentSessionId === request.sessionId && value.generation === request.generation && parent?.generation === request.generation
        && parent.conversationId === request.conversationId && value.kind === request.type && Number(value.expiresAt) > clock(),
      'WORK_ASSET_SCOPE_MISMATCH', 'The attachment belongs to a different or expired work scope.');
      const filename = join(directory, request.assetId);
      const data = await bytes(filename, Number(value.bytes), String(value.hash));
      await options.authorize(request.conversationId, request.signal);
      assert(options.parent(String(value.parentSessionId))?.generation === request.generation, 'WORK_PARENT_UNAVAILABLE', 'The parent changed during asset reading.');
      request.signal.throwIfAborted();
      assert(Number(value.expiresAt) > clock(), 'WORK_ASSET_EXPIRED', 'The work attachment expired during reading.');
      return { file: `base64://${data.toString('base64')}` };
    }); }
  });
}
