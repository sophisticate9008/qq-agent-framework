import { normalizeContent } from '../core/content.ts';
import type { AccountScope } from '../contracts/account-scope.ts';
import { assertAccountScope, normalizeAccountScope } from '../core/account-scope.ts';
import { bindAccountStore } from '../storage/account-scope.ts';
import type { Clock, DeliveryReceipt, TextContent } from '../core/types.ts';
import { assert, isRecord, reference, snapshot } from '../core/values.ts';
import { digest, json, object, records } from './data.ts';
import { withDeadline } from './deadlines.ts';
import type { DurableStore, InboundMessage, StoredRecord } from './types.ts';

export const CONTROL_COMMAND_NAMESPACE = 'host.control-commands';
export const CONTROL_COMMAND_TRUST_BOUNDARY = 'trusted-normalized-protocol-caller-required';

export interface ControlCommandContext {
  readonly message: Readonly<InboundMessage>;
  readonly signal: AbortSignal;
  readonly reply: (text: string) => Promise<DeliveryReceipt>;
}

export interface ControlCommandDefinition {
  readonly id: string;
  readonly matches: (message: Readonly<InboundMessage>) => boolean;
  readonly handle: (context: Readonly<ControlCommandContext>) => Promise<void>;
  readonly replyTexts?: readonly string[];
}

export interface ControlCommandSendRequest {
  readonly conversationId: string;
  readonly content: readonly [Readonly<TextContent>];
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
}

export interface ControlCommandResult {
  readonly handled: boolean;
  readonly status: 'unmatched' | 'ignored-self' | 'stopped' | 'capacity' | 'completed' | 'unknown';
  readonly commandId?: string;
  readonly duplicate?: boolean;
  readonly replyReceipt?: DeliveryReceipt;
}

