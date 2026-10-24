import { createHash, randomUUID } from 'node:crypto';

import type { Clock, JsonObject } from '../core/types.ts';
import { FrameworkError, assert, identifier, isRecord, reference, snapshot } from '../core/values.ts';
import type { DurableStore, StoredRecord } from '../host/types.ts';

const META_NAMESPACE = 'policy.meta';
const META_KEY = 'global';
const GRANT_NAMESPACE = 'policy.grants';
const INDEX_META_NAMESPACE = 'policy.grant-index-meta';
const INDEX_META_KEY = 'global';
const INDEX_NAMESPACE_PREFIX = 'policy.grant-index';
const INDEX_VERSION = 1;
const MAX_ATTEMPTS = 12;
const PAGE_SIZE = 1_000;

interface EffectAuthorization {
  featureId: string;
  conversationId: string;
  capability: string;
}

interface Reservation extends EffectAuthorization {
  id: string;
  grantId: string;
}

interface PolicyMeta {
  paused: boolean;
  nextGrantOrder: number;
}

interface GrantRecord {
  id: string;
  featureId: string;
  conversationId: string;
  capabilities: string[];
  maxUses: Record<string, number>;
  expiresAt: number | null;
  active: boolean;
  used: Record<string, number>;
  order: number;
}

interface IndexedGrant {
  stored: StoredRecord;
  grant: GrantRecord;
}

export interface PersistentPolicyOptions {
  store: DurableStore;
  clock?: Clock;
}

function conflict(error: unknown): boolean {
  return error instanceof FrameworkError && error.code === 'STORE_CONFLICT';
}

function storedData(condition: unknown): asserts condition {
  assert(condition, 'INVALID_STORED_DATA', 'Stored policy data is invalid.');
}

function parseMeta(record: StoredRecord | null): PolicyMeta {
  if (!record) return { paused: false, nextGrantOrder: 0 };
  const value = record.value;
  storedData(isRecord(value)
    && value.schema === 1
    && typeof value.paused === 'boolean'
    && typeof value.nextGrantOrder === 'number'
    && Number.isSafeInteger(value.nextGrantOrder)
    && value.nextGrantOrder >= 0);
  return { paused: value.paused, nextGrantOrder: value.nextGrantOrder };
}

function metaValue(meta: PolicyMeta): JsonObject {
  return { schema: 1, paused: meta.paused, nextGrantOrder: meta.nextGrantOrder };
}

function parseGrant(record: StoredRecord): GrantRecord {
  const value = record.value;
  storedData(isRecord(value)
    && value.schema === 1
    && reference(value.id)
    && value.id === record.key
    && identifier(value.featureId)
    && reference(value.conversationId)
    && Array.isArray(value.capabilities)
    && value.capabilities.length > 0
    && value.capabilities.every(identifier)
    && new Set(value.capabilities).size === value.capabilities.length
    && isRecord(value.maxUses)
    && isRecord(value.used)
    && (value.expiresAt === null
      || typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt))
    && typeof value.active === 'boolean'
    && typeof value.order === 'number'
    && Number.isSafeInteger(value.order)
    && value.order > 0);
  const capabilities = value.capabilities as string[];
  storedData(Object.keys(value.maxUses).length === capabilities.length
    && Object.keys(value.used).length === capabilities.length);
  const maxUses: Record<string, number> = {};
  const used: Record<string, number> = {};
  for (const capability of capabilities) {
    const maximum = value.maxUses[capability];
    const consumed = value.used[capability];
    storedData(typeof maximum === 'number' && Number.isSafeInteger(maximum) && maximum >= 0
      && typeof consumed === 'number' && Number.isSafeInteger(consumed)
      && consumed >= 0 && consumed <= maximum);
    maxUses[capability] = maximum;
    used[capability] = consumed;
  }
  return {
    id: value.id,
    featureId: value.featureId,
    conversationId: value.conversationId,
    capabilities,
    maxUses,
    expiresAt: value.expiresAt as number | null,
    active: value.active,
    used,
    order: value.order
  };
}

