import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';

import type { EffectRequest } from '../src/core/types.ts';
import {
  createSelfExpressionEffect,
  createSelfExpressionService,
  type SelfExpressionHistoryImage,
  type SelfExpressionScope,
  type SelfExpressionServiceOptions,
} from '../src/features/self-expression.ts';

const imagePack = Object.freeze({
  id: 'whale-self-image',
  version: '2026-10-24.package-v1',
  referenceAssetIds: Object.freeze([
    '539548dbdf78a6488b9baca3af07521fe422c62bd8dee6e5664a1880754325b6',
    '1debce40cf05ef1b6ee1ec138595036d55667224cb1306e3f4d77de0e2b0b97e',
  ]),
});

const scope: Readonly<SelfExpressionScope> = Object.freeze({
  conversationId: 'group:trusted',
  persona: Object.freeze({ id: 'snowluma', version: '3.0.0' }),
  sessionId: 'session:trusted',
  generation: 2,
});

const expression = Object.freeze({ prompt: '画一张刚完成工作的轻松表情', occasion: '对话内回应当前进展' });

function options(overrides: Partial<SelfExpressionServiceOptions> = {}): SelfExpressionServiceOptions {
  return {
    imagePack,
    generate: async () => ({ status: 'confirmed', assetId: 'generated:default' }),
    check: async () => ({ status: 'approved' }),
    discard: async () => ({ status: 'confirmed' }),
    chooseHistory: async () => ({ status: 'rejected' }),
    ...overrides,
  };
}

function historical(assetId: string, values: Partial<SelfExpressionHistoryImage> = {}): SelfExpressionHistoryImage {
  return {
    assetId,
    imagePack: { id: imagePack.id, version: imagePack.version },
    scope,
    approved: true,
    ...values,
  };
}

test('selects one checked generation with caller context and injected authoritative identity data', async () => {
  const calls: string[] = [];
  const service = createSelfExpressionService(options({
    async generate(request) {
      calls.push('generate');
      assert.equal(request.prompt, expression.prompt);
      assert.equal(request.occasion, expression.occasion);
      assert.deepEqual(request.imagePack, imagePack);
      assert.deepEqual(request.scope, scope);
      assert.equal(request.attempt, 1);
      assert.equal(request.previousIssues, undefined);
      assert(Object.isFrozen(request) && Object.isFrozen(request.imagePack) && Object.isFrozen(request.scope));
      return { status: 'confirmed', assetId: 'generated:one' };
    },
    async check(request) {
      calls.push('check');
      assert.equal(request.assetId, 'generated:one');
      return { status: 'approved' };
    },
  }));

  assert.deepEqual(await service.prepare(expression, { scope, signal: new AbortController().signal }), {
    status: 'selected',
    source: 'generated',
    assetId: 'generated:one',
    attempts: 1,
    imagePack: { id: imagePack.id, version: imagePack.version },
  });
  assert.deepEqual(calls, ['generate', 'check']);
  assert.deepEqual(service.metrics(), { pending: 0, maxPending: 2 });
});

test('regenerates only once after explicit rejection and confirmed discard', async () => {
  const calls: string[] = [];
  const service = createSelfExpressionService(options({
    async generate(request) {
      calls.push(`generate:${request.attempt}`);
      if (request.attempt === 2) assert.deepEqual(request.previousIssues, ['wrong-hands', 'palette-drift']);
      return { status: 'confirmed', assetId: `generated:${request.attempt}` };
    },
    async check(request) {
      calls.push(`check:${request.attempt}`);
      return request.attempt === 1
        ? { status: 'rejected', issues: ['wrong-hands', 'palette-drift'] }
        : { status: 'approved' };
    },
    async discard(request) {
      calls.push(`discard:${request.attempt}:${request.reason}`);
      assert.equal(request.assetId, 'generated:1');
      return { status: 'confirmed' };
    },
    async chooseHistory() {
      calls.push('history');
      return { status: 'rejected' };
    },
  }));

  const result = await service.prepare(expression, { scope, signal: new AbortController().signal });
  assert.deepEqual(result, {
    status: 'selected',
    source: 'generated',
    assetId: 'generated:2',
    attempts: 2,
    imagePack: { id: imagePack.id, version: imagePack.version },
  });
  assert.deepEqual(calls, [
    'generate:1',
    'check:1',
    'discard:1:check_rejected',
    'generate:2',
    'check:2',
  ]);
});

