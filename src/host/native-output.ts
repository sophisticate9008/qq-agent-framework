import { createBuiltinPackageContent } from './native-package-content.ts'
import type { FrameworkEvent, MessageContent } from '../core/types.ts'
import { normalizeContent } from '../core/content.ts'
import { assert, isRecord } from '../core/values.ts'
import { DEFAULT_NATIVE_OUTPUT, validateNativeOutputConfiguration } from '../contracts/native-output.ts'
import { splitNativeChatBubbles } from './native-chat-bubbles.ts'
import { boundedTextChunks } from '../core/text-chunks.ts'
import type { PackageConfigurationContribution, PackageConfigurationRegistry } from './package-configuration.ts'
import type { NativePackageDefinition } from './native-packages.ts'
import { CHAT_OUTPUT_SERVICE_CONTRACT } from './framework-service-contracts.ts'
import { publishService, serviceDeclaration } from './service-contract.ts'

export const NATIVE_OUTPUT_CONFIGURATION: PackageConfigurationContribution = Object.freeze<PackageConfigurationContribution>({
  descriptor: { id: 'chat-output', owner: 'chat-output', schemaVersion: 1, title: '回复方式',
    description: 'Markdown 标题、表格与代码在本机渲染为图片；控制短回复分条与长文合并转发。图片、语音和文件使用当前会话的有效资源，按协议端支持发送。', application: 'live', fields: [
      { id: 'bubbles', path: ['bubbles'], kind: 'boolean', label: '短回复分条', description: '完整短段落分成最多四条消息，代码和结构化文本保持完整。' },
      { id: 'long-forward', path: ['longTextAsForward'], kind: 'boolean', label: '长文合并转发', description: '超出阈值的纯文本作为机器人署名的合并转发发送。' },
      { id: 'long-threshold', path: ['longTextThreshold'], kind: 'integer', label: '长文字符阈值', description: '启用长文合并转发时生效。', minimum: 500, maximum: 16000, unit: '字符' }
    ] }, defaults: DEFAULT_NATIVE_OUTPUT, validate: validateNativeOutputConfiguration
})

export interface NativeMarkdownOutputRequest { readonly format: 'markdown-image'; readonly body: string; readonly title?: string }

