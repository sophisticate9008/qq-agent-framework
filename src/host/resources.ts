import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { assert, isRecord, reference, snapshot } from '../core/values.ts';
import type { Clock } from '../core/types.ts';
import type { DurableStore, StoredRecord } from './types.ts';
import { json, object } from './data.ts';

export type ResourceType = 'image' | 'audio' | 'file';
export type ResourceSource = { kind: 'url'; url: string } | { kind: 'file'; path: string } | { kind: 'gateway'; id: string };
export interface ResourceInput {
  id: string;
  type: ResourceType;
  scope: string;
  persona?: string;
  version: string;
  source: ResourceSource;
  expiresAt?: number | null;
  sessionId?: string;
  generation?: number;
}

const namespace = 'resources';
function resource(record: StoredRecord) {
  const value = object(record.value);
  assert(reference(value.id) && reference(value.scope) && reference(value.version)
    && ['image', 'audio', 'file'].includes(String(value.type)) && ['pending', 'approved', 'revoked'].includes(String(value.status))
    && (value.persona === null || reference(value.persona)) && isRecord(value.source),
  'INVALID_STORED_DATA', 'Stored resource data is invalid.');
  return value;
}

export function createResourceRegistry({ store, clock = Date.now, rootDirectory, allowedOrigins = [], maxFileBytes = 20 * 1024 * 1024 }:
  { store: DurableStore; clock?: Clock; rootDirectory?: string; allowedOrigins?: readonly string[]; maxFileBytes?: number }) {
  let root: string | null = null;
  if (rootDirectory !== undefined) {
    try { root = realpathSync(rootDirectory); }
    catch { assert(false, 'RESOURCE_SOURCE_DENIED', 'The resource directory is unavailable.'); }
  }
  assert(Number.isSafeInteger(maxFileBytes) && maxFileBytes > 0, 'INVALID_RESOURCE_OPTIONS', 'A finite file bound is required.');
  const origins = new Set(allowedOrigins.map(origin => {
    const url = new URL(origin);
    assert(url.protocol === 'https:' && !url.username && !url.password && url.origin === origin,
      'INVALID_RESOURCE_OPTIONS', 'Trusted HTTPS origins must be explicit.');
    return origin;
  }));

  function location(source: unknown): string {
    assert(isRecord(source), 'INVALID_RESOURCE', 'An explicit resource source is required.');
    if (source.kind === 'url') {
      assert(typeof source.url === 'string', 'INVALID_RESOURCE', 'A trusted resource URL is required.');
      let url: URL;
      try { url = new URL(source.url); } catch { assert(false, 'INVALID_RESOURCE', 'A valid resource URL is required.'); }
      assert(url.protocol === 'https:' && !url.username && !url.password && origins.has(url.origin),
        'RESOURCE_SOURCE_DENIED', 'The resource origin is not trusted.');
      return url.href;
    }
    if (source.kind === 'file') {
      assert(root && typeof source.path === 'string', 'RESOURCE_SOURCE_DENIED', 'A resource directory must be configured.');
      let filename: string;
      try {
        filename = realpathSync(source.path);
        const child = relative(root, filename);
        const information = statSync(filename);
        assert(child !== '' && child !== '..' && !child.startsWith('../') && !isAbsolute(child)
          && information.isFile() && information.size <= maxFileBytes, 'RESOURCE_SOURCE_DENIED', 'The file is outside resource limits.');
      } catch { assert(false, 'RESOURCE_SOURCE_DENIED', 'The resource file is unavailable or outside limits.'); }
      return filename;
    }
    assert(source.kind === 'gateway' && typeof source.id === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,255}$/.test(source.id)
      && source.id !== '..', 'INVALID_RESOURCE', 'A safe gateway resource identifier is required.');
    return source.id;
  }

  function metadata(record: StoredRecord) {
    const value = resource(record);
    return { cursor: record.key, id: value.id, type: value.type, scope: value.scope, persona: value.persona,
      version: value.version, status: value.status, expiresAt: value.expiresAt,
      sessionId: value.sessionId ?? null, generation: value.generation ?? null };
  }

  return Object.freeze({
    get(id: string) {
      assert(reference(id), 'INVALID_RESOURCE', 'A resource reference is required.');
      const record = store.read(namespace, id);
      return record === null ? null : snapshot(metadata(record));
    },
    register(input: ResourceInput) {
      const value = snapshot(input);
      assert(reference(value.id) && reference(value.scope) && reference(value.version)
        && ['image', 'audio', 'file'].includes(value.type) && (value.persona === undefined || reference(value.persona))
        && (value.sessionId === undefined || reference(value.sessionId))
        && (value.generation === undefined || reference(value.sessionId) && Number.isSafeInteger(value.generation) && value.generation > 0),
      'INVALID_RESOURCE', 'A scoped, versioned resource is required.');
      const expiresAt = value.expiresAt ?? null;
      assert(expiresAt === null || Number.isFinite(expiresAt) && expiresAt > clock(), 'INVALID_RESOURCE', 'Resource expiry must be in the future.');
      location(value.source);
      store.write(namespace, value.id, json({ id: value.id, type: value.type, scope: value.scope, version: value.version,
        persona: value.persona ?? null, source: value.source, status: 'pending', expiresAt,
        sessionId: value.sessionId ?? null, generation: value.generation ?? null }), { expectedRevision: null });
      return value.id;
    },
    approve(id: string) {
      const record = store.read(namespace, id);
      assert(record && resource(record).status === 'pending', 'RESOURCE_NOT_PENDING', 'Only pending resources can be approved.');
      store.write(namespace, id, json({ ...resource(record), status: 'approved' }), { expectedRevision: record.revision });
    },
    revoke(id: string) {
      const record = store.read(namespace, id);
      if (!record) return false;
      store.write(namespace, id, json({ ...resource(record), status: 'revoked' }), { expectedRevision: record.revision });
      return true;
    },
    resolve({ assetId, type, conversationId, persona, expectedVersion, sessionId, generation }:
      { assetId: string; type: ResourceType; conversationId: string; persona?: string; expectedVersion?: string;
        sessionId?: string; generation?: number }) {
      const record = store.read(namespace, assetId);
      assert(record, 'RESOURCE_UNAVAILABLE', 'The resource is unavailable.');
      const value = resource(record);
      assert(value.status === 'approved' && value.type === type && (value.scope === 'global' || value.scope === conversationId)
        && (value.persona === null || value.persona === persona)
        && (expectedVersion === undefined || value.version === expectedVersion)
        && (value.sessionId === undefined || value.sessionId === null || value.sessionId === sessionId)
        && (value.generation === undefined || value.generation === null || value.generation === generation)
        && (value.expiresAt === null || typeof value.expiresAt === 'number' && value.expiresAt > clock()),
      'RESOURCE_UNAVAILABLE', 'The resource is not approved for this context.');
      return location(value.source);
    },
    list({ limit = 100, after }: { limit?: number; after?: string } = {}) {
      return snapshot(store.list(namespace, after === undefined ? { limit } : { limit, after }).map(metadata));
    },
  });
}