test('discards both failed generations then randomly selects only approved exact-scope history', async () => {
  const discarded: string[] = [];
  let randomCalls = 0;
  const service = createSelfExpressionService(options({
    generate: async request => ({ status: 'confirmed', assetId: `generated:${request.attempt}` }),
    check: async request => ({ status: 'rejected', issues: [`obvious-error-${request.attempt}`] }),
    async discard(request) {
      discarded.push(request.assetId);
      return { status: 'confirmed' };
    },
    async chooseHistory(request) {
      assert.equal(request.fallbackFrom, 'check_rejected');
      assert.deepEqual(request.rejectedAssetIds, ['generated:1', 'generated:2']);
      return { status: 'available', candidates: [
        historical('history:unapproved', { approved: false }),
        historical('history:wrong-conversation', { scope: { ...scope, conversationId: 'group:other' } }),
        historical('history:wrong-pack', { imagePack: { id: imagePack.id, version: 'old' } }),
        historical('history:first'),
        historical('history:second'),
        historical('history:second'),
      ] };
    },
    random() {
      randomCalls += 1;
      return 0.75;
    },
  }));

  assert.deepEqual(await service.prepare(expression, { scope, signal: new AbortController().signal }), {
    status: 'selected',
    source: 'history',
    assetId: 'history:second',
    attempts: 2,
    fallbackFrom: 'check_rejected',
    imagePack: { id: imagePack.id, version: imagePack.version },
  });
  assert.deepEqual(discarded, ['generated:1', 'generated:2']);
  assert.equal(randomCalls, 1);
});

test('returns explicit no-image when history is not approved for the exact scope', async () => {
  const service = createSelfExpressionService(options({
    generate: async () => ({ status: 'rejected' }),
    chooseHistory: async () => ({ status: 'available', candidates: [
      historical('history:unapproved', { approved: false }),
      historical('history:wrong-session', { scope: { ...scope, sessionId: 'session:other' } }),
      historical('history:wrong-generation', { scope: { ...scope, generation: 3 } }),
    ] }),
    random() { throw new Error('random must not run without eligible history'); },
  }));

  assert.deepEqual(await service.prepare(expression, { scope, signal: new AbortController().signal }), {
    status: 'none',
    reason: 'no_approved_history',
    attempts: 1,
    fallbackFrom: 'generation_rejected',
    imagePack: { id: imagePack.id, version: imagePack.version },
  });
});

test('conversation and persona scoped history remains reusable across sessions unless it declares a session boundary', async () => {
  const unbound = historical('history:conversation-persona', {
    scope: { conversationId: scope.conversationId, persona: scope.persona },
  });
  const service = createSelfExpressionService(options({
    generate: async () => ({ status: 'rejected' }),
    chooseHistory: async () => ({ status: 'available', candidates: [
      historical('history:other-session', { scope: { ...scope, sessionId: 'session:other', generation: 1 } }),
      unbound,
    ] }),
    random: () => 0,
  }));
  const nextSession = { ...scope, sessionId: 'session:next', generation: 1 };

  for (const currentScope of [scope, nextSession]) {
    assert.deepEqual(await service.prepare(expression, { scope: currentScope, signal: new AbortController().signal }), {
      status: 'selected',
      source: 'history',
      assetId: 'history:conversation-persona',
      attempts: 1,
      fallbackFrom: 'generation_rejected',
      imagePack: { id: imagePack.id, version: imagePack.version },
    });
  }
});

test('generation unknown is never checked, discarded, regenerated, or reported as selected', async () => {
  let generations = 0;
  let laterCallbacks = 0;
  const service = createSelfExpressionService(options({
    async generate() { generations += 1; return { status: 'unknown' }; },
    async check() { laterCallbacks += 1; return { status: 'approved' }; },
    async discard() { laterCallbacks += 1; return { status: 'confirmed' }; },
    async chooseHistory() { laterCallbacks += 1; return { status: 'rejected' }; },
  }));

  assert.deepEqual(await service.prepare(expression, { scope, signal: new AbortController().signal }), {
    status: 'none',
    reason: 'generation_unknown',
    attempts: 1,
    imagePack: { id: imagePack.id, version: imagePack.version },
  });
  assert.equal(generations, 1);
  assert.equal(laterCallbacks, 0);
});

test('unknown check is discarded and falls back without triggering regeneration', async () => {
  let generations = 0;
  const service = createSelfExpressionService(options({
    async generate() { generations += 1; return { status: 'confirmed', assetId: 'generated:uncertain' }; },
    check: async () => ({ status: 'unknown' }),
    async discard(request) {
      assert.equal(request.reason, 'check_unknown');
      return { status: 'confirmed' };
    },
    async chooseHistory(request) {
      assert.equal(request.fallbackFrom, 'check_unknown');
      return { status: 'available', candidates: [historical('history:safe')] };
    },
    random: () => 0,
  }));

  assert.deepEqual(await service.prepare(expression, { scope, signal: new AbortController().signal }), {
    status: 'selected',
    source: 'history',
    assetId: 'history:safe',
    attempts: 1,
    fallbackFrom: 'check_unknown',
    imagePack: { id: imagePack.id, version: imagePack.version },
  });
  assert.equal(generations, 1);
});

