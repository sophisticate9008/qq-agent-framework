import { FRAMEWORK_MEDIA_IMAGE_BYTES, frameworkImageBytes, type FrameworkImageMediaType } from './framework-media.ts';
import { isChatPlanIdentifier } from './chat-plans.ts';
import { NATIVE_REVISION_PATTERN } from './native-revisions.ts';

export const NATIVE_APPEARANCE_PATH = '/api/chat/appearance';
export const NATIVE_APPEARANCE_FILE = 'chat-appearance.json';
export const NATIVE_APPEARANCE_MAX_DIMENSION = 16_384;
export const NATIVE_APPEARANCE_MAX_PIXELS = 64 * 1024 * 1024;
export interface NativeAppearanceVersion {
  readonly version: number; readonly name: string; readonly description: string; readonly source: 'manual-upload';
  readonly createdAt: number; readonly mediaType: FrameworkImageMediaType; readonly bytes: number;
  readonly width: number; readonly height: number; readonly sha256: string;
}
export interface NativeAppearanceAsset { readonly id: string; readonly versions: readonly NativeAppearanceVersion[] }
export interface NativeAppearanceBinding {
  readonly personaId: string; readonly assetId: string | null; readonly version: number | null;
  readonly generation: number; readonly updatedAt: number;
}
export interface NativeAppearanceConfiguration {
  readonly schema: 1; readonly assets: readonly NativeAppearanceAsset[]; readonly bindings: readonly NativeAppearanceBinding[];
}
export interface NativeAppearanceSnapshot extends NativeAppearanceConfiguration { readonly revision: string }
export interface NativeAppearancePreview {
  readonly schema: 1; readonly revision: string; readonly assetId: string; readonly version: number;
  readonly image: { readonly mediaType: FrameworkImageMediaType; readonly data: string; readonly bytes: number; readonly width: number; readonly height: number; readonly sha256: string };
}
export interface NativeAppearanceContext extends NativeAppearanceVersion { readonly assetId: string; readonly bindingGeneration: number }
export type NativeAppearanceRequest =
  | { readonly action: 'upload'; readonly revision: string; readonly assetId?: string; readonly name: string; readonly description: string; readonly mediaType: FrameworkImageMediaType; readonly data: string }
  | { readonly action: 'bind'; readonly revision: string; readonly personaId: string; readonly assetId: string; readonly version: number }
  | { readonly action: 'unbind'; readonly revision: string; readonly personaId: string }
  | { readonly action: 'remove'; readonly revision: string; readonly assetId: string };
