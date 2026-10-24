import { normalizeContent } from '../core/content.ts';
import { normalizeOutboundScope } from '../core/scope.ts';
import type { EffectAdapter, EffectRequest, MessageContent, OutboundScope, TransportCapabilities } from '../core/types.ts';
import { FrameworkError, assert, errorCode, isRecord, reference, snapshot } from '../core/values.ts';
import type { MarkdownPngPage, MarkdownRenderer } from '../rendering/markdown.ts';
import { digest, json } from './data.ts';
import { withDeadline } from './deadlines.ts';

export type PresentationFormat = 'text' | 'markdown-image' | 'forward';
export interface ReplyTarget {
  messageId: string;
  distance?: number;
  ageMs?: number;
}
export interface PresentationRequest {
  body: string;
  title?: string;
  format?: PresentationFormat | 'auto';
  purpose?: 'conversation' | 'document';
  fallback?: 'none' | 'text';
  reply?: 'auto' | 'never' | 'always';
  replyTo?: ReplyTarget;
}
export interface PresentationChoice { format: PresentationFormat; quote: boolean }
export interface PresentationContext {
  conversationId: string;
  scope: Readonly<OutboundScope>;
  idempotencyKey: string;
  signal: AbortSignal;
}
export interface RenderedImageRequest extends MarkdownPngPage, PresentationContext {}
export interface PreparedPresentation extends PresentationChoice {
  content: readonly MessageContent[];
  fallbackFrom?: PresentationFormat;
}
export interface PresentationSelection {
  request: Readonly<PresentationRequest>;
  available: readonly PresentationFormat[];
  suggested: Readonly<PresentationChoice>;
  replyTiming: 'near' | 'far' | 'uncertain' | 'absent';
}
export interface PresentationServiceOptions {
  capabilities: Readonly<TransportCapabilities>;
  renderer?: MarkdownRenderer;
  publishImage?(request: RenderedImageRequest): Promise<string>;
  select?(input: Readonly<PresentationSelection>, signal: AbortSignal): PresentationChoice | Promise<PresentationChoice>;
  nearDistance?: number;
  nearAgeMs?: number;
  timeoutMs?: number;
  maxPending?: number;
}

function requestData(input: unknown): Readonly<PresentationRequest> {
  const value = snapshot(input);
  assert(isRecord(value) && Object.keys(value).every(key => ['body', 'title', 'format', 'purpose', 'fallback', 'reply', 'replyTo'].includes(key))
    && typeof value.body === 'string' && value.body.length > 0 && Buffer.byteLength(value.body) <= 64 * 1024
    && (value.title === undefined || typeof value.title === 'string' && value.title.length > 0 && value.title.length <= 200)
    && (value.format === undefined || ['auto', 'text', 'markdown-image', 'forward'].includes(String(value.format)))
    && (value.purpose === undefined || ['conversation', 'document'].includes(String(value.purpose)))
    && (value.fallback === undefined || ['none', 'text'].includes(String(value.fallback)))
    && (value.reply === undefined || ['auto', 'never', 'always'].includes(String(value.reply))),
  'INVALID_PRESENTATION', 'A bounded document and explicit presentation options are required.');
  if (value.replyTo !== undefined) {
    const target = value.replyTo;
    assert(isRecord(target) && Object.keys(target).every(key => ['messageId', 'distance', 'ageMs'].includes(key))
      && reference(target.messageId)
      && (target.distance === undefined || Number.isSafeInteger(target.distance) && Number(target.distance) >= 0)
      && (target.ageMs === undefined || typeof target.ageMs === 'number' && Number.isFinite(target.ageMs) && target.ageMs >= 0),
    'INVALID_PRESENTATION', 'Reply timing must describe a bounded target.');
  }
  assert(value.reply !== 'always' || value.replyTo !== undefined, 'INVALID_PRESENTATION', 'Explicit quoting requires a reply target.');
  return value as unknown as Readonly<PresentationRequest>;
}

