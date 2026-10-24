import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';

import MarkdownIt from 'markdown-it';
import type { Browser } from 'playwright';

import { FrameworkError } from '../core/values.ts';

type MarkdownParser = InstanceType<typeof MarkdownIt>;

const DEFAULT_MAX_INPUT_BYTES = 256 * 1024;
const DEFAULT_WIDTH = 1_200;
const DEFAULT_PAGE_HEIGHT = 1_600;
const DEFAULT_MAX_PAGES = 8;
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_PENDING = 2;

const MAX_INPUT_BYTES = 1024 * 1024;
const MIN_WIDTH = 320;
const MAX_WIDTH = 2_048;
const MIN_PAGE_HEIGHT = 256;
const MAX_PAGE_HEIGHT = 4_096;
const MAX_PAGES = 32;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MIN_TIMEOUT_MS = 10;
const MAX_TIMEOUT_MS = 120_000;
const MAX_PENDING = 16;

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "font-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "img-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "worker-src 'none'"
].join('; ');

const STYLE = `
:root {
  color-scheme: light;
  background: #f4f6f8;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 20px;
  line-height: 1.65;
  color: #18212f;
}
* { box-sizing: border-box; }
html, body { margin: 0; min-width: 0; background: #f4f6f8; }
body { width: 100%; overflow-x: hidden; }
.markdown-body {
  width: 100%;
  min-width: 0;
  padding: 54px 64px 64px;
  overflow-wrap: anywhere;
}
.document-title {
  margin: 0 0 38px;
  padding-bottom: 22px;
  border-bottom: 3px solid #d8dee8;
  font-size: 2.15rem;
  line-height: 1.22;
  letter-spacing: -0.02em;
}
h1, h2, h3, h4, h5, h6 {
  margin: 1.35em 0 0.55em;
  line-height: 1.3;
  color: #101828;
}
h1 { font-size: 2rem; border-bottom: 2px solid #d8dee8; padding-bottom: 0.25em; }
h2 { font-size: 1.6rem; border-bottom: 1px solid #e2e7ef; padding-bottom: 0.22em; }
h3 { font-size: 1.3rem; }
p, ul, ol, blockquote, pre, table { margin: 0.75em 0 1em; }
ul, ol { padding-left: 1.65em; }
li { margin: 0.28em 0; }
li > p { margin: 0.3em 0; }
strong { color: #0b1220; }
blockquote {
  margin-left: 0;
  padding: 0.25em 1em;
  border-left: 5px solid #9aa9bd;
  color: #475467;
  background: #edf1f6;
}
code {
  padding: 0.12em 0.34em;
  border-radius: 5px;
  background: #e8edf3;
  font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
  font-size: 0.88em;
  overflow-wrap: anywhere;
}
pre {
  max-width: 100%;
  padding: 20px 24px;
  border-radius: 10px;
  background: #111827;
  color: #e5e7eb;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}
pre code { padding: 0; background: transparent; color: inherit; }
table {
  width: 100%;
  max-width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 0.92em;
}
th, td {
  padding: 12px 14px;
  border: 1px solid #cbd3df;
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
}
th { background: #e8edf3; color: #101828; }
tr:nth-child(even) td { background: #fafbfc; }
hr { margin: 1.6em 0; border: 0; border-top: 2px solid #d8dee8; }
.md-link { color: #175cd3; text-decoration: underline; text-decoration-thickness: 1px; }
.md-image {
  display: inline-block;
  max-width: 100%;
  padding: 0.12em 0.5em;
  border: 1px dashed #98a2b3;
  border-radius: 5px;
  color: #475467;
  background: #f8fafc;
}
`;

export type MarkdownBrowser = Pick<Browser, 'newContext'>;

export interface MarkdownRendererOptions {
  browser: MarkdownBrowser;
  maxInputBytes?: number;
  width?: number;
  pageHeight?: number;
  maxPages?: number;
  maxOutputBytes?: number;
  timeoutMs?: number;
  maxPending?: number;
}

export interface MarkdownRenderRequest {
  markdown: string;
  title?: string;
  signal?: AbortSignal;
}

export interface MarkdownPngPage {
  png: Uint8Array;
  width: number;
  height: number;
}

export interface MarkdownRenderer {
  render(request: MarkdownRenderRequest): Promise<readonly MarkdownPngPage[]>;
}

interface ResolvedOptions {
  browser: MarkdownBrowser;
  maxInputBytes: number;
  width: number;
  pageHeight: number;
  maxPages: number;
  maxOutputBytes: number;
  timeoutMs: number;
  maxPending: number;
}

interface PageDimensions {
  width: number;
  height: number;
}

function fail(code: string, message: string): never {
  throw new FrameworkError(code, message);
}

