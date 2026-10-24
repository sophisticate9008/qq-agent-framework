import { createHash } from 'node:crypto';

import type { EffectAdapter, EffectRequest, JsonValue, OutboundScope } from '../core/types.ts';
import { normalizeOutboundScope } from '../core/scope.ts';
import { FrameworkError, assert, isRecord, reference, snapshot } from '../core/values.ts';
import { digest, json } from '../host/data.ts';

export type ImageGenerationOperation = 'generate' | 'edit';
export type ImageGenerationSize = 'auto' | '1024x1024' | '1536x1024' | '1024x1536';
export type ImageGenerationQuality = 'low' | 'medium' | 'high';
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface ImageGenerationInput {
  prompt: string;
  operation?: ImageGenerationOperation;
  referenceAssetIds?: readonly string[];
  size?: ImageGenerationSize;
  quality?: ImageGenerationQuality;
}

export interface ImageGenerationContext {
  conversationId: string;
  scope: Readonly<OutboundScope>;
  idempotencyKey: string;
  signal: AbortSignal;
}

export interface ResolveWorkerReferenceRequest extends ImageGenerationContext {
  assetId: string;
}

export interface PublishGeneratedImageRequest extends ImageGenerationContext {
  jobId: string;
  bytes: Uint8Array;
  mediaType: ImageMediaType;
}

export interface ImageGenerationAdapterOptions {
  endpoint: string;
  authentication: { type: 'bearer'; token: string };
  publishImage(request: PublishGeneratedImageRequest): Promise<string> | string;
  resolveWorkerReference?(request: ResolveWorkerReferenceRequest): Promise<string> | string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxConcurrent?: number;
  maxPending?: number;
  maxImageBytes?: number;
}

interface NormalizedRequest {
  prompt: string;
  operation: ImageGenerationOperation;
  referenceAssetIds: readonly string[];
  size?: ImageGenerationSize;
  quality?: ImageGenerationQuality;
}

interface WorkerJob {
  id: string;
  status: 'submitted' | 'queued' | 'running' | 'done' | 'error';
}

interface PendingJob {
  request: NormalizedRequest;
  context: ImageGenerationContext;
  id: string;
  controller: AbortController;
  started: boolean;
  dispatched: boolean;
  settled: boolean;
  timedOut: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve(value: Readonly<{ assetId: string; jobId: string; replayed: boolean }>): void;
  reject(error: unknown): void;
  detach(): void;
}

const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_REFERENCE_IMAGES = 4;
const MAX_JSON_BYTES = 32 * 1024;

function workerUrl(input: string, suffix: string): URL {
  let value: URL;
  try { value = new URL(input); }
  catch { throw new FrameworkError('INVALID_IMAGE_GENERATION_OPTIONS', 'A fixed HTTP(S) worker endpoint is required.'); }
  assert((value.protocol === 'http:' || value.protocol === 'https:') && value.username === '' && value.password === ''
    && value.hash === '' && value.search === '', 'INVALID_IMAGE_GENERATION_OPTIONS',
  'A fixed HTTP(S) worker endpoint without embedded credentials is required.');
  if (!value.pathname.endsWith('/')) value.pathname += '/';
  return new URL(suffix, value);
}

function inputData(input: unknown): NormalizedRequest {
  const value = snapshot(input);
  assert(isRecord(value) && Object.keys(value).every(key =>
    ['prompt', 'operation', 'referenceAssetIds', 'size', 'quality'].includes(key))
    && typeof value.prompt === 'string' && value.prompt.trim().length > 0 && value.prompt.length <= 6000
    && (value.operation === undefined || value.operation === 'generate' || value.operation === 'edit')
    && (value.referenceAssetIds === undefined || Array.isArray(value.referenceAssetIds)
      && value.referenceAssetIds.length <= MAX_REFERENCE_IMAGES && value.referenceAssetIds.every(reference))
    && (value.size === undefined || ['auto', '1024x1024', '1536x1024', '1024x1536'].includes(String(value.size)))
    && (value.quality === undefined || ['low', 'medium', 'high'].includes(String(value.quality))),
  'INVALID_IMAGE_GENERATION_REQUEST', 'A bounded image prompt and supported generation options are required.');
  const referenceAssetIds = Object.freeze([...(value.referenceAssetIds as string[] | undefined ?? [])]);
  const operation = value.operation ?? (referenceAssetIds.length > 0 ? 'edit' : 'generate');
  assert(operation === 'edit' && referenceAssetIds.length > 0 || operation === 'generate' && referenceAssetIds.length === 0,
    'INVALID_IMAGE_GENERATION_REQUEST', 'Image editing requires one to four controlled reference assets.');
  return Object.freeze({
    prompt: value.prompt.trim(),
    operation,
    referenceAssetIds,
    ...(value.size === undefined ? {} : { size: value.size as ImageGenerationSize }),
    ...(value.quality === undefined ? {} : { quality: value.quality as ImageGenerationQuality }),
  });
}

