import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { NativeApplicationPhase, NativeApplicationRequest, NativeApplicationSnapshot } from '../contracts/native-application.ts';
import { nativeApplicationRequiresReconciliation, parseNativeApplicationRequest, parseNativeApplicationSnapshot } from '../contracts/native-application.ts';
import type { NativeConfigurationRevisions } from '../contracts/native-revisions.ts';
import { isNativeConfigurationRevisions, NATIVE_CONFIGURATION_REVISION_KEYS } from '../contracts/native-revisions.ts';
import type { NativeDeploymentApplyResult, NativeDeploymentPreparationResult, NativeDeploymentReconciliationResult } from '../contracts/native-deployment.ts';
import { assert, errorCode, snapshot } from '../core/values.ts';
import type { NativeSessionMigrationCommit, NativeSessionMigrationResult } from './native-session-migration.ts';
import { digest } from './data.ts';
import { withDeadline } from './deadlines.ts';

export interface NativeApplicationRuntimeStatus {
  readonly state: string;
  readonly canStart: boolean;
  readonly canApplyDeployment: boolean;
  readonly chatReady: boolean;
  readonly revisions: Readonly<Record<string, string>>;
  readonly missingReasons: readonly string[];
  readonly configurationCompatibility: { readonly state: string };
  readonly quiescent?: boolean;
}
export interface NativeApplicationPorts {
  status(): Promise<NativeApplicationRuntimeStatus>;
  stop(signal: AbortSignal): Promise<NativeApplicationRuntimeStatus>;
  prepare(revision: string, signal: AbortSignal): Promise<{
    readonly revisions: Readonly<Record<string, string>>;
    readonly prepared: NativeDeploymentPreparationResult;
  }>;
  apply(revisions: NativeConfigurationRevisions, targetRevision: string, signal: AbortSignal): Promise<NativeDeploymentApplyResult>;
  reconcileDeployment(revisions: NativeConfigurationRevisions, signal: AbortSignal): Promise<NativeDeploymentReconciliationResult>;
  previewMigration(revisions: NativeConfigurationRevisions, signal: AbortSignal): Promise<NativeSessionMigrationResult>;
  migrate(request: NativeSessionMigrationCommit, signal: AbortSignal): Promise<NativeSessionMigrationResult>;
  start(revisions: NativeConfigurationRevisions, signal: AbortSignal): Promise<NativeApplicationRuntimeStatus>;
}
export interface NativeApplicationRecord {
  readonly request: NativeApplicationRequest;
  readonly instanceId: string;
  readonly snapshot: NativeApplicationSnapshot;
}
export interface NativeApplicationJournal {
  readonly schema: 1;
  readonly records: readonly NativeApplicationRecord[];
  readonly retired?: readonly string[];
}
export interface NativeApplicationStorage {
  read(): Promise<{ readonly revision: string; readonly value: NativeApplicationJournal }>;
  write(revision: string, value: NativeApplicationJournal): Promise<{ readonly revision: string; readonly value: NativeApplicationJournal }>;
}
export function validateNativeApplicationJournal(value: unknown): NativeApplicationJournal {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_APPLICATION_JOURNAL', 'Invalid application journal.');
  const data = value as Record<string, unknown>;
  assert(data.schema === 1 && Array.isArray(data.records) && data.records.length <= 1024,
    'INVALID_APPLICATION_JOURNAL', 'Application history must be bounded.');
  const ids = new Set<string>();
  const records = data.records.map(record => {
    assert(record !== null && typeof record === 'object' && !Array.isArray(record), 'INVALID_APPLICATION_JOURNAL', 'Invalid application record.');
    const item = record as Record<string, unknown>;
    const request = parseNativeApplicationRequest(item.request);
    const state = parseNativeApplicationSnapshot(item.snapshot);
    assert(request && state && request.operationId === state.id && !ids.has(state.id)
      && typeof item.instanceId === 'string' && item.instanceId.length <= 128,
    'INVALID_APPLICATION_JOURNAL', 'Invalid application request or state.');
    ids.add(state.id);
    return { request, snapshot: state, instanceId: item.instanceId };
  });
  const retired = data.retired ?? [];
  assert(Array.isArray(retired) && retired.length <= 8192 && retired.every(id => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id))
    && new Set(retired).size === retired.length && retired.every(id => !ids.has(id)), 'INVALID_APPLICATION_JOURNAL', 'Invalid retired operation identities.');
  return snapshot({ schema: 1, records, retired: retired as string[] });
}