function integerOption(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('MARKDOWN_INVALID_OPTIONS', `Expected ${label} to be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function resolveOptions(options: MarkdownRendererOptions): ResolvedOptions {
  if (!options || typeof options !== 'object'
    || !options.browser || typeof options.browser.newContext !== 'function') {
    fail('MARKDOWN_INVALID_OPTIONS', 'A Playwright browser is required.');
  }
  return {
    browser: options.browser,
    maxInputBytes: integerOption(options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
      1, MAX_INPUT_BYTES, 'maxInputBytes'),
    width: integerOption(options.width ?? DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH, 'width'),
    pageHeight: integerOption(options.pageHeight ?? DEFAULT_PAGE_HEIGHT,
      MIN_PAGE_HEIGHT, MAX_PAGE_HEIGHT, 'pageHeight'),
    maxPages: integerOption(options.maxPages ?? DEFAULT_MAX_PAGES, 1, MAX_PAGES, 'maxPages'),
    maxOutputBytes: integerOption(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      1, MAX_OUTPUT_BYTES, 'maxOutputBytes'),
    timeoutMs: integerOption(options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, 'timeoutMs'),
    maxPending: integerOption(options.maxPending ?? DEFAULT_MAX_PENDING, 1, MAX_PENDING, 'maxPending')
  };
}

function createParser(): MarkdownParser {
  const parser = new MarkdownIt({
    html: false,
    linkify: false,
    typographer: false,
    maxNesting: 32
  });
  parser.renderer.rules.link_open = () => '<span class="md-link">';
  parser.renderer.rules.link_close = () => '</span>';
  parser.renderer.rules.image = (tokens, index) => {
    const alt = parser.utils.escapeHtml(tokens[index].content.trim() || 'image');
    return `<span class="md-image" role="img" aria-label="Image: ${alt}">[图片：${alt}]</span>`;
  };
  return parser;
}

function documentHtml(parser: MarkdownParser, markdown: string, title?: string): string {
  const titleMarkup = title === undefined || title.length === 0
    ? ''
    : `<h1 class="document-title">${parser.utils.escapeHtml(title)}</h1>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">
<style>${STYLE}</style>
</head>
<body><main class="markdown-body">${titleMarkup}${parser.render(markdown)}</main></body>
</html>`;
}

function assertRequest(request: MarkdownRenderRequest, maxInputBytes: number): void {
  if (!request || typeof request !== 'object' || typeof request.markdown !== 'string'
    || (request.title !== undefined && typeof request.title !== 'string')) {
    fail('MARKDOWN_INVALID_INPUT', 'Expected Markdown text and an optional title.');
  }
  if (request.signal !== undefined
    && (!(request.signal instanceof AbortSignal) || typeof request.signal.addEventListener !== 'function')) {
    fail('MARKDOWN_INVALID_INPUT', 'Expected a valid abort signal.');
  }
  const inputBytes = Buffer.byteLength(request.markdown, 'utf8')
    + Buffer.byteLength(request.title ?? '', 'utf8');
  if (inputBytes > maxInputBytes) {
    fail('MARKDOWN_INPUT_TOO_LARGE', 'Markdown input exceeds the configured byte limit.');
  }
}

function abortFailure(signal: AbortSignal): FrameworkError {
  return signal.reason instanceof FrameworkError
    ? signal.reason
    : new FrameworkError('MARKDOWN_ABORTED', 'Markdown rendering was aborted.');
}

function timeoutFailure(): FrameworkError {
  return new FrameworkError('MARKDOWN_TIMEOUT_UNKNOWN',
    'Markdown rendering did not finish within its total deadline.');
}

function checkActive(signal: AbortSignal, deadlineAt: number): void {
  if (signal.aborted) throw abortFailure(signal);
  if (performance.now() >= deadlineAt) throw timeoutFailure();
}

function validDimensions(value: PageDimensions): boolean {
  return value && Number.isSafeInteger(value.width) && value.width > 0
    && Number.isSafeInteger(value.height) && value.height > 0;
}

async function renderDocument(
  options: ResolvedOptions,
  parser: MarkdownParser,
  request: MarkdownRenderRequest,
  signal: AbortSignal,
  deadlineAt: number
): Promise<readonly MarkdownPngPage[]> {
  let context: Awaited<ReturnType<MarkdownBrowser['newContext']>> | undefined;
  let closing: Promise<void> | undefined;
  const closeContext = (): Promise<void> => {
    if (!context) return Promise.resolve();
    closing ??= context.close({ reason: 'Markdown render ended.' });
    return closing;
  };
  const onAbort = (): void => {
    void closeContext().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    checkActive(signal, deadlineAt);
    const html = documentHtml(parser, request.markdown, request.title);
    checkActive(signal, deadlineAt);
    context = await options.browser.newContext({
      acceptDownloads: false,
      bypassCSP: false,
      colorScheme: 'light',
      deviceScaleFactor: 1,
      javaScriptEnabled: false,
      offline: true,
      permissions: [],
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
      viewport: { width: options.width, height: options.pageHeight }
    });
    checkActive(signal, deadlineAt);
    await context.route('**/*', route => route.abort('blockedbyclient'));
    checkActive(signal, deadlineAt);
    const page = await context.newPage();
    checkActive(signal, deadlineAt);
    await page.setContent(html, { waitUntil: 'load', timeout: 0 });
    checkActive(signal, deadlineAt);
    const dimensions = await page.evaluate(() => ({
      width: Math.ceil(Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)),
      height: Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight))
    }));
    checkActive(signal, deadlineAt);
    if (!validDimensions(dimensions)) {
      fail('MARKDOWN_LAYOUT_INVALID', 'Markdown produced invalid page dimensions.');
    }
    if (dimensions.width > options.width) {
      fail('MARKDOWN_LAYOUT_OVERFLOW', 'Markdown content exceeds the configured page width.');
    }
    const pageCount = Math.ceil(dimensions.height / options.pageHeight);
    if (pageCount > options.maxPages) {
      fail('MARKDOWN_PAGE_LIMIT', 'Markdown content exceeds the configured page limit.');
    }
    const pages: MarkdownPngPage[] = [];
    let outputBytes = 0;
    for (let index = 0; index < pageCount; index += 1) {
      checkActive(signal, deadlineAt);
      const y = index * options.pageHeight;
      const height = Math.min(options.pageHeight, dimensions.height - y);
      await page.setViewportSize({ width: options.width, height });
      checkActive(signal, deadlineAt);
      await page.evaluate(scrollY => window.scrollTo(0, scrollY), y);
      checkActive(signal, deadlineAt);
      const image = await page.screenshot({
        animations: 'disabled',
        caret: 'hide',
        omitBackground: false,
        type: 'png'
      });
      checkActive(signal, deadlineAt);
      outputBytes += image.byteLength;
      if (outputBytes > options.maxOutputBytes) {
        fail('MARKDOWN_OUTPUT_TOO_LARGE', 'Rendered PNG output exceeds the configured byte limit.');
      }
      pages.push(Object.freeze({ png: Uint8Array.from(image), width: options.width, height }));
    }
    return Object.freeze(pages);
  } catch (error: unknown) {
    if (signal.aborted) throw abortFailure(signal);
    if (error instanceof FrameworkError) throw error;
    throw new FrameworkError('MARKDOWN_RENDER_FAILED', 'Markdown rendering failed.');
  } finally {
    signal.removeEventListener('abort', onAbort);
    try {
      await closeContext();
    } catch {
      if (!signal.aborted) {
        throw new FrameworkError('MARKDOWN_RENDER_FAILED', 'Markdown rendering failed.');
      }
    }
  }
}

export function createMarkdownRenderer(input: MarkdownRendererOptions): Readonly<MarkdownRenderer> {
  const options = resolveOptions(input);
  const parser = createParser();
  let pending = 0;

  function render(request: MarkdownRenderRequest): Promise<readonly MarkdownPngPage[]> {
    try {
      assertRequest(request, options.maxInputBytes);
    } catch (error: unknown) {
      return Promise.reject(error);
    }
    if (request.signal?.aborted) {
      return Promise.reject(new FrameworkError('MARKDOWN_ABORTED', 'Markdown rendering was aborted.'));
    }
    if (pending >= options.maxPending) {
      return Promise.reject(new FrameworkError('MARKDOWN_BACKPRESSURE',
        'Too many Markdown render operations are unresolved.'));
    }

    pending += 1;
    const controller = new AbortController();
    const deadlineAt = performance.now() + options.timeoutMs;
    return new Promise<readonly MarkdownPngPage[]>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', onAbort);
        callback();
      };
      const stop = (error: FrameworkError): void => {
        controller.abort(error);
        finish(() => reject(error));
      };
      const onAbort = (): void => stop(new FrameworkError('MARKDOWN_ABORTED', 'Markdown rendering was aborted.'));
      const timer = setTimeout(() => stop(timeoutFailure()), options.timeoutMs);
      request.signal?.addEventListener('abort', onAbort, { once: true });
      if (request.signal?.aborted) {
        pending -= 1;
        onAbort();
        return;
      }
      const operation = Promise.resolve().then(() =>
        renderDocument(options, parser, request, controller.signal, deadlineAt));
      void operation.then(
        pages => {
          pending -= 1;
          finish(() => resolve(pages));
        },
        (error: unknown) => {
          pending -= 1;
          const safeError = error instanceof FrameworkError
            ? error
            : new FrameworkError('MARKDOWN_RENDER_FAILED', 'Markdown rendering failed.');
          finish(() => reject(safeError));
        }
      );
    });
  }

  return Object.freeze({ render });
}
