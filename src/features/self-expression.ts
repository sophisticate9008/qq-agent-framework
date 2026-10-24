import { normalizeOutboundScope } from '../core/scope.ts';
import type { EffectAdapter, EffectRequest, JsonValue, OutboundScope } from '../core/types.ts';
import { assert, isRecord, reference, snapshot } from '../core/values.ts';
import { withDeadline } from '../host/deadlines.ts';

export interface SelfExpressionImagePack {
  id: string;
  version: string;
  referenceAssetIds: readonly string[];
}

export interface SelfExpressionScope extends OutboundScope {
  conversationId: string;
}

export interface SelfExpressionRequest {
  prompt: string;
  occasion: string;
}

export interface SelfExpressionContext {
  scope: Readonly<SelfExpressionScope>;
  signal: AbortSignal;
}

export interface SelfExpressionGenerateRequest extends SelfExpressionRequest {
  imagePack: Readonly<SelfExpressionImagePack>;
  scope: Readonly<SelfExpressionScope>;
  attempt: 1 | 2;
  previousIssues?: readonly string[];
  signal: AbortSignal;
}

export type SelfExpressionGenerateResult =
  | { status: 'confirmed'; assetId: string }
  | { status: 'rejected' }
  | { status: 'unknown' };

export interface SelfExpressionCheckRequest extends SelfExpressionRequest {
  imagePack: Readonly<SelfExpressionImagePack>;
  scope: Readonly<SelfExpressionScope>;
  attempt: 1 | 2;
  assetId: string;
  signal: AbortSignal;
}

export type SelfExpressionCheckResult =
  | { status: 'approved' }
  | { status: 'rejected'; issues: readonly string[] }
  | { status: 'unknown' };

export type SelfExpressionDiscardReason = 'check_rejected' | 'check_unknown';

export interface SelfExpressionDiscardRequest {
  imagePack: Readonly<SelfExpressionImagePack>;
  scope: Readonly<SelfExpressionScope>;
  assetId: string;
  attempt: 1 | 2;
  reason: SelfExpressionDiscardReason;
  signal: AbortSignal;
}

export type SelfExpressionDiscardResult = { status: 'confirmed' | 'rejected' | 'unknown' };

export interface SelfExpressionHistoryImage {
  assetId: string;
  imagePack: Readonly<{ id: string; version: string }>;
  scope: Readonly<SelfExpressionScope>;
  approved: boolean;
}

export interface SelfExpressionHistoryRequest extends SelfExpressionRequest {
  imagePack: Readonly<SelfExpressionImagePack>;
  scope: Readonly<SelfExpressionScope>;
  fallbackFrom: SelfExpressionFallbackReason;
  rejectedAssetIds: readonly string[];
  signal: AbortSignal;
}

export type SelfExpressionHistoryResult =
  | { status: 'available'; candidates: readonly SelfExpressionHistoryImage[] }
  | { status: 'rejected' }
  | { status: 'unknown' };

export type SelfExpressionFallbackReason = 'generation_rejected' | SelfExpressionDiscardReason;
export type SelfExpressionNoImageReason = 'generation_unknown' | 'discard_rejected' | 'discard_unknown'
  | 'history_rejected' | 'history_unknown' | 'no_approved_history';

export type SelfExpressionResult =
  | Readonly<{
    status: 'selected';
    source: 'generated';
    assetId: string;
    attempts: 1 | 2;
    imagePack: Readonly<{ id: string; version: string }>;
  }>
  | Readonly<{
    status: 'selected';
    source: 'history';
    assetId: string;
    attempts: 1 | 2;
    fallbackFrom: SelfExpressionFallbackReason;
    imagePack: Readonly<{ id: string; version: string }>;
  }>
  | Readonly<{
    status: 'none';
    reason: SelfExpressionNoImageReason;
    attempts: 1 | 2;
    fallbackFrom?: SelfExpressionFallbackReason;
    imagePack: Readonly<{ id: string; version: string }>;
  }>;

