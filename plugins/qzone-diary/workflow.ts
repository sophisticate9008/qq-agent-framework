import { randomInt } from 'node:crypto'
import { assert, errorCode, isRecord } from '../../src/core/values.ts'
import { json } from '../../src/host/data.ts'
import type { DiaryConfiguration, DiaryDay, DiaryOptions, DiarySchedulerHandlers, DiarySlot } from './types.ts'
import { localDay, localMinute } from './time.ts'
import { diaryPlanRecovery, diarySlotCanRunNow, MAX_AUTOMATIC_PLANS, PLAN_RETRY_DELAY_MS, MANUAL_PLAN_DELAY_MS } from './planning.ts'
export { DIARY_WORKFLOW_CONTRACT } from './workflow-contract.ts'

const namespace = 'qzone-diary.days'
const terminal = new Set(['published', 'preview', 'skipped'])
function text(value: unknown, maximum: number): string {
  assert(typeof value === 'string' && value.trim().length > 0 && value.length <= maximum, 'DIARY_MODEL_OUTPUT_INVALID', 'The model response did not match the requested format.')
  return value.trim()
}
function parse(value: string): Record<string, unknown> {
  const result: unknown = JSON.parse(value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
  assert(isRecord(result), 'DIARY_MODEL_OUTPUT_INVALID', 'A JSON object is required.')
  return result
}
export function validateDiaryConfiguration(value: DiaryConfiguration): DiaryConfiguration {
  assert(typeof value.enabled === 'boolean' && typeof value.publish === 'boolean' && value.persona.length > 0 && value.persona.length <= 4000
    && Array.isArray(value.windows) && value.windows.length >= 1 && value.windows.length <= 3,
  'DIARY_CONFIGURATION_INVALID', 'Use one to three daily time windows and a bounded persona.')
  new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).format()
  let previous = -1
  for (const window of value.windows) {
    assert(Number.isInteger(window.start) && Number.isInteger(window.end) && window.start >= 0 && window.end <= 1440
      && window.end - window.start >= 60 && window.start > previous, 'DIARY_WINDOWS_INVALID', 'Daily windows must be distinct, ordered and at least one hour long.')
    previous = window.end
  }
  return value
}