interface Ledger {
  readonly schema: 1;
  readonly eventId: string;
  readonly conversationId: string;
  readonly commandId: string;
  readonly fingerprint: string;
  readonly state: 'running' | 'completed' | 'unknown';
  readonly replyState: 'none' | 'intent' | 'confirmed' | 'rejected' | 'unknown';
  readonly templateHash: string | null;
  readonly messageId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface Execution {
  readonly key: string;
  readonly controller: AbortController;
  record: StoredRecord;
  value: Ledger;
  active: boolean;
}

interface SharedState {
  readonly raw: Set<Promise<unknown>>;
  readonly inflight: Map<string, { readonly fingerprint: string; readonly promise: Promise<ControlCommandResult> }>;
  recordCount: number;
}

const sharedStores = new WeakMap<DurableStore, SharedState>();
const commandId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function readLedger(record: StoredRecord): Ledger {
  const value = object(record.value);
  assert(record.expiresAt === null && value.schema === 1 && reference(value.eventId) && reference(value.conversationId)
    && commandId(value.commandId) && hash(value.fingerprint)
    && ['running', 'completed', 'unknown'].includes(String(value.state))
    && ['none', 'intent', 'confirmed', 'rejected', 'unknown'].includes(String(value.replyState))
    && timestamp(value.createdAt) && timestamp(value.updatedAt)
    && (value.replyState === 'none' ? value.templateHash === null : hash(value.templateHash))
    && (value.replyState === 'confirmed' ? reference(value.messageId) : value.messageId === null)
    && record.key === digest([value.conversationId, value.eventId]),
  'CONTROL_COMMAND_LEDGER_INVALID', 'The control command ledger is invalid.');
  return snapshot({ schema: 1, eventId: String(value.eventId), conversationId: String(value.conversationId),
    commandId: String(value.commandId), fingerprint: String(value.fingerprint), state: value.state as Ledger['state'],
    replyState: value.replyState as Ledger['replyState'], templateHash: value.templateHash as string | null,
    messageId: value.messageId as string | null, createdAt: value.createdAt, updatedAt: value.updatedAt });
}

function receipt(value: Ledger): DeliveryReceipt | undefined {
  if (value.replyState === 'none') return undefined;
  if (value.replyState === 'confirmed') return snapshot({ status: 'confirmed', messageId: value.messageId! });
  return snapshot({ status: value.replyState === 'rejected' ? 'rejected' : 'unknown' });
}

function result(value: Ledger, duplicate = false): ControlCommandResult {
  const replyReceipt = receipt(value);
  return snapshot({ handled: true, status: value.state === 'completed' ? 'completed' : 'unknown', commandId: value.commandId,
    duplicate, ...(replyReceipt === undefined ? {} : { replyReceipt }) });
}

function normalized(message: InboundMessage): Readonly<InboundMessage> {
  assert(isRecord(message) && reference(message.id) && reference(message.conversationId) && reference(message.userId)
    && timestamp(message.receivedAt) && typeof message.directed === 'boolean' && typeof message.isSelf === 'boolean',
  'CONTROL_COMMAND_SOURCE_INVALID', 'A trusted normalized protocol message is required.');
  return snapshot({ ...(message.accountScope === undefined ? {} : { accountScope: normalizeAccountScope(message.accountScope) }),
    id: message.id, conversationId: message.conversationId, userId: message.userId,
    receivedAt: message.receivedAt, content: normalizeContent(message.content), directed: message.directed, isSelf: message.isSelf });
}

export function createControlCommands(options: {
  readonly accountScope?: AccountScope;
  readonly store: DurableStore;
  readonly send: (request: ControlCommandSendRequest) => Promise<DeliveryReceipt>;
  readonly commands: readonly ControlCommandDefinition[];
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxRaw?: number;
  readonly maxRecords?: number;
  readonly clock?: Clock;
}) {
  const accountScope = options.accountScope === undefined ? undefined : normalizeAccountScope(options.accountScope);
  bindAccountStore(options.store, accountScope);
  const timeoutMs = options.timeoutMs ?? 10000;
  const maxRaw = options.maxRaw ?? 32;
  const maxRecords = options.maxRecords ?? 4096;
  assert(typeof options.send === 'function' && Array.isArray(options.commands) && options.commands.length <= 64
    && Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 300000
    && Number.isSafeInteger(maxRaw) && maxRaw >= 1 && maxRaw <= 32
    && Number.isSafeInteger(maxRecords) && maxRecords >= 1 && maxRecords <= 4096
    && (options.signal === undefined || options.signal instanceof AbortSignal),
  'CONTROL_COMMAND_CONFIGURATION_INVALID', 'Control command limits or callbacks are invalid.');
  const identifiers = new Set<string>();
  const commands = options.commands.map(command => {
    assert(commandId(command.id) && !identifiers.has(command.id) && typeof command.matches === 'function'
      && typeof command.handle === 'function' && (command.replyTexts === undefined || Array.isArray(command.replyTexts)
      && command.replyTexts.length <= 32 && command.replyTexts.every((text: unknown) => typeof text === 'string'
        && text.trim().length > 0 && text.length <= 1000)),
    'CONTROL_COMMAND_CONFIGURATION_INVALID', 'Static command definitions and reply templates must be valid and unique.');
    identifiers.add(command.id);
    return Object.freeze({ id: command.id, matches: command.matches, handle: command.handle,
      replyTexts: Object.freeze([...(command.replyTexts ?? [])]) });
  });
  const clock = options.clock ?? Date.now;
  const controller = new AbortController();
  const pending = new Set<Promise<ControlCommandResult>>();
  let closed = false;
  let stopping: Promise<{ readonly pendingRaw: number }> | undefined;
  const shared = sharedStores.get(options.store) ?? { raw: new Set<Promise<unknown>>(),
    inflight: new Map<string, { fingerprint: string; promise: Promise<ControlCommandResult> }>(), recordCount: 0 };
  sharedStores.set(options.store, shared);

  function now(): number {
    const value = clock();
    assert(timestamp(value), 'CONTROL_COMMAND_CLOCK_INVALID', 'A valid host clock is required.');
    return value;
  }

  const existing: StoredRecord[] = [];
  for (const record of records(options.store, CONTROL_COMMAND_NAMESPACE)) {
    assert(existing.length < 4096, 'CONTROL_COMMAND_CAPACITY', 'The durable control command ledger is full.');
    readLedger(record);
    existing.push(record);
  }
  shared.recordCount = existing.length;
  for (const record of existing) {
    const value = readLedger(record);
    if (shared.inflight.has(record.key) || value.state !== 'running' && value.replyState !== 'intent') continue;
    options.store.write(CONTROL_COMMAND_NAMESPACE, record.key, json({ ...value, state: 'unknown',
      replyState: value.replyState === 'intent' ? 'unknown' : value.replyState, updatedAt: now() }), { expectedRevision: record.revision });
  }

  function startRaw<Value>(run: () => Promise<Value>): Promise<Value> {
    assert(shared.raw.size < maxRaw, 'CONTROL_COMMAND_RAW_CAPACITY', 'Unsettled control operations have reached the limit.');
    const operation = Promise.resolve().then(run);
    shared.raw.add(operation);
    operation.then(() => shared.raw.delete(operation), () => shared.raw.delete(operation));
    return operation;
  }

  function persist(execution: Execution, update: Partial<Ledger>): void {
    const value = snapshot({ ...execution.value, ...update, updatedAt: now() });
    execution.record = options.store.write(CONTROL_COMMAND_NAMESPACE, execution.key, json(value),
      { expectedRevision: execution.record.revision });
    execution.value = value;
  }

  async function execute(execution: Execution, command: typeof commands[number], message: Readonly<InboundMessage>, signal: AbortSignal): Promise<ControlCommandResult> {
    const combined = AbortSignal.any([controller.signal, execution.controller.signal, signal]);
    let replyAttempted = false;
    let replyTask: Promise<DeliveryReceipt> | undefined;
    let replyViolation = false;
    try {
      await withDeadline({ signal: combined, timeoutMs, code: 'CONTROL_COMMAND_TIMEOUT_UNKNOWN', run: commandSignal =>
        startRaw(async () => {
          commandSignal.throwIfAborted();
          async function sendReply(text: string): Promise<DeliveryReceipt> {
            assert(execution.active && !commandSignal.aborted && !closed,
              'CONTROL_COMMAND_CONTEXT_CLOSED', 'The original command context is no longer active.');
            assert(!replyAttempted, 'CONTROL_COMMAND_REPLY_LIMIT', 'Only one fixed reply is allowed.');
            replyAttempted = true;
            assert(typeof text === 'string' && command.replyTexts.includes(text),
              'CONTROL_COMMAND_REPLY_DENIED', 'Only an exact registered reply template is allowed.');
            assert(shared.raw.size < maxRaw, 'CONTROL_COMMAND_RAW_CAPACITY', 'Unsettled control operations have reached the limit.');
            persist(execution, { replyState: 'intent', templateHash: digest(text) });
            let delivered: DeliveryReceipt;
            try {
              const observed = await startRaw(async () => {
                commandSignal.throwIfAborted();
                assert(execution.active && !closed, 'CONTROL_COMMAND_CONTEXT_CLOSED', 'The original command context is no longer active.');
                return options.send(Object.freeze({ conversationId: message.conversationId,
                  content: Object.freeze([Object.freeze({ type: 'text' as const, text })] as const),
                  idempotencyKey: `host-control-reply:${execution.key}`, signal: commandSignal }));
              });
              delivered = observed?.status === 'confirmed' && reference(observed.messageId)
                ? { status: 'confirmed', messageId: observed.messageId }
                : observed?.status === 'rejected' ? { status: 'rejected' } : { status: 'unknown' };
            } catch { delivered = { status: 'unknown' }; }
            if (!execution.active || commandSignal.aborted || closed) return snapshot({ status: 'unknown' });
            persist(execution, { replyState: delivered.status, messageId: delivered.status === 'confirmed' ? delivered.messageId : null });
            return snapshot(delivered);
          }
          const context = Object.freeze({ message, signal: commandSignal, reply(text: string) {
            const task = sendReply(text);
            void task.catch(() => { replyViolation = true; });
            replyTask ??= task;
            return task;
          } });
          await command.handle(context);
          if (replyTask) await replyTask;
          assert(!replyViolation, 'CONTROL_COMMAND_REPLY_DENIED', 'A reply request violated the command boundary.');
        }) });
      combined.throwIfAborted();
      assert(execution.active, 'CONTROL_COMMAND_CONTEXT_CLOSED', 'The command execution is no longer active.');
      persist(execution, { state: 'completed' });
      return result(execution.value);
    } catch {
      execution.active = false;
      execution.controller.abort();
      const value: Ledger = { ...execution.value, state: 'unknown',
        replyState: execution.value.replyState === 'intent' ? 'unknown' : execution.value.replyState };
      try { persist(execution, value); } catch {}
      return result(value);
    } finally {
      execution.active = false;
      execution.controller.abort();
    }
  }

  async function dispatchNormalized(input: InboundMessage, signal: AbortSignal): Promise<ControlCommandResult> {
    assert(signal instanceof AbortSignal, 'CONTROL_COMMAND_SOURCE_INVALID', 'An inbound lifetime signal is required.');
    if (closed || signal.aborted) return snapshot({ handled: true, status: 'stopped' });
    const message = normalized(input);
    assertAccountScope(accountScope, message.accountScope);
    if (message.isSelf) return snapshot({ handled: false, status: 'ignored-self' });
    const key = digest([message.conversationId, message.id]);
    const fingerprint = digest({ id: message.id, conversationId: message.conversationId, userId: message.userId,
      content: message.content, directed: message.directed, isSelf: message.isSelf });
    const inflight = shared.inflight.get(key);
    if (inflight) {
      assert(inflight.fingerprint === fingerprint, 'CONTROL_COMMAND_EVENT_CONFLICT', 'The source event identity has conflicting content.');
      return inflight.promise;
    }
    const previous = options.store.read(CONTROL_COMMAND_NAMESPACE, key);
    if (previous) {
      const value = readLedger(previous);
      assert(value.fingerprint === fingerprint, 'CONTROL_COMMAND_EVENT_CONFLICT', 'The source event identity has conflicting content.');
      return result(value, true);
    }
    const matched = commands.filter(command => {
      let matches: unknown;
      try { matches = command.matches(message); }
      catch { assert(false, 'CONTROL_COMMAND_MATCH_FAILED', 'A trusted command selector failed.'); }
      assert(typeof matches === 'boolean', 'CONTROL_COMMAND_MATCH_FAILED', 'Command selectors must return a synchronous boolean.');
      return matches;
    });
    assert(matched.length <= 1, 'CONTROL_COMMAND_AMBIGUOUS', 'More than one control command matched the source.');
    const command = matched[0];
    if (!command) return snapshot({ handled: false, status: 'unmatched' });
    if (shared.raw.size >= maxRaw || shared.recordCount >= maxRecords) return snapshot({ handled: true, status: 'capacity', commandId: command.id });
    const at = now();
    const value: Ledger = { schema: 1, eventId: message.id, conversationId: message.conversationId, commandId: command.id,
      fingerprint, state: 'running', replyState: 'none', templateHash: null, messageId: null, createdAt: at, updatedAt: at };
    let record: StoredRecord;
    try { record = options.store.write(CONTROL_COMMAND_NAMESPACE, key, json(value), { expectedRevision: null }); }
    catch (error) {
      const concurrent = options.store.read(CONTROL_COMMAND_NAMESPACE, key);
      if (!concurrent) throw error;
      const entry = readLedger(concurrent);
      assert(entry.fingerprint === fingerprint, 'CONTROL_COMMAND_EVENT_CONFLICT', 'The source event identity has conflicting content.');
      return result(entry, true);
    }
    shared.recordCount++;
    const execution: Execution = { key, controller: new AbortController(), record, value, active: true };
    const promise = execute(execution, command, message, signal);
    const held = { fingerprint, promise };
    shared.inflight.set(key, held);
    pending.add(promise);
    void promise.finally(() => {
      pending.delete(promise);
      if (shared.inflight.get(key) === held) shared.inflight.delete(key);
    }).catch(() => undefined);
    return promise;
  }

  function stop(): Promise<{ readonly pendingRaw: number }> {
    if (stopping) return stopping;
    closed = true;
    controller.abort();
    options.signal?.removeEventListener('abort', abort);
    stopping = Promise.allSettled([...pending]).then(() => Object.freeze({ pendingRaw: shared.raw.size }));
    return stopping;
  }

  function abort(): void { void stop(); }
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });

  async function drain(): Promise<void> {
    assert(closed, 'CONTROL_COMMAND_NOT_STOPPED', 'Stop command intake before draining its raw work.');
    while (shared.raw.size > 0) await Promise.allSettled([...shared.raw]);
  }

  return Object.freeze({ dispatchNormalized, stop, drain, metrics: () => Object.freeze({ commands: commands.length,
    pendingRaw: shared.raw.size, inflight: shared.inflight.size, records: shared.recordCount, closed,
    trustBoundary: CONTROL_COMMAND_TRUST_BOUNDARY }) });
}