export function isNativeMarkdownText(text: string): boolean {
  return /^ {0,3}#{1,6}[ \t]+\S/m.test(text) || /^ {0,3}(?:`{3,}|~{3,})[^\n]*\n/m.test(text)
    || /(?:^|\n)[^\n]*\|[^\n]*\n[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*\|[ \t]*:?-{3,}:?[ \t]*(?:\|[^\n]*)?(?:\n|$)/.test(text)
}

export function parseNativeOutputContent(content: readonly MessageContent[]): readonly MessageContent[] | NativeMarkdownOutputRequest {
  if (!content.every(part => part.type === 'text')) return content
  const text = content.map(part => part.type === 'text' ? part.text : '').join('')
  let input: unknown
  try { input = JSON.parse(text) } catch {
    assert(!/^\s*\{\s*"schema"\s*:\s*"qbf\.output\/1"/.test(text), 'NATIVE_OUTPUT_INVALID', 'The output envelope is malformed.')
    return content
  }
  if (!isRecord(input) || input.schema !== 'qbf.output/1') return content
  if (input.format === 'markdown-image') {
    assert(Object.keys(input).every(key => ['schema', 'format', 'body', 'title'].includes(key))
      && typeof input.body === 'string' && input.body.trim().length > 0 && input.body.length <= 32000
      && Buffer.byteLength(input.body) <= 65536 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.body)
      && (input.title === undefined || typeof input.title === 'string' && input.title.trim().length > 0 && input.title.length <= 120
        && !/[\x00-\x1f\x7f]/.test(input.title)), 'NATIVE_OUTPUT_INVALID', 'A Markdown image requires bounded text and an optional title.')
    return { format: 'markdown-image', body: input.body, ...(input.title === undefined ? {} : { title: input.title }) }
  }
  assert(Object.keys(input).length === 2 && Array.isArray(input.content) && input.content.length <= 8,
    'NATIVE_OUTPUT_INVALID', 'The output requires bounded message content.')
  // An envelope is itself delivered as bounded text blocks. Preserve its inner long text too.
  const expanded: unknown[] = []
  for (const part of input.content) {
    if (isRecord(part) && part.type === 'text' && typeof part.text === 'string' && Object.keys(part).length === 2) {
      const chunks = boundedTextChunks(part.text, 8000, 8 - expanded.length)
      assert(chunks, 'NATIVE_OUTPUT_LIMIT', 'The structured reply exceeds the bounded text size.')
      expanded.push(...chunks.map(text => ({ type: 'text', text })))
    } else expanded.push(part)
  }
  const result = normalizeContent(expanded)
  assert(result.every(part => part.type !== 'forward-reference'), 'NATIVE_OUTPUT_INVALID', 'Forward references must first be read into bounded nodes.')
  return result
}

/** The output package plans complete deliveries before the existing relay consumes send permissions. */
export function createNativeOutputService(registry: PackageConfigurationRegistry, options: {
  readonly renderMarkdown?: (request: NativeMarkdownOutputRequest & { readonly event: FrameworkEvent; readonly signal: AbortSignal }) => Promise<readonly MessageContent[]>
} = {}) {
  const planned = new Map<string, readonly (readonly MessageContent[])[]>()
  async function prepare(content: unknown, event: FrameworkEvent, signal: AbortSignal): Promise<readonly MessageContent[]> {
    signal.throwIfAborted()
    const configuration = validateNativeOutputConfiguration((await registry.read('chat-output')).configuration)
    signal.throwIfAborted()
    const selected = parseNativeOutputContent(normalizeContent(content))
    let result: readonly MessageContent[]
    if ('format' in selected) {
      assert(options.renderMarkdown, 'NATIVE_MARKDOWN_UNAVAILABLE', 'Markdown image rendering is unavailable.')
      result = normalizeContent(await options.renderMarkdown({ ...selected, event, signal }))
    } else {
      result = selected
      if (options.renderMarkdown && result.every(part => part.type === 'text')) {
        const text = result.map(part => part.type === 'text' ? part.text : '').join('')
        if (isNativeMarkdownText(text)) result = normalizeContent(await options.renderMarkdown({ format: 'markdown-image', body: text, event, signal }))
      }
    }
    signal.throwIfAborted()
    if (configuration.longTextAsForward && result.every(part => part.type === 'text')) {
      const text = result.map(part => part.type === 'text' ? part.text : '').join('')
      if (text.length > configuration.longTextThreshold) {
        const chunks = boundedTextChunks(text, 3500, 32)
        assert(chunks, 'NATIVE_OUTPUT_LIMIT', 'The long reply exceeds the bounded forward size.')
        const nodes = chunks.map(chunk => ({ content: [{ type: 'text' as const, text: chunk }] }))
        result = normalizeContent([{ type: 'forward', nodes }])
      }
    }
    const groups: (readonly MessageContent[])[] = []
    if (result.some(part => part.type === 'file' || part.type === 'forward')) {
      let batch: MessageContent[] = []
      for (const part of result) {
        if (part.type === 'file' || part.type === 'forward') {
          if (batch.length) { groups.push(batch); batch = [] }
          groups.push([part])
        } else batch.push(part)
      }
      if (batch.length) groups.push(batch)
    } else groups.push(...(configuration.bubbles ? splitNativeChatBubbles(result) : [result]))
    assert(groups.length > 0 && groups.length <= 4, 'NATIVE_OUTPUT_LIMIT', 'The output exceeds four deliveries.')
    assert(planned.size < 256 || planned.has(event.id), 'NATIVE_OUTPUT_BACKPRESSURE', 'The output planner is full.')
    planned.set(event.id, groups)
    return result
  }
  return Object.freeze({ prepare,
    async context(signal: AbortSignal) { signal.throwIfAborted(); const configuration = validateNativeOutputConfiguration((await registry.read('chat-output')).configuration)
      signal.throwIfAborted(); return { ...configuration, protocol: 'qbf.output/1' as const, maxDeliveries: 4, markdownImageSupported: options.renderMarkdown !== undefined,
        formats: ['text', ...(options.renderMarkdown ? ['markdown-image'] : [])], markdownImageMaxCharacters: 32000 } },
    split(content: readonly MessageContent[], event: FrameworkEvent) {
      const groups = planned.get(event.id); planned.delete(event.id)
      assert(groups, 'NATIVE_OUTPUT_UNPREPARED', 'Output splitting requires its current preparation.')
      return groups
    }, clear() { planned.clear() }
  })
}
export type NativeOutputService = ReturnType<typeof createNativeOutputService>

export function createNativeOutputPackage(service: NativeOutputService): NativePackageDefinition {
  return { content: createBuiltinPackageContent(import.meta.url, ['./framework-service-contracts', './service-contract', '../contracts/service-contract', '../contracts/native-output', './native-chat-bubbles', '../core/text-chunks', './native-markdown', '../rendering/builtin-markdown', '../rendering/builtin-markdown-worker', '../rendering/builtin-markdown-math']), manifest: { schema: 1, id: 'chat-output', version: '1.0.0', displayName: '回复呈现与 Markdown 转图',
    description: '框架内置 Markdown 图片渲染、短回复分条与长纯文本转发。', dependencies: [], requires: [],
    provides: [serviceDeclaration(CHAT_OUTPUT_SERVICE_CONTRACT)], contributions: [] }, configurations: [NATIVE_OUTPUT_CONFIGURATION],
    install(context) { publishService(context, CHAT_OUTPUT_SERVICE_CONTRACT, service); context.own('subscription', 'output-plans', () => service.clear()) } }
}
