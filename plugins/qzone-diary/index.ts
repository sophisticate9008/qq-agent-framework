import { assert } from '../../src/core/values.ts'
import { json } from '../../src/host/data.ts'
import type { NativePackageDefinition } from '../../src/host/native-packages.ts'
import type { DiaryOptions } from './types.ts'
import type { ImageGenerationService } from '../../src/contracts/image-generation.ts'
import { createQzoneDiary } from './workflow.ts'

export function createQzoneDiaryPackage(options: Omit<DiaryOptions, 'runtime' | 'images' | 'signal'> & {
  readonly imagePackageId: string
  readonly setEnabled?: (enabled: boolean) => Promise<void>
}): NativePackageDefinition {
  let diary: ReturnType<typeof createQzoneDiary> | undefined
  const names = ['status', 'plan', 'set-enabled'].map(id => `extension.qzone-diary.${id}`)
  return {
    manifest: { schema: 1, id: 'qzone-diary', version: '1.0.0', displayName: '空间生活日记',
      description: '在每日时间段内安排1–3条图文动态，使用角色参考图生成生活画面，经图像审查后发布到QQ空间。',
      toolNames: names, dependencies: [options.imagePackageId], provides: [],
      requires: [{ id: 'image-generation', version: 1 }], contributions: [] },
    start(context) {
      assert(context.runtime?.tools && context.runtime.scheduler, 'DIARY_RUNTIME_UNAVAILABLE', 'Plugin tools and scheduler are required.')
      const images = context.service('image-generation', 1) as ImageGenerationService
      assert(typeof images.generate === 'function', 'DIARY_IMAGES_UNAVAILABLE', 'An image generation service is required.')
      diary = createQzoneDiary({ ...options, runtime: context.runtime, images, signal: context.signal })
      context.own('task', 'workflow', () => diary?.stop())
      context.own('subscription', 'status', context.runtime.tools.register({ id: 'status', description: '查看空间生活日记插件的今日时间安排、图文审查与发布状态。',
        readOnly: true, permission: 'owner', parameters: { type: 'object', properties: {}, additionalProperties: false },
        async execute() { return json(diary!.status()) } }))
      context.own('subscription', 'plan', context.runtime.tools.register({ id: 'plan', description: '为空间生活日记安排今日计划；已有计划保持不变，不额外增加当天发布次数。',
        readOnly: false, permission: 'owner', parameters: { type: 'object', properties: {}, additionalProperties: false },
        async execute(_input, request) {
          context.runtime!.scheduler!.schedule({ id: `manual-${request.invocationId}`, handler: 'plan', payload: {},
            schedule: { kind: 'once', at: Date.now() + 1000 }, windowMs: 1800000, timeZone: options.configuration().timeZone })
          return { status: 'confirmed', state: 'scheduled', summary: '已安排检查今日计划，已有日程不会重复创建。' }
        } }))
      context.own('subscription', 'set-enabled', context.runtime.tools.register({ id: 'set-enabled', description: '启用或暂停空间生活日记；暂停后不再生成或发布新的动态。',
        readOnly: false, permission: 'owner', parameters: { type: 'object', required: ['enabled'], additionalProperties: false,
          properties: { enabled: { type: 'boolean' } } },
        async execute(input) {
          assert(options.setEnabled && typeof input.enabled === 'boolean', 'DIARY_SETTING_UNAVAILABLE', 'An operator configuration writer is required.')
          await options.setEnabled(input.enabled)
          return { status: 'confirmed', enabled: input.enabled }
        } }))
      diary.start()
    },
  }
}
export { createQzoneDiary, validateDiaryConfiguration } from './workflow.ts'
export { createLocalDiaryMedia } from './media-store.ts'
export type { DiaryConfiguration, DiaryOptions, DiaryMedia, DiaryDay, DiarySlot } from './types.ts'
