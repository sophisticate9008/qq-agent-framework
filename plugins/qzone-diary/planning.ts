import type { DiaryDay, DiaryOptions, DiarySlot } from './types.ts'
import { localDay } from './time.ts'

export const MAX_AUTOMATIC_PLANS = 3
export const PLAN_RETRY_DELAY_MS = 5 * 60_000
export const MANUAL_PLAN_DELAY_MS = 60_000

/** These refusals occur before the first model input, image job or publication. */
export function diarySlotUnsubmitted(slot: DiarySlot): boolean {
  return slot.state === 'unknown' && slot.attempts === 0 && !slot.caption && !slot.artifactId && !slot.receipt
    && ['PLUGIN_MODEL_SESSION_UNAVAILABLE', 'PLUGIN_MODEL_SESSION_WRITER_HELD', 'PLUGIN_MODEL_SELECTION_UNAVAILABLE',
      'PLUGIN_MODEL_SESSION_BUSY', 'PLUGIN_MODEL_CONTEXT_UNAVAILABLE', 'PLUGIN_MODEL_REJECTED'].includes(slot.error ?? '')
}

export function diarySlotCanRunNow(day: DiaryDay | null, index: number, options: DiaryOptions): boolean {
  const now = (options.clock ?? Date.now)(), configuration = options.configuration()
  const slot = day?.slots.find(item => item.index === index)
  if (!configuration.enabled || !day || day.date !== localDay(now, configuration.timeZone) || !slot || slot.until <= now) return false
  const binding = options.runtime.models.list().find(item => item.name === 'diary' && item.conversationId === null)
  if (binding && (binding.busy || binding.state !== 'ready')) return false
  return slot.state === 'scheduled' || diarySlotUnsubmitted(slot) || slot.state === 'preview' && configuration.publish
    && Boolean(slot.review?.acceptable && slot.review.captionMatches && !slot.review.issues.length && slot.artifactId)
}

/** A ready binding means the host has no unresolved model execution. It does not prove a prior output was saved. */
export function diaryPlanRecovery(day: DiaryDay | null, options: DiaryOptions) {
  if (!options.configuration().enabled) return { state: 'disabled', message: '插件已停用，启用后才能恢复规划。' } as const
  if (!day || day.state === 'planned') return { state: 'not-needed', message: '检查今日安排会沿用已有计划。' } as const
  if (day.slots.length || options.runtime.scheduler.list({ limit: 1000 }).some(rule =>
    rule.handler === 'publish' && rule.payload.date === day.date)) {
    return { state: 'partial', message: '已有日记或发布任务，保留原记录，请先核对已有安排。' } as const
  }
  const binding = options.runtime.models.list().find(item => item.name === 'diary' && item.conversationId === null)
  if (day.state === 'planning' || binding?.busy) return { state: 'busy', message: '规划或会话仍在执行，请稍后核对。' } as const
  if (!binding || binding.state !== 'ready') return { state: 'unsettled',
    message: '先在插件模型会话中核对原执行；确认会话就绪后，再请求恢复今日规划。' } as const
  return { state: 'ready', message: '没有已保存的日记安排，模型会话已就绪，可以恢复今日规划。' } as const
}
