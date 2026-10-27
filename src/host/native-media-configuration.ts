import { DEFAULT_NATIVE_MEDIA_CONFIGURATION, validateNativeMediaConfiguration } from '../contracts/native-media-configuration.ts'
import type { PackageConfigurationContribution } from './package-configuration.ts'

export const NATIVE_MEDIA_CONFIGURATION: PackageConfigurationContribution = Object.freeze<PackageConfigurationContribution>({
  descriptor: { id: 'media', owner: 'media', schemaVersion: 1, title: '媒体观察', application: 'live',
    description: '控制是否允许读取当前会话的视频并抽取少量画面。保存后立即生效，不改变媒体发送权限。',
    fields: [{ id: 'observe-video', path: ['observeVideo'], kind: 'boolean', label: '允许观察视频',
      description: '默认关闭。开启后按需下载当前会话的视频并抽取最多六帧；只观察抽样画面，不分析音轨，不代表已观看完整视频。' }] },
  defaults: DEFAULT_NATIVE_MEDIA_CONFIGURATION, validate: validateNativeMediaConfiguration
})