export function createQzoneDiary(options: DiaryOptions) {
  const { store, runtime, signal } = options
  const scheduler = runtime.scheduler
  assert(scheduler, 'DIARY_SCHEDULER_UNAVAILABLE', 'The plugin scheduler is required.')
  const now = options.clock ?? Date.now, random = options.random ?? (() => randomInt(0, 1_000_000) / 1_000_000)
  const tasks = new Map<string, Promise<void>>()
  const cleanups: (() => void)[] = []
  let started = false
  const config = () => validateDiaryConfiguration(options.configuration())
  function read(date: string): DiaryDay | null {
    const row = store.read(namespace, date)
    return row ? structuredClone(row.value) as unknown as DiaryDay : null
  }
  function save(day: DiaryDay, changedSlot?: number) {
    const current = store.read(namespace, day.date)
    day.updatedAt = now()
    if (changedSlot === undefined) {
      store.write(namespace, day.date, json(day), { expectedRevision: current?.revision ?? null })
      return
    }
    // A model/image request may be pending while another slot is skipped in the console.
    // Persist this slot only; never overwrite a newer sibling slot with an old day snapshot.
    const latest = current ? structuredClone(current.value) as unknown as DiaryDay : null
    const changed = day.slots.find(slot => slot.index === changedSlot)
    assert(current && latest && changed && latest.slots.some(slot => slot.index === changedSlot),
      'DIARY_SLOT_MISSING', 'A saved day plan is required.')
    latest.slots = latest.slots.map(slot => slot.index === changedSlot ? structuredClone(changed) : slot)
    latest.updatedAt = day.updatedAt
    store.write(namespace, day.date, json(latest), { expectedRevision: current.revision })
  }
  const observe = (phase: string, date: string, slot?: number, attempt?: number, code?: string) => {
    try { options.observe?.({ phase, day: date, ...(slot === undefined ? {} : { slot }), ...(attempt === undefined ? {} : { attempt }), ...(code ? { code } : {}) }) } catch {}
  }
  function serial(id: string, run: () => Promise<void>): Promise<void> {
    const previous = tasks.get(id)
    if (previous) return previous
    const task = run().finally(() => tasks.delete(id)); tasks.set(id, task); return task
  }
  async function writeModel(prompt: string, current: AbortSignal) {
    let binding = runtime.models.list().find(b => b.name === 'diary' && b.conversationId === null)
    if (!binding) binding = await runtime.models.create({ name: 'diary', model: config().model, signal: current })
    const marker = store.read('qzone-diary.context', 'identity')
    const initialized = isRecord(marker?.value) && marker.value.sessionId === binding.sessionId
    const recent = initialized ? [] : store.list(namespace, { limit: 366 }).flatMap(row => {
      const day = row.value as unknown as DiaryDay
      return day.slots.filter(slot => slot.state === 'published').map(slot => ({ date: day.date, caption: slot.caption }))
    }).slice(-5)
    const prefix = initialized ? '' : `你为以下虚构角色经营生活动态，延续这段独立会话的经历与偏好：${config().persona}\n口吻自然，有具体生活细节，克制，不像广告或任务汇报。不要编造真实用户隐私、现实定位或他人的经历。不提后台、工具、提示词、账本。角色形象参考在生图服务内部加入，你只写场景、动作、服装与画风。画风可变化，不要求总是自拍，不复刻参考图三视图。仅输出本次要求的JSON。最近已经发布的内容：${JSON.stringify(recent)}\n`
    const result = await runtime.models.run({ name: 'diary', model: config().model, prompt: prefix + prompt, maxOutputChars: 10000, timeoutMs: 180000, signal: current })
    if (!initialized) store.write('qzone-diary.context', 'identity', { sessionId: result.sessionId }, { expectedRevision: marker?.revision ?? null })
    return parse(result.text)
  }
  function scheduleDay(day: DiaryDay) {
    for (const slot of day.slots) {
      if (slot.state !== 'scheduled') continue
      const id = `post-${day.date}-${slot.index}`
      if (scheduler!.list({ limit: 1000 }).some(rule => rule.id === id)) continue
      if (slot.at < now()) { slot.state = 'skipped'; slot.error = 'DIARY_WINDOW_MISSED'; save(day); continue }
      scheduler!.schedule({ id, handler: 'publish', payload: { date: day.date, slot: slot.index }, schedule: { kind: 'once', at: slot.at },
        presentation: { title: `空间生活日记 · ${day.date} 第 ${slot.index + 1} 条`, ownerLabel: '空间生活日记', description: '生成图文并检查图片，通过后发布到空间。' },
        timeZone: config().timeZone, windowMs: slot.until - slot.at, misfire: 'skip' })
    }
  }
  function schedulePlanRetry(day: DiaryDay) {
    if (day.state !== 'unknown' || diaryPlanRecovery(day, options).state !== 'ready'
      || (day.planningAttempts ?? 1) >= MAX_AUTOMATIC_PLANS || signal.aborted) return
    const at = Math.max(now() + 5000, day.updatedAt + PLAN_RETRY_DELAY_MS)
    if (!config().windows.some(window => localMinute(day.date, window.end, config().timeZone) - at >= 1_860_000)) return
    const id = `retry-plan-${day.date}-${day.planningAttempts ?? 1}`
    if (scheduler!.list({ limit: 1000 }).some(rule => rule.id === id)) return
    scheduler!.schedule({ id, handler: 'plan', payload: { date: day.date }, schedule: { kind: 'once', at },
      presentation: { title: '恢复今日空间日记规划', ownerLabel: '空间生活日记', description: '核对模型会话后恢复尚未生成的计划。' },
      timeZone: config().timeZone, windowMs: 1800000, misfire: 'skip' })
  }
  async function planDay(current: AbortSignal = signal, request: { recover?: boolean; date?: string } = {}): Promise<void> {
    const c = config(), date = localDay(now(), c.timeZone)
    current.throwIfAborted()
    if (!c.enabled || request.date !== undefined && request.date !== date) return
    return serial(`plan:${date}`, async () => {
      const existing = read(date)
      if (existing?.state === 'planned') { scheduleDay(existing); return }
      if (existing) {
        const recovery = diaryPlanRecovery(existing, options)
        assert(recovery.state === 'ready', 'DIARY_PLAN_RECOVERY_BLOCKED', recovery.message)
        if (!request.recover && (existing.planningAttempts ?? 1) >= MAX_AUTOMATIC_PLANS) return
        const delay = request.recover ? MANUAL_PLAN_DELAY_MS : PLAN_RETRY_DELAY_MS
        if (now() < existing.updatedAt + delay) {
          if (request.recover) assert(false, 'DIARY_PLAN_RECOVERY_COOLDOWN', '恢复规划至少间隔一分钟。')
          schedulePlanRetry(existing); return
        }
      }
      assert(existing || store.list(namespace, { limit: 366 }).length < 366, 'DIARY_HISTORY_LIMIT', 'Resolve retained unfinished days before creating new ones.')
      const windows = c.windows.map(window => ({ start: Math.max(localMinute(date, window.start, c.timeZone), now() + 60000),
        end: localMinute(date, window.end, c.timeZone) })).filter(window => window.end - window.start >= 1800000)
      const day: DiaryDay = { ...existing, date, createdAt: existing?.createdAt ?? now(), updatedAt: now(), state: 'planning', slots: [],
        planningAttempts: (existing ? existing.planningAttempts ?? 1 : 0) + 1 }; save(day)
      if (!windows.length) { day.state = 'planned'; save(day); return }
      const count = 1 + Math.floor(random() * windows.length)
      const selected = windows.map(window => ({ ...window, order: random() })).sort((a, b) => a.order - b.order).slice(0, count).sort((a, b) => a.start - b.start)
      const planned = selected.map(window => ({ at: Math.floor(window.start + random() * (window.end - window.start - 1800000)), until: window.end }))
      try {
        observe('planning', date)
        const times = planned.map(window => new Date(window.at).toLocaleTimeString('zh-CN', { timeZone: c.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }))
        const result = await writeModel(`今天是${date}，时区${c.timeZone}。安排${count}个相互连贯但不同的日常生活片段，对应本地时间依次为${times.join('、')}。场景必须符合对应时间：凌晨不写白天阳光，不把未发生的计划说成已完成。避免重复历史日程，也不要每条都拿杯子或对镜头摆拍。每段可自由选不同画风。输出 {"slots":[{"scene":"具体活动与生活细节","style":"画风"}]}，正好${count}段，按上述时间顺序。`, current)
        assert(Array.isArray(result.slots) && result.slots.length === count, 'DIARY_PLAN_INVALID', 'The day plan must match the bounded number of windows.')
        day.slots = result.slots.map((entry, index) => {
          assert(isRecord(entry), 'DIARY_PLAN_INVALID', 'A scene and style are required.')
          const window = planned[index]!, at = Math.max(window.at, now() + 1000)
          return { index, at, until: window.until, scene: text(entry.scene, 1000), style: text(entry.style, 160),
            state: window.until - at >= 1800000 ? 'scheduled' : 'skipped', attempts: 0 }
        })
        current.throwIfAborted(); day.state = 'planned'; save(day); scheduleDay(day); observe('planned', date)
      } catch (error) {
        // A saved plan stays authoritative even when registering its schedules fails.
        if (day.state !== 'planned') day.state = 'unknown'
        const code = errorCode(error)
        day.planningFailures = [...(day.planningFailures ?? []), { at: now(), code, attempt: day.planningAttempts! }].slice(-16)
        save(day); observe('planning-failed', date, undefined, day.planningAttempts, code)
        if (!current.aborted) schedulePlanRetry(day)
        throw error
      }
    })
  }
  async function publishSlot(date: string, index: number, current: AbortSignal = signal, request: { manual?: boolean } = {}): Promise<void> {
    return serial(`publish:${date}:${index}`, async () => {
      const day = read(date), slot = day?.slots.find(slot => slot.index === index)
      assert(day && slot, 'DIARY_SLOT_MISSING', 'A saved day plan is required.')
      if (request.manual) {
        current.throwIfAborted()
        assert(diarySlotCanRunNow(day, index, options), 'DIARY_RUN_UNAVAILABLE', '当前日记不能安全立即执行，请先核对原执行。')
        slot.at = Math.min(slot.at, now())
        if (slot.state === 'preview') { save(day, index); await publishApproved(date, index, current); return }
        slot.state = 'scheduled'; delete slot.error; save(day, index)
      }
      if (slot.state !== 'scheduled') return
      if (!config().enabled || now() < slot.at || now() >= slot.until) {
        if (now() >= slot.until || !config().enabled) { slot.state = 'skipped'; slot.error = 'DIARY_WINDOW_MISSED_OR_DISABLED'; save(day, index) }
        return
      }
      // Persist intent before any model/image side effect. Interrupted work is retained, never blindly replayed.
      slot.state = 'generating'; save(day, index)
      try {
        const draft = await writeModel(`现在是${new Date(now()).toLocaleString('zh-CN', { timeZone: config().timeZone })}。本次日常片段：${slot.scene}，画风：${slot.style}。写一条简短第一人称生活动态（8-100字，随手记感，不必问读者问题），配一幅含自己角色的生活画面。输出 {"caption":"正文","prompt":"独立生图要求，场景服装动作构图与画风，最多2000字"}。画面不要水印或文字。`, current)
        slot.caption = text(draft.caption, 240); slot.prompt = text(draft.prompt, 3000); save(day, index)
        let correction = ''
        for (let attempt = 1; attempt <= 3; attempt++) {
          current.throwIfAborted()
          if (!config().enabled || now() >= slot.until) { slot.state = 'skipped'; slot.error = 'DIARY_WINDOW_CLOSED'; save(day, index); return }
          slot.attempts = attempt; slot.state = 'generating'; save(day, index); observe('generating', date, index, attempt)
          const image = await options.images.generate({ idempotencyKey: `qzone-diary:${date}:${index}:${attempt}`, subject: 'self',
            prompt: slot.prompt + (correction ? `\n修正上一版的具体问题：${correction}` : ''), signal: current })
          const artifact = await options.media.save(`${date}-${index}-${attempt}`, image)
          slot.artifactId = artifact.id; slot.protocolImage = artifact.protocolImage; slot.state = 'reviewing'; save(day, index); observe('reviewing', date, index, attempt)
          const check = await runtime.models.run({ name: 'visual-review', mode: 'stateless', model: config().visionModel,
            prompt: `检查实际附图能否用于生活动态。目标：${slot.scene}；要求：${slot.prompt}；文案：${slot.caption}。检查手指/肢体多余或缺失、肢体连接错乱、面部严重畸形、物体穿模、画面内容与文案矛盾、严重乱码水印。风格化和合理遮挡不算错误，不要求写实。看不清关键结构时不能盲目通过。仅返回JSON {"acceptable":布尔值,"captionMatches":布尔值,"issues":["具体可见问题"],"correction":"重生成时的明确修正建议，无问题为空"}。`,
            images: [{ mediaType: image.mediaType, data: Buffer.from(image.data).toString('base64') }], timeoutMs: 180000, maxOutputChars: 4000, signal: current })
          const review = parse(check.text)
          assert(typeof review.acceptable === 'boolean' && typeof review.captionMatches === 'boolean' && Array.isArray(review.issues)
            && review.issues.length <= 16 && review.issues.every(item => typeof item === 'string' && item.length <= 500)
            && typeof review.correction === 'string' && review.correction.length <= 2000, 'DIARY_REVIEW_INVALID', 'Image review must return explicit findings.')
          slot.review = { acceptable: review.acceptable, captionMatches: review.captionMatches, issues: review.issues as string[], correction: review.correction }; save(day, index)
          if (!review.acceptable || !review.captionMatches || review.issues.length) {
            correction = [review.correction, ...review.issues].join('；'); observe('image-rejected', date, index, attempt)
            if (attempt === 3) { slot.state = 'skipped'; slot.error = 'DIARY_IMAGE_REJECTED'; save(day, index); return }
            continue
          }
          current.throwIfAborted()
          if (!config().enabled || now() >= slot.until) { slot.state = 'skipped'; slot.error = 'DIARY_WINDOW_CLOSED'; save(day, index); return }
          slot.state = 'preview'; save(day, index)
          if (!config().publish) { observe('preview-ready', date, index, attempt); return }
          await publishApproved(date, index, current); return
        }
      } catch (error) { slot.state = 'unknown'; slot.error = errorCode(error); save(day, index); observe('failed', date, index, slot.attempts, slot.error); throw error }
    })
  }
  async function publishApproved(date: string, index: number, current: AbortSignal = signal): Promise<void> {
    const day = read(date), slot = day?.slots.find(slot => slot.index === index)
    assert(day && slot, 'DIARY_SLOT_MISSING', 'A saved approved draft is required.')
    if (slot.state !== 'preview') return
    assert(config().enabled && config().publish && slot.at <= now() && now() < slot.until
      && slot.review?.acceptable && slot.review.captionMatches && slot.review.issues.length === 0
      && slot.caption && slot.protocolImage, 'DIARY_PUBLISH_NOT_READY', 'An approved image and active publication window are required.')
    current.throwIfAborted(); slot.state = 'publishing'; save(day, index)
    try {
      const image = options.media.resolve && slot.artifactId ? await options.media.resolve(slot.artifactId) : { protocolImage: slot.protocolImage }
      current.throwIfAborted()
      const receipt = await runtime.capabilities.call({ id: 'send_qzone_msg', input: { content: slot.caption, images: [image.protocolImage] },
        idempotencyKey: `diary:${date}:${index}`, signal: current })
      if (receipt.status === 'confirmed') { slot.state = 'published'; slot.receipt = JSON.stringify(receipt.data).slice(0, 2000) }
      else { slot.state = receipt.status === 'rejected' ? 'skipped' : 'unknown'; slot.error = receipt.code }
      save(day, index); observe(slot.state, date, index, slot.attempts)
    } catch (error) { slot.state = 'unknown'; slot.error = errorCode(error); save(day, index); throw error }
  }
  function status() {
    const date = localDay(now(), config().timeZone), day = read(date)
    return { enabled: config().enabled, publish: config().publish, date, state: day?.state ?? 'not-planned',
      recovery: diaryPlanRecovery(day, options), planningAttempts: day?.planningAttempts ?? (day ? 1 : 0),
      planningFailures: day?.planningFailures ?? [],
      sessions: runtime.models.list().map(b => ({ name: b.name, sessionId: b.sessionId, state: b.state })),
      slots: day?.slots.map(({ prompt: _prompt, receipt: _receipt, protocolImage: _file, ...slot }) => slot) ?? [] }
  }
  async function maintain() {
    for (const record of store.list(namespace, { limit: 366 })) {
      const day = structuredClone(record.value) as unknown as DiaryDay
      let changed = false
      for (const slot of day.slots) if (slot.state === 'scheduled' && slot.until <= now()) {
        slot.state = 'skipped'; slot.error = 'DIARY_WINDOW_MISSED'; changed = true
      }
      if (changed) save(day)
      if (day.createdAt < now() - 7 * 86400000 && day.state === 'planned' && day.slots.every(slot => terminal.has(slot.state))) {
        const current = store.read(namespace, record.key)
        if (current) store.delete(namespace, record.key, current.revision)
      }
    }
    const retained = store.list(namespace, { limit: 366 }).flatMap(row => (row.value as unknown as DiaryDay).slots.flatMap(slot => slot.artifactId ? [slot.artifactId] : []))
    await options.media.prune?.(retained)
  }
  function start(handlers?: DiarySchedulerHandlers): () => void {
    if (started) return () => {}; signal.throwIfAborted(); started = true
    for (const row of store.list(namespace, { limit: 366 })) {
      const day = structuredClone(row.value) as unknown as DiaryDay
      let changed = false
      if (day.state === 'planning') { day.state = 'unknown'; changed = true }
      for (const slot of day.slots) if (['generating', 'reviewing', 'publishing'].includes(slot.state)) {
        slot.state = 'unknown'; slot.error = 'DIARY_INTERRUPTED_UNKNOWN'; changed = true
      }
      if (changed) save(day)
    }
    const registrations: (() => void)[] = []
    const release = () => { for (const unregister of registrations.splice(0).reverse()) unregister() }
    // A package owning fixed entry points retains these registrations across behavior generations.
    // Direct workflow users continue to release their own handlers through stop().
    if (!handlers) cleanups.push(release)
    try {
      registrations.push(scheduler.registerHandler('plan', handlers?.plan ?? (async occurrence => {
        await maintain(); await planDay(occurrence.signal, { recover: occurrence.payload.recover === true,
          ...(typeof occurrence.payload.date === 'string' ? { date: occurrence.payload.date } : {}) })
      })))
      registrations.push(scheduler.registerHandler('publish', handlers?.publish ?? (async occurrence => {
        assert(typeof occurrence.payload.date === 'string' && typeof occurrence.payload.slot === 'number', 'DIARY_TRIGGER_INVALID', 'A saved slot is required.')
        await publishSlot(occurrence.payload.date, occurrence.payload.slot, occurrence.signal)
      })))
      const rules = scheduler.list({ limit: 1000 })
      const daily = rules.find(rule => rule.id === 'daily-plan')
      scheduler.schedule({ id: 'daily-plan', handler: 'plan', payload: {}, schedule: { kind: 'daily', hour: 8, minute: 30 },
        presentation: { title: '安排当天的空间日记', ownerLabel: '空间生活日记', description: '在可用时间段内安排每天 1–3 条生活动态。' },
        timeZone: config().timeZone, windowMs: 15 * 3600000, misfire: 'coalesce' }, daily ? { expectedRevision: daily.revision } : undefined)
      const date = localDay(now(), config().timeZone)
      if (!read(date) && config().enabled && !rules.some(rule => rule.id === `start-${date}`)) scheduler.schedule({ id: `start-${date}`, handler: 'plan', payload: {},
        presentation: { title: '检查今天的空间日记安排', ownerLabel: '空间生活日记', description: '保留已有安排，尚无计划时创建当天计划。' },
        schedule: { kind: 'once', at: now() + 5000 }, timeZone: config().timeZone, windowMs: 1800000 })
      const existing = read(date)
      if (existing?.state === 'planned') scheduleDay(existing)
      else if (existing?.state === 'unknown') schedulePlanRetry(existing)
      return release
    } catch (error) { release(); throw error }
  }
  return { start, planDay, publishSlot, publishApproved, status, read, maintain,
    async stop() { for (const release of cleanups.splice(0)) release(); await Promise.allSettled(tasks.values()) } }
}
