import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

import {
  createImageGenerationAdapter,
  createImageGenerationEffect,
  imageGenerationJobId,
  type ImageGenerationAdapterOptions,
  type ImageGenerationContext,
} from '../src/adapters/image-generation.ts';
import type { EffectRequest } from '../src/core/types.ts';
import { digest } from '../src/host/data.ts';

const token = 'a'.repeat(64);
const png = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);

function context(signal = new AbortController().signal): ImageGenerationContext {
  return { conversationId: 'group:123', idempotencyKey: 'message:456',
    scope: { persona: { id: 'whale', version: '1.0.0' }, sessionId: 'session:1', generation: 2 }, signal };
}

function jobResponse(id: string, status: 'submitted' | 'queued' | 'running' | 'done' | 'error', replayed = false): Response {
  return Response.json({ ok: true, job: { id, status, ahead: 0, operation: 'generate', referenceCount: 0,
    referenceSha256: [] }, ...(replayed ? { replayed: true } : {}) });
}

function options(overrides: Partial<ImageGenerationAdapterOptions> = {}): ImageGenerationAdapterOptions {
  const id = imageGenerationJobId('group:123', 'message:456');
  return { endpoint: 'http://127.0.0.1:17865', authentication: { type: 'bearer', token },
    publishImage: () => 'generated-asset', fetch: async input => String(input).endsWith('/image')
      ? new Response(png) : jobResponse(id, 'done'), ...overrides };
}

test('generation submits the existing worker contract and publishes its image as an asset', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const publications: unknown[] = [];
  const id = imageGenerationJobId('group:123', 'message:456');
  assert.equal(id, 'd835e5de561af701be568278bd98b489d80c72678a7fca3ed3013f35ee2cf1b5');
  const adapter = createImageGenerationAdapter(options({
    async fetch(input, init) {
      calls.push({ url: String(input), init });
      return String(input).endsWith('/image') ? new Response(png) : jobResponse(id, 'done');
    },
    publishImage(input) { publications.push(input); return 'asset:generated'; },
  }));
  const result = await adapter.generate({ prompt: ' 月球上喝茶的猫 ', size: '1536x1024', quality: 'high' }, context());
  assert.deepEqual(result, { assetId: 'asset:generated', jobId: id, replayed: false });
  assert.deepEqual(calls.map(call => call.url), [
    'http://127.0.0.1:17865/jobs', `http://127.0.0.1:17865/jobs/${id}/image`,
  ]);
  assert.equal(new Headers(calls[0]?.init?.headers).get('authorization'), `Bearer ${token}`);
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    id, prompt: '月球上喝茶的猫', size: '1536x1024', quality: 'high', operation: 'generate',
  });
  const publication = publications[0] as Record<string, unknown>;
  assert.equal(publication.jobId, id);
  assert.equal(publication.conversationId, 'group:123');
  assert.deepEqual(publication.scope, context().scope);
  assert.equal(publication.mediaType, 'image/png');
  assert.deepEqual(publication.bytes, png);
});

test('submitted jobs are polled without resubmission and replay metadata is preserved', async () => {
  const id = imageGenerationJobId('group:123', 'message:456');
  const calls: string[] = [];
  const statuses: Array<'submitted' | 'running' | 'done'> = ['submitted', 'running', 'done'];
  const adapter = createImageGenerationAdapter(options({ pollIntervalMs: 1, async fetch(input) {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/image')) return new Response(png);
    return jobResponse(id, statuses.shift() ?? 'done', calls.length === 1);
  } }));
  assert.deepEqual(await adapter.generate({ prompt: 'x' }, context()), {
    assetId: 'generated-asset', jobId: id, replayed: true,
  });
  assert.equal(calls.filter(url => url.endsWith('/jobs')).length, 1);
  assert.deepEqual(calls, [
    'http://127.0.0.1:17865/jobs',
    `http://127.0.0.1:17865/jobs/${id}`,
    `http://127.0.0.1:17865/jobs/${id}`,
    `http://127.0.0.1:17865/jobs/${id}/image`,
  ]);
});

