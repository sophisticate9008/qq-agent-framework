import { isNativeAccessAccount, isNativeAccessScope } from '../contracts/native-access.ts';
import { FrameworkError, assert, isRecord, reference, snapshot } from '../core/values.ts';
import type { NativeChatAccess } from './native-chat-configuration.ts';

export interface AccessDocument {
  readonly revision: string;
  readonly value: NativeChatAccess;
}

export interface AccessChangeRequest {
  readonly actorId: string;
  readonly expectedRevision: string;
  readonly kind: 'group' | 'private';
  readonly targetId: string;
  readonly operation: 'add' | 'remove';
  readonly sourceId: string;
}

export interface AccessChangeResult {
  readonly state: 'applied' | 'unchanged';
  readonly document: AccessDocument;
  readonly sourceId: string;
}

export interface AccessServiceOptions {
  read(): Promise<AccessDocument>;
  compareAndSet(expectedRevision: string, next: NativeChatAccess, signal: AbortSignal): Promise<AccessDocument>;
  publish?(saved: AccessDocument, previous: AccessDocument, signal: AbortSignal): Promise<void>;
  readonly timeoutMs?: number;
}

export class AccessServiceError extends FrameworkError {
  readonly saved: AccessDocument | null;
  readonly sourceId: string | null;

  constructor(code: string, message: string, saved: AccessDocument | null = null, sourceId: string | null = null) {
    super(code, message);
    this.name = 'AccessServiceError';
    this.saved = saved;
    this.sourceId = sourceId;
  }
}

const account = (value: unknown): value is string => isNativeAccessAccount(value, 20);
const scope = (value: unknown): value is string => isNativeAccessScope(value, 20);
const keys = (value: Record<string, unknown>, names: readonly string[]) => Object.keys(value).length === names.length
  && names.every(name => Object.hasOwn(value, name));

function entries(value: unknown): readonly string[] {
  assert(Array.isArray(value) && value.length <= 1024 && value.every(scope) && new Set(value).size === value.length,
    'ACCESS_INVALID_DOCUMENT', 'Access rules require distinct canonical conversation identifiers within capacity.');
  return value;
}

function document(input: unknown): AccessDocument {
  try {
    const value = snapshot(input);
    assert(isRecord(value) && keys(value, ['revision', 'value']) && reference(value.revision) && value.revision.trim().length > 0
      && isRecord(value.value) && keys(value.value, ['allow', 'deny', 'owner'])
      && (value.value.owner === null || account(value.value.owner)), 'ACCESS_INVALID_DOCUMENT', 'Invalid access document.');
    const allow = entries(value.value.allow);
    const deny = entries(value.value.deny);
    const denied = new Set(deny);
    assert(!allow.some(entry => denied.has(entry)), 'ACCESS_INVALID_DOCUMENT', 'Access rules cannot overlap deny rules.');
    return snapshot({ revision: value.revision, value: { allow, deny, owner: value.value.owner } });
  } catch {
    throw new AccessServiceError('ACCESS_INVALID_DOCUMENT', 'The access document is invalid.');
  }
}

function request(input: unknown): AccessChangeRequest {
  try {
    const value = snapshot(input);
    assert(isRecord(value) && keys(value, ['actorId', 'expectedRevision', 'kind', 'targetId', 'operation', 'sourceId'])
      && account(value.actorId) && account(value.targetId) && reference(value.expectedRevision) && value.expectedRevision.trim().length > 0
      && reference(value.sourceId) && value.sourceId.trim().length > 0
      && (value.kind === 'group' || value.kind === 'private') && (value.operation === 'add' || value.operation === 'remove'),
    'ACCESS_INVALID_REQUEST', 'An explicit actor, revision, target, operation and source are required.');
    return snapshot({ actorId: value.actorId, expectedRevision: value.expectedRevision, kind: value.kind,
      targetId: value.targetId, operation: value.operation, sourceId: value.sourceId });
  } catch {
    throw new AccessServiceError('ACCESS_INVALID_REQUEST', 'The access change request is invalid.');
  }
}