export interface SelfExpressionServiceOptions {
  imagePack: SelfExpressionImagePack;
  generate(request: Readonly<SelfExpressionGenerateRequest>): SelfExpressionGenerateResult | Promise<SelfExpressionGenerateResult>;
  check(request: Readonly<SelfExpressionCheckRequest>): SelfExpressionCheckResult | Promise<SelfExpressionCheckResult>;
  discard(request: Readonly<SelfExpressionDiscardRequest>): SelfExpressionDiscardResult | Promise<SelfExpressionDiscardResult>;
  chooseHistory(request: Readonly<SelfExpressionHistoryRequest>): SelfExpressionHistoryResult | Promise<SelfExpressionHistoryResult>;
  random?: () => number;
  timeoutMs?: number;
  maxPending?: number;
  maxHistoryCandidates?: number;
}

export interface SelfExpressionService {
  readonly imagePack: Readonly<SelfExpressionImagePack>;
  metrics(): Readonly<{ pending: number; maxPending: number }>;
  prepare(request: SelfExpressionRequest, context: SelfExpressionContext): Promise<SelfExpressionResult>;
}

const promptByteLimit = 16 * 1024;
const occasionByteLimit = 4 * 1024;
const maximumReferences = 32;
const maximumIssues = 16;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}

function normalizeImagePack(input: unknown): Readonly<SelfExpressionImagePack> {
  const value = snapshot(input);
  assert(isRecord(value) && exactKeys(value, ['id', 'version', 'referenceAssetIds'])
    && reference(value.id) && reference(value.version)
    && Array.isArray(value.referenceAssetIds) && value.referenceAssetIds.length > 0
    && value.referenceAssetIds.length <= maximumReferences
    && value.referenceAssetIds.every(reference)
    && new Set(value.referenceAssetIds).size === value.referenceAssetIds.length,
  'INVALID_SELF_EXPRESSION_IMAGE_PACK', 'A bounded, versioned image pack with controlled references is required.');
  return value as unknown as Readonly<SelfExpressionImagePack>;
}

function normalizeScope(input: unknown): Readonly<SelfExpressionScope> {
  const value = snapshot(input);
  assert(isRecord(value) && Object.keys(value).every(key => ['conversationId', 'persona', 'sessionId', 'generation'].includes(key))
    && reference(value.conversationId),
  'INVALID_SELF_EXPRESSION_SCOPE', 'A trusted conversation and persona scope is required.');
  const outbound = normalizeOutboundScope({
    persona: value.persona,
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    ...(value.generation === undefined ? {} : { generation: value.generation }),
  });
  return snapshot({ conversationId: value.conversationId, ...outbound });
}

function normalizeRequest(input: unknown): Readonly<SelfExpressionRequest> {
  const value = snapshot(input);
  assert(isRecord(value) && exactKeys(value, ['prompt', 'occasion'])
    && typeof value.prompt === 'string' && value.prompt.length > 0
    && Buffer.byteLength(value.prompt) <= promptByteLimit
    && typeof value.occasion === 'string' && value.occasion.length > 0
    && Buffer.byteLength(value.occasion) <= occasionByteLimit,
  'INVALID_SELF_EXPRESSION_REQUEST', 'A bounded prompt and occasion are required.');
  return value as unknown as Readonly<SelfExpressionRequest>;
}

function normalizeGenerateResult(input: unknown): SelfExpressionGenerateResult {
  const value = snapshot(input);
  assert(isRecord(value) && (value.status === 'confirmed' && exactKeys(value, ['status', 'assetId']) && reference(value.assetId)
    || (value.status === 'rejected' || value.status === 'unknown') && exactKeys(value, ['status'])),
  'INVALID_SELF_EXPRESSION_GENERATION', 'The generator returned an invalid outcome.');
  return value as SelfExpressionGenerateResult;
}

