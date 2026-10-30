import { FRAMEWORK_MEDIA_PROTOCOL, FRAMEWORK_MEDIA_WIRE_BYTES, parseNativeMediaReadEnvelope, type FrameworkToolProjectedResult } from '../contracts/framework-media.ts'
import type { FrameworkToolDefinition } from '../contracts/framework-tools.ts'
import type { JsonValue } from '../contracts/data.ts'
import { assert } from '../core/values.ts'

function frameLayout(frames: readonly { readonly timeSeconds: number; readonly grid?: { readonly times: readonly number[] } }[]): string {
  if (!frames[0]?.grid) return `图片按实际时间顺序排列，时间点（秒）：${frames.map(frame => frame.timeSeconds).join('、')}。`
  return `以下 ${frames.length} 张图片是四宫格，共 ${frames.reduce((sum, frame) => sum + (frame.grid?.times.length ?? 1), 0)} 个抽样画面。每张按左上、右上、左下、右下读取；每格宽高减半，超大画面受像素上限约束，小字细节可能缺失。各图实际时间点（秒）：${frames.map((frame, index) => `图${index + 1}=[${frame.grid?.times.join('、')}]`).join('；')}。末图不足四格时，其余为空白，不能将空白理解为视频内容。`
}

/** Only a trusted tool's fixed media-read capability opts into this reserved envelope. */
export function makeFrameworkMediaResultProjector() {
  return (definition: Readonly<FrameworkToolDefinition>, value: JsonValue): FrameworkToolProjectedResult => {
    if (definition.capability !== 'native.media.read') return { value }
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== FRAMEWORK_MEDIA_PROTOCOL) return { value }
    const envelope = parseNativeMediaReadEnvelope(value)
    assert(envelope, 'INVALID_FRAMEWORK_MEDIA_RESULT', 'The media read result cannot be interpreted safely.')
    if (!envelope.contentRead) return { value: { ...envelope } }
    if (envelope.kind === 'animation') {
      const value = { schema: envelope.schema, contentRead: true, kind: 'animation', durationSeconds: envelope.durationSeconds,
        frameCount: envelope.frameCount, loopCount: envelope.loopCount,
        frames: envelope.frames.map(frame => ({ timeSeconds: frame.timeSeconds, mediaType: frame.mediaType, ...(frame.grid ? { grid: { ...frame.grid, times: [...frame.grid.times] } } : {}) })), coverage: envelope.coverage } as const
      const content = [{ type: 'text' as const, text: `GIF 动画抽样画面：单次播放时长 ${envelope.durationSeconds} 秒，原动画 ${envelope.frameCount} 帧，${envelope.loopCount === 0 ? '无限循环（loopCount=0）' : `解码器记录的循环次数为 ${envelope.loopCount}`}。${frameLayout(envelope.frames)}仅观察这些抽样帧，不表示逐帧观看了完整动画；不能据此断言未抽到的动作不存在。` },
        ...envelope.frames.map(frame => ({ type: 'image' as const, mediaType: frame.mediaType, data: frame.data }))]
      assert(Buffer.byteLength(JSON.stringify({ value, content })) <= FRAMEWORK_MEDIA_WIRE_BYTES,
        'INVALID_FRAMEWORK_MEDIA_RESULT', 'The sampled animation frames exceed the tool wire limit.')
      return { value, content }
    }
    if (envelope.kind === 'video') {
      const value = { schema: envelope.schema, contentRead: true, kind: 'video', durationSeconds: envelope.durationSeconds,
        frames: envelope.frames.map(frame => ({ timeSeconds: frame.timeSeconds, mediaType: frame.mediaType, ...(frame.grid ? { grid: { ...frame.grid, times: [...frame.grid.times] } } : {}) })),
        audioObserved: false, hasAudio: envelope.hasAudio, coverage: envelope.coverage } as const
      const content = [{ type: 'text' as const, text: `视频抽样画面：时长 ${envelope.durationSeconds} 秒，${frameLayout(envelope.frames)}仅观察这些抽样时刻，不表示已观看完整视频。未分析音轨；${envelope.hasAudio ? '检测到音轨，但未听取或转录。' : '未检出音轨。'}` },
        ...envelope.frames.map(frame => ({ type: 'image' as const, mediaType: frame.mediaType, data: frame.data }))]
      assert(Buffer.byteLength(JSON.stringify({ value, content })) <= FRAMEWORK_MEDIA_WIRE_BYTES,
        'INVALID_FRAMEWORK_MEDIA_RESULT', 'The sampled frames exceed the tool wire limit.')
      return { value, content }
    }
    if (envelope.kind === 'image') return { value: { schema: envelope.schema, contentRead: true, kind: 'image', mediaType: envelope.mediaType },
      content: [{ type: 'image', mediaType: envelope.mediaType, data: envelope.data }] }
    return { value: { schema: envelope.schema, contentRead: true, kind: 'text', sourceKind: envelope.sourceKind },
      content: [{ type: 'text', text: envelope.text }] }
  }
}