export const EMPTY_NATIVE_APPEARANCE: NativeAppearanceConfiguration = Object.freeze({ schema: 1, assets: Object.freeze([]), bindings: Object.freeze([]) });
export function isNativeAppearanceAssetId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
}
function dense(value: readonly unknown[]): boolean { return Object.keys(value).length === value.length; }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max; }
function time(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000; }
function text(value: unknown, max: number, empty = false): value is string { return typeof value === 'string' && (empty || value.trim().length > 0) && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value); }
export function isNativeAppearanceMediaType(value: unknown): value is FrameworkImageMediaType { return ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(value)); }
function dimensions(value: Record<string, unknown>): boolean { return integer(value.width, NATIVE_APPEARANCE_MAX_DIMENSION) && integer(value.height, NATIVE_APPEARANCE_MAX_DIMENSION) && value.width * value.height <= NATIVE_APPEARANCE_MAX_PIXELS; }
export function parseNativeAppearanceVersion(value: unknown): NativeAppearanceVersion | null {
  if (!record(value) || !exact(value, ['version', 'name', 'description', 'source', 'createdAt', 'mediaType', 'bytes', 'width', 'height', 'sha256'])
    || !integer(value.version, 128) || !text(value.name, 128) || !text(value.description, 2000, true) || value.source !== 'manual-upload'
    || !time(value.createdAt) || !isNativeAppearanceMediaType(value.mediaType) || !integer(value.bytes, FRAMEWORK_MEDIA_IMAGE_BYTES)
    || !dimensions(value) || typeof value.sha256 !== 'string' || !NATIVE_REVISION_PATTERN.test(value.sha256)) return null;
  return value as unknown as NativeAppearanceVersion;
}
export function parseNativeAppearanceConfiguration(value: unknown): NativeAppearanceConfiguration | null {
  if (!record(value) || !exact(value, ['schema', 'assets', 'bindings']) || value.schema !== 1 || !Array.isArray(value.assets) || value.assets.length > 64 || !dense(value.assets) || !Array.isArray(value.bindings) || value.bindings.length > 256 || !dense(value.bindings)) return null;
  const ids = new Set<string>(); let versions = 0;
  for (const asset of value.assets) {
    if (!record(asset) || !exact(asset, ['id', 'versions']) || !isNativeAppearanceAssetId(asset.id) || ids.has(asset.id) || !Array.isArray(asset.versions) || asset.versions.length === 0 || !dense(asset.versions)) return null;
    ids.add(asset.id); versions += asset.versions.length;
    if (versions > 128 || !asset.versions.every((version, index) => parseNativeAppearanceVersion(version)?.version === index + 1)) return null;
  }
  const personas = new Set<string>();
  for (const binding of value.bindings) {
    if (!record(binding) || !exact(binding, ['personaId', 'assetId', 'version', 'generation', 'updatedAt']) || !isChatPlanIdentifier(binding.personaId) || personas.has(binding.personaId)
      || !integer(binding.generation) || !time(binding.updatedAt) || (binding.assetId === null) !== (binding.version === null)) return null;
    personas.add(binding.personaId);
    if (binding.assetId !== null && (!isNativeAppearanceAssetId(binding.assetId) || !integer(binding.version, 128)
      || !value.assets.some(asset => record(asset) && asset.id === binding.assetId && Array.isArray(asset.versions) && asset.versions.some(version => record(version) && version.version === binding.version)))) return null;
  }
  return value as unknown as NativeAppearanceConfiguration;
}
export function parseNativeAppearanceSnapshot(value: unknown): NativeAppearanceSnapshot | null {
  if (!record(value) || !exact(value, ['schema', 'assets', 'bindings', 'revision']) || typeof value.revision !== 'string' || !NATIVE_REVISION_PATTERN.test(value.revision)) return null;
  const configuration = parseNativeAppearanceConfiguration({ schema: value.schema, assets: value.assets, bindings: value.bindings });
  return configuration ? { ...configuration, revision: value.revision } : null;
}
export function parseNativeAppearancePreview(value: unknown): NativeAppearancePreview | null {
  if (!record(value) || !exact(value, ['schema', 'revision', 'assetId', 'version', 'image']) || value.schema !== 1 || typeof value.revision !== 'string' || !NATIVE_REVISION_PATTERN.test(value.revision)
    || !isNativeAppearanceAssetId(value.assetId) || !integer(value.version, 128) || !record(value.image) || !exact(value.image, ['mediaType', 'data', 'bytes', 'width', 'height', 'sha256'])
    || !isNativeAppearanceMediaType(value.image.mediaType) || !integer(value.image.bytes, FRAMEWORK_MEDIA_IMAGE_BYTES) || frameworkImageBytes(value.image.data) !== value.image.bytes || !dimensions(value.image)
    || typeof value.image.sha256 !== 'string' || !NATIVE_REVISION_PATTERN.test(value.image.sha256)) return null;
  return value as unknown as NativeAppearancePreview;
}
export function parseNativeAppearanceRequest(value: unknown): NativeAppearanceRequest | null {
  if (!record(value) || typeof value.revision !== 'string' || !NATIVE_REVISION_PATTERN.test(value.revision)) return null;
  switch (value.action) {
    case 'upload': return exact(value, ['action', 'revision', 'name', 'description', 'mediaType', 'data', ...(Object.hasOwn(value, 'assetId') ? ['assetId'] : [])])
      && (!Object.hasOwn(value, 'assetId') || isNativeAppearanceAssetId(value.assetId)) && text(value.name, 128) && text(value.description, 2000, true)
      && isNativeAppearanceMediaType(value.mediaType) && frameworkImageBytes(value.data) !== null ? value as unknown as NativeAppearanceRequest : null;
    case 'bind': return exact(value, ['action', 'revision', 'personaId', 'assetId', 'version']) && isChatPlanIdentifier(value.personaId) && isNativeAppearanceAssetId(value.assetId) && integer(value.version, 128) ? value as unknown as NativeAppearanceRequest : null;
    case 'unbind': return exact(value, ['action', 'revision', 'personaId']) && isChatPlanIdentifier(value.personaId) ? value as unknown as NativeAppearanceRequest : null;
    case 'remove': return exact(value, ['action', 'revision', 'assetId']) && isNativeAppearanceAssetId(value.assetId) ? value as unknown as NativeAppearanceRequest : null;
    default: return null;
  }
}
