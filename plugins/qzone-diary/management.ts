import { assert } from '../../src/core/values.ts'
import { json } from '../../src/host/data.ts'
import type { PluginScheduleBusinessDetails, PluginScheduleBusinessSummary } from '../../src/contracts/plugin-schedules.ts'
import type { PluginSchedulerClient, PluginScheduledRule, PluginScheduledHistory } from '../../src/host/plugin-scheduler.ts'
import type { DiaryDay, DiaryOptions, DiarySlot } from './types.ts'
import { localDay } from './time.ts'
import { diaryPlanRecovery, MAX_AUTOMATIC_PLANS } from './planning.ts'

type DetailsProvider = Parameters<PluginSchedulerClient['registerDetailsProvider']>[1]
type Step = NonNullable<PluginScheduleBusinessDetails['steps']>[number]
const namespace = 'qzone-diary.days'
const explanations: Readonly<Record<string, string>> = {
  DIARY_SKIPPED_BY_OPERATOR: '已手动跳过本条安排。',
  DIARY_WINDOW_MISSED: '已超过安排的时间段。',
  DIARY_WINDOW_MISSED_OR_DISABLED: '执行时已超过时间段，或插件已停用。',
  DIARY_WINDOW_CLOSED: '处理期间时间段已结束，或插件已停用。',
  DIARY_IMAGE_REJECTED: '三版图片均未通过检查，本条未发布。',
  DIARY_INTERRUPTED_UNKNOWN: '上次执行中断，尚未确认最终结果。',
  PLUGIN_MODEL_SESSION_UNAVAILABLE: '模型会话读取或恢复失败，请检查 DSH 会话状态。',
  PLUGIN_MODEL_SELECTION_UNAVAILABLE: '所选模型不可用，请检查插件的模型配置。',
  PLUGIN_MODEL_SESSION_BUSY: '模型会话正在处理其他请求，本次尚未提交。',
  PLUGIN_MODEL_CONTEXT_UNAVAILABLE: '模型上下文准备失败，本次尚未提交。',
  PLUGIN_MODEL_REJECTED: '模型服务拒绝了本次请求，请检查 DSH 运行状态。',
}

function slotStage(slot: DiarySlot): string {
  if (slot.state === 'generating') return slot.caption ? `正在生成图片 · 第 ${slot.attempts || 1}/3 版` : '正在生成文案'
  if (slot.state === 'reviewing') return `正在检查图片 · 第 ${slot.attempts}/3 版`
  return { scheduled: '等待执行', publishing: '正在发布', published: '已发布到空间',
    preview: '图文已准备好，尚未发布', skipped: '已跳过', unknown: '执行结果未确认' }[slot.state]
}

function slotSteps(slot: DiarySlot, date: string): readonly Step[] {
  const active = ['generating', 'reviewing', 'publishing'].includes(slot.state)
  const stopped = slot.state === 'skipped' ? 'skipped' : slot.state === 'unknown' ? 'unknown' : 'pending'
  const later = slot.state === 'publishing' || slot.state === 'published' || slot.state === 'preview'
  const accepted = Boolean(slot.review?.acceptable && slot.review.captionMatches && slot.review.issues.length === 0)
  const reviewed = later || accepted || slot.state === 'skipped' && slot.error === 'DIARY_IMAGE_REJECTED'
  const hasCurrentImage = slot.artifactId?.startsWith(`${date}-${slot.index}-${slot.attempts}-`) === true
  return [
    { label: '生成文案', state: slot.caption ? 'completed' : slot.state === 'generating' ? 'running' : stopped },
    { label: '生成图片', state: slot.state === 'generating' && slot.caption ? 'running'
      : hasCurrentImage && (slot.state === 'reviewing' || later || !active) ? 'completed' : stopped },
    { label: '检查图片', state: slot.state === 'reviewing' ? 'running' : reviewed ? accepted ? 'completed' : 'failed' : stopped },
    { label: '发布到空间', state: slot.state === 'published' ? 'completed' : slot.state === 'publishing' ? 'running' : stopped },
  ]
}