export function createPresentationService({ capabilities, renderer, publishImage, select, nearDistance = 6,
  nearAgeMs = 120_000, timeoutMs = 15_000, maxPending = 2 }: PresentationServiceOptions) {
  const supported = snapshot(capabilities);
  assert(Array.isArray(supported.contentTypes) && supported.contentTypes.every(type => ['text', 'image', 'audio', 'file', 'mention', 'reply', 'forward'].includes(type))
    && Number.isSafeInteger(nearDistance) && nearDistance >= 0 && nearDistance <= 1000
    && Number.isSafeInteger(nearAgeMs) && nearAgeMs >= 0 && nearAgeMs <= 86_400_000
    && Number.isSafeInteger(timeoutMs) && timeoutMs >= 10 && timeoutMs <= 300000
    && Number.isSafeInteger(maxPending) && maxPending > 0 && maxPending <= 256
    && (select === undefined || typeof select === 'function')
    && (renderer === undefined || typeof renderer.render === 'function')
    && (publishImage === undefined || typeof publishImage === 'function'),
  'INVALID_PRESENTATION_OPTIONS', 'Presentation requires finite bounds and explicit transport capabilities.');
  const available: PresentationFormat[] = [];
  if (supported.contentTypes.includes('text')) available.push('text');
  if (supported.contentTypes.includes('image') && renderer && publishImage) available.push('markdown-image');
  if (supported.contentTypes.includes('forward')) available.push('forward');
  const formats = Object.freeze(available);
  const forwardLimit = supported.maxForwardNodes ?? 32;
  assert(Number.isSafeInteger(forwardLimit) && forwardLimit > 0 && forwardLimit <= 32,
    'INVALID_PRESENTATION_OPTIONS', 'Forward node capacity must be finite.');
  let pending = 0;

  function timing(request: PresentationRequest): PresentationSelection['replyTiming'] {
    const target = request.replyTo;
    if (!target) return 'absent';
    if (target.distance !== undefined && target.distance > nearDistance || target.ageMs !== undefined && target.ageMs > nearAgeMs) return 'far';
    if (target.distance !== undefined && target.ageMs !== undefined) return 'near';
    return 'uncertain';
  }

  function suggested(request: PresentationRequest, replyTiming: PresentationSelection['replyTiming']): PresentationChoice {
    let format = request.format ?? 'auto';
    if (format === 'auto') {
      format = request.purpose === 'document' && formats.includes('markdown-image') ? 'markdown-image'
        : request.body.length > 8000 && formats.includes('forward') ? 'forward'
        : request.body.length > 8000 && formats.includes('markdown-image') ? 'markdown-image' : 'text';
    }
    if (!formats.includes(format) && request.fallback === 'text' && formats.includes('text')) format = 'text';
    assert(formats.includes(format), 'PRESENTATION_UNAVAILABLE', 'The requested presentation is not supported by this host.');
    const quote = request.reply === 'always' || request.reply !== 'never' && replyTiming === 'far';
    return { format, quote: format !== 'forward' && supported.contentTypes.includes('reply') && quote };
  }

  function validateChoice(input: unknown, request: PresentationRequest, replyTiming: PresentationSelection['replyTiming']): PresentationChoice {
    const value = snapshot(input);
    assert(isRecord(value) && Object.keys(value).length === 2 && Object.keys(value).every(key => ['format', 'quote'].includes(key))
      && formats.includes(value.format as PresentationFormat) && typeof value.quote === 'boolean',
    'INVALID_PRESENTATION_CHOICE', 'A selector must return a supported format and explicit quote decision.');
    assert(!value.quote || request.replyTo !== undefined && supported.contentTypes.includes('reply') && value.format !== 'forward',
      'INVALID_PRESENTATION_CHOICE', 'This presentation cannot quote the requested target.');
    assert(request.reply !== 'never' || !value.quote, 'INVALID_PRESENTATION_CHOICE', 'The caller disabled quoting.');
    assert(request.reply !== 'always' || value.quote, 'INVALID_PRESENTATION_CHOICE', 'An explicit reply cannot be silently omitted.');
    assert(request.format === undefined || request.format === 'auto' || value.format === request.format
      || request.fallback === 'text' && value.format === 'text', 'INVALID_PRESENTATION_CHOICE', 'An explicit output format cannot be silently replaced.');
    assert(request.reply !== 'auto' && request.reply !== undefined || replyTiming !== 'near' || !value.quote,
      'INVALID_PRESENTATION_CHOICE', 'Nearby messages do not require an automatic quote.');
    return value as unknown as PresentationChoice;
  }

  function textContent(request: PresentationRequest, quote: boolean): readonly MessageContent[] {
    return normalizeContent([...(quote ? [{ type: 'reply', messageId: request.replyTo!.messageId }] : []),
      { type: 'text', text: request.body }]);
  }

  async function run(request: Readonly<PresentationRequest>, context: PresentationContext): Promise<Readonly<PreparedPresentation>> {
    const replyTiming = timing(request);
    const initial = suggested(request, replyTiming);
    const choice = validateChoice(select ? await select(snapshot({ request, available: formats, suggested: initial, replyTiming }), context.signal)
      : initial, request, replyTiming);
    context.signal.throwIfAborted();
    const fallbackFrom = request.format && request.format !== 'auto' && request.format !== choice.format ? request.format : undefined;
    if (choice.format === 'text') return snapshot({ ...choice, content: textContent(request, choice.quote),
      ...(fallbackFrom === undefined ? {} : { fallbackFrom }) });
    if (choice.format === 'forward') {
      const points = Array.from(request.body);
      const nodes = [];
      for (let index = 0; index < points.length; index += 4000) nodes.push({ content: [{ type: 'text' as const, text: points.slice(index, index + 4000).join('') }] });
      assert(nodes.length <= forwardLimit, 'PRESENTATION_TOO_LARGE', 'The document exceeds the forward node capacity.');
      return snapshot({ ...choice, content: normalizeContent([{ type: 'forward', nodes }]) });
    }
    try {
      const pages = await renderer!.render({ markdown: request.body, ...(request.title === undefined ? {} : { title: request.title }), signal: context.signal });
      context.signal.throwIfAborted();
      assert(Array.isArray(pages) && pages.length > 0 && pages.length <= 6, 'PRESENTATION_TOO_LARGE', 'The document must fit within six image pages.');
      const images: MessageContent[] = [];
      for (let index = 0; index < pages.length; index++) {
        context.signal.throwIfAborted();
        const assetId = await publishImage!({ ...pages[index], ...context, idempotencyKey: digest([context.idempotencyKey, index]) });
        context.signal.throwIfAborted();
        assert(reference(assetId), 'INVALID_RENDERED_ASSET', 'The publisher did not return a controlled asset reference.');
        images.push({ type: 'image', assetId });
      }
      return snapshot({ ...choice, content: normalizeContent([...(choice.quote ? [{ type: 'reply', messageId: request.replyTo!.messageId }] : []), ...images]) });
    } catch (error) {
      context.signal.throwIfAborted();
      if (request.fallback === 'text' && formats.includes('text') && request.body.length <= 8000) {
        return snapshot({ format: 'text' as const, quote: choice.quote, content: textContent(request, choice.quote), fallbackFrom: 'markdown-image' as const });
      }
      throw new FrameworkError(errorCode(error, 'PRESENTATION_RENDER_FAILED'), 'The document could not be prepared safely.');
    }
  }

  return Object.freeze({
    availableFormats: formats,
    metrics() { return Object.freeze({ pending, maxPending }); },
    async prepare(input: PresentationRequest, inputContext: PresentationContext): Promise<Readonly<PreparedPresentation>> {
      const request = requestData(input);
      const scope = normalizeOutboundScope(inputContext.scope);
      assert(reference(inputContext.conversationId) && reference(inputContext.idempotencyKey) && inputContext.signal instanceof AbortSignal,
        'INVALID_PRESENTATION_CONTEXT', 'A trusted scoped presentation context is required.');
      assert(pending < maxPending, 'PRESENTATION_BACKPRESSURE', 'Too many presentation operations remain unresolved.');
      return withDeadline({ signal: inputContext.signal, timeoutMs, code: 'PRESENTATION_TIMEOUT_UNKNOWN', run(signal) {
        pending++;
        const operation = run(request, { conversationId: inputContext.conversationId, idempotencyKey: inputContext.idempotencyKey, scope, signal });
        operation.then(() => { pending--; }, () => { pending--; });
        return operation;
      } });
    },
  });
}

export function createPresentationEffect(service: ReturnType<typeof createPresentationService>): EffectAdapter {
  return Object.freeze({ async execute(request: EffectRequest) {
    const scope = normalizeOutboundScope({ persona: request.scope.persona,
      ...(request.scope.sessionId === undefined ? {} : { sessionId: request.scope.sessionId }),
      ...(request.scope.generation === undefined ? {} : { generation: request.scope.generation }) });
    return json(await service.prepare(requestData(request.input), { conversationId: request.scope.conversationId, scope,
      idempotencyKey: digest([request.scope.eventId, request.scope.featureId, request.scope.version, request.input]), signal: request.signal }));
  } });
}
