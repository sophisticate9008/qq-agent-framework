import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createPresentationService, type PresentationContext, type PresentationRequest, type PresentationServiceOptions } from '../src/host/presentation.ts';

function context(): PresentationContext {
  return { conversationId: 'group:123', scope: { persona: { id: 'fixture', version: '1.0.0' } },
    idempotencyKey: 'document', signal: new AbortController().signal };
}

test('normal conversation stays plain and does not gain an automatic quote', async () => {
  const service = createPresentationService({ capabilities: { contentTypes: ['text', 'reply'] } });
  const result = await service.prepare({ body: '今天怎么样？' }, context());
  assert.deepEqual(result, { format: 'text', quote: false, content: [{ type: 'text', text: '今天怎么样？' }] });
  assert.equal((await service.prepare({ body: '收到', replyTo: { messageId: '12', distance: 1, ageMs: 3000 } }, context())).quote, false);
});

test('trusted selectors receive frozen execution metadata separately from the live abort signal', async () => {
  const trusted = { ...context(), scope: { persona: { id: 'fixture', version: '2' }, sessionId: 'actual-session', generation: 3 } };
  let calls = 0;
  const service = createPresentationService({ capabilities: { contentTypes: ['text', 'forward'] }, select(input, signal, metadata) {
    calls++;
    assert(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false);
    assert.deepEqual(metadata, { conversationId: trusted.conversationId, scope: trusted.scope, idempotencyKey: trusted.idempotencyKey });
    assert.deepEqual(Object.keys(metadata).sort(), ['conversationId', 'idempotencyKey', 'scope']);
    assert(Object.isFrozen(metadata) && Object.isFrozen(metadata.scope) && Object.isFrozen(metadata.scope.persona));
    assert.equal(Reflect.set(metadata.scope.persona, 'version', 'spoofed'), false);
    return { format: metadata.conversationId === 'group:123' ? 'forward' : input.suggested.format, quote: false };
  } });
  assert.equal((await service.prepare({ body: '# standard text' }, trusted)).format, 'forward');
  for (const field of ['conversationId', 'scope', 'idempotencyKey', 'signal']) {
    await assert.rejects(service.prepare({ body: 'x', [field]: 'spoofed' } as PresentationRequest, trusted), { code: 'INVALID_PRESENTATION' });
  }
  assert.equal(calls, 1);
  const oldSelect: PresentationServiceOptions['select'] = (input, signal) => {
    assert(signal instanceof AbortSignal);
    return input.suggested;
  };
  assert.equal((await createPresentationService({ capabilities: { contentTypes: ['text'] }, select: oldSelect })
    .prepare({ body: 'unchanged' }, trusted)).format, 'text');
});

test('distant messages can quote; uncertain timing goes to a selector and otherwise omits quoting', async () => {
  const service = createPresentationService({ capabilities: { contentTypes: ['text', 'reply'] } });
  assert.equal((await service.prepare({ body: '之前那件事', replyTo: { messageId: '12', distance: 20, ageMs: 1000 } }, context())).quote, true);
  assert.equal((await service.prepare({ body: '收到', replyTo: { messageId: '12' } }, context())).quote, false);
  const noReplyCapability = createPresentationService({ capabilities: { contentTypes: ['text'] } });
  assert.equal((await noReplyCapability.prepare({ body: '之前那件事', replyTo: { messageId: '12', distance: 20 } }, context())).quote, false);
  let timing = '';
  const intelligent = createPresentationService({ capabilities: { contentTypes: ['text', 'reply'] }, select(input) {
    timing = input.replyTiming;
    assert(Object.isFrozen(input) && Object.isFrozen(input.request));
    return { format: 'text', quote: true };
  } });
  const result = await intelligent.prepare({ body: '之前那件事', replyTo: { messageId: '12' } }, context());
  assert.equal(timing, 'uncertain');
  assert.equal(result.content[0].type, 'reply');
});

test('explicit no-quote and nearby automatic replies cannot be overridden by the selector', async () => {
  const service = createPresentationService({ capabilities: { contentTypes: ['text', 'reply'] }, select: () => ({ format: 'text', quote: true }) });
  for (const request of [
    { body: 'x', reply: 'never' as const, replyTo: { messageId: '12', distance: 100 } },
    { body: 'x', replyTo: { messageId: '12', distance: 1, ageMs: 1000 } },
  ]) await assert.rejects(service.prepare(request, context()), { code: 'INVALID_PRESENTATION_CHOICE' });
});

test('document rendering publishes complete images in trusted scope before preparing a send', async () => {
  const published: unknown[] = [];
  const service = createPresentationService({ capabilities: { contentTypes: ['text', 'image', 'reply'] },
    renderer: { async render(input) { assert.equal(input.markdown, '# 事项\n\n|A|B|\n|-|-|\n|1|2|'); return [{ png: new Uint8Array([1]), width: 100, height: 100 }]; } },
    async publishImage(input) { published.push(input.scope); return 'approved-document'; },
  });
  const result = await service.prepare({ body: '# 事项\n\n|A|B|\n|-|-|\n|1|2|', purpose: 'document' }, context());
  assert.equal(result.format, 'markdown-image');
  assert.deepEqual(result.content, [{ type: 'image', assetId: 'approved-document' }]);
  assert.deepEqual(published, [context().scope]);
});