function mediaType(bytes: Uint8Array): ImageMediaType | null {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
    && bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return 'image/jpeg';
  if (bytes.length >= 14 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46
    && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'image/gif';
  if (bytes.length >= 16 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

async function boundedBytes(response: Response, maximum: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const declared = response.headers.get('content-length');
  assert(declared === null || /^\d+$/.test(declared) && Number(declared) <= maximum,
    'IMAGE_GENERATION_RESULT_UNKNOWN', 'The worker returned an oversized image.');
  assert(response.body, 'IMAGE_GENERATION_RESULT_UNKNOWN', 'The worker returned an unusable image.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      assert(total <= maximum, 'IMAGE_GENERATION_RESULT_UNKNOWN', 'The worker returned an oversized image.');
      chunks.push(part.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  assert(total > 0, 'IMAGE_GENERATION_RESULT_UNKNOWN', 'The worker returned an unusable image.');
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const bytes = await boundedBytes(response, MAX_JSON_BYTES, signal);
  try { return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown; }
  catch { throw new FrameworkError('IMAGE_GENERATION_RESULT_UNKNOWN', 'The worker returned an unusable response.'); }
}

function workerJob(value: unknown, expectedId: string): WorkerJob {
  assert(isRecord(value) && isRecord(value.job) && value.ok === true && value.job.id === expectedId
    && ['submitted', 'queued', 'running', 'done', 'error'].includes(String(value.job.status)),
  'IMAGE_GENERATION_RESULT_UNKNOWN', 'The worker returned an unusable job response.');
  return { id: expectedId, status: value.job.status as WorkerJob['status'] };
}

function publicError(job: PendingJob): FrameworkError {
  if (job.timedOut) return new FrameworkError(job.dispatched ? 'IMAGE_GENERATION_TIMEOUT_UNKNOWN' : 'IMAGE_GENERATION_TIMEOUT',
    job.dispatched ? 'The worker job result is unknown and must not be resubmitted automatically.' : 'Image generation expired before submission.');
  return new FrameworkError(job.dispatched ? 'IMAGE_GENERATION_ABORTED_UNKNOWN' : 'IMAGE_GENERATION_ABORTED',
    job.dispatched ? 'The worker job result is unknown and must not be resubmitted automatically.' : 'Image generation was cancelled before submission.');
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, milliseconds);
    const aborted = (): void => { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(signal.reason); };
    signal.addEventListener('abort', aborted, { once: true });
  });
}

export function imageGenerationJobId(conversationId: string, idempotencyKey: string): string {
  assert(reference(conversationId) && reference(idempotencyKey), 'INVALID_IMAGE_GENERATION_CONTEXT',
    'A trusted conversation and source request id are required.');
  return createHash('sha256').update(`${conversationId}/${idempotencyKey}`).digest('hex');
}

export function createImageGenerationAdapter({ endpoint, authentication, publishImage, resolveWorkerReference,
  fetch: fetchImpl = globalThis.fetch, timeoutMs = 300_000, pollIntervalMs = 2_000, maxConcurrent = 1,
  maxPending = 4, maxImageBytes = DEFAULT_MAX_IMAGE_BYTES }: ImageGenerationAdapterOptions) {
  const jobsUrl = workerUrl(endpoint, 'jobs');
  assert(authentication?.type === 'bearer' && typeof authentication.token === 'string' && authentication.token.length >= 32
    && authentication.token.length <= 8192 && !/[\r\n]/.test(authentication.token)
    && typeof publishImage === 'function' && typeof fetchImpl === 'function'
    && (resolveWorkerReference === undefined || typeof resolveWorkerReference === 'function')
    && Number.isSafeInteger(timeoutMs) && timeoutMs >= 10 && timeoutMs <= 600_000
    && Number.isSafeInteger(pollIntervalMs) && pollIntervalMs > 0 && pollIntervalMs <= 60_000
    && Number.isSafeInteger(maxConcurrent) && maxConcurrent > 0 && maxConcurrent <= 16
    && Number.isSafeInteger(maxPending) && maxPending >= maxConcurrent && maxPending <= 256
    && Number.isSafeInteger(maxImageBytes) && maxImageBytes >= 24 && maxImageBytes <= 64 * 1024 * 1024,
  'INVALID_IMAGE_GENERATION_OPTIONS', 'Image generation requires explicit worker authentication, callbacks, and finite limits.');
  const authorization = `Bearer ${authentication.token}`;
  const queued: PendingJob[] = [];
  let active = 0;

  async function request(url: URL, init: RequestInit, signal: AbortSignal): Promise<Response> {
    try { return await fetchImpl(url, { ...init, redirect: 'error', signal }); }
    catch { throw new FrameworkError('IMAGE_GENERATION_UNKNOWN', 'The worker job result is unknown and must not be retried automatically.'); }
  }

  async function run(job: PendingJob): Promise<Readonly<{ assetId: string; jobId: string; replayed: boolean }>> {
    const referenceImages: string[] = [];
    for (const assetId of job.request.referenceAssetIds) {
      assert(resolveWorkerReference, 'IMAGE_EDIT_UNAVAILABLE', 'This host does not resolve worker reference images.');
      try {
        const path = await resolveWorkerReference({ ...job.context, signal: job.controller.signal, assetId });
        job.controller.signal.throwIfAborted();
        assert(typeof path === 'string' && path.startsWith('/') && path.length <= 4096 && !/[\x00-\x1f\x7f]/.test(path),
          'REFERENCE_IMAGE_REJECTED', 'A controlled reference image could not be resolved.');
        referenceImages.push(path);
      } catch {
        job.controller.signal.throwIfAborted();
        throw new FrameworkError('REFERENCE_IMAGE_REJECTED', 'A controlled reference image could not be resolved.');
      }
    }
    const payload = { id: job.id, prompt: job.request.prompt,
      ...(job.request.size === undefined ? {} : { size: job.request.size }),
      ...(job.request.quality === undefined ? {} : { quality: job.request.quality }),
      operation: job.request.operation,
      ...(referenceImages.length === 0 ? {} : { referenceImages }) };
    job.dispatched = true;
    const submitted = await request(jobsUrl, { method: 'POST', headers: { authorization, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload) }, job.controller.signal);
    if (!submitted.ok) {
      void submitted.body?.cancel().catch(() => undefined);
      if (submitted.status >= 400 && submitted.status < 500 && submitted.status !== 408) {
        throw new FrameworkError('IMAGE_GENERATION_REJECTED', 'The worker rejected the image job.');
      }
      throw new FrameworkError('IMAGE_GENERATION_UNKNOWN', 'The worker job result is unknown and must not be retried automatically.');
    }
    const submittedBody = await boundedJson(submitted, job.controller.signal);
    let current = workerJob(submittedBody, job.id);
    const replayed = isRecord(submittedBody) && submittedBody.replayed === true;
    while (current.status !== 'done') {
      if (current.status === 'error') throw new FrameworkError('IMAGE_GENERATION_FAILED', 'The worker completed the image job with an error.');
      await wait(pollIntervalMs, job.controller.signal);
      const status = await request(workerUrl(endpoint, `jobs/${job.id}`),
        { method: 'GET', headers: { authorization, accept: 'application/json' } }, job.controller.signal);
      if (!status.ok) {
        void status.body?.cancel().catch(() => undefined);
        throw new FrameworkError('IMAGE_GENERATION_UNKNOWN', 'The worker job result is unknown and must not be retried automatically.');
      }
      current = workerJob(await boundedJson(status, job.controller.signal), job.id);
    }
    const result = await request(workerUrl(endpoint, `jobs/${job.id}/image`),
      { method: 'GET', headers: { authorization, accept: 'image/*' } }, job.controller.signal);
    if (!result.ok) {
      void result.body?.cancel().catch(() => undefined);
      throw new FrameworkError('IMAGE_GENERATION_RESULT_UNKNOWN', 'The completed worker image could not be retrieved.');
    }
    const bytes = await boundedBytes(result, maxImageBytes, job.controller.signal);
    const detected = mediaType(bytes);
    assert(detected !== null, 'IMAGE_GENERATION_RESULT_UNKNOWN', 'The worker returned unsupported image content.');
    job.controller.signal.throwIfAborted();
    let assetId: string;
    try { assetId = await publishImage({ ...job.context, signal: job.controller.signal, jobId: job.id, bytes, mediaType: detected }); }
    catch { throw new FrameworkError('IMAGE_PUBLICATION_UNKNOWN', 'The generated image could not be published with a confirmed result.'); }
    job.controller.signal.throwIfAborted();
    assert(reference(assetId), 'IMAGE_PUBLICATION_UNKNOWN', 'The generated image publisher returned an invalid asset reference.');
    return snapshot({ assetId, jobId: job.id, replayed });
  }

  function finish(job: PendingJob): void {
    clearTimeout(job.timer);
    job.detach();
    active--;
    pump();
  }

  function start(job: PendingJob): void {
    job.started = true;
    active++;
    const operation = run(job);
    operation.then(value => {
      if (!job.settled) { job.settled = true; job.resolve(value); }
    }, error => {
      if (!job.settled) {
        job.settled = true;
        job.reject(error instanceof FrameworkError ? error
          : new FrameworkError('IMAGE_GENERATION_UNKNOWN', 'The worker job result is unknown and must not be retried automatically.'));
      }
    }).finally(() => finish(job));
  }

  function pump(): void {
    while (active < maxConcurrent && queued.length > 0) {
      const job = queued.shift()!;
      if (!job.settled) start(job);
    }
  }

  return Object.freeze({
    metrics() { return Object.freeze({ queued: queued.length, active, pending: queued.length + active, maxConcurrent, maxPending }); },
    async generate(input: ImageGenerationInput, inputContext: ImageGenerationContext):
      Promise<Readonly<{ assetId: string; jobId: string; replayed: boolean }>> {
      const generation = inputData(input);
      const scope = normalizeOutboundScope(inputContext.scope);
      assert(reference(inputContext.conversationId) && reference(inputContext.idempotencyKey)
        && inputContext.signal instanceof AbortSignal, 'INVALID_IMAGE_GENERATION_CONTEXT',
      'A trusted scoped image generation context is required.');
      assert(queued.length + active < maxPending, 'IMAGE_GENERATION_BACKPRESSURE', 'Too many image generation operations remain unresolved.');
      const context = Object.freeze({ conversationId: inputContext.conversationId, idempotencyKey: inputContext.idempotencyKey,
        scope, signal: inputContext.signal });
      const controller = new AbortController();
      const id = imageGenerationJobId(context.conversationId, context.idempotencyKey);
      return new Promise((resolve, reject) => {
        let job!: PendingJob;
        const abort = (): void => {
          controller.abort(inputContext.signal.reason);
          if (job.settled) return;
          job.settled = true;
          if (!job.started) {
            const index = queued.indexOf(job);
            if (index >= 0) queued.splice(index, 1);
            clearTimeout(job.timer);
            job.detach();
          }
          reject(publicError(job));
          pump();
        };
        const timer = setTimeout(() => { job.timedOut = true; abort(); }, timeoutMs);
        job = { request: generation, context, id, controller, started: false, dispatched: false, settled: false,
          timedOut: false, timer, resolve, reject, detach: () => inputContext.signal.removeEventListener('abort', abort) };
        inputContext.signal.addEventListener('abort', abort, { once: true });
        if (inputContext.signal.aborted) abort();
        else { queued.push(job); pump(); }
      });
    },
  });
}

export function createImageGenerationEffect(adapter: ReturnType<typeof createImageGenerationAdapter>): EffectAdapter {
  return Object.freeze({ async execute(request: EffectRequest): Promise<JsonValue> {
    const scope = normalizeOutboundScope({ persona: request.scope.persona,
      ...(request.scope.sessionId === undefined ? {} : { sessionId: request.scope.sessionId }),
      ...(request.scope.generation === undefined ? {} : { generation: request.scope.generation }) });
    const input = inputData(request.input);
    return json(await adapter.generate(input, { conversationId: request.scope.conversationId, scope,
      idempotencyKey: digest([request.scope.eventId, request.scope.featureId, request.scope.version, input]), signal: request.signal }));
  } });
}