/** Business projections read stored facts only. Skipping persists business state before the host cancels the rule. */
export function createDiaryScheduleDetails(handler: 'plan' | 'publish', options: DiaryOptions): DetailsProvider {
  const now = options.clock ?? Date.now
  function dateFor(rule: PluginScheduledRule, scheduledAt?: number): string {
    return typeof rule.payload.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rule.payload.date)
      ? rule.payload.date : localDay(scheduledAt ?? now(), options.configuration().timeZone)
  }
  function read(date: string): DiaryDay | null {
    const value = options.store.read(namespace, date)
    return value ? structuredClone(value.value) as unknown as DiaryDay : null
  }
  function summarize(rule: PluginScheduledRule, occurrence?: PluginScheduledHistory): PluginScheduleBusinessSummary {
    const date = dateFor(rule, occurrence?.scheduledAt), day = read(date)
    if (handler === 'plan') {
      const count = day?.slots.length ?? 0, published = day?.slots.filter(slot => slot.state === 'published').length ?? 0
      if (day?.state === 'unknown') {
        const failure = day.planningFailures?.at(-1)
        const reason = failure ? explanations[failure.code] : undefined
        const recovery = diaryPlanRecovery(day, options)
        const retry = options.runtime.scheduler.list({ limit: 1000 }).find(item => item.handler === 'plan'
          && item.payload.date === date && item.enabled && !item.cancelled && item.nextAt !== null)
        return { stage: recovery.state === 'ready' ? '规划失败，可恢复' : '规划待核对',
          summary: `${reason ? `${reason} ` : ''}${recovery.message}${retry && recovery.state === 'ready' ? ' 已登记后续规划检查。'
            : recovery.state === 'ready' ? (day.planningAttempts ?? 1) >= MAX_AUTOMATIC_PLANS
              ? ' 自动恢复次数已用完，可在 QQ 请求“恢复今天的空间日记规划”。' : ' 可在 QQ 请求“恢复今天的空间日记规划”。' : ''}` }
      }
      return { stage: !day ? '等待安排' : day.state === 'planning' ? '正在安排今日计划'
        : '今日计划已安排',
      summary: !day ? `${date} 尚未生成计划。` : day.state === 'planned'
        ? `${date} 已安排 ${count} 条，已发布 ${published} 条。${occurrence && ['failed', 'unknown'].includes(occurrence.status)
          ? ' 此次执行曾失败或中断，后续规划已成功；原执行记录保留。' : ''}` : day.state === 'planning' ? '正在生成各时间段的生活片段。' : '规划中断，保留已有记录。' }
    }
    const slot = day?.slots.find(item => item.index === rule.payload.slot)
    if (!slot) return { stage: '日程记录不可用', summary: '未找到这条任务对应的业务日程。' }
    return { stage: !options.configuration().enabled && slot.state === 'scheduled' ? '插件已停用' : slotStage(slot),
      summary: [slot.scene, slot.error ? explanations[slot.error] ?? '本次处理未正常完成，请结合执行记录核对。' : ''].filter(Boolean).join(' ').slice(0, 1200) }
  }
  return {
    presentation: {
      title: handler === 'plan' ? '安排空间日记' : '发布空间生活日记', ownerLabel: '空间生活日记',
      description: handler === 'plan' ? '在每日时间段中安排生活片段。' : '生成文案和图片，检查图片后发布。',
    },
    summarize,
    async read(rule, occurrence, signal): Promise<PluginScheduleBusinessDetails> {
      signal.throwIfAborted()
      const date = dateFor(rule, occurrence?.scheduledAt), day = read(date)
      const sessionId = options.runtime.models.list().find(binding => binding.name === 'diary' && binding.conversationId === null)?.sessionId ?? null
      if (handler === 'plan') {
        return { ...summarize(rule, occurrence), sessionId, canSkip: false, result: null }
      }
      const slot = day?.slots.find(item => item.index === rule.payload.slot)
      if (!slot) return { stage: '日程记录不可用', summary: '未找到这条任务对应的业务日程。', sessionId, canSkip: false, result: null }
      const images: { dataUrl: string; alt: string }[] = []
      let previewUnavailable = false
      if (slot.artifactId && options.media.preview) {
        try {
          const preview = await options.media.preview(slot.artifactId, signal)
          images.push({ dataUrl: `data:${preview.mediaType};base64,${preview.data}`, alt: `${date} 第 ${slot.index + 1} 条日记图片` })
        } catch { previewUnavailable = true }
      }
      signal.throwIfAborted()
      const summary = [slot.scene, slot.style ? `画风：${slot.style}` : '',
        slot.error ? explanations[slot.error] ?? '本次处理未正常完成，请结合执行记录核对。' : '',
        slot.review && (slot.review.issues.length > 0 || !slot.review.acceptable || !slot.review.captionMatches)
          ? `图片检查：${slot.review.issues.join('；') || '图片或文案匹配未通过。'}` : '',
        previewUnavailable ? '图片缩略图暂不可用。' : ''].filter(Boolean).join('\n').slice(0, 4000)
      return { stage: !options.configuration().enabled && slot.state === 'scheduled' ? '插件已停用' : slotStage(slot),
        summary, sessionId, canSkip: slot.state === 'scheduled', steps: slotSteps(slot, date),
        result: slot.caption || images.length ? { title: `${date} · 第 ${slot.index + 1} 条${slot.state === 'published' ? '已发布' : '草稿'}`,
          body: slot.caption ?? '', images } : null }
    },
    ...(handler === 'publish' ? { skip(rule: PluginScheduledRule, signal: AbortSignal) {
      signal.throwIfAborted()
      const date = dateFor(rule), record = options.store.read(namespace, date)
      const day = record ? structuredClone(record.value) as unknown as DiaryDay : null
      const slot = day?.slots.find(item => item.index === rule.payload.slot)
      assert(record && day && slot && slot.state === 'scheduled', 'DIARY_SKIP_UNAVAILABLE', 'Only a scheduled diary entry can be skipped.')
      slot.state = 'skipped'; slot.error = 'DIARY_SKIPPED_BY_OPERATOR'; day.updatedAt = now()
      options.store.write(namespace, date, json(day), { expectedRevision: record.revision })
    } } : {}),
  }
}