function normalizeCheckResult(input: unknown): SelfExpressionCheckResult {
  const value = snapshot(input);
  assert(isRecord(value) && (value.status === 'approved' && exactKeys(value, ['status'])
    || value.status === 'unknown' && exactKeys(value, ['status'])
    || value.status === 'rejected' && exactKeys(value, ['status', 'issues'])
      && Array.isArray(value.issues) && value.issues.length > 0 && value.issues.length <= maximumIssues
      && value.issues.every(reference)),
  'INVALID_SELF_EXPRESSION_CHECK', 'The checker returned an invalid outcome.');
  return value as unknown as SelfExpressionCheckResult;
}

function normalizeDiscardResult(input: unknown): SelfExpressionDiscardResult {
  const value = snapshot(input);
  assert(isRecord(value) && exactKeys(value, ['status'])
    && (value.status === 'confirmed' || value.status === 'rejected' || value.status === 'unknown'),
  'INVALID_SELF_EXPRESSION_DISCARD', 'The discard callback returned an invalid outcome.');
  return value as SelfExpressionDiscardResult;
}

function normalizeHistoryImage(input: unknown): Readonly<SelfExpressionHistoryImage> {
  const value = snapshot(input);
  assert(isRecord(value) && exactKeys(value, ['assetId', 'imagePack', 'scope', 'approved'])
    && reference(value.assetId) && typeof value.approved === 'boolean'
    && isRecord(value.imagePack) && exactKeys(value.imagePack, ['id', 'version'])
    && reference(value.imagePack.id) && reference(value.imagePack.version),
  'INVALID_SELF_EXPRESSION_HISTORY', 'Historical image metadata is invalid.');
  return snapshot({ assetId: value.assetId, imagePack: { id: value.imagePack.id, version: value.imagePack.version },
    scope: normalizeScope(value.scope), approved: value.approved });
}

function normalizeHistoryResult(input: unknown, maxHistoryCandidates: number): SelfExpressionHistoryResult {
  assert(isRecord(input) && (input.status === 'rejected' || input.status === 'unknown' || input.status === 'available'),
    'INVALID_SELF_EXPRESSION_HISTORY', 'The history callback returned an invalid outcome.');
  if (input.status !== 'available') {
    assert(exactKeys(input, ['status']), 'INVALID_SELF_EXPRESSION_HISTORY', 'The history callback returned an invalid outcome.');
    return snapshot(input) as SelfExpressionHistoryResult;
  }
  assert(exactKeys(input, ['status', 'candidates']) && Array.isArray(input.candidates)
    && input.candidates.length <= maxHistoryCandidates,
  'INVALID_SELF_EXPRESSION_HISTORY', 'Historical candidates must respect the configured bound.');
  return snapshot({ status: 'available' as const, candidates: input.candidates.map(normalizeHistoryImage) });
}

function sameScope(left: Readonly<SelfExpressionScope>, right: Readonly<SelfExpressionScope>): boolean {
  return left.conversationId === right.conversationId
    && left.persona.id === right.persona.id && left.persona.version === right.persona.version
    && (left.sessionId === undefined || left.sessionId === right.sessionId)
    && (left.generation === undefined || left.generation === right.generation);
}

