import { parentPort, workerData } from 'node:worker_threads'
import { readFile } from 'node:fs/promises'
import MarkdownIt from 'markdown-it'
import type { Token } from 'markdown-it'
import { Renderer, type Node, type MeasuredNode, type ImageSource } from '@takumi-rs/core'
import { fromHtml } from '@takumi-rs/helpers/html'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import json from 'highlight.js/lib/languages/json'
import bash from 'highlight.js/lib/languages/bash'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import sql from 'highlight.js/lib/languages/sql'
import sharp from 'sharp'
import { assert, FrameworkError, isRecord } from '../core/values.ts'
import type { MarkdownPngPage } from './markdown.ts'

const STYLE = `
html { font-family: "WenQuanYi Micro Hei"; font-size:24px; color:#202b3b; background:#fff; }
body { margin:0; padding:42px 48px; line-height:1.55; overflow-wrap:anywhere; }
h1,h2,h3,h4,h5,h6 { color:#111d30; line-height:1.3; margin:24px 0 14px; font-weight:700; }
h1 { font-size:38px; border-bottom:2px solid #d5dce6; padding-bottom:12px; }
h2 { font-size:32px; border-bottom:1px solid #d5dce6; padding-bottom:8px; }
h3 { font-size:28px; } h4,h5,h6 { font-size:25px; }
p { margin:12px 0; } strong { font-weight:700; } em { font-style:italic; }
a,.md-link { color:#185db8; } del { text-decoration:line-through; }
ul,ol { margin:12px 0; padding-left:34px; } li { margin:5px 0; }
blockquote { margin:16px 0; padding:8px 20px; border-left:5px solid #8c9eb6; background:#f1f5fa; color:#40546b; }
pre { font-family:"WenQuanYi Micro Hei Mono"; background:#f0f3f8; padding:18px 20px; border-radius:8px; margin:18px 0; white-space:pre-wrap; overflow-wrap:anywhere; font-size:21px; line-height:1.5; }
code { font-family:"WenQuanYi Micro Hei Mono"; font-size:21px; color:#245270; background:#f0f3f8; }
pre code { background:transparent; color:#263449; }
table { width:100%; table-layout:fixed; border-collapse:collapse; font-size:22px; margin:18px 0; }
th,td { border:1px solid #bbc6d4; padding:11px 14px; text-align:left; vertical-align:top; overflow-wrap:anywhere; }
th { background:#e9eff8; font-weight:700; } tr:nth-child(even) td { background:#f8fafc; }
hr { border:0; border-top:1px solid #c9d3df; margin:22px 0; }
.md-image { color:#697c91; } .qaf-checkbox { display:inline-block; width:20px; height:20px; line-height:18px; font-size:18px; text-align:center; border:1px solid #60748b; margin-right:7px; } .qaf-math-block { display:block; margin:16px 0; }
.hljs-keyword,.hljs-selector-tag,.hljs-literal { color:#8041b0; }
.hljs-string,.hljs-attr { color:#167147; } .hljs-number,.hljs-symbol { color:#a65514; }
.hljs-comment,.hljs-quote { color:#718095; } .hljs-title,.hljs-built_in,.hljs-function { color:#1f62b5; }
`
for (const [name, language] of Object.entries({ javascript, typescript, python, json, bash, xml, css, sql })) hljs.registerLanguage(name, language)

function mathRules(parser: InstanceType<typeof MarkdownIt>) {
  parser.inline.ruler.before('escape', 'qaf_math_inline', (state, silent) => {
    const start = state.pos
    const opening = state.src.startsWith('\\(', start) ? '\\(' : state.src[start] === '$' && state.src[start + 1] !== '$' ? '$' : null
    if (!opening) return false
    const closing = opening === '$' ? '$' : '\\)'
    if (opening === '$' && /\s/.test(state.src[start + 1] ?? '')) return false
    let end = state.src.indexOf(closing, start + opening.length)
    while (end >= 0 && state.src[end - 1] === '\\') end = state.src.indexOf(closing, end + closing.length)
    if (end < 0 || end === start + opening.length || end - start > 2000 || state.src.slice(start, end).includes('\n')
      || opening === '$' && (/\s/.test(state.src[end - 1]) || /[0-9]/.test(state.src[end + 1] ?? ''))) return false
    if (!silent) { const token = state.push('qaf_math_inline', '', 0); token.content = state.src.slice(start + opening.length, end) }
    state.pos = end + closing.length
    return true
  })
  parser.block.ruler.before('fence', 'qaf_math_block', (state, start, end, silent) => {
    const first = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]).trim()
    const opening = first.startsWith('$$') ? '$$' : first.startsWith('\\[') ? '\\[' : null
    if (!opening) return false
    const closing = opening === '$$' ? '$$' : '\\]'
    let last = start
    let expression = first.slice(opening.length)
    if (!expression.endsWith(closing) || expression.length < closing.length) {
      for (last = start + 1; last < Math.min(end, start + 80); last++) {
        const line = state.src.slice(state.bMarks[last] + state.tShift[last], state.eMarks[last]).trim()
        expression += '\n' + line
        if (line.endsWith(closing)) break
      }
      if (last >= Math.min(end, start + 80)) return false
    }
    expression = expression.slice(0, -closing.length).trim()
    if (expression.length > 2000 || !expression) return false
    if (silent) return true
    const token = state.push('qaf_math_block', '', 0); token.block = true; token.content = expression; token.map = [start, last + 1]
    state.line = last + 1
    return true
  }, { alt: ['paragraph', 'blockquote', 'list'] })
}
function allTokens(tokens: readonly Token[]): Token[] { return tokens.flatMap(token => [token, ...allTokens(token.children ?? [])]) }

