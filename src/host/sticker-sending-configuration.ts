import { DEFAULT_STICKER_SENDING_CONFIGURATION, validateStickerSendingConfiguration, type StickerSendingConfiguration } from '../contracts/sticker-sending.ts'
import type { PackageConfigurationContribution } from './package-configuration.ts'

export const STICKER_SENDING_CONFIGURATION: PackageConfigurationContribution<StickerSendingConfiguration> = {
  descriptor: { id: 'sticker-sending', owner: 'sticker-sending', schemaVersion: 1, title: '表情发送', application: 'live',
    description: '先按本地标注检索，再由独立DSH会话判断表达是否合适。', fields: [
      { id: 'ai-selection', path: ['useAiSelection'], kind: 'boolean', label: 'AI筛选表情',
        description: '开启时复用独立DSH会话从少量候选中选择；关闭时直接使用本地适配度匹配。' },
      { id: 'dsh-timeout', path: ['dshSelectionTimeoutSeconds'], kind: 'integer', label: 'AI选图等待上限',
        description: '默认10秒，仅开启AI筛选时生效；超时静默放弃本次发送，后台可补充语义标注供下次使用。', minimum: 1, maximum: 60, unit: '秒' },
    ] }, defaults: DEFAULT_STICKER_SENDING_CONFIGURATION, validate: validateStickerSendingConfiguration,
}
