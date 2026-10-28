import type { NativeToolInventory, NativeToolInventoryItem, NativeToolRegistrationSource } from '../contracts/native-tool-inventory.ts'
import { NATIVE_MEDIA_TOOLS } from './native-framework-tools.ts'
import { NATIVE_WORK_TOOLS } from './native-work-tools.ts'
import { NATIVE_STICKER_TOOLS } from './native-sticker-tools.ts'
import { NATIVE_REPLY_TOOLS } from './native-reply-tools.ts'
import { NATIVE_DIRECTORY_TOOLS } from './native-capability-directory.ts'
import { NATIVE_CONVERSATION_TOOLS } from './native-conversation-tools.ts'

/** Framework definitions remain visible before any DSH session has been opened. */
export function withFrameworkToolInventory(inventory: NativeToolInventory,
  registered?: readonly { readonly name: string; readonly description: string; readonly loadedInSession: boolean; readonly registrationSource?: NativeToolRegistrationSource }[],
  sessionNames?: ReadonlySet<string>): NativeToolInventory {
  const definitions = registered ?? [...NATIVE_MEDIA_TOOLS, ...[...NATIVE_REPLY_TOOLS, ...NATIVE_WORK_TOOLS, ...NATIVE_STICKER_TOOLS, ...NATIVE_CONVERSATION_TOOLS, ...NATIVE_DIRECTORY_TOOLS].map(tool => tool.definition)]
  const framework: NativeToolInventoryItem[] = definitions.map(tool => ({ id: `framework:${tool.name}`, name: tool.name,
    description: tool.description.slice(0, 2000), sourceId: 'framework',
    ...(tool.registrationSource ? { registrationSource: tool.registrationSource } : {}), registration: registered ? 'registered' : 'declared',
    loadedInSession: 'loadedInSession' in tool ? tool.loadedInSession : null }))
  const sources = inventory.sources.filter(source => source.id !== 'framework').slice(0, 128)
  const sourceIds = new Set(sources.map(source => source.id))
  const external = inventory.items.filter(item => sourceIds.has(item.sourceId)).slice(0, 1024 - framework.length)
  const occurrences = new Map<string, number>()
  for (const item of inventory.items) occurrences.set(item.name, (occurrences.get(item.name) ?? 0) + 1)
  return { ...inventory, limited: inventory.limited || external.length < inventory.items.length || sources.length < inventory.sources.length,
    items: [...external.map(item => ({ ...item,
      loadedInSession: sessionNames && occurrences.get(item.name) === 1 ? sessionNames.has(item.name) : null })), ...framework],
    sources: [...sources, { id: 'framework', kind: 'framework', label: '框架桥工具', agentPreset: null, modules: [] }],
    missingReasons: [...new Set([...inventory.missingReasons, ...(!sessionNames ? ['session_tool_visibility_not_observed'] : [])])] }
}