async function run(): Promise<readonly MarkdownPngPage[]> {
  const input: unknown = workerData
  assert(isRecord(input) && typeof input.markdown === 'string' && typeof input.fontPath === 'string'
    && typeof input.width === 'number' && typeof input.pageHeight === 'number' && typeof input.maxPages === 'number',
  'MARKDOWN_INVALID_INPUT', 'Invalid trusted render request.')
  const { width, pageHeight, maxPages } = input
  const renderer = new Renderer({ cacheMaxBytes: 16 * 1024 * 1024, fontCacheMaxBytes: 16 * 1024 * 1024 })
  const fonts = await readFile(input.fontPath)
  assert(fonts.byteLength <= 8 * 1024 * 1024, 'MARKDOWN_FONT_INVALID', 'The bundled document font exceeds its limit.')
  await renderer.registerFont({ data: fonts })
  const parser = new MarkdownIt({ html: false, linkify: false, typographer: false, maxNesting: 24,
    highlight(code, language) {
      if (code.length > 24000 || !hljs.getLanguage(language)) return ''
      try { return hljs.highlight(code, { language, ignoreIllegals: true }).value } catch { return '' }
    } })
  mathRules(parser)
  // All links become inert spans and all user images become alt placeholders, including file: URLs.
  parser.validateLink = () => true
  parser.renderer.rules.link_open = () => '<span class="md-link">'
  parser.renderer.rules.link_close = () => '</span>'
  parser.renderer.rules.image = (tokens, index) => `<span class="md-image">[图片：${parser.utils.escapeHtml(tokens[index].content || '未加载外部图片')}]</span>`
  const tokens = parser.parse(input.markdown, {})
  const flattened = allTokens(tokens)
  assert(flattened.length <= 12000, 'MARKDOWN_NODE_LIMIT', 'The document contains too many markup nodes.')
  const taskHtml = new Map<Token, string>()
  for (const token of flattened) {
    if (token.type === 'inline' && token.children?.[0]?.type === 'text') {
      const text = token.children[0]
      const match = text.content.match(/^\[([ xX])\]\s+/)
      if (match) {
        taskHtml.set(text, `<span class="qaf-checkbox">${match[1] === ' ' ? '&nbsp;' : 'x'}</span>${parser.utils.escapeHtml(text.content.slice(match[0].length))}`)
        text.type = 'qaf_task'
      }
    }
  }
  parser.renderer.rules.qaf_task = (tokens, index) => taskHtml.get(tokens[index]) ?? ''
  const mathTokens = flattened.filter(token => token.type === 'qaf_math_inline' || token.type === 'qaf_math_block')
  assert(mathTokens.length <= 32 && mathTokens.reduce((length, token) => length + token.content.length, 0) <= 8000,
    'MARKDOWN_MATH_LIMIT', 'The document contains too many or overly large formulas.')
  const images: ImageSource[] = []
  const mathHtml = new Map<Token, string>()
  if (mathTokens.length) {
    const math = await (await import('./builtin-markdown-math.ts')).loadBuiltinMath()
    for (const token of mathTokens) {
      const result = math(token.content, token.type === 'qaf_math_block')
      const scale = Math.min(1, (width - 96) / result.width)
      const imageWidth = Math.max(1, Math.ceil(result.width * scale)); const imageHeight = Math.max(1, Math.ceil(result.height * scale))
      const key = `qaf-formula-${images.length}`
      images.push({ src: key, data: result.svg })
      mathHtml.set(token, `<img class="${token.type === 'qaf_math_block' ? 'qaf-math-block' : 'qaf-math-inline'}" src="${key}" width="${imageWidth}" height="${imageHeight}">`)
    }
  }
  parser.renderer.rules.qaf_math_inline = parser.renderer.rules.qaf_math_block = (tokens, index) => mathHtml.get(tokens[index]) ?? ''
  const body = parser.renderer.render(tokens, parser.options, {})
  const title = typeof input.title === 'string' && input.title ? `<h1>${parser.utils.escapeHtml(input.title)}</h1>` : ''
  const { node: parsedNode } = fromHtml(`<html lang="zh-CN"><body>${title}${body}</body></html>`)
  // HTML whitespace between block elements produces no layout box. Remove only those
  // separators so source tags can be paired with measured boxes; preserve every inline/code space.
  const structural = new Set(['html', 'body', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'ul', 'ol', 'blockquote'])
  const canonical = (source: Node): Node => source.type === 'container' ? { ...source,
    children: source.children?.filter(child => !(structural.has(source.tagName ?? '') && child.type === 'text' && /^\s*$/.test(child.text))).map(canonical),
  } : source
  const node = canonical(parsedNode)
  const css = [STYLE]
  const renderOptions = { width, css, images, lang: 'zh-CN' }
  const measured = await renderer.measure(node, renderOptions)
  const totalHeight = Math.ceil(measured.height)
  assert(Number.isSafeInteger(totalHeight) && totalHeight > 0 && totalHeight <= pageHeight * maxPages,
    'MARKDOWN_PAGE_LIMIT', 'The document exceeds the bounded image page capacity.')
  // Measured text-line and image boxes supply cut points. Never cut through a glyph or table-row text.
  const forbidden: { top: number; bottom: number }[] = []
  const visit = (box: MeasuredNode, source?: Node) => {
    // Takumi transforms are absolute. Text runs are relative to the content box;
    // the only top padding on a run-owning element in our fixed stylesheet is below.
    const paddingTop = source?.tagName === 'pre' ? 18 : source?.tagName === 'td' || source?.tagName === 'th' ? 12 : 0
    if ((source?.tagName === 'pre' || source?.tagName === 'table') && box.height < pageHeight - 100) {
      forbidden.push({ top: box.transform[5], bottom: box.transform[5] + box.height })
    }
    const y = box.transform[5] + paddingTop
    for (const line of box.runs) if (line.height > 0) forbidden.push({ top: y + line.y - 3, bottom: y + line.y + line.height + 3 })
    if (!box.runs.length && !box.children.length && box.height > 0) {
      forbidden.push({ top: box.transform[5], bottom: box.transform[5] + box.height })
    }
    const children = source?.type === 'container' && source.children?.length === box.children.length ? source.children : []
    box.children.forEach((child, index) => visit(child, children?.[index]))
  }
  visit(measured, node)
  const png = await renderer.render(node, { ...renderOptions, height: totalHeight, format: 'png' })
  assert(png.byteLength <= 16 * 1024 * 1024, 'MARKDOWN_OUTPUT_TOO_LARGE', 'The rendered document exceeds the output byte limit.')
  // Confirm each proposed cut against actual pixels. Pale document/code backgrounds and
  // table borders are ignored; a three-row gap must contain no text-colored pixels.
  async function pixelGap(end: number, top: number): Promise<number> {
    const first = Math.max(top, end - 64)
    const last = Math.min(totalHeight, end + 3)
    const { data, info } = await sharp(png).extract({ left: 48, top: first, width: width - 96, height: last - first }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const ink: boolean[] = []
    for (let row = 0; row < info.height; row++) {
      let count = 0
      for (let col = 0; col < info.width; col++) {
        const offset = (row * info.width + col) * info.channels
        if (data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722 < 165) count++
      }
      ink.push(count > 3)
    }
    for (let cut = end; cut >= first + 2; cut--) {
      const row = cut - first
      if (!ink[row - 1] && !ink[row] && !ink[row + 1]
        && !forbidden.some(region => region.top < cut && region.bottom > cut)) return cut
    }
    throw new FrameworkError('MARKDOWN_PAGE_LIMIT', 'No safe pixel gap is available for this document page.')
  }
  const cuts = [0]
  while (cuts.at(-1)! < totalHeight) {
    const top = cuts.at(-1)!
    let end = Math.min(totalHeight, top + pageHeight)
    if (end < totalHeight) {
      let changed = true
      while (changed) {
        changed = false
        for (const region of forbidden) if (region.top < end && region.bottom > end) {
          const next = Math.floor(region.top)
          if (next < end) { end = next; changed = true }
        }
      }
    }
    if (end < totalHeight) end = await pixelGap(end, top)
    assert(end > top && cuts.length <= maxPages, 'MARKDOWN_PAGE_LIMIT', 'The document cannot be paginated without cutting a text line.')
    cuts.push(end)
  }
  const pages: MarkdownPngPage[] = []
  let outputBytes = 0
  for (let i = 0; i < cuts.length - 1; i++) {
    const height = cuts[i + 1] - cuts[i]
    const page = await sharp(png, { limitInputPixels: width * pageHeight * maxPages }).extract({ left: 0, top: cuts[i], width, height }).png().toBuffer()
    outputBytes += page.byteLength
    assert(outputBytes <= 16 * 1024 * 1024, 'MARKDOWN_OUTPUT_TOO_LARGE', 'The rendered pages exceed the output byte limit.')
    pages.push({ png: page, width, height })
  }
  return pages
}
run().then(pages => parentPort?.postMessage({ ok: true, pages }), error => {
  parentPort?.postMessage({ ok: false, code: error instanceof FrameworkError ? error.code : 'MARKDOWN_RENDER_FAILED' })
})
