import { createBuiltinPackageContent } from './native-package-content.ts'
import type { FrameworkEvent, MessageContent } from '../core/types.ts'
import { normalizeContent } from '../core/content.ts'
import { assert, isRecord } from '../core/values.ts'
import { DEFAULT_NATIVE_OUTPUT, validateNativeOutputConfiguration } from '../contracts/native-output.ts'
import { splitNativeChatBubbles } from './native-chat-bubbles.ts'
import type { PackageConfigurationContribution, PackageConfigurationRegistry } from './package-configuration.ts'
import type { NativePackageDefinition } from './native-packages.ts'

export const NATIVE_OUTPUT_CONFIGURATION: PackageConfigurationContribution = Object.freeze<PackageConfigurationContribution>({
  descriptor: { id: 'chat-output', owner: 'chat-output', schemaVersion: 1, title: '回复方式',
    description: '控制短回复分条、长文合并转发与已登记媒体的发送。配置不会扩大消息发送权限。', application: 'live', fields: [
      { id: 'bubbles', path: ['bubbles'], kind: 'boolean', label: '短回复分条', description: '完整短段落分成最多四条消息，代码和结构化文本保持完整。' },
      { id: 'long-forward', path: ['longTextAsForward'], kind: 'boolean', label: '长文合并转发', description: '超出阈值的纯文本作为机器人署名的合并转发发送。' },
      { id: 'long-threshold', path: ['longTextThreshold'], kind: 'integer', label: '长文字符阈值', description: '启用长文合并转发时生效。', minimum: 500, maximum: 16000, unit: '字符' },
      { id: 'media', path: ['media'], kind: 'boolean', label: '发送已登记媒体', description: '图片、语音和文件必须来自当前会话的有效资源，不接受模型提供的URL或本机路径。' }
    ] }, defaults: DEFAULT_NATIVE_OUTPUT, validate: validateNativeOutputConfiguration
})

function structured(content: readonly MessageContent[]): readonly MessageContent[] {
  if (!content.every(part => part.type === 'text')) return content
  const text = content.map(part => part.type === 'text' ? part.text : '').join('')
  let input: unknown
  try { input = JSON.parse(text) } catch {
    assert(!/^\s*\{\s*"schema"\s*:\s*"qaf\.output\/1"/.test(text), 'NATIVE_OUTPUT_INVALID', 'The output envelope is malformed.')
    return content
  }
  if (!isRecord(input) || input.schema !== 'qaf.output/1') return content
  assert(Object.keys(input).length === 2 && Array.isArray(input.content) && input.content.length <= 8,
    'NATIVE_OUTPUT_INVALID', 'The output requires bounded message content.')
  const result = normalizeContent(input.content)
  assert(result.every(part => part.type !== 'forward-reference'), 'NATIVE_OUTPUT_INVALID', 'Forward references must first be read into bounded nodes.')
  return result
}

/** The output package plans complete deliveries before the existing relay consumes send permissions. */
export function createNativeOutputService(registry: PackageConfigurationRegistry) {
  const planned = new Map<string, readonly (readonly MessageContent[])[]>()
  async function prepare(content: unknown, event: FrameworkEvent, signal: AbortSignal): Promise<readonly MessageContent[]> {
    signal.throwIfAborted()
    const configuration = validateNativeOutputConfiguration((await registry.read('chat-output')).configuration)
    signal.throwIfAborted()
    let result = structured(normalizeContent(content))
    assert(configuration.media || result.every(part => part.type === 'text'), 'NATIVE_OUTPUT_MEDIA_DISABLED', 'Media output is disabled.')
    if (configuration.longTextAsForward && result.every(part => part.type === 'text')) {
      const text = result.map(part => part.type === 'text' ? part.text : '').join('')
      if (text.length > configuration.longTextThreshold) {
        const nodes = []
        for (let offset = 0; offset < text.length; offset += 3500) nodes.push({ content: [{ type: 'text' as const, text: text.slice(offset, offset + 3500) }] })
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
      signal.throwIfAborted(); return { ...configuration, protocol: 'qaf.output/1' as const, maxDeliveries: 4 } },
    split(content: readonly MessageContent[], event: FrameworkEvent) {
      const groups = planned.get(event.id); planned.delete(event.id)
      assert(groups, 'NATIVE_OUTPUT_UNPREPARED', 'Output splitting requires its current preparation.')
      return groups
    }, clear() { planned.clear() }
  })
}
export function createNativeOutputPackage(service: ReturnType<typeof createNativeOutputService>): NativePackageDefinition {
  return { content: createBuiltinPackageContent(import.meta.url, ['../contracts/native-output', './native-chat-bubbles']), manifest: { schema: 1, id: 'chat-output', version: '1.0.0', dependencies: [], requires: [],
    provides: [{ id: 'chat-output', version: 1 }], contributions: [] }, configurations: [NATIVE_OUTPUT_CONFIGURATION],
    install(context) { context.publish('chat-output', 1, service); context.own('subscription', 'output-plans', () => service.clear()) } }
}