export function createAccessService(options: AccessServiceOptions) {
  const { read, compareAndSet, publish, timeoutMs = 10_000 } = options;
  assert(typeof read === 'function' && typeof compareAndSet === 'function' && (publish === undefined || typeof publish === 'function')
    && Number.isSafeInteger(timeoutMs) && timeoutMs >= 10 && timeoutMs <= 300_000,
  'ACCESS_INVALID_OPTIONS', 'Access callbacks and a bounded operation deadline are required.');
  let busy = false;

  function run<Value>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<Value>, interrupted: () => AccessServiceError): Promise<Value> {
    if (!(signal instanceof AbortSignal)) return Promise.reject(new AccessServiceError('ACCESS_INVALID_REQUEST', 'An operation signal is required.'));
    if (signal.aborted) return Promise.reject(interrupted());
    if (busy) return Promise.reject(new AccessServiceError('ACCESS_SERVICE_BUSY', 'A previous access operation has not settled.'));
    busy = true;
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    return new Promise<Value>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(abort, timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      function abort() {
        if (settled) return;
        settled = true;
        cleanup();
        const failure = interrupted();
        controller.abort();
        reject(failure);
      }
      signal.addEventListener('abort', abort, { once: true });
      const raw = Promise.resolve().then(() => {
        if (combined.aborted) throw interrupted();
        return work(combined);
      });
      raw.then(value => {
        busy = false;
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      }, failure => {
        busy = false;
        if (settled) return;
        settled = true;
        cleanup();
        reject(failure);
      });
    });
  }

  async function load(signal: AbortSignal, interrupted: () => AccessServiceError): Promise<AccessDocument> {
    if (signal.aborted) throw interrupted();
    let value: AccessDocument;
    try { value = await read(); }
    catch { throw new AccessServiceError('ACCESS_READ_UNKNOWN', 'Access rules could not be read.'); }
    if (signal.aborted) throw interrupted();
    return document(value);
  }

  return Object.freeze({
    read(signal: AbortSignal = new AbortController().signal): Promise<AccessDocument> {
      const interrupted = () => new AccessServiceError('ACCESS_READ_UNKNOWN', 'The access read did not complete within its active deadline.');
      return run(signal, combined => load(combined, interrupted), interrupted);
    },
    change(input: AccessChangeRequest, signal: AbortSignal): Promise<AccessChangeResult> {
      let change: AccessChangeRequest;
      try { change = request(input); }
      catch (failure) { return Promise.reject(failure); }
      let saved: AccessDocument | null = null;
      let writing = false;
      const reloadRequired = () => new AccessServiceError('APPLIED_RELOAD_REQUIRED',
        'Access rules were saved, but runtime publication was not confirmed. Reload the saved rules; do not repeat the change.', saved, change.sourceId);
      const interrupted = () => saved ? reloadRequired() : new AccessServiceError(writing ? 'ACCESS_CHANGE_UNKNOWN' : 'ACCESS_READ_UNKNOWN',
        writing ? 'The access write result is unknown. Read the saved rules before taking further action.' : 'The access read did not complete.', null, change.sourceId);
      return run(signal, async combined => {
        const previous = await load(combined, interrupted);
        if (combined.aborted) throw interrupted();
        if (previous.value.owner === null || previous.value.owner !== change.actorId)
          throw new AccessServiceError('ACCESS_OWNER_REQUIRED', 'Only the currently configured owner can change access rules.', null, change.sourceId);
        if (previous.revision !== change.expectedRevision)
          throw new AccessServiceError('ACCESS_REVISION_CONFLICT', 'The access revision changed. Read the current rules first.', null, change.sourceId);
        const target = `${change.kind}:${change.targetId}`;
        if (change.operation === 'add' && previous.value.deny.includes(target))
          throw new AccessServiceError('ACCESS_DENIED', 'A deny rule prevents adding this conversation.', null, change.sourceId);
        const present = previous.value.allow.includes(target);
        if (present === (change.operation === 'add')) return snapshot({ state: 'unchanged' as const, document: previous, sourceId: change.sourceId });
        const allow = change.operation === 'add' ? [...previous.value.allow, target] : previous.value.allow.filter(entry => entry !== target);
        if (allow.length > 1024) throw new AccessServiceError('ACCESS_LIMIT_EXCEEDED', 'The access allow list is at capacity.', null, change.sourceId);
        const next = snapshot({ allow, deny: previous.value.deny, owner: previous.value.owner });
        if (combined.aborted) throw interrupted();
        writing = true;
        let result: AccessDocument;
        try { result = await compareAndSet(previous.revision, next, combined); }
        catch (failure) {
          if (!combined.aborted && isRecord(failure) && ['ACCESS_REVISION_CONFLICT', 'STORE_CONFLICT', 'chat_revision_conflict'].includes(String(failure.code)))
            throw new AccessServiceError('ACCESS_REVISION_CONFLICT', 'The access revision changed. Read the current rules first.', null, change.sourceId);
          throw interrupted();
        }
        try {
          const confirmed = document(result);
          assert(confirmed.revision !== previous.revision && JSON.stringify(confirmed.value) === JSON.stringify(next),
            'ACCESS_CHANGE_UNKNOWN', 'The callback did not confirm the requested access revision.');
          saved = confirmed;
        } catch { throw interrupted(); }
        if (combined.aborted) throw reloadRequired();
        if (publish) {
          try {
            await publish(saved, previous, combined);
            if (combined.aborted) throw reloadRequired();
          } catch { throw reloadRequired(); }
        }
        return snapshot({ state: 'applied' as const, document: saved, sourceId: change.sourceId });
      }, interrupted);
    }
  });
}

export type AccessService = ReturnType<typeof createAccessService>;