function grantValue(grant: GrantRecord): JsonObject {
  return {
    schema: 1,
    id: grant.id,
    featureId: grant.featureId,
    conversationId: grant.conversationId,
    capabilities: grant.capabilities,
    maxUses: grant.maxUses,
    expiresAt: grant.expiresAt,
    active: grant.active,
    used: grant.used,
    order: grant.order
  };
}

function indexNamespace(featureId: string, conversationId: string): string {
  const digest = createHash('sha256').update(JSON.stringify([featureId, conversationId])).digest('hex');
  return `${INDEX_NAMESPACE_PREFIX}.${digest}`;
}

function indexValue(grant: GrantRecord): JsonObject {
  return {
    schema: 1,
    grantId: grant.id,
    featureId: grant.featureId,
    conversationId: grant.conversationId
  };
}

function indexedGrantId(record: StoredRecord, featureId: string, conversationId: string): string | null {
  const value = record.value;
  if (!isRecord(value)
    || value.schema !== 1
    || !reference(value.grantId)
    || value.grantId !== record.key
    || value.featureId !== featureId
    || value.conversationId !== conversationId) return null;
  return value.grantId;
}

function currentIndexVersion(record: StoredRecord | null): boolean {
  if (!record) return false;
  const value = record.value;
  storedData(isRecord(value) && value.schema === 1 && value.version === INDEX_VERSION);
  return true;
}

function usable(grant: GrantRecord, currentTime: number): boolean {
  return grant.active && (grant.expiresAt === null || currentTime < grant.expiresAt);
}