test('editing maps controlled asset ids to worker-validated attachment paths', async () => {
  const id = imageGenerationJobId('group:123', 'message:456');
  const resolved: string[] = [];
  let body: Record<string, unknown> | undefined;
  const adapter = createImageGenerationAdapter(options({
    resolveWorkerReference(input) {
      resolved.push(input.assetId);
      return `/trusted/dsh/attachments/${input.assetId}`;
    },
    async fetch(input, init) {
      if (String(input).endsWith('/jobs')) { body = JSON.parse(String(init?.body)) as Record<string, unknown>; return jobResponse(id, 'done'); }
      return new Response(png);
    },
  }));
  await adapter.generate({ prompt: '保留构图，改成水彩', operation: 'edit',
    referenceAssetIds: ['reference-one', 'reference-two'] }, context());
  assert.deepEqual(resolved, ['reference-one', 'reference-two']);
  assert.deepEqual(body, { id, prompt: '保留构图，改成水彩', operation: 'edit', referenceImages: [
    '/trusted/dsh/attachments/reference-one', '/trusted/dsh/attachments/reference-two',
  ] });
});

test('model input cannot supply worker URLs, paths, credentials, or mismatched edit mode', async () => {
  let fetches = 0;
  const adapter = createImageGenerationAdapter(options({ fetch: async () => { fetches++; return new Response(png); } }));
  for (const input of [
    { prompt: 'x', endpoint: 'https://attacker.invalid' },
    { prompt: 'x', url: 'file:///etc/passwd' },
    { prompt: 'x', path: '/etc/passwd' },
    { prompt: 'x', token: 'stolen' },
    { prompt: 'x', operation: 'edit' },
    { prompt: 'x', operation: 'generate', referenceAssetIds: ['asset'] },
    { prompt: 'x', referenceImages: ['/tmp/reference.png'] },
  ]) await assert.rejects(adapter.generate(input as never, context()), { code: 'INVALID_IMAGE_GENERATION_REQUEST' });
  assert.equal(fetches, 0);
});

test('unknown submission is never retried and credentials do not enter errors', async () => {
  let calls = 0;
  const adapter = createImageGenerationAdapter(options({ fetch: async () => {
    calls++;
    throw new Error(`${token} /private/token`);
  } }));
  await assert.rejects(adapter.generate({ prompt: 'x' }, context()), error => {
    assert(error instanceof Error);
    assert.equal((error as Error & { code?: string }).code, 'IMAGE_GENERATION_UNKNOWN');
    assert.doesNotMatch(error.message, new RegExp(`${token}|private`));
    return true;
  });
  assert.equal(calls, 1);
});

test('worker image bytes and JSON responses are bounded before publication', async () => {
  const id = imageGenerationJobId('group:123', 'message:456');
  let publications = 0;
  const oversized = createImageGenerationAdapter(options({ maxImageBytes: 24,
    publishImage: () => { publications++; return 'asset'; },
    fetch: async input => String(input).endsWith('/image') ? new Response(Uint8Array.from([...png, 1])) : jobResponse(id, 'done'),
  }));
  await assert.rejects(oversized.generate({ prompt: 'x' }, context()), { code: 'IMAGE_GENERATION_RESULT_UNKNOWN' });

  const invalid = createImageGenerationAdapter(options({ publishImage: () => { publications++; return 'asset'; },
    fetch: async input => String(input).endsWith('/image')
      ? new Response(Uint8Array.from({ length: 24 }, () => 1)) : jobResponse(id, 'done'),
  }));
  await assert.rejects(invalid.generate({ prompt: 'x' }, context()), { code: 'IMAGE_GENERATION_RESULT_UNKNOWN' });

  const oversizedJson = createImageGenerationAdapter(options({ publishImage: () => { publications++; return 'asset'; },
    fetch: async () => new Response('x'.repeat(33_000)),
  }));
  await assert.rejects(oversizedJson.generate({ prompt: 'x' }, context()), { code: 'IMAGE_GENERATION_RESULT_UNKNOWN' });
  assert.equal(publications, 0);
});