test('unconfirmed discard stops the workflow before retry or history selection', async () => {
  let generations = 0;
  let historyCalls = 0;
  const service = createSelfExpressionService(options({
    async generate() { generations += 1; return { status: 'confirmed', assetId: 'generated:bad' }; },
    check: async () => ({ status: 'rejected', issues: ['obvious-error'] }),
    discard: async () => ({ status: 'unknown' }),
    async chooseHistory() { historyCalls += 1; return { status: 'rejected' }; },
  }));

  assert.deepEqual(await service.prepare(expression, { scope, signal: new AbortController().signal }), {
    status: 'none',
    reason: 'discard_unknown',
    attempts: 1,
    fallbackFrom: 'check_rejected',
    imagePack: { id: imagePack.id, version: imagePack.version },
  });
  assert.equal(generations, 1);
  assert.equal(historyCalls, 0);
});

test('aborted unresolved callback keeps its real pending slot until it settles', async () => {
  let release: ((value: { status: 'unknown' }) => void) | undefined;
  let entered: (() => void) | undefined;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const service = createSelfExpressionService(options({
    maxPending: 1,
    timeoutMs: 1000,
    generate() {
      entered?.();
      return new Promise(resolve => { release = resolve; });
    },
  }));
  const controller = new AbortController();
  const pending = service.prepare(expression, { scope, signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending, { code: 'OPERATION_ABORTED_UNKNOWN' });
  assert.deepEqual(service.metrics(), { pending: 1, maxPending: 1 });
  await assert.rejects(service.prepare(expression, { scope, signal: new AbortController().signal }),
    { code: 'SELF_EXPRESSION_BACKPRESSURE' });
  assert(release);
  release({ status: 'unknown' });
  await nextTurn();
  assert.deepEqual(service.metrics(), { pending: 0, maxPending: 1 });
});

test('effect adapter derives trusted scope and rejects identity or permission fields in caller input', async () => {
  let receivedScope: Readonly<SelfExpressionScope> | undefined;
  const service = createSelfExpressionService(options({
    async generate(request) {
      receivedScope = request.scope;
      return { status: 'confirmed', assetId: 'generated:effect' };
    },
  }));
  const effect = createSelfExpressionEffect(service);
  const request: EffectRequest = {
    input: expression,
    scope: {
      eventId: 'event:1',
      conversationId: scope.conversationId,
      featureId: 'self-expression-feature',
      version: '1.0.0',
      persona: scope.persona,
      sessionId: scope.sessionId,
      generation: scope.generation,
    },
    signal: new AbortController().signal,
  };

  assert.deepEqual(await effect.execute(request), {
    status: 'selected',
    source: 'generated',
    assetId: 'generated:effect',
    attempts: 1,
    imagePack: { id: imagePack.id, version: imagePack.version },
  });
  assert.deepEqual(receivedScope, scope);
  await assert.rejects(async () => effect.execute({ ...request, input: {
    ...expression,
    persona: { id: 'forged', version: '1' },
  } }), { code: 'INVALID_SELF_EXPRESSION_REQUEST' });
  await assert.rejects(async () => effect.execute({ ...request, scope: { ...request.scope, persona: undefined } }),
    { code: 'INVALID_SELF_EXPRESSION_SCOPE' });
});

test('validates finite identity, request, history, and random bounds', async () => {
  assert.throws(() => createSelfExpressionService(options({ imagePack: { ...imagePack, referenceAssetIds: [] } })),
    { code: 'INVALID_SELF_EXPRESSION_IMAGE_PACK' });
  const service = createSelfExpressionService(options());
  await assert.rejects(service.prepare({ ...expression, prompt: '' }, { scope, signal: new AbortController().signal }),
    { code: 'INVALID_SELF_EXPRESSION_REQUEST' });

  const invalidRandom = createSelfExpressionService(options({
    generate: async () => ({ status: 'rejected' }),
    chooseHistory: async () => ({ status: 'available', candidates: [historical('history:one')] }),
    random: () => 1,
  }));
  await assert.rejects(invalidRandom.prepare(expression, { scope, signal: new AbortController().signal }),
    { code: 'INVALID_SELF_EXPRESSION_RANDOM' });

  const boundedHistory = createSelfExpressionService(options({
    maxHistoryCandidates: 1,
    generate: async () => ({ status: 'rejected' }),
    chooseHistory: async () => ({ status: 'available', candidates: [historical('history:one'), historical('history:two')] }),
  }));
  await assert.rejects(boundedHistory.prepare(expression, { scope, signal: new AbortController().signal }),
    { code: 'INVALID_SELF_EXPRESSION_HISTORY' });
});
