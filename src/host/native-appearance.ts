import { createHash, randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { EMPTY_NATIVE_APPEARANCE, NATIVE_APPEARANCE_FILE, isNativeAppearanceAssetId, parseNativeAppearanceConfiguration, parseNativeAppearanceRequest,
  type NativeAppearanceAsset, type NativeAppearanceBinding, type NativeAppearanceConfiguration, type NativeAppearanceContext, type NativeAppearancePreview, type NativeAppearanceRequest, type NativeAppearanceSnapshot, type NativeAppearanceVersion } from '../contracts/native-appearance.ts';
import { FRAMEWORK_MEDIA_IMAGE_BYTES, FRAMEWORK_MEDIA_PROTOCOL, type NativeMediaReadEnvelope } from '../contracts/framework-media.ts';
import { isChatPlanIdentifier, validateChatPersonas } from '../contracts/chat-plans.ts';
import { FrameworkError, isRecord } from '../core/values.ts';
import { ensurePrivateDirectory, readDocument, updateDocument } from '../storage/private-json.ts';
import { readPrivateBlob, writePrivateBlob } from '../storage/private-blob.ts';
import { inspectAppearanceImage } from './native-appearance-image.ts';

function fail(code: string): never { throw new FrameworkError(code, code); }
function configuration(input: unknown): NativeAppearanceConfiguration {
  const value = parseNativeAppearanceConfiguration(input); if (!value) fail('APPEARANCE_STORED_INVALID'); return value;
}
export async function readNativeAppearanceConfiguration(directory: string) {
  if (!isAbsolute(directory) || directory.includes('\0')) throw new TypeError('An absolute appearance directory is required');
  const document = await readDocument(join(directory, NATIVE_APPEARANCE_FILE), EMPTY_NATIVE_APPEARANCE, configuration);
  return { revision: document.revision, configuration: document.value };
}
function versionOf(assets: readonly NativeAppearanceAsset[], assetId: string, version: number): NativeAppearanceVersion {
  const value = assets.find(asset => asset.id === assetId)?.versions.find(item => item.version === version);
  if (!value) fail('APPEARANCE_NOT_FOUND'); return value;
}
function bound(bindings: readonly NativeAppearanceBinding[], personaId: string): NativeAppearanceBinding | null {
  return bindings.find(binding => binding.personaId === personaId && binding.assetId !== null) ?? null;
}
function blobName(assetId: string, version: NativeAppearanceVersion): string { return `${assetId}-v${version.version}-${version.sha256}.image`; }

export function createNativeAppearanceService(options: { readonly directory: string; readonly now?: () => number }) {
  if (!isAbsolute(options.directory) || options.directory.includes('\0')) throw new TypeError('An absolute appearance directory is required');
  const directory = resolve(options.directory); const blobs = join(directory, 'appearance-blobs');
  const filename = join(directory, NATIVE_APPEARANCE_FILE); const now = options.now ?? Date.now;
  const readConfiguration = () => readNativeAppearanceConfiguration(directory);
  async function snapshot(): Promise<NativeAppearanceSnapshot> { const document = await readConfiguration(); return { ...document.configuration, revision: document.revision }; }
  async function personaExists(personaId: string): Promise<boolean> {
    if (!isChatPlanIdentifier(personaId)) return false;
    const document = await readDocument(join(directory, 'chat-personas.json'), { schema: 1 as const, personas: [] as ReturnType<typeof validateChatPersonas> }, value => {
      if (!isRecord(value) || value.schema !== 1 || Object.keys(value).length !== 2) fail('APPEARANCE_PERSONAS_INVALID');
      return { schema: 1 as const, personas: validateChatPersonas(value.personas) };
    });
    return document.value.personas.some(persona => persona.id === personaId);
  }
  async function bytes(assetId: string, version: NativeAppearanceVersion, signal: AbortSignal): Promise<Buffer> {
    const data = await readPrivateBlob(join(blobs, blobName(assetId, version)), { bytes: version.bytes, sha256: version.sha256, maximumBytes: FRAMEWORK_MEDIA_IMAGE_BYTES }, signal);
    const image = inspectAppearanceImage(data);
    if (!image || image.mediaType !== version.mediaType || image.width !== version.width || image.height !== version.height) fail('APPEARANCE_IMAGE_INVALID');
    return data;
  }
  return Object.freeze({
    snapshot,
    async execute(input: NativeAppearanceRequest, signal: AbortSignal): Promise<NativeAppearanceSnapshot> {
      const request = parseNativeAppearanceRequest(input); if (!request) fail('APPEARANCE_INVALID');
      signal.throwIfAborted(); await ensurePrivateDirectory(directory); signal.throwIfAborted();
      const removed: { assetId: string; version: NativeAppearanceVersion }[] = [];
      const document = await updateDocument(directory, filename, request.revision, EMPTY_NATIVE_APPEARANCE, configuration, async current => {
        signal.throwIfAborted();
        switch (request.action) {
          case 'upload': {
            const data = Buffer.from(request.data, 'base64'); const image = inspectAppearanceImage(data);
            if (data.toString('base64') !== request.data || !image || image.mediaType !== request.mediaType) fail('APPEARANCE_IMAGE_INVALID');
            const existing = request.assetId === undefined ? null : current.assets.find(asset => asset.id === request.assetId);
            if (request.assetId !== undefined && !existing) fail('APPEARANCE_NOT_FOUND');
            if (current.assets.reduce((total, asset) => total + asset.versions.length, 0) >= 128 || !existing && current.assets.length >= 64) fail('APPEARANCE_CAPACITY');
            const assetId = existing?.id ?? randomUUID();
            const version: NativeAppearanceVersion = { version: (existing?.versions.length ?? 0) + 1, name: request.name.trim(), description: request.description,
              source: 'manual-upload', createdAt: now(), ...image, bytes: data.byteLength, sha256: createHash('sha256').update(data).digest('hex') };
            const asset = { id: assetId, versions: [...(existing?.versions ?? []), version] };
            const next = configuration({ ...current, assets: existing ? current.assets.map(item => item.id === assetId ? asset : item) : [...current.assets, asset] });
            if (Buffer.byteLength(JSON.stringify(next) + '\n') > 60 * 1024) fail('APPEARANCE_CAPACITY');
            await writePrivateBlob(blobs, blobName(assetId, version), data, signal);
            return next;
          }
          case 'bind': case 'unbind': {
            if (!await personaExists(request.personaId)) fail('APPEARANCE_PERSONA_NOT_FOUND');
            if (request.action === 'bind') versionOf(current.assets, request.assetId, request.version);
            const previous = current.bindings.find(binding => binding.personaId === request.personaId);
            const binding: NativeAppearanceBinding = { personaId: request.personaId, assetId: request.action === 'bind' ? request.assetId : null,
              version: request.action === 'bind' ? request.version : null, generation: (previous?.generation ?? 0) + 1, updatedAt: now() };
            return configuration({ ...current, bindings: previous ? current.bindings.map(item => item.personaId === request.personaId ? binding : item) : [...current.bindings, binding] });
          }
          case 'remove': {
            const asset = current.assets.find(item => item.id === request.assetId); if (!asset) fail('APPEARANCE_NOT_FOUND');
            if (current.bindings.some(binding => binding.assetId === asset.id)) fail('APPEARANCE_IN_USE');
            removed.push(...asset.versions.map(version => ({ assetId: asset.id, version })));
            return { ...current, assets: current.assets.filter(item => item.id !== asset.id) };
          }
        }
      }, next => { signal.throwIfAborted(); if (Buffer.byteLength(JSON.stringify(next) + '\n') > 60 * 1024) fail('APPEARANCE_CAPACITY'); });
      // Metadata removal withdraws access first. Unlink only server-derived immutable filenames.
      for (const item of removed) await unlink(join(blobs, blobName(item.assetId, item.version))).catch(error => {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      });
      return { ...document.value, revision: document.revision };
    },
    async preview(assetId: string, version: number, signal: AbortSignal): Promise<NativeAppearancePreview> {
      if (!isNativeAppearanceAssetId(assetId) || !Number.isSafeInteger(version) || version < 1) fail('APPEARANCE_INVALID');
      signal.throwIfAborted(); const document = await readConfiguration(); const metadata = versionOf(document.configuration.assets, assetId, version);
      const data = await bytes(assetId, metadata, signal); const current = await readConfiguration();
      const latest = versionOf(current.configuration.assets, assetId, version);
      if (latest.sha256 !== metadata.sha256) fail('APPEARANCE_CHANGED');
      signal.throwIfAborted();
      return { schema: 1, revision: current.revision, assetId, version, image: { mediaType: metadata.mediaType, data: data.toString('base64'), bytes: metadata.bytes, width: metadata.width, height: metadata.height, sha256: metadata.sha256 } };
    },
    async context(personaId: string, signal: AbortSignal = new AbortController().signal): Promise<NativeAppearanceContext | null> {
      signal.throwIfAborted(); if (!await personaExists(personaId)) return null;
      const document = await readConfiguration(); const binding = bound(document.configuration.bindings, personaId);
      signal.throwIfAborted();
      if (!binding?.assetId || binding.version === null) return null;
      return { ...versionOf(document.configuration.assets, binding.assetId, binding.version), assetId: binding.assetId, bindingGeneration: binding.generation };
    },
    async read(input: { readonly personaId: string; readonly assetId: string; readonly version: number; readonly signal: AbortSignal }): Promise<NativeMediaReadEnvelope> {
      input.signal.throwIfAborted(); if (!await personaExists(input.personaId)) fail('APPEARANCE_PERSONA_NOT_FOUND');
      const document = await readConfiguration(); const binding = bound(document.configuration.bindings, input.personaId);
      if (!binding || binding.assetId !== input.assetId || binding.version !== input.version) fail('APPEARANCE_BINDING_MISMATCH');
      const metadata = versionOf(document.configuration.assets, input.assetId, input.version);
      const data = await bytes(input.assetId, metadata, input.signal); const current = await readConfiguration();
      const after = bound(current.configuration.bindings, input.personaId);
      if (!after || after.generation !== binding.generation || after.assetId !== binding.assetId || after.version !== binding.version || !await personaExists(input.personaId)) fail('APPEARANCE_BINDING_CHANGED');
      input.signal.throwIfAborted();
      return { schema: FRAMEWORK_MEDIA_PROTOCOL, contentRead: true, kind: 'image', mediaType: metadata.mediaType, data: data.toString('base64') };
    }
  });
}