export function createSelfExpressionService({ imagePack: inputImagePack, generate, check, discard, chooseHistory,
  random = Math.random, timeoutMs = 30_000, maxPending = 2, maxHistoryCandidates = 256 }:
  SelfExpressionServiceOptions): SelfExpressionService {
  const imagePack = normalizeImagePack(inputImagePack);
  const imagePackIdentity = snapshot({ id: imagePack.id, version: imagePack.version });
  assert(typeof generate === 'function' && typeof check === 'function' && typeof discard === 'function'
    && typeof chooseHistory === 'function' && typeof random === 'function'
    && Number.isSafeInteger(timeoutMs) && timeoutMs >= 10 && timeoutMs <= 300_000
    && Number.isSafeInteger(maxPending) && maxPending >= 1 && maxPending <= 256
    && Number.isSafeInteger(maxHistoryCandidates) && maxHistoryCandidates >= 1 && maxHistoryCandidates <= 1000,
  'INVALID_SELF_EXPRESSION_OPTIONS', 'Self-expression requires callbacks and finite operation bounds.');
  let pending = 0;

  async function generateImage(request: Readonly<SelfExpressionRequest>, scope: Readonly<SelfExpressionScope>,
    attempt: 1 | 2, previousIssues: readonly string[] | undefined, signal: AbortSignal): Promise<SelfExpressionGenerateResult> {
    let value: unknown;
    try {
      value = await generate(Object.freeze({ ...request, imagePack, scope, attempt,
        ...(previousIssues === undefined ? {} : { previousIssues }), signal }));
    } catch {
      signal.throwIfAborted();
      return Object.freeze({ status: 'unknown' });
    }
    signal.throwIfAborted();
    return normalizeGenerateResult(value);
  }

  async function checkImage(request: Readonly<SelfExpressionRequest>, scope: Readonly<SelfExpressionScope>,
    attempt: 1 | 2, assetId: string, signal: AbortSignal): Promise<SelfExpressionCheckResult> {
    let value: unknown;
    try {
      value = await check(Object.freeze({ ...request, imagePack, scope, attempt, assetId, signal }));
    } catch {
      signal.throwIfAborted();
      return Object.freeze({ status: 'unknown' });
    }
    signal.throwIfAborted();
    return normalizeCheckResult(value);
  }

  async function discardImage(scope: Readonly<SelfExpressionScope>, assetId: string, attempt: 1 | 2,
    reason: SelfExpressionDiscardReason, signal: AbortSignal): Promise<SelfExpressionDiscardResult> {
    let value: unknown;
    try {
      value = await discard(Object.freeze({ imagePack, scope, assetId, attempt, reason, signal }));
    } catch {
      signal.throwIfAborted();
      return Object.freeze({ status: 'unknown' });
    }
    signal.throwIfAborted();
    return normalizeDiscardResult(value);
  }

  function noImage(reason: SelfExpressionNoImageReason, attempts: 1 | 2,
    fallbackFrom?: SelfExpressionFallbackReason): SelfExpressionResult {
    return snapshot({ status: 'none' as const, reason, attempts,
      ...(fallbackFrom === undefined ? {} : { fallbackFrom }), imagePack: imagePackIdentity });
  }

  async function historyFallback(request: Readonly<SelfExpressionRequest>, scope: Readonly<SelfExpressionScope>,
    fallbackFrom: SelfExpressionFallbackReason, rejectedAssetIds: readonly string[], attempts: 1 | 2,
    signal: AbortSignal): Promise<SelfExpressionResult> {
    let value: unknown;
    try {
      value = await chooseHistory(Object.freeze({ ...request, imagePack, scope, fallbackFrom,
        rejectedAssetIds: Object.freeze([...rejectedAssetIds]), signal }));
    } catch {
      signal.throwIfAborted();
      return noImage('history_unknown', attempts, fallbackFrom);
    }
    signal.throwIfAborted();
    const result = normalizeHistoryResult(value, maxHistoryCandidates);
    if (result.status === 'rejected') return noImage('history_rejected', attempts, fallbackFrom);
    if (result.status === 'unknown') return noImage('history_unknown', attempts, fallbackFrom);
    const seen = new Set<string>();
    const eligible = result.candidates.filter(candidate => candidate.approved
      && candidate.imagePack.id === imagePack.id && candidate.imagePack.version === imagePack.version
      && sameScope(candidate.scope, scope) && !rejectedAssetIds.includes(candidate.assetId)
      && !seen.has(candidate.assetId) && Boolean(seen.add(candidate.assetId)));
    if (eligible.length === 0) return noImage('no_approved_history', attempts, fallbackFrom);
    const sample = random();
    assert(typeof sample === 'number' && Number.isFinite(sample) && sample >= 0 && sample < 1,
      'INVALID_SELF_EXPRESSION_RANDOM', 'The injected random source must return a number from zero up to one.');
    const selected = eligible[Math.floor(sample * eligible.length)]!;
    return snapshot({ status: 'selected' as const, source: 'history' as const, assetId: selected.assetId,
      attempts, fallbackFrom, imagePack: imagePackIdentity });
  }

  async function run(request: Readonly<SelfExpressionRequest>, scope: Readonly<SelfExpressionScope>,
    signal: AbortSignal): Promise<SelfExpressionResult> {
    const rejectedAssetIds: string[] = [];
    let previousIssues: readonly string[] | undefined;
    for (const attempt of [1, 2] as const) {
      const generated = await generateImage(request, scope, attempt, previousIssues, signal);
      if (generated.status === 'unknown') return noImage('generation_unknown', attempt);
      if (generated.status === 'rejected') {
        return historyFallback(request, scope, 'generation_rejected', rejectedAssetIds, attempt, signal);
      }
      const checked = await checkImage(request, scope, attempt, generated.assetId, signal);
      if (checked.status === 'approved') {
        return snapshot({ status: 'selected' as const, source: 'generated' as const,
          assetId: generated.assetId, attempts: attempt, imagePack: imagePackIdentity });
      }
      const fallbackFrom = checked.status === 'rejected' ? 'check_rejected' : 'check_unknown';
      const discarded = await discardImage(scope, generated.assetId, attempt, fallbackFrom, signal);
      if (discarded.status !== 'confirmed') {
        return noImage(discarded.status === 'rejected' ? 'discard_rejected' : 'discard_unknown', attempt, fallbackFrom);
      }
      rejectedAssetIds.push(generated.assetId);
      if (checked.status === 'unknown') {
        return historyFallback(request, scope, fallbackFrom, rejectedAssetIds, attempt, signal);
      }
      if (attempt === 2) return historyFallback(request, scope, fallbackFrom, rejectedAssetIds, attempt, signal);
      previousIssues = checked.issues;
    }
    return noImage('generation_unknown', 2);
  }

  return Object.freeze({
    imagePack,
    metrics() { return Object.freeze({ pending, maxPending }); },
    async prepare(input: SelfExpressionRequest, context: SelfExpressionContext): Promise<SelfExpressionResult> {
      const request = normalizeRequest(input);
      const scope = normalizeScope(context.scope);
      assert(context.signal instanceof AbortSignal, 'INVALID_SELF_EXPRESSION_CONTEXT', 'An AbortSignal is required.');
      assert(pending < maxPending, 'SELF_EXPRESSION_BACKPRESSURE', 'Too many self-expression operations remain unresolved.');
      return withDeadline({ signal: context.signal, timeoutMs, code: 'SELF_EXPRESSION_TIMEOUT_UNKNOWN', run(signal) {
        pending += 1;
        const operation = run(request, scope, signal);
        operation.then(() => { pending -= 1; }, () => { pending -= 1; });
        return operation;
      } });
    },
  });
}

export function createSelfExpressionEffect(service: SelfExpressionService): EffectAdapter {
  return Object.freeze({ async execute(request: EffectRequest): Promise<JsonValue> {
    assert(request.scope.persona !== undefined, 'INVALID_SELF_EXPRESSION_SCOPE', 'The effect requires a trusted persona scope.');
    const scope = normalizeScope({ conversationId: request.scope.conversationId, persona: request.scope.persona,
      ...(request.scope.sessionId === undefined ? {} : { sessionId: request.scope.sessionId }),
      ...(request.scope.generation === undefined ? {} : { generation: request.scope.generation }) });
    return snapshot(await service.prepare(normalizeRequest(request.input), { scope, signal: request.signal })) as unknown as JsonValue;
  } });
}
