import { createHash } from 'node:crypto';
import { constants, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readSync,
  readdirSync, realpathSync, unlinkSync, type Stats } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { crc32 } from 'node:zlib';
import { normalizeOutboundScope, personaKey } from '../core/scope.ts';
import type { OutboundScope } from '../core/types.ts';
import { FrameworkError, assert, reference } from '../core/values.ts';
import type { createResourceRegistry } from './resources.ts';

export interface RenderedAssetPublisherOptions {
  registry: ReturnType<typeof createResourceRegistry>;
  directory: string;
  maxFiles?: number;
  maxFileBytes?: number;
  maxPending?: number;
}

export interface RenderedAssetPublishRequest {
  png: Uint8Array;
  width: number;
  height: number;
  conversationId: string;
  scope: OutboundScope;
  idempotencyKey: string;
  signal: AbortSignal;
}

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const directoryTails = new Map<string, Promise<void>>();
const lockName = '.rendered-assets.lock';
const failureCodes = new Set(['RENDERED_ASSET_INVALID', 'RENDERED_ASSET_DIRECTORY', 'RENDERED_ASSET_FILE',
  'RENDERED_ASSET_LIMIT', 'RENDERED_ASSET_BUSY', 'RENDERED_ASSET_CONFLICT', 'RENDERED_ASSET_ABORTED',
  'RESOURCE_SOURCE_DENIED', 'RENDERED_ASSET_BACKPRESSURE']);

function fail(code: string): never {
  throw new FrameworkError(code, 'The trusted rendered asset could not be published.');
}

function cancelled(signal: AbortSignal) {
  if (signal.aborted) fail('RENDERED_ASSET_ABORTED');
}

