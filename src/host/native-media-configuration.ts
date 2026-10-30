import { DEFAULT_NATIVE_MEDIA_CONFIGURATION, validateNativeMediaConfiguration } from '../contracts/native-media-configuration.ts'
import type { PackageConfigurationContribution } from './package-configuration.ts'

export const NATIVE_MEDIA_CONFIGURATION: PackageConfigurationContribution = Object.freeze<PackageConfigurationContribution>({
  descriptor: { id: 'media', owner: 'media', schemaVersion: 1, title: '媒体观察', application: 'live',
    description: '设置视频观察开关，以及视频与 GIF 的固定抽帧方案。保存后立即生效，不改变媒体发送权限。',
    fields: [{ id: 'observe-video', path: ['observeVideo'], kind: 'boolean', label: '允许观察视频',
      description: '默认关闭。开启后按需下载当前会话的视频，使用所选 V1/V2 方案；只观察抽样画面，不分析音轨，不代表已观看完整视频。' },
      { id: 'observation-version', path: ['observationVersion'], kind: 'choice', label: '画面方案',
        options: [{ value: 'v1', label: 'V1 · 单帧' }, { value: 'v2', label: 'V2 · 四宫格' }],
        description: '视频与 GIF 共用。V1（默认）：均匀抽取最多 6 帧，独立显示，便于查看单帧细节。V2：均匀抽取最多 24 帧，每帧宽高各缩小一半，按左上、右上、左下、右下拼成最多 6 张四宫格；更广地覆盖时间过程，小字和细节会减少，解码及传输开销可能增加。超大画面继续按像素上限等比例缩小，实际时间随结果返回。固定方案由这里选择，模型不决定拼图参数。两种方案都不分析音轨。保存后对后续读取生效；视频仍需开启观察，GIF 不受视频开关影响。' }] },
  defaults: DEFAULT_NATIVE_MEDIA_CONFIGURATION, validate: validateNativeMediaConfiguration
})
