import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';

import { FrameworkError } from '../src/core/values.ts';
import {
  createMarkdownRenderer,
  type MarkdownBrowser
} from '../src/rendering/index.ts';

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
}

interface FakeState {
  contextOptions?: Record<string, unknown>;
  html?: string;
  routePattern?: string;
  routeHandler?: (route: { abort(code?: string): void }) => unknown;
  viewports: Array<{ width: number; height: number }>;
  scrolls: number[];
  closes: number;
  abortCodes: string[];
}

interface FakeOptions {
  dimensions?: { width: number; height: number };
  png?: Uint8Array;
  setContentGate?: Promise<void>;
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>(resolve => { resolvePromise = resolve; });
  if (!resolvePromise) throw new Error('Deferred promise was not initialized.');
  return { promise, resolve: resolvePromise };
}

function fakeContext(state: FakeState, options: FakeOptions = {}) {
  const dimensions = options.dimensions ?? { width: 640, height: 480 };
  const png = options.png ?? new Uint8Array([137, 80, 78, 71]);
  return {
    async route(pattern: string, handler: (route: { abort(code?: string): void }) => unknown) {
      state.routePattern = pattern;
      state.routeHandler = handler;
      return { [Symbol.dispose]() {} };
    },
    async newPage() {
      return {
        async setContent(html: string) {
          state.html = html;
          await options.setContentGate;
        },
        async evaluate<Result, Argument>(_callback: unknown, argument?: Argument) {
          if (typeof argument === 'number') {
            state.scrolls.push(argument);
            return undefined as Result;
          }
          return dimensions as Result;
        },
        async setViewportSize(viewport: { width: number; height: number }) {
          state.viewports.push(viewport);
        },
        async screenshot() {
          return png;
        }
      };
    },
    async close() {
      state.closes += 1;
    }
  };
}

function fakeBrowser(options: FakeOptions = {}) {
  const state: FakeState = { viewports: [], scrolls: [], closes: 0, abortCodes: [] };
  const context = fakeContext(state, options);
  const browser = {
    async newContext(contextOptions?: Record<string, unknown>) {
      state.contextOptions = contextOptions;
      return context;
    }
  } as unknown as MarkdownBrowser;
  return { browser, context, state };
}

function hasCode(code: string): (error: unknown) => boolean {
  return error => error instanceof FrameworkError && error.code === code;
}

test('renderer produces readable inert markup in an isolated offline context', async () => {
  const fixture = fakeBrowser({ dimensions: { width: 640, height: 650 } });
  const renderer = createMarkdownRenderer({
    browser: fixture.browser,
    width: 640,
    pageHeight: 400,
    maxPages: 3
  });
  const pages = await renderer.render({
    title: '</style><script>globalThis.compromised = true</script>',
    markdown: `# 标题

- 列表一
- **重点**

| 项目 | 说明 |
| --- | --- |
| 安全 | 可读 |

\`\`\`ts
const value = '<img src="file:///etc/passwd">';
\`\`\`

[外部链接](https://example.invalid/private)
![远程图片](https://example.invalid/image.png)

<script>fetch('https://example.invalid')</script>`
  });

  assert.equal(fixture.state.contextOptions?.javaScriptEnabled, false);
  assert.equal(fixture.state.contextOptions?.offline, true);
  assert.equal(fixture.state.contextOptions?.serviceWorkers, 'block');
  assert.deepEqual(fixture.state.contextOptions?.permissions, []);
  assert.equal(fixture.state.routePattern, '**/*');
  fixture.state.routeHandler?.({ abort(code) { if (code) fixture.state.abortCodes.push(code); } });
  assert.deepEqual(fixture.state.abortCodes, ['blockedbyclient']);

  const html = fixture.state.html ?? '';
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /script-src 'none'/);
  assert.match(html, /font-src 'none'/);
  assert.match(html, /<table>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<strong>重点<\/strong>/);
  assert.match(html, /<pre><code class="language-ts">/);
  assert.match(html, /<span class="md-link">外部链接<\/span>/);
  assert.match(html, /\[图片：远程图片\]/);
  assert.match(html, /&lt;script&gt;fetch/);
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /<img\b/i);
  assert.doesNotMatch(html, /<a\b/i);
  assert.doesNotMatch(html, /\s(?:href|src)=["']/i);

  assert.deepEqual(pages.map(page => [page.width, page.height]), [[640, 400], [640, 250]]);
  assert.deepEqual(fixture.state.viewports, [
    { width: 640, height: 400 },
    { width: 640, height: 250 }
  ]);
  assert.deepEqual(fixture.state.scrolls, [0, 400]);
  assert.equal(fixture.state.closes, 1);
});