function hash(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validPng(png: Buffer, width: number, height: number) {
  assert(Number.isSafeInteger(width) && width > 0 && width <= 8192
    && Number.isSafeInteger(height) && height > 0 && height <= 8192 && width * height <= 16_777_216
    && png.length >= 57 && png.subarray(0, 8).equals(signature),
  'RENDERED_ASSET_INVALID', 'A bounded document PNG is required.');
  let offset = 8;
  let imageData = false;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const end = offset + length + 12;
    assert(end <= png.length, 'RENDERED_ASSET_INVALID', 'The document PNG is truncated.');
    const type = png.toString('ascii', offset + 4, offset + 8);
    assert(/^[A-Za-z]{4}$/.test(type) && crc32(png.subarray(offset + 4, end - 4)) === png.readUInt32BE(end - 4),
      'RENDERED_ASSET_INVALID', 'The document PNG has invalid chunks.');
    if (offset === 8) {
      assert(type === 'IHDR' && length === 13 && png.readUInt32BE(16) === width && png.readUInt32BE(20) === height,
        'RENDERED_ASSET_INVALID', 'The PNG header must match the rendered dimensions.');
      const depths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      assert(depths[png[25]]?.includes(png[24]) && png[26] === 0 && png[27] === 0 && png[28] <= 1,
        'RENDERED_ASSET_INVALID', 'The PNG header is invalid.');
    } else {
      assert(type !== 'IHDR', 'RENDERED_ASSET_INVALID', 'The PNG header cannot be repeated.');
    }
    if (type === 'IDAT' && length > 0) imageData = true;
    if (type === 'IEND') {
      assert(length === 0 && end === png.length && imageData, 'RENDERED_ASSET_INVALID', 'The PNG must end with IEND.');
      return;
    }
    offset = end;
  }
  fail('RENDERED_ASSET_INVALID');
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function descriptorPath(descriptor: number): string {
  return `${process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'}/${descriptor}`;
}

function directoryHandle(directory: string, expected?: Stats): number {
  let descriptor: number | undefined;
  try {
    assert(realpathSync(directory) === directory, 'RENDERED_ASSET_DIRECTORY', 'A canonical directory is required.');
    descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const information = fstatSync(descriptor);
    assert(information.isDirectory() && sameFile(information, lstatSync(directory))
      && (!expected || sameFile(information, expected)) && realpathSync(descriptorPath(descriptor)) === directory,
    'RENDERED_ASSET_DIRECTORY', 'The rendered asset directory has changed.');
    if (!expected) fchmodSync(descriptor, 0o700);
    assert((fstatSync(descriptor).mode & 0o777) === 0o700,
      'RENDERED_ASSET_DIRECTORY', 'A private rendered asset directory is required.');
    return descriptor;
  } catch {
    if (descriptor !== undefined) closeSync(descriptor);
    fail('RENDERED_ASSET_DIRECTORY');
  }
}

function verifyFile(filename: string, png: Buffer, maxFileBytes: number) {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const information = fstatSync(descriptor);
    assert(information.isFile() && information.nlink === 1 && (information.mode & 0o777) === 0o600
      && information.size === png.length && information.size <= maxFileBytes,
    'RENDERED_ASSET_FILE', 'A private, bounded regular PNG file is required.');
    const output = Buffer.alloc(png.length);
    let offset = 0;
    while (offset < output.length) {
      const count = readSync(descriptor, output, offset, output.length - offset, offset);
      assert(count > 0, 'RENDERED_ASSET_FILE', 'The rendered asset is incomplete.');
      offset += count;
    }
    assert(output.equals(png) && fstatSync(descriptor).size === png.length
      && sameFile(information, lstatSync(filename)), 'RENDERED_ASSET_FILE', 'The rendered asset has changed.');
  } catch {
    fail('RENDERED_ASSET_FILE');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function existingResource(registry: ReturnType<typeof createResourceRegistry>, assetId: string) {
  return registry.get(assetId);
}

export function createRenderedAssetPublisher({ registry, directory, maxFiles = 256, maxFileBytes = 20 * 1024 * 1024, maxPending = 4 }:
  RenderedAssetPublisherOptions) {
  assert(registry && ['register', 'approve', 'resolve', 'revoke', 'get'].every(method =>
    typeof Reflect.get(registry, method) === 'function')
    && typeof directory === 'string' && isAbsolute(directory) && directory === resolve(directory) && dirname(directory) !== directory
    && !directory.includes('\0') && Number.isSafeInteger(maxFiles) && maxFiles > 0 && maxFiles <= 10_000
    && Number.isSafeInteger(maxFileBytes) && maxFileBytes > 0 && maxFileBytes <= 64 * 1024 * 1024
    && Number.isSafeInteger(maxPending) && maxPending >= 1 && maxPending <= 256,
  'RENDERED_ASSET_INVALID', 'A trusted registry, canonical directory, and bounded limits are required.');
  try {
    assert(realpathSync(dirname(directory)) === dirname(directory), 'RENDERED_ASSET_DIRECTORY', 'A canonical parent directory is required.');
    mkdirSync(directory, { mode: 0o700 });
  }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') fail('RENDERED_ASSET_DIRECTORY');
  }
  const initialDescriptor = directoryHandle(directory);
  const initialDirectory = fstatSync(initialDescriptor);
  closeSync(initialDescriptor);
  let pending = 0;

  return Object.freeze({
    metrics() { return Object.freeze({ pending, maxPending }); },
    async publish(request: RenderedAssetPublishRequest): Promise<string> {
      assert(pending < maxPending, 'RENDERED_ASSET_BACKPRESSURE', 'Too many rendered files remain pending.');
      pending++;
      let release: (() => void) | undefined;
      let tail: Promise<void> | undefined;
      let descriptor: number | undefined;
      let lock: number | undefined;
      let ioDirectory: string | undefined;
      let filename: string | undefined;
      let created = false;
      let registered = false;
      let approved = false;
      let assetId: string | undefined;
      try {
        assert(request && request.signal instanceof AbortSignal, 'RENDERED_ASSET_INVALID', 'A cancellation signal is required.');
        const { signal, width, height, conversationId, idempotencyKey } = request;
        cancelled(signal);
        const scope = normalizeOutboundScope(request.scope);
        const persona = personaKey(scope);
        assert(reference(conversationId) && conversationId !== 'global' && reference(idempotencyKey) && reference(persona)
          && request.png instanceof Uint8Array && !(request.png.buffer instanceof SharedArrayBuffer)
          && request.png.byteLength <= maxFileBytes, 'RENDERED_ASSET_INVALID', 'A scoped and bounded rendered PNG is required.');
        const png = Buffer.from(request.png);
        validPng(png, width, height);
        const version = hash(png);
        assetId = `rendered-${hash(JSON.stringify([conversationId, persona, idempotencyKey]))}`;
        const basename = `${version}.png`;
        const sourcePath = join(directory, basename);
        const selection = { assetId, type: 'image' as const, conversationId, persona, expectedVersion: version };

        const previous = directoryTails.get(directory);
        tail = new Promise<void>(resolveTail => { release = resolveTail; });
        directoryTails.set(directory, tail);
        if (previous) await previous;
        cancelled(signal);
        descriptor = directoryHandle(directory, initialDirectory);
        ioDirectory = descriptorPath(descriptor);
        try {
          lock = openSync(join(ioDirectory, lockName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        } catch { fail('RENDERED_ASSET_BUSY'); }
        const entries = readdirSync(ioDirectory).filter(entry => entry !== lockName);
        assert(entries.length <= maxFiles, 'RENDERED_ASSET_LIMIT', 'The rendered asset directory is full.');
        for (const entry of entries) {
          const information = lstatSync(join(ioDirectory, entry));
          assert(information.isFile() && information.nlink === 1, 'RENDERED_ASSET_FILE', 'Only local regular files are allowed.');
        }
        const existing = existingResource(registry, assetId);
        if (existing) {
          assert(existing.status === 'approved' && existing.type === 'image' && existing.scope === conversationId
            && existing.persona === persona && existing.version === version && existing.expiresAt === null
            && existing.sessionId === null && existing.generation === null,
          'RENDERED_ASSET_CONFLICT', 'The rendered resource id is already reserved.');
        }
        filename = join(ioDirectory, basename);
        if (!entries.includes(basename)) {
          assert(!existing, 'RENDERED_ASSET_CONFLICT', 'An approved rendered asset cannot be recreated.');
          assert(entries.length < maxFiles, 'RENDERED_ASSET_LIMIT', 'The rendered asset directory is full.');
          const file = await open(filename, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          created = true;
          try {
            cancelled(signal);
            await file.chmod(0o600);
            await file.writeFile(png, { signal });
            await file.sync();
          } finally { await file.close(); }
        }
        cancelled(signal);
        verifyFile(filename, png, maxFileBytes);
        const checkedDirectory = directoryHandle(directory, initialDirectory);
        closeSync(checkedDirectory);
        cancelled(signal);
        if (!existing) {
          registry.register({ id: assetId, type: 'image', scope: conversationId, persona, version,
            source: { kind: 'file', path: sourcePath } });
          registered = true;
          cancelled(signal);
          registry.approve(assetId);
          approved = true;
        }
        cancelled(signal);
        assert(registry.resolve(selection) === sourcePath, 'RENDERED_ASSET_CONFLICT', 'The rendered resource location conflicts.');
        verifyFile(filename, png, maxFileBytes);
        const finalDirectory = directoryHandle(directory, initialDirectory);
        closeSync(finalDirectory);
        cancelled(signal);
        return assetId;
      } catch (error) {
        if (approved && assetId) {
          try { registry.revoke(assetId); } catch {}
        }
        if (created && !registered && filename) {
          try { unlinkSync(filename); } catch {}
        }
        if (request?.signal instanceof AbortSignal && request.signal.aborted) fail('RENDERED_ASSET_ABORTED');
        fail(error instanceof FrameworkError && failureCodes.has(error.code) ? error.code : 'RENDERED_ASSET_FAILED');
      } finally {
        if (lock !== undefined && ioDirectory) {
          try {
            if (sameFile(fstatSync(lock), lstatSync(join(ioDirectory, lockName)))) unlinkSync(join(ioDirectory, lockName));
          } catch {}
          closeSync(lock);
        }
        if (descriptor !== undefined) closeSync(descriptor);
        release?.();
        if (tail && directoryTails.get(directory) === tail) directoryTails.delete(directory);
        pending--;
      }
    },
  });
}
