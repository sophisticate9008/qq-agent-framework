import { DEFAULT_STICKER_LIBRARY_CONFIGURATION, validateStickerLibraryConfiguration, type StickerLibraryConfiguration } from '../contracts/sticker-library.ts'
import type { PackageConfigurationContribution } from './package-configuration.ts'

export const STICKER_LIBRARY_CONFIGURATION: PackageConfigurationContribution<StickerLibraryConfiguration> = {
  descriptor: { id: 'sticker-library', owner: 'sticker-library', schemaVersion: 1, title: '表情自动收藏',
    description: '独立模型会话筛选、打标与收藏，手动收藏复用筛选和去重。', application: 'live', fields: [
      { id: 'enabled', path: ['enabled'], kind: 'boolean', label: '自动处理表情', description: '仅处理白名单内协议标记为表情的图片；关闭不影响明确提出的手动收藏。' },
      { id: 'trigger-probability', path: ['triggerProbabilityPercent'], kind: 'number', label: '表情触发概率', description: '未见过的表情消息进入独立会话筛选、打标的概率，默认15%。', minimum: 0, maximum: 100, unit: '%' },
      { id: 'collect-probability', path: ['collectProbabilityPercent'], kind: 'number', label: '自动收藏概率', description: '通过筛选后收藏的概率，默认15%；手动请求不抽取概率。', minimum: 0, maximum: 100, unit: '%' },
      { id: 'near-full', path: ['accountNearFullAt'], kind: 'integer', label: '账号转存阈值', description: '默认500张，达到阈值后新收藏转存额外库；明确返回收藏已满时也转存。', minimum: 1, maximum: 10000, unit: '张' },
    ] }, defaults: DEFAULT_STICKER_LIBRARY_CONFIGURATION, validate: validateStickerLibraryConfiguration,
}
