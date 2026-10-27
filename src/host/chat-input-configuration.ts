import { DEFAULT_PERSONA_WAKE, validatePersonaWake, type PersonaWake } from '../contracts/persona-wake.ts'
import { digest } from './data.ts'
import { CHAT_INPUT_PACKAGE_ID, DEFAULT_CHAT_INPUT_CONFIGURATION, resolveChatInputConfiguration,
  validateChatInputConfiguration, type ChatInputConfiguration } from '../contracts/chat-input-configuration.ts'
import { createPackageConfigurationFileStore } from '../storage/package-configuration.ts'
import { createPackageConfigurationRegistry, type PackageConfigurationContribution } from './package-configuration.ts'

/** @deprecated Legacy document descriptor; not registered by the framework. */
export const CHAT_INPUT_CONFIGURATION_CONTRIBUTION: PackageConfigurationContribution<ChatInputConfiguration> = Object.freeze<PackageConfigurationContribution<ChatInputConfiguration>>({
  descriptor: { id: CHAT_INPUT_PACKAGE_ID, owner: CHAT_INPUT_PACKAGE_ID, schemaVersion: 1, title: '消息参与',
    description: '设置昵称唤醒、引用回复与会话续聊，并限制适用会话。', application: 'live', fields: [
      { id: 'enabled', path: ['enabled'], kind: 'boolean', label: '启用消息参与', description: '处理当前访问策略允许的消息。' },
      { id: 'nicknames', path: ['nicknames'], kind: 'string-list', label: '唤醒昵称', description: '群聊提及这些昵称时参与。', maximumEntries: 16, maximumLength: 128 },
      { id: 'wake-on-mention', path: ['wakeOnMention'], kind: 'boolean', label: '提及唤醒', description: '群聊直接提及机器人时参与。' },
      { id: 'wake-on-reply', path: ['wakeOnReply'], kind: 'boolean', label: '引用唤醒', description: '群聊引用机器人消息时参与。' },
      { id: 'continuation', path: ['continuationMs'], kind: 'integer', label: '会话续聊时长', description: '唤醒或实际回复后，本会话所有发言者的消息都可进入模型参与判断，模型可静默；普通消息不刷新时长，0表示关闭。', minimum: 0, maximum: 300_000, unit: 'ms' },
      { id: 'group', path: ['scopes', 'group'], kind: 'boolean', label: '群聊', description: '在已获准的群聊中使用。' },
      { id: 'private', path: ['scopes', 'private'], kind: 'boolean', label: '私聊', description: '在已获准的私聊中使用。' },
      { id: 'include', path: ['scopes', 'include'], kind: 'string-list', label: '限定会话', description: '留空使用已开启的会话类型，填写后仅在列出的会话生效。', maximumEntries: 256, maximumLength: 40 },
      { id: 'exclude', path: ['scopes', 'exclude'], kind: 'string-list', label: '排除会话', description: '排除优先于限定会话。', maximumEntries: 256, maximumLength: 40 }
    ] },
  defaults: DEFAULT_CHAT_INPUT_CONFIGURATION,
  validate: validateChatInputConfiguration
})

export function createDefaultPackageConfigurationRegistry(directory: string) {
  return createPackageConfigurationRegistry({ store: createPackageConfigurationFileStore(directory),
    contributions: [] })
}

/** Persona wake settings are live; no separate package configuration participates in admission. */
export async function readChatInputConfiguration(_directory: string, conversationId: string, personaName?: string,
  wake: PersonaWake = DEFAULT_PERSONA_WAKE) {
  const configuration = validateChatInputConfiguration({ ...DEFAULT_CHAT_INPUT_CONFIGURATION, ...validatePersonaWake(wake) })
  return { schema: 1 as const, id: CHAT_INPUT_PACKAGE_ID, schemaVersion: 1,
    revision: digest({ personaName: personaName ?? null, configuration }), source: 'stored' as const, application: 'live' as const,
    configuration, effective: resolveChatInputConfiguration(configuration, conversationId, personaName) }
}
