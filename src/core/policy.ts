import { assertAccountScope, normalizeAccountScope } from './account-scope.ts';
import type { AccountScope } from '../contracts/account-scope.ts';
import { randomUUID } from 'node:crypto';
import { assert, identifier, isRecord, reference, snapshot } from './values.ts';
import type { Clock } from './types.ts';
import { incrementPolicyUsage, isPolicyAttemptLimit, type PolicyAttemptLimits } from './policy-limits.ts';

interface GrantRecord {
  accountScope?: Readonly<AccountScope>;
  id: string;
  featureId: string;
  conversationId: string;
  capabilities: string[];
  maxUses: PolicyAttemptLimits;
  expiresAt: number | null;
  active: boolean;
  used: Record<string, number>;
}
interface EffectAuthorization { accountScope?: Readonly<AccountScope>; featureId: string; conversationId: string; capability: string }
interface Reservation extends EffectAuthorization { id: string; grantId: string }
type CapabilityGrants = Map<string, GrantRecord[]>;
type ConversationGrants = Map<string, CapabilityGrants>;

export function createPolicy({ clock = Date.now, accountScope: accountInput }: { clock?: Clock; accountScope?: AccountScope } = {}) {
  const accountScope = accountInput === undefined ? undefined : normalizeAccountScope(accountInput);
  const grants = new Map<string, GrantRecord>();
  const grantsByScope = new Map<string, ConversationGrants>();
  const reservations = new Map<string, Reservation>();
  let paused = false;

  function usable(grant: GrantRecord) {
    return grant.active && (grant.expiresAt === null || clock() < grant.expiresAt);
  }

  function indexGrant(value: GrantRecord) {
    let conversations = grantsByScope.get(value.featureId);
    if (!conversations) {
      conversations = new Map();
      grantsByScope.set(value.featureId, conversations);
    }
    let capabilities = conversations.get(value.conversationId);
    if (!capabilities) {
      capabilities = new Map();
      conversations.set(value.conversationId, capabilities);
    }
    for (const capability of value.capabilities) {
      let matching = capabilities.get(capability);
      if (!matching) {
        matching = [];
        capabilities.set(capability, matching);
      }
      matching.push(value);
    }
  }

  function grant(input: unknown) {
    const value = snapshot(input);
    assert(isRecord(value) && reference(value.id) && identifier(value.featureId) && reference(value.conversationId),
      'INVALID_GRANT', 'Grant identity and scope are required.');
    assertAccountScope(accountScope, value.accountScope);
    assert(!grants.has(value.id), 'GRANT_EXISTS', 'Grant ids cannot be replaced.');
    assert(Array.isArray(value.capabilities) && value.capabilities.length > 0
      && value.capabilities.every(identifier) && new Set(value.capabilities).size === value.capabilities.length,
    'INVALID_GRANT', 'Explicit capabilities are required.');
    assert(Object.hasOwn(value, 'maxUses') && isRecord(value.maxUses),
      'INVALID_GRANT', 'Each capability needs an explicit attempt limit.');
    const maxUses = value.maxUses;
    assert(Object.keys(maxUses).length === value.capabilities.length
      && value.capabilities.every(capability => Object.hasOwn(maxUses, capability) && isPolicyAttemptLimit(maxUses[capability])),
    'INVALID_GRANT', 'Each capability needs a nonnegative finite attempt limit or explicit null.');
    const expiresAt = value.expiresAt ?? null;
    assert(expiresAt === null || (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > clock()),
      'INVALID_GRANT', 'Grant expiry must be in the future.');
    const record = { ...(accountScope ? { accountScope } : {}), id: value.id, featureId: value.featureId, conversationId: value.conversationId,
      capabilities: value.capabilities, maxUses: maxUses as PolicyAttemptLimits, expiresAt, active: true,
      used: Object.fromEntries(value.capabilities.map(capability => [capability, 0])) };
    grants.set(value.id, record);
    indexGrant(record);
    return value.id;
  }

  function reserve({ featureId, conversationId, capability, accountScope: scope }: EffectAuthorization): Reservation {
    assertAccountScope(accountScope, scope);
    assert(!paused, 'POLICY_PAUSED', 'Effects are paused.');
    const matching = grantsByScope.get(featureId)?.get(conversationId)?.get(capability) ?? [];
    let authorized = false;
    let selected: GrantRecord | undefined;
    for (const value of matching) {
      if (!usable(value)) continue;
      authorized = true;
      const maximum = value.maxUses[capability];
      if (maximum === null || value.used[capability] < maximum) {
        selected = value;
        break;
      }
    }
    assert(authorized, 'POLICY_DENIED', 'No active grant authorizes this effect.');
    assert(selected, 'BUDGET_EXHAUSTED', 'The effect attempt budget is exhausted.');
    selected.used[capability] = incrementPolicyUsage(selected.used[capability]);
    const reservation = snapshot({ ...(accountScope ? { accountScope } : {}), id: randomUUID(), grantId: selected.id, featureId, conversationId, capability });
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
    assert(owner.featureId === held.featureId && owner.conversationId === held.conversationId
      && owner.capabilities.includes(held.capability), 'POLICY_DENIED', 'The effect grant scope changed.');
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
        ...(value.accountScope ? { accountScope: value.accountScope } : {}), capabilities: value.capabilities, maxUses: value.maxUses, used: value.used,
        expiresAt: value.expiresAt, active: usable(value),
      })) });
    },
  });
}