const same = (left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>) =>
  isNativeConfigurationRevisions(left) && isNativeConfigurationRevisions(right)
  && Object.keys(left).every(key => left[key] === right[key]);
const reasons = (values: readonly string[]) => [...new Set(values.map(value =>
  /^[A-Za-z0-9_.:-]{1,160}$/.test(value) ? value : 'application_unverified'))].slice(0, 64);

/** One explicit application intent, durable phase boundaries, no unknown replay. Browser lifetime is unrelated. */
export function createNativeApplicationCoordinator(options: {
  readonly storage: NativeApplicationStorage;
  readonly ports: NativeApplicationPorts;
  readonly signal: AbortSignal;
  readonly clock?: () => number;
  readonly deploymentVerificationTimeoutMs?: number;
  readonly deploymentPollIntervalMs?: number;
}) {
  const instanceId = randomUUID();
  const now = options.clock ?? Date.now;
  const verificationTimeoutMs = options.deploymentVerificationTimeoutMs ?? 60_000;
  const pollIntervalMs = options.deploymentPollIntervalMs ?? 500;
  assert(Number.isSafeInteger(verificationTimeoutMs) && verificationTimeoutMs >= 1 && verificationTimeoutMs <= 60_000
    && Number.isSafeInteger(pollIntervalMs) && pollIntervalMs >= 1 && pollIntervalMs <= 10_000,
  'INVALID_APPLICATION_TIMEOUT', 'Application deployment observation must be bounded.');
  let active: Promise<void> | undefined;
  let starting = false;
  let pendingEffects = 0;
  let inMemoryUnknown: NativeApplicationSnapshot | undefined;
  function project(record: NativeApplicationRecord): NativeApplicationSnapshot {
    if (inMemoryUnknown?.id === record.snapshot.id) return snapshot(inMemoryUnknown);
    return record.snapshot.state === 'running' && record.instanceId !== instanceId
      ? snapshot({ ...record.snapshot, state: 'unknown', reasons: ['application_process_interrupted'] }) : snapshot(record.snapshot);
  }
  async function update(id: string, change: Partial<NativeApplicationSnapshot>) {
    const prior = await options.storage.read();
    const record = prior.value.records.find(record => record.snapshot.id === id);
    assert(record && record.instanceId === instanceId, 'APPLICATION_OWNERSHIP_CHANGED', 'This application no longer owns the journal.');
    const next = { ...record.snapshot, ...change, updatedAt: now() };
    assert(parseNativeApplicationSnapshot(next), 'INVALID_APPLICATION_STATE', 'Invalid application phase transition.');
    try {
      await options.storage.write(prior.revision, { ...prior.value, schema: 1, records: prior.value.records.map(item => item.snapshot.id === id
        ? { ...record, snapshot: next } : item) });
    } catch (error) {
      inMemoryUnknown = { ...next, state: 'unknown', reasons: ['application_journal_write_unknown'] };
      throw error;
    }
    return next;
  }
  async function verifyDeployment(revisions: NativeConfigurationRevisions, signal: AbortSignal) {
    const result = await withDeadline({ signal, timeoutMs: 10_000, code: 'APPLICATION_DEPLOYMENT_READ_UNAVAILABLE',
      run: phaseSignal => options.ports.reconcileDeployment(revisions, phaseSignal) });
    return result.missingReasons.length === 0 && result.presetBindings.length > 0
      && result.verificationScope === 'provider-preset-and-managed-file-provenance'
      && result.credentialValueIdentityVerified === false;
  }
  async function run(request: NativeApplicationRequest, continuation?: { readonly revisions: NativeConfigurationRevisions }) {
    const id = request.operationId;
    let currentRevisions = continuation?.revisions ?? request.revisions;
    let sideEffectStarted = false;
    let lastPhase: NativeApplicationPhase | null = continuation ? 'apply' : null;
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(180_000)]);
    async function check(checkSignal = signal) {
      checkSignal.throwIfAborted();
      const status = await withDeadline({ signal: checkSignal, timeoutMs: 10_000, code: 'APPLICATION_STATUS_UNAVAILABLE', run: () => options.ports.status() });
      assert(same(status.revisions, currentRevisions), 'APPLICATION_CONFIGURATION_CHANGED', 'Saved settings changed during application.');
      return status;
    }
    async function step<Result>(phase: NativeApplicationPhase, operation: (signal: AbortSignal) => Promise<Result>) {
      signal.throwIfAborted();
      lastPhase = phase;
      await update(id, { phase, phaseState: 'in-flight' });
      signal.throwIfAborted();
      sideEffectStarted = true;
      const result = await withDeadline({ signal, timeoutMs: 90_000, code: 'APPLICATION_PHASE_UNKNOWN', run: phaseSignal => {
        pendingEffects++;
        return Promise.resolve().then(() => operation(phaseSignal)).finally(() => { pendingEffects--; });
      } });
      await update(id, { phaseState: 'confirmed' });
      return result;
    }
    async function blocked(values: readonly string[]) { await update(id, { state: 'blocked', reasons: reasons(values) }); }
    async function waitForDeployment() {
      const deadline = AbortSignal.timeout(verificationTimeoutMs);
      const observationSignal = AbortSignal.any([signal, deadline]);
      try {
        while (!observationSignal.aborted) {
          await check(observationSignal);
          const verified = await verifyDeployment(currentRevisions, observationSignal);
          await check(observationSignal);
          if (verified) return true;
          await delay(pollIntervalMs, undefined, { signal: observationSignal });
        }
      } catch (error) {
        if (!deadline.aborted || signal.aborted) throw error;
      }
      signal.throwIfAborted();
      return false;
    }
    try {
      let status = await check();
      if (!continuation && (status.state === 'running' || status.state === 'error')) {
        const stopped = await step('stop', phaseSignal => options.ports.stop(phaseSignal));
        assert(stopped.state === 'stopped', 'APPLICATION_STOP_UNCONFIRMED', 'Stopping has not been confirmed.');
        status = await check();
      }
      assert(status.state === 'stopped', 'APPLICATION_RUNTIME_BUSY', 'Runtime is not stopped.');
      if (request.deploy && !continuation) {
        if (!status.canApplyDeployment) { await blocked(status.missingReasons); return; }
        const prepared = await step('prepare', phaseSignal => options.ports.prepare(currentRevisions.deployment, phaseSignal));
        assert(isNativeConfigurationRevisions(prepared.revisions)
          && same({ ...currentRevisions, deployment: prepared.revisions.deployment }, prepared.revisions),
        'APPLICATION_PREPARATION_UNVERIFIED', 'Prepared settings changed unrelated configuration.');
        currentRevisions = prepared.revisions;
        await update(id, { revisions: currentRevisions });
        if (prepared.prepared.state !== 'prepared') { await blocked(prepared.prepared.missingReasons); return; }
        assert(prepared.prepared.summary.missingReasons.length === 0, 'APPLICATION_PREPARATION_UNVERIFIED', 'Preparation remains blocked.');
        status = await check();
        assert(status.state === 'stopped' && status.canApplyDeployment, 'APPLICATION_RUNTIME_BUSY', 'Runtime changed before deployment.');
        const applied = await step('apply', phaseSignal => options.ports.apply(currentRevisions, prepared.prepared.targetRevision!, phaseSignal));
        if (applied.state === 'blocked' || applied.state === 'conflict') { await blocked(applied.missingReasons); return; }
        if (applied.state === 'pending_reload') {
          if (applied.missingReasons.some(reason => reason !== 'pending_reload')) {
            await update(id, { state: 'blocked', reasons: reasons(applied.missingReasons) });
            return;
          }
          await update(id, { reasons: ['pending_reload'] });
          if (!await waitForDeployment()) {
            const uncertain = applied.missingReasons.some(reason => reason !== 'pending_reload');
            await update(id, { state: uncertain ? 'unknown' : 'blocked', reasons: reasons(applied.missingReasons.length > 0
              ? applied.missingReasons : ['pending_reload']) });
            return;
          }
          await update(id, { reasons: [] });
        } else if (applied.state === 'unknown') {
          await update(id, { state: 'unknown', reasons: reasons(applied.missingReasons.length > 0
            ? applied.missingReasons : ['APPLICATION_DEPLOYMENT_UNCONFIRMED']) });
          return;
        } else {
          assert(applied.state === 'verified' && applied.missingReasons.length === 0,
            'APPLICATION_DEPLOYMENT_UNCONFIRMED', 'Deployment has no verified completion.');
        }
        status = await check();
      }
      // Updating the managed preset keeps the original DSH session and history.
      // Remaining compatibility failures describe storage/endpoint/unfinished work,
      // and must not implicitly fork sessions to work around them.
      if (status.configurationCompatibility.state === 'blocked') {
        await blocked(status.missingReasons.filter(reason => reason !== 'runtime_not_started'));
        return;
      }
      if (!status.canStart) { await blocked(status.missingReasons.filter(reason => reason !== 'runtime_not_started')); return; }
      const started = await step('start', phaseSignal => options.ports.start(currentRevisions, phaseSignal));
      assert(started.state === 'running' && started.chatReady && same(started.revisions, currentRevisions),
        'APPLICATION_START_UNCONFIRMED', 'Start has not been verified.');
      const verified = await check();
      assert(verified.state === 'running' && verified.chatReady, 'APPLICATION_START_UNCONFIRMED', 'Running state is unavailable.');
      await update(id, { state: 'completed', phase: 'start', phaseState: 'confirmed', reasons: [] });
    } catch (error) {
      const code = errorCode(error, 'APPLICATION_UNKNOWN');
      try { await update(id, { state: sideEffectStarted ? 'unknown' : 'blocked', phase: lastPhase,
        reasons: reasons([code]), ...(sideEffectStarted ? {} : { phaseState: 'pending' }) }); }
      catch { /* Keep the durable in-flight marker and the process-local unknown projection. */ }
    }
  }
  return Object.freeze({
    async reconcile(id: string): Promise<NativeApplicationSnapshot> {
      assert(!active && !starting && pendingEffects === 0, 'APPLICATION_BUSY', 'An application phase is still unsettled.');
      assert(!options.signal.aborted, 'APPLICATION_CLOSED', 'Application service is closed.');
      starting = true;
      try {
        const prior = await options.storage.read();
        const record = prior.value.records.find(item => item.snapshot.id === id);
        assert(record, 'APPLICATION_NOT_FOUND', 'The application was not found.');
        const current = project(record);
        if (current.reasons.some(reason => reason === 'session_configuration_reload_required'
          || reason === 'session_configuration_reload_unknown')) return current;
        const awaitingDeployment = current.phase === 'apply' && (current.state === 'unknown'
          || current.state === 'blocked' && current.reasons.includes('pending_reload'));
        if (current.state !== 'unknown' && !awaitingDeployment) return current;
        const observed = await withDeadline({ signal: options.signal, timeoutMs: 10_000,
          code: 'APPLICATION_STATUS_UNAVAILABLE', run: () => options.ports.status() });
        const sameRevisions = same(observed.revisions, current.revisions);
        const onlyPreparedDeploymentChanged = isNativeConfigurationRevisions(observed.revisions)
          && NATIVE_CONFIGURATION_REVISION_KEYS.every(key => key === 'deployment' || observed.revisions[key] === current.revisions[key]);
        const safelyStopped = observed.state === 'stopped' && observed.quiescent === true;
        const stoppedIntent = current.phase === null || current.phase === 'stop';
        const preparedIntent = current.phase === 'prepare' && onlyPreparedDeploymentChanged;
        if (safelyStopped && (stoppedIntent || preparedIntent)) {
          const settled: NativeApplicationSnapshot = { ...current, state: 'blocked', updatedAt: now(), reasons: [preparedIntent
            ? 'application_preparation_saved_new_intent_required' : 'application_stopped_verified_new_intent_required'] };
          await options.storage.write(prior.revision, { ...prior.value, schema: 1, records: prior.value.records.map(item => item.snapshot.id === id
            ? { ...item, instanceId, snapshot: settled } : item) });
          inMemoryUnknown = undefined;
          return snapshot(settled);
        }
        if (!sameRevisions) return current;
        if (awaitingDeployment && observed.state === 'stopped' && await verifyDeployment(current.revisions, options.signal)) {
          const checked = await withDeadline({ signal: options.signal, timeoutMs: 10_000,
            code: 'APPLICATION_STATUS_UNAVAILABLE', run: () => options.ports.status() });
          if (checked.state !== 'stopped' || !same(checked.revisions, current.revisions)) return current;
          const continuing: NativeApplicationSnapshot = { ...current, state: 'running', phaseState: 'confirmed', reasons: [], updatedAt: now() };
          await options.storage.write(prior.revision, { ...prior.value, schema: 1, records: prior.value.records.map(item => item.snapshot.id === id
            ? { ...item, instanceId, snapshot: continuing } : item) });
          inMemoryUnknown = undefined;
          active = run(record.request, { revisions: current.revisions }).finally(() => { active = undefined; });
          return snapshot(continuing);
        }
        let verified: NativeApplicationSnapshot | undefined;
        if (current.phase === 'start' && observed.state === 'running' && observed.chatReady) {
          verified = { ...current, state: 'completed', phaseState: 'confirmed', reasons: [], updatedAt: now() };
        } else if (safelyStopped && current.phase === 'migrate' && observed.configurationCompatibility.state === 'compatible') {
          verified = { ...current, state: 'blocked', reasons: ['application_stopped_verified_new_intent_required'], updatedAt: now() };
        }
        if (!verified) return current;
        await options.storage.write(prior.revision, { ...prior.value, schema: 1, records: prior.value.records.map(item => item.snapshot.id === id
          ? { ...item, instanceId, snapshot: verified! } : item) });
        inMemoryUnknown = undefined;
        return snapshot(verified);
      } finally { starting = false; }
    },
    async read(id?: string): Promise<NativeApplicationSnapshot | null> {
      const journal = await options.storage.read();
      const record = id === undefined ? journal.value.records.at(-1) : journal.value.records.find(record => record.snapshot.id === id);
      return record ? project(record) : null;
    },
    async create(input: NativeApplicationRequest): Promise<NativeApplicationSnapshot> {
      const request = parseNativeApplicationRequest(input);
      assert(request, 'INVALID_APPLICATION_REQUEST', 'An explicit versioned application request is required.');
      assert(!options.signal.aborted, 'APPLICATION_CLOSED', 'Application service is closed.');
      assert(!starting, 'APPLICATION_BUSY', 'Another application request is being admitted.');
      starting = true;
      try {
        const prior = await options.storage.read();
        const existing = prior.value.records.find(record => record.snapshot.id === request.operationId);
        if (existing) {
          assert(digest(existing.request) === digest(request), 'APPLICATION_ID_CONFLICT', 'An operation ID cannot change intent.');
          return project(existing);
        }
        assert(!prior.value.retired?.includes(request.operationId), 'APPLICATION_OPERATION_RETIRED', 'This completed operation cannot be submitted again.');
        assert(!active && !prior.value.records.some(record => nativeApplicationRequiresReconciliation(project(record))),
          'APPLICATION_RECONCILIATION_REQUIRED', 'An existing application requires reconciliation.');
        assert(prior.value.records.length < 1024, 'APPLICATION_HISTORY_FULL', 'Application journal capacity is full.');
        const status = await withDeadline({ signal: options.signal, timeoutMs: 10_000,
          code: 'APPLICATION_STATUS_UNAVAILABLE', run: () => options.ports.status() });
        assert(same(status.revisions, request.revisions), 'APPLICATION_CONFIGURATION_CHANGED', 'Saved settings changed before application.');
        const at = now();
        const state: NativeApplicationSnapshot = { schema: 1, id: request.operationId, state: 'running', phase: null,
          phaseState: 'pending', revisions: request.revisions, createdAt: at, updatedAt: at, reasons: [] };
        await options.storage.write(prior.revision, { ...prior.value, schema: 1, records: [...prior.value.records, { request, instanceId, snapshot: state }] });
        active = run(request).finally(() => { active = undefined; });
        return snapshot(state);
      } finally { starting = false; }
    },
    async drain() { await active; },
  });
}
