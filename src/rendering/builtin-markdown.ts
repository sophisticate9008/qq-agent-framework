import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { assert, FrameworkError, isRecord } from '../core/values.ts'
import type { MarkdownRenderer, MarkdownPngPage, MarkdownRenderRequest } from './markdown.ts'

export interface BuiltinMarkdownOptions {
  readonly width?: number
  readonly pageHeight?: number
  readonly maxPages?: number
  readonly timeoutMs?: number
  /** Trusted host configuration; never taken from Markdown or a model output object. */
  readonly fontPath?: string
}
export function createBuiltinMarkdownRenderer(options: BuiltinMarkdownOptions = {}): MarkdownRenderer {
  const width = options.width ?? 1080
  const pageHeight = options.pageHeight ?? 1800
  const maxPages = options.maxPages ?? 6
  const timeoutMs = options.timeoutMs ?? 12000
  const fontPath = options.fontPath ?? fileURLToPath(new URL('../../assets/fonts/wqy-microhei.ttc', import.meta.url))
  assert(Number.isSafeInteger(width) && width >= 480 && width <= 1600
    && Number.isSafeInteger(pageHeight) && pageHeight >= 600 && pageHeight <= 3000
    && Number.isSafeInteger(maxPages) && maxPages >= 1 && maxPages <= 6
    && Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 30000,
  'MARKDOWN_INVALID_OPTIONS', 'The built-in renderer requires bounded dimensions and a deadline.')
  let pending = 0
  return Object.freeze({ async render(request: MarkdownRenderRequest) {
    assert(typeof request.markdown === 'string' && Buffer.byteLength(request.markdown) <= 64 * 1024
      && (request.title === undefined || typeof request.title === 'string' && request.title.length <= 120),
    'MARKDOWN_INVALID_INPUT', 'A bounded Markdown document and title are required.')
    request.signal?.throwIfAborted()
    assert(pending < 2, 'MARKDOWN_BACKPRESSURE', 'The built-in renderer has reached its concurrent document limit.')
    pending++
    let worker: Worker | undefined
    try {
      return await new Promise<readonly MarkdownPngPage[]>((resolve, reject) => {
        const fail = (code: string) => reject(new FrameworkError(code, 'The Markdown image could not be rendered.'))
        worker = new Worker(new URL(import.meta.url.endsWith('.ts') ? './builtin-markdown-worker.ts' : './builtin-markdown-worker.js', import.meta.url), {
          execArgv: [],
          workerData: { markdown: request.markdown, title: request.title, width, pageHeight, maxPages, fontPath },
          resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
        })
        const timer = setTimeout(() => fail('MARKDOWN_TIMEOUT'), timeoutMs)
        const aborted = () => fail('MARKDOWN_ABORTED')
        request.signal?.addEventListener('abort', aborted, { once: true })
        const cleanup = () => { clearTimeout(timer); request.signal?.removeEventListener('abort', aborted) }
        worker.once('error', () => { cleanup(); fail('MARKDOWN_RENDER_FAILED') })
        worker.once('exit', () => { cleanup(); fail('MARKDOWN_RENDER_FAILED') })
        worker.once('message', (value: unknown) => {
          cleanup()
          if (isRecord(value) && value.ok === false) {
            fail(typeof value.code === 'string' && /^MARKDOWN_[A-Z_]{1,64}$/.test(value.code) ? value.code : 'MARKDOWN_RENDER_FAILED'); return
          }
          if (!isRecord(value) || !Array.isArray(value.pages) || value.pages.length < 1 || value.pages.length > maxPages
            || !value.pages.every(page => isRecord(page) && page.png instanceof Uint8Array
              && Number.isSafeInteger(page.width) && page.width === width && Number.isSafeInteger(page.height)
              && Number(page.height) > 0 && Number(page.height) <= pageHeight)) { fail('MARKDOWN_RENDER_FAILED'); return }
          resolve(value.pages as unknown as readonly MarkdownPngPage[])
        })
        if (request.signal?.aborted) aborted()
      })
    } finally { if (worker) await worker.terminate(); pending-- }
  } })
}
