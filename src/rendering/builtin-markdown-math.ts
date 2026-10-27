import { createRequire } from 'node:module'
import { assert, isRecord } from '../core/values.ts'

interface MathEngine {
  tex2svg(source: string, options: { display: boolean }): unknown
  startup: { adaptor: { outerHTML(node: unknown): string } }
}
/** The prebuilt Node component is loaded only for a document containing math tokens. */
export async function loadBuiltinMath() {
  const module: unknown = createRequire(import.meta.url)('mathjax')
  assert(isRecord(module) && typeof module.init === 'function', 'MARKDOWN_MATH_UNAVAILABLE', 'The local formula engine is unavailable.')
  const initialized: unknown = await module.init({
    loader: { load: ['input/tex-base', '[tex]/ams', 'output/svg'] },
    tex: { packages: ['base', 'ams'], maxMacros: 200, maxBuffer: 4000 },
    svg: { fontCache: 'none' },
  })
  assert(isRecord(initialized) && typeof initialized.tex2svg === 'function'
    && isRecord(initialized.startup) && isRecord(initialized.startup.adaptor)
    && typeof initialized.startup.adaptor.outerHTML === 'function', 'MARKDOWN_MATH_UNAVAILABLE', 'The local formula engine returned an invalid interface.')
  const engine = initialized as unknown as MathEngine
  return (source: string, display: boolean) => {
    assert(source.length > 0 && source.length <= 2000
      && !/\\(?:require|autoload|includegraphics|href|url|class|cssId|style|html|input|include|read|write|openin|openout)\b/i.test(source),
    'MARKDOWN_MATH_INVALID', 'The formula contains an unavailable command or exceeds its size limit.')
    const markup = engine.startup.adaptor.outerHTML(engine.tex2svg(source, { display }))
    const svg = markup.match(/<svg\b[\s\S]*<\/svg>/)?.[0]
    assert(svg && !/data-mjx-error|<merror\b|<image\b/i.test(svg) && Buffer.byteLength(svg) <= 512 * 1024,
      'MARKDOWN_MATH_INVALID', 'The formula could not be rendered within the supported math subset.')
    const width = Math.ceil(Number(svg.match(/\bwidth="([\d.]+)ex"/)?.[1]) * 12)
    const height = Math.ceil(Number(svg.match(/\bheight="([\d.]+)ex"/)?.[1]) * 12)
    assert(width > 0 && height > 0 && width <= 16000 && height <= 4000,
      'MARKDOWN_MATH_INVALID', 'The formula dimensions exceed the supported bounds.')
    return { width, height, svg: Buffer.from(svg.replace(/\bwidth="[\d.]+ex"/, `width="${width}"`)
      .replace(/\bheight="[\d.]+ex"/, `height="${height}"`)) }
  }
}
