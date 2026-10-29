import { useEffect, useState } from 'react'
import { validateChatPersona, type ChatPersona } from '../../src/contracts/chat-plans.ts'
import { DEFAULT_PERSONA_WAKE, validatePersonaWake } from '../../src/contracts/persona-wake.ts'
import { asRecord, errorMessage } from '../lib/api.ts'
import { parsePlanCatalog } from '../lib/chat-plans.ts'
import { useReadResource } from '../lib/use-read-resource.ts'
import { writeResource } from '../lib/resource-reader.ts'
import type { PageProps } from '../lib/types.ts'
import { HelpTip } from './help-tip.tsx'
import { Input } from './ui/input.tsx'
import { Button } from './ui/button.tsx'

function parse(value: unknown): { revision: string; personas: readonly ChatPersona[] } | null {
  const row = asRecord(value)
  if (typeof row.revision !== 'string' || !Array.isArray(row.personas)) return null
  try { return { revision: row.revision, personas: row.personas.map(validateChatPersona) } } catch { return null }
}
export function ConversationWakeSettings({ api, connected, setDirty }: Pick<PageProps, 'api' | 'connected' | 'setDirty'>) {
  const catalog = useReadResource(api, '/api/chat/personas', connected, parse)
  const plans = useReadResource(api, '/api/chat/plans', connected, parsePlanCatalog)
  const plan = plans.snapshot?.plans.find(plan => plan.id === plans.snapshot?.activePlanId)
  const persona = catalog.snapshot?.personas.find(persona => persona.id === plan?.personaId)
  const [draft, setDraft] = useState<{ id: string; revision: string; base: string; extra: string } | null>(null)
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [uncertain, setUncertain] = useState(false)
  useEffect(() => { setDirty(draft !== null, 'conversation-wake'); return () => setDirty(false, 'conversation-wake') }, [draft, setDirty])
  const wake = persona?.wake ?? DEFAULT_PERSONA_WAKE
  function edit(field: 'base' | 'extra', value: string) {
    if (!persona || !catalog.snapshot) return
    setDraft(current => ({ ...(current ?? { id: persona.id, revision: catalog.snapshot!.revision,
      base: String(wake.continuationMs / 1000), extra: String((wake.replyExtensionMs ?? 500) / 1000) }), [field]: value }))
    setNotice('')
  }
  async function save() {
    if (!draft || !catalog.snapshot || !persona || draft.id !== persona.id || draft.revision !== catalog.snapshot.revision) {
      setNotice('当前人设或配置已变化，请重新读取后编辑。'); return
    }
    try {
      if (![draft.base, draft.extra].every(value => /^\d+(?:\.\d{1,3})?$/.test(value))) throw new Error('时长需要是非负数字，最多三位小数。')
      const next = validatePersonaWake({ ...wake, continuationMs: Math.round(Number(draft.base) * 1000), replyExtensionMs: Math.round(Number(draft.extra) * 1000) })
      setBusy(true); setUncertain(true)
      const result = parse(await writeResource(api, '/api/chat/personas', { revision: draft.revision,
        personas: catalog.snapshot.personas.map(item => item.id === draft.id ? { ...item, wake: next } : item) }))
      if (!result || !result.personas.some(item => item.id === draft.id && item.wake?.continuationMs === next.continuationMs
        && item.wake?.replyExtensionMs === next.replyExtensionMs)) throw new Error('保存结果尚未确认，请重新读取核对。')
      setUncertain(false); setDraft(null); setNotice('已保存，后续输入使用新设置。'); catalog.refresh()
    } catch (error) { setNotice(errorMessage(error)) } finally { setBusy(false) }
  }
  function reload() { setDraft(null); setUncertain(false); setNotice(''); catalog.refresh(); plans.refresh() }
  return <div className="flatgroup stack">
    <div className="row"><span>续聊策略</span><HelpTip label="续聊与唤醒策略">在白名单会话中，直接 @、昵称呼叫，以及开启引用唤醒后的引用机器人消息，会刷新基础续聊窗口。空 @ 机器人和协议识别的戳一戳也会唤醒，模型结合上下文决定如何回应；普通文字模拟戳一戳不算。窗口内本会话所有人的消息可进入参与判断，包括 @ 或引用他人，模型可以保持安静。窗口按实际时间减少。只有一轮执行通过新消息覆盖检查、真正决定发言时才追加一次；静默、仅处理、被覆盖的旧结果和分拆气泡不重复追加。基础时长设为 0 关闭续聊，追加时长设为 0 关闭动态追加；剩余窗口最多 300 秒。</HelpTip></div>
    <div className="row flex-wrap">
      <label htmlFor="overview-continuation">基础续聊时长</label><Input id="overview-continuation" className="w-24" type="number" min={0} max={300} step={0.1}
        value={draft?.base ?? wake.continuationMs / 1000} disabled={!persona || busy || uncertain} onChange={event => edit('base', event.target.value)} /><span>秒</span>
      <HelpTip label="基础续聊时长">默认 90 秒，从实际呼叫时开始计时；再次呼叫刷新基础窗口。普通群消息不会刷新计时，0 表示关闭续聊。</HelpTip>
    </div>
    <div className="row flex-wrap">
      <label htmlFor="overview-continuation-extra">每轮决定发言后追加</label><Input id="overview-continuation-extra" className="w-24" type="number" min={0} max={60} step={0.1}
        value={draft?.extra ?? (wake.replyExtensionMs ?? 500) / 1000} disabled={!persona || busy || uncertain} onChange={event => edit('extra', event.target.value)} /><span>秒</span>
      <HelpTip label="发言后的续聊追加">默认 0.5 秒，增加到当时剩余窗口上，随后继续随时间减少。按有效执行编号只计算一次，与发送气泡数量无关；被新消息覆盖而没有发言的执行不增加。处理期间窗口已耗尽时，仅获得这次追加的时长。</HelpTip>
    </div>
    <p className="small muted">设置跟随当前人设{persona ? `「${persona.name}」` : ''}，无需重启。</p>
    {(catalog.error || plans.error) && <p className="small">设置读取失败，请重新读取。</p>}
    {notice && <p className="small" role="status">{notice}</p>}
    <div className="row"><Button size="sm" disabled={!draft || busy || uncertain} onClick={() => void save()}>保存续聊设置</Button><Button size="sm" variant="ghost" disabled={busy} onClick={reload}>重新读取</Button></div>
  </div>
}