export function createPersistentPolicy({ store, clock = Date.now }: PersistentPolicyOptions) {
  assert(store && typeof store.read === 'function' && typeof store.write === 'function',
    'INVALID_POLICY', 'A durable store is required.');
  assert(typeof clock === 'function', 'INVALID_POLICY', 'Clock must be a function.');
  const reservations = new Map<string, Reservation>();

  function now(): number {
    const value = clock();
    assert(typeof value === 'number' && Number.isFinite(value),
      'INVALID_POLICY', 'Clock must return a finite timestamp.');
    return value;
  }

  function allRecords(namespace: string): StoredRecord[] {
    const records: StoredRecord[] = [];
    let after: string | undefined;
    do {
      const page = store.list(namespace, {
        limit: PAGE_SIZE,
        ...(after === undefined ? {} : { after })
      });
      records.push(...page);
      after = page.at(-1)?.key;
      if (page.length < PAGE_SIZE) break;
    } while (after !== undefined);
    return records;
  }

  function allGrantRecords(): StoredRecord[] {
    return allRecords(GRANT_NAMESPACE);
  }

  function ensureGrantIndex(grantRecord: GrantRecord): void {
    const namespace = indexNamespace(grantRecord.featureId, grantRecord.conversationId);
    const value = indexValue(grantRecord);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const current = store.read(namespace, grantRecord.id);
      if (current && indexedGrantId(current, grantRecord.featureId, grantRecord.conversationId) === grantRecord.id) return;
      try {
        store.write(namespace, grantRecord.id, value, {
          expectedRevision: current?.revision ?? null
        });
        return;
      } catch (error: unknown) {
        if (!conflict(error)) throw error;
      }
    }
    throw new FrameworkError('POLICY_CONFLICT', 'Policy index changed concurrently.');
  }

  function recoverGrantIndex(): void {
    const initial = store.read(INDEX_META_NAMESPACE, INDEX_META_KEY);
    if (currentIndexVersion(initial)) return;
    for (const stored of allGrantRecords()) ensureGrantIndex(parseGrant(stored));
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const current = store.read(INDEX_META_NAMESPACE, INDEX_META_KEY);
      if (currentIndexVersion(current)) return;
      try {
        store.write(INDEX_META_NAMESPACE, INDEX_META_KEY, { schema: 1, version: INDEX_VERSION }, {
          expectedRevision: current?.revision ?? null
        });
        return;
      } catch (error: unknown) {
        if (!conflict(error)) throw error;
      }
    }
    throw new FrameworkError('POLICY_CONFLICT', 'Policy index recovery changed concurrently.');
  }

  function updateMeta(change: (meta: PolicyMeta) => PolicyMeta): PolicyMeta {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const current = store.read(META_NAMESPACE, META_KEY);
      const next = change(parseMeta(current));
      try {
        store.write(META_NAMESPACE, META_KEY, metaValue(next), {
          expectedRevision: current?.revision ?? null
        });
        return next;
      } catch (error: unknown) {
        if (!conflict(error)) throw error;
      }
    }
    throw new FrameworkError('POLICY_CONFLICT', 'Policy changed concurrently.');
  }

  function allocateOrder(): number {
    return updateMeta((meta) => {
      assert(meta.nextGrantOrder < Number.MAX_SAFE_INTEGER,
        'POLICY_CAPACITY', 'Policy grant order is exhausted.');
      return { ...meta, nextGrantOrder: meta.nextGrantOrder + 1 };
    }).nextGrantOrder;
  }

  function grant(input: unknown): string {
    const value = snapshot(input);
    assert(isRecord(value) && reference(value.id) && identifier(value.featureId) && reference(value.conversationId),
      'INVALID_GRANT', 'Grant identity and scope are required.');
    assert(Array.isArray(value.capabilities) && value.capabilities.length > 0
      && value.capabilities.every(identifier) && new Set(value.capabilities).size === value.capabilities.length,
    'INVALID_GRANT', 'Explicit capabilities are required.');
    assert(isRecord(value.maxUses),
      'INVALID_GRANT', 'Each capability needs an explicit finite attempt budget.');
    const maxUsesInput = value.maxUses;
    assert(Object.keys(maxUsesInput).length === value.capabilities.length
      && value.capabilities.every((capability) => Number.isSafeInteger(maxUsesInput[capability])
        && typeof maxUsesInput[capability] === 'number'
        && maxUsesInput[capability] >= 0),
    'INVALID_GRANT', 'Each capability needs an explicit finite attempt budget.');
    const expiresAt = value.expiresAt ?? null;
    assert(expiresAt === null || (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > now()),
      'INVALID_GRANT', 'Grant expiry must be in the future.');
    assert(store.read(GRANT_NAMESPACE, value.id) === null, 'GRANT_EXISTS', 'Grant ids cannot be replaced.');
    const capabilities = value.capabilities as string[];
    const maxUses = Object.fromEntries(
      capabilities.map((capability) => [capability, maxUsesInput[capability]])
    ) as Record<string, number>;
    const record: GrantRecord = {
      id: value.id,
      featureId: value.featureId,
      conversationId: value.conversationId,
      capabilities,
      maxUses,
      expiresAt,
      active: true,
      used: Object.fromEntries(capabilities.map((capability) => [capability, 0])),
      order: allocateOrder()
    };
    ensureGrantIndex(record);
    try {
      store.write(GRANT_NAMESPACE, record.id, grantValue(record), { expectedRevision: null });
    } catch (error: unknown) {
      if (conflict(error)) throw new FrameworkError('GRANT_EXISTS', 'Grant ids cannot be replaced.');
      throw error;
    }
    return record.id;
  }

  function matchingGrants({ featureId, conversationId, capability }: EffectAuthorization): IndexedGrant[] {
    const matches: IndexedGrant[] = [];
    for (const indexed of allRecords(indexNamespace(featureId, conversationId))) {
      const grantId = indexedGrantId(indexed, featureId, conversationId);
      if (!grantId) continue;
      const stored = store.read(GRANT_NAMESPACE, grantId);
      if (!stored) continue;
      const grantRecord = parseGrant(stored);
      if (grantRecord.featureId !== featureId
        || grantRecord.conversationId !== conversationId
        || !grantRecord.capabilities.includes(capability)) continue;
      matches.push({ stored, grant: grantRecord });
    }
    return matches.sort((left, right) => left.grant.order - right.grant.order
      || left.grant.id.localeCompare(right.grant.id));
  }

  function reserve(authorization: EffectAuthorization): Reservation {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      assert(!parseMeta(store.read(META_NAMESPACE, META_KEY)).paused, 'POLICY_PAUSED', 'Effects are paused.');
      const matches = matchingGrants(authorization);
      let authorized = false;
      let retry = false;
      for (const match of matches) {
        const current = match.stored;
        const selected = match.grant;
        if (!usable(selected, now())) continue;
        authorized = true;
        if (selected.used[authorization.capability] >= selected.maxUses[authorization.capability]) continue;
        const updated: GrantRecord = {
          ...selected,
          used: {
            ...selected.used,
            [authorization.capability]: selected.used[authorization.capability] + 1
          }
        };
        try {
          store.write(GRANT_NAMESPACE, selected.id, grantValue(updated), {
            expectedRevision: current.revision
          });
        } catch (error: unknown) {
          if (!conflict(error)) throw error;
          retry = true;
          break;
        }
        assert(!parseMeta(store.read(META_NAMESPACE, META_KEY)).paused,
          'POLICY_PAUSED', 'Effects are paused.');
        const reservation = snapshot({
          id: randomUUID(),
          grantId: selected.id,
          featureId: authorization.featureId,
          conversationId: authorization.conversationId,
          capability: authorization.capability
        });
        reservations.set(reservation.id, reservation);
        return reservation;
      }
      if (retry) continue;
      assert(authorized, 'POLICY_DENIED', 'No active grant authorizes this effect.');
      throw new FrameworkError('BUDGET_EXHAUSTED', 'The effect attempt budget is exhausted.');
    }
    throw new FrameworkError('POLICY_CONFLICT', 'Policy changed concurrently.');
  }

  function begin(reservation: unknown): void {
    assert(isRecord(reservation) && reference(reservation.id),
      'INVALID_RESERVATION', 'A fresh host reservation is required.');
    const held = reservations.get(reservation.id);
    assert(held && Object.is(held, reservation),
      'INVALID_RESERVATION', 'A fresh host reservation is required.');
    reservations.delete(reservation.id);
    assert(!parseMeta(store.read(META_NAMESPACE, META_KEY)).paused,
      'POLICY_PAUSED', 'Effects are paused.');
    const record = store.read(GRANT_NAMESPACE, held.grantId);
    assert(record && parseGrant(record).active, 'GRANT_REVOKED', 'The effect grant was revoked.');
    const owner = parseGrant(record);
    assert(owner.expiresAt === null || now() < owner.expiresAt,
      'GRANT_EXPIRED', 'The effect grant expired.');
  }

  function revoke(id: string): boolean {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const current = store.read(GRANT_NAMESPACE, id);
      if (!current) return false;
      const grantRecord = parseGrant(current);
      if (!grantRecord.active) return true;
      try {
        store.write(GRANT_NAMESPACE, id, grantValue({ ...grantRecord, active: false }), {
          expectedRevision: current.revision
        });
        return true;
      } catch (error: unknown) {
        if (!conflict(error)) throw error;
      }
    }
    throw new FrameworkError('POLICY_CONFLICT', 'Policy changed concurrently.');
  }

  function setPaused(value: boolean): void {
    assert(typeof value === 'boolean', 'INVALID_POLICY', 'Pause state must be boolean.');
    updateMeta((meta) => meta.paused === value ? meta : { ...meta, paused: value });
  }

  function describe() {
    const currentTime = now();
    const grants = allGrantRecords().map(parseGrant)
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
    return snapshot({
      paused: parseMeta(store.read(META_NAMESPACE, META_KEY)).paused,
      grants: grants.map((grantRecord) => ({
        id: grantRecord.id,
        featureId: grantRecord.featureId,
        conversationId: grantRecord.conversationId,
        capabilities: grantRecord.capabilities,
        maxUses: grantRecord.maxUses,
        used: grantRecord.used,
        expiresAt: grantRecord.expiresAt,
        active: usable(grantRecord, currentTime)
      }))
    });
  }

  recoverGrantIndex();
  return Object.freeze({ grant, reserve, begin, revoke, setPaused, describe });
}