test('finite FIFO concurrency, admission, queued cancellation, and submitted unknown cancellation are enforced', async () => {
  const releases: Array<() => void> = [];
  const starts: string[] = [];
  const adapter = createImageGenerationAdapter(options({ maxConcurrent: 1, maxPending: 2,
    fetch: async (_input, init) => {
      const prompt = (JSON.parse(String(init?.body)) as { prompt: string }).prompt;
      starts.push(prompt);
      await new Promise<void>(resolve => releases.push(resolve));
      return jobResponse(imageGenerationJobId('group:123', 'message:456'), 'done');
    },
  }));
  const activeController = new AbortController();
  const first = adapter.generate({ prompt: 'first' }, context(activeController.signal));
  const queuedController = new AbortController();
  const second = adapter.generate({ prompt: 'second' }, context(queuedController.signal));
  await assert.rejects(adapter.generate({ prompt: 'overflow' }, context()), { code: 'IMAGE_GENERATION_BACKPRESSURE' });
  queuedController.abort();
  await assert.rejects(second, { code: 'IMAGE_GENERATION_ABORTED' });
  assert.deepEqual(starts, ['first']);
  activeController.abort();
  await assert.rejects(first, { code: 'IMAGE_GENERATION_ABORTED_UNKNOWN' });
  assert.equal(adapter.metrics().active, 1);
  releases.shift()?.();
  await nextTurn();
  assert.equal(adapter.metrics().pending, 0);
});

test('deadline includes queue time and submitted timeout remains counted until raw fetch settles', async () => {
  let release!: () => void;
  const adapter = createImageGenerationAdapter(options({ timeoutMs: 20, maxConcurrent: 1, maxPending: 2,
    fetch: async () => { await new Promise<void>(resolve => { release = resolve; }); return new Response(); },
  }));
  const first = adapter.generate({ prompt: 'first' }, context());
  const second = adapter.generate({ prompt: 'second' }, context());
  await assert.rejects(first, { code: 'IMAGE_GENERATION_TIMEOUT_UNKNOWN' });
  await assert.rejects(second, { code: 'IMAGE_GENERATION_TIMEOUT' });
  assert.equal(adapter.metrics().active, 1);
  release();
  await nextTurn();
  assert.equal(adapter.metrics().pending, 0);
});

test('effect derives worker job and publication scope from trusted metadata', async () => {
  const publications: Array<Record<string, unknown>> = [];
  const expectedId = imageGenerationJobId('private:7', digest(['event:1', 'drawing', '1.0.0',
    { prompt: '画一条鲸鱼', operation: 'generate', referenceAssetIds: [] }]));
  const effect = createImageGenerationEffect(createImageGenerationAdapter(options({
    fetch: async input => String(input).endsWith('/image') ? new Response(png) : jobResponse(expectedId, 'done'),
    publishImage(input) { publications.push(input as unknown as Record<string, unknown>); return 'effect-asset'; },
  })));
  const request: EffectRequest = {
    input: { prompt: '画一条鲸鱼' }, signal: new AbortController().signal,
    scope: { eventId: 'event:1', conversationId: 'private:7', featureId: 'drawing', version: '1.0.0',
      persona: { id: 'whale', version: '2.0.0' }, sessionId: 'session:9', generation: 3 },
  };
  assert.deepEqual(await effect.execute(request), { assetId: 'effect-asset', jobId: expectedId, replayed: false });
  assert.equal(publications[0]?.conversationId, 'private:7');
  assert.equal(publications[0]?.jobId, expectedId);
  assert.deepEqual(publications[0]?.scope, {
    persona: { id: 'whale', version: '2.0.0' }, sessionId: 'session:9', generation: 3,
  });
});