test('unsupported or failed rendering only falls back when explicitly permitted and never truncates', async () => {
  const unavailable = createPresentationService({ capabilities: { contentTypes: ['text'] } });
  await assert.rejects(unavailable.prepare({ body: '# x', format: 'markdown-image' }, context()), { code: 'PRESENTATION_UNAVAILABLE' });
  assert.equal((await unavailable.prepare({ body: '# x', format: 'markdown-image', fallback: 'text' }, context())).fallbackFrom, 'markdown-image');
  const failed = createPresentationService({ capabilities: { contentTypes: ['text', 'image'] },
    renderer: { async render() { throw new Error('/private/credentials'); } }, publishImage: async () => 'asset',
  });
  await assert.rejects(failed.prepare({ body: '# x', format: 'markdown-image' }, context()), error => {
    assert(error instanceof Error && !error.message.includes('/private')); return true;
  });
  assert.equal((await failed.prepare({ body: '# x', format: 'markdown-image', fallback: 'text' }, context())).format, 'text');
  await assert.rejects(unavailable.prepare({ body: 'x'.repeat(8001) }, context()));
  await assert.rejects(failed.prepare({ body: 'x'.repeat(8001), format: 'markdown-image', fallback: 'text' }, context()));
});

test('forward format preserves all text, obeys node limits and never invents original authors', async () => {
  const service = createPresentationService({ capabilities: { contentTypes: ['text', 'forward'], maxForwardNodes: 2 } });
  const body = '记录😀'.repeat(1001);
  const result = await service.prepare({ body, format: 'forward' }, context());
  assert.equal(result.content[0].type, 'forward');
  if (result.content[0].type === 'forward') {
    assert.equal(result.content[0].nodes.flatMap(node => node.content).map(block => block.type === 'text' ? block.text : '').join(''), body);
    assert(result.content[0].nodes.every(node => Object.keys(node).length === 1));
  }
  await assert.rejects(service.prepare({ body: 'x'.repeat(8001), format: 'forward' }, context()), { code: 'PRESENTATION_TOO_LARGE' });
  await assert.rejects(service.prepare({ body: 'x', format: 'forward', reply: 'always', replyTo: { messageId: '12' } }, context()), { code: 'INVALID_PRESENTATION_CHOICE' });
});

test('malformed selector choices and caller-injected scope are rejected', async () => {
  const service = createPresentationService({ capabilities: { contentTypes: ['text'] } });
  for (const input of [{ body: 'x', persona: 'fake' }, { body: '' }, { body: 'x', reply: 'always' },
    { body: 'x', replyTo: { messageId: '1', distance: -1 } }]) {
    await assert.rejects(service.prepare(input as PresentationRequest, context()), { code: 'INVALID_PRESENTATION' });
  }
  const wrong = createPresentationService({ capabilities: { contentTypes: ['text'] }, select: () => ({ format: 'forward', quote: false }) });
  await assert.rejects(wrong.prepare({ body: 'x' }, context()), { code: 'INVALID_PRESENTATION_CHOICE' });
});

test('automatic suggestions stay within partial transport capabilities and reach the selector', async () => {
  const selected: string[] = [];
  const forward = createPresentationService({ capabilities: { contentTypes: ['forward'] }, select(input) {
    assert.deepEqual(input.available, ['forward']);
    assert.deepEqual(input.suggested, { format: 'forward', quote: false });
    selected.push(input.suggested.format);
    return input.suggested;
  } });
  const result = await forward.prepare({ body: '简短记录', format: 'auto' }, context());
  assert.equal(result.format, 'forward');
  assert.deepEqual(result.content, [{ type: 'forward', nodes: [{ content: [{ type: 'text', text: '简短记录' }] }] }]);
  assert.deepEqual(selected, ['forward']);
  const withoutSelector = createPresentationService({ capabilities: { contentTypes: ['forward'] } });
  assert.equal((await withoutSelector.prepare({ body: '简短记录' }, context())).format, 'forward');
  const images = createPresentationService({ capabilities: { contentTypes: ['image'] },
    renderer: { async render() { return [{ png: new Uint8Array([1]), width: 1, height: 1 }]; } },
    publishImage: async () => 'controlled-image',
  });
  assert.deepEqual((await images.prepare({ body: '简短记录' }, context())).content,
    [{ type: 'image', assetId: 'controlled-image' }]);
  await assert.rejects(forward.prepare({ body: '简短记录', format: 'text' }, context()), { code: 'PRESENTATION_UNAVAILABLE' });
  assert.deepEqual(selected, ['forward']);
  const empty = createPresentationService({ capabilities: { contentTypes: ['image'] }, select() {
    assert.fail('Incomplete image support must not invoke a selector.');
  } });
  await assert.rejects(empty.prepare({ body: '简短记录' }, context()), { code: 'PRESENTATION_UNAVAILABLE' });
});

test('uncooperative selectors remain counted after abort until their real promise settles', async () => {
  let release!: (value: { format: 'text'; quote: false }) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const service = createPresentationService({ capabilities: { contentTypes: ['text'] }, maxPending: 1, timeoutMs: 1000,
    select() { entered(); return new Promise(resolve => { release = resolve; }); },
  });
  const controller = new AbortController();
  const pending = service.prepare({ body: 'x' }, { ...context(), signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending, { code: 'OPERATION_ABORTED_UNKNOWN' });
  assert.equal(service.metrics().pending, 1);
  await assert.rejects(service.prepare({ body: 'x' }, context()), { code: 'PRESENTATION_BACKPRESSURE' });
  release({ format: 'text', quote: false });
  await nextTurn();
  assert.equal(service.metrics().pending, 0);
});

test('QQ face capability coexists with text presentation without enabling another format', async () => {
  const service = createPresentationService({ capabilities: { contentTypes: ['text', 'face'] } });
  const result = await service.prepare({ body: 'QQ text', format: 'text' }, context());
  assert.equal(result.format, 'text');
});