test('renderer rejects input, page and output limits without returning partial content', async () => {
  const inputFixture = fakeBrowser();
  const inputRenderer = createMarkdownRenderer({ browser: inputFixture.browser, maxInputBytes: 5 });
  await assert.rejects(inputRenderer.render({ markdown: '中文' }), hasCode('MARKDOWN_INPUT_TOO_LARGE'));
  assert.equal(inputFixture.state.contextOptions, undefined);

  const pageFixture = fakeBrowser({ dimensions: { width: 640, height: 1_201 } });
  const pageRenderer = createMarkdownRenderer({
    browser: pageFixture.browser,
    width: 640,
    pageHeight: 400,
    maxPages: 3
  });
  await assert.rejects(pageRenderer.render({ markdown: 'too tall' }), hasCode('MARKDOWN_PAGE_LIMIT'));
  assert.equal(pageFixture.state.viewports.length, 0);

  const outputFixture = fakeBrowser({
    dimensions: { width: 640, height: 500 },
    png: new Uint8Array([1, 2, 3, 4])
  });
  const outputRenderer = createMarkdownRenderer({
    browser: outputFixture.browser,
    width: 640,
    pageHeight: 300,
    maxOutputBytes: 7
  });
  await assert.rejects(outputRenderer.render({ markdown: 'two pages' }), hasCode('MARKDOWN_OUTPUT_TOO_LARGE'));
  assert.equal(outputFixture.state.viewports.length, 2);
});

test('invalid dimensions and unsafe option expansion are rejected', async () => {
  const fixture = fakeBrowser({ dimensions: { width: 641, height: 400 } });
  assert.throws(() => createMarkdownRenderer({ browser: fixture.browser, width: 319 }),
    hasCode('MARKDOWN_INVALID_OPTIONS'));
  const renderer = createMarkdownRenderer({ browser: fixture.browser, width: 640 });
  await assert.rejects(renderer.render({ markdown: 'overflow' }), hasCode('MARKDOWN_LAYOUT_OVERFLOW'));
});

test('timeout retains the unresolved admission slot until the browser call really settles', async () => {
  const firstContext = deferred<ReturnType<typeof fakeContext>>();
  const fixture = fakeBrowser();
  let contextCalls = 0;
  const browser = {
    async newContext(contextOptions?: Record<string, unknown>) {
      fixture.state.contextOptions = contextOptions;
      contextCalls += 1;
      if (contextCalls === 1) return firstContext.promise;
      return fixture.context;
    }
  } as unknown as MarkdownBrowser;
  const renderer = createMarkdownRenderer({
    browser,
    width: 640,
    pageHeight: 400,
    timeoutMs: 20,
    maxPending: 1
  });

  await assert.rejects(renderer.render({ markdown: 'first' }), hasCode('MARKDOWN_TIMEOUT_UNKNOWN'));
  await assert.rejects(renderer.render({ markdown: 'blocked' }), hasCode('MARKDOWN_BACKPRESSURE'));
  assert.equal(contextCalls, 1);

  firstContext.resolve(fixture.context);
  await nextTurn();
  const pages = await renderer.render({ markdown: 'recovered' });
  assert.equal(pages.length, 2);
  assert.equal(contextCalls, 2);
});

test('cancellation closes the context while retaining the slot for unfinished page work', async () => {
  const contentGate = deferred<void>();
  const fixture = fakeBrowser({ setContentGate: contentGate.promise });
  const renderer = createMarkdownRenderer({
    browser: fixture.browser,
    width: 640,
    pageHeight: 400,
    timeoutMs: 1_000,
    maxPending: 1
  });
  const controller = new AbortController();
  const rendering = renderer.render({ markdown: 'cancel me', signal: controller.signal });
  await nextTurn();
  controller.abort();
  await assert.rejects(rendering, hasCode('MARKDOWN_ABORTED'));
  assert.equal(fixture.state.closes, 1);
  await assert.rejects(renderer.render({ markdown: 'still blocked' }), hasCode('MARKDOWN_BACKPRESSURE'));

  contentGate.resolve();
  await nextTurn();
});
