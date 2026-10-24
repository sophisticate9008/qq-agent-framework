import { randomUUID } from 'node:crypto';
import { assert, identifier, isRecord, reference, snapshot } from './values.ts';
import type { Clock } from './types.ts';

interface GrantRecord {
  id: string;
  featureId: string;
  conversationId: string;
  capabilities: string[];
  maxUses: Record<string, number>;
  expiresAt: number | null;
  active: boolean;
  used: Record<string, number>;
}
interface EffectAuthorization { featureId: string; conversationId: string; capability: string }
interface Reservation extends EffectAuthorization { id: string; grantId: string }

export function createPolicy({ clock = Date.now }: { clock?: Clock } = {}) {
  const grants = new Map<string, GrantRecord>();
  const reservations = new Map<string, Reservation>();
  let paused = false;

  function usable(grant: GrantRecord) {
    return grant.active && (grant.expiresAt === null || clock() < grant.expiresAt);
  }

  function grant(input: unknown) {
    const value = snapshot(input);
    assert(isRecord(value) && reference(value.id) && identifier(value.featureId) && reference(value.conversationId),
      'INVALID_GRANT', 'Grant identity and scope are required.');
    assert(!grants.has(value.id), 'GRANT_EXISTS', 'Grant ids cannot be replaced.');
    assert(Array.isArray(value.capabilities) && value.capabilities.length > 0
      && value.capabilities.every(identifier) && new Set(value.capabilities).size === value.capabilities.length,
    'INVALID_GRANT', 'Explicit capabilities are required.');
    assert(isRecord(value.maxUses)
      && Object.keys(value.maxUses).length === value.capabilities.length
      && value.capabilities.every(capability => Number.isSafeInteger((value.maxUses as Record<string, unknown>)[capability])
        && typeof (value.maxUses as Record<string, unknown>)[capability] === 'number'
        && ((value.maxUses as Record<string, number>)[capability] >= 0)),
    'INVALID_GRANT', 'Each capability needs an explicit finite attempt budget.');
    const expiresAt = value.expiresAt ?? null;
    assert(expiresAt === null || (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > clock()),
      'INVALID_GRANT', 'Grant expiry must be in the future.');
    grants.set(value.id, { id: value.id, featureId: value.featureId, conversationId: value.conversationId,
      capabilities: value.capabilities, maxUses: value.maxUses as Record<string, number>, expiresAt, active: true,
      used: Object.fromEntries(value.capabilities.map(capability => [capability, 0])) });
    return value.id;
  }

  function reserve({ featureId, conversationId, capability }: EffectAuthorization): Reservation {
    assert(!paused, 'POLICY_PAUSED', 'Effects are paused.');
    const matching = [...grants.values()].filter(value => value.featureId === featureId
      && value.conversationId === conversationId && value.capabilities.includes(capability) && usable(value));
    assert(matching.length > 0, 'POLICY_DENIED', 'No active grant authorizes this effect.');
    const selected = matching.find(value => value.used[capability] < value.maxUses[capability]);
    assert(selected, 'BUDGET_EXHAUSTED', 'The effect attempt budget is exhausted.');
    selected.used[capability]++;
    const reservation = snapshot({ id: randomUUID(), grantId: selected.id, featureId, conversationId, capability });
    reservations.set(reservation.id, reservation);
    return reservation;
  }

  function begin(reservation: unknown) {
    assert(isRecord(reservation) && reference(reservation.id), 'INVALID_RESERVATION', 'A fresh host reservation is required.');
    const held = reservations.get(reservation.id);
    assert(held && Object.is(held, reservation), 'INVALID_RESERVATION', 'A fresh host reservation is required.');
    reservations.delete(reservation.id);
    assert(!paused, 'POLICY_PAUSED', 'Effects are paused.');
    const owner = grants.get(held.grantId);
    assert(owner?.active, 'GRANT_REVOKED', 'The effect grant was revoked.');
    assert(owner.expiresAt === null || clock() < owner.expiresAt, 'GRANT_EXPIRED', 'The effect grant expired.');
  }

  return Object.freeze({
    grant,
    reserve,
    begin,
    revoke(id: string) {
      const value = grants.get(id);
      if (!value) return false;
      value.active = false;
      return true;
    },
    setPaused(value: boolean) {
      assert(typeof value === 'boolean', 'INVALID_POLICY', 'Pause state must be boolean.');
      paused = value;
    },
    describe() {
      return snapshot({ paused, grants: [...grants.values()].map(value => ({
        id: value.id, featureId: value.featureId, conversationId: value.conversationId,
        capabilities: value.capabilities, maxUses: value.maxUses, used: value.used,
        expiresAt: value.expiresAt, active: usable(value),
      })) });
    },
  });
}
