import { useEffect, useId, useRef, useState } from 'react'
import { parseStickerLibraryIdentityUpdate, parseStickerLibraryIdentityUpdateResult, parseStickerLibrarySnapshot,
  type StickerLibraryIdentity, type StickerLibraryIdentityUpdate, type StickerLibraryItem,
  type StickerLibrarySnapshot } from '../../src/contracts/sticker-library.ts'
import { ApiError, errorMessage, type ApiClient } from '../lib/api.ts'
import { Button } from './ui/button.tsx'
import { Input } from './ui/input.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog.tsx'

interface StickerCharacterEditorProps {
  readonly api: ApiClient
  readonly item: StickerLibraryItem | null
  readonly open?: boolean
  readonly onClose: () => void
  readonly onSaved: (snapshot?: StickerLibrarySnapshot) => void
}
const clients = new WeakMap<ApiClient, { readonly key: number; readonly pending: Map<string, StickerLibraryIdentityUpdate> }>()
let nextClient = 0
function clientState(api: ApiClient) {
  let state = clients.get(api)
  if (!state) { state = { key: ++nextClient, pending: new Map() }; clients.set(api, state) }
  return state
}
const normalizedName = (value: string): string => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s_]+/g, ' ').trim()
const sources = { model: '模型推测', user: '用户确认', web: '网页依据' } as const
function sameIdentity(actual: StickerLibraryIdentity | undefined, expected: StickerLibraryIdentityUpdate['identity']): boolean {
  return actual?.source === 'user' && normalizedName(actual.character) === normalizedName(expected.character)
    && actual.aliases.length === expected.aliases.length
    && actual.aliases.every(alias => expected.aliases.some(value => normalizedName(value) === normalizedName(alias)))
}

/** Manual identity only; provenance is assigned by the host, never chosen in this form. */
export function StickerCharacterEditor(props: StickerCharacterEditorProps) {
  if (!props.item || props.open === false) return null
  return <CharacterEditor key={`${clientState(props.api).key}:${props.item.id}`} {...props} item={props.item} />
}
function CharacterEditor({ api, item, onClose, onSaved }: Omit<StickerCharacterEditorProps, 'item'> & { readonly item: StickerLibraryItem }) {
  const pending = clientState(api).pending, previous = pending.get(item.id)
  const [base, setBase] = useState(item)
  const [character, setCharacter] = useState(previous?.identity.character ?? item.identity?.character ?? '')
  const [aliases, setAliases] = useState((previous?.identity.aliases ?? item.identity?.aliases ?? []).join('，'))
  const [phase, setPhase] = useState<'idle' | 'saving' | 'reading'>('idle')
  const [blocked, setBlocked] = useState(previous !== undefined)
  const [missing, setMissing] = useState(false)
  const [nameError, setNameError] = useState(''), [aliasError, setAliasError] = useState('')
  const [error, setError] = useState(''), [message, setMessage] = useState('')
  const request = useRef<AbortController | null>(null)
  const nameId = useId(), aliasId = useId()
  const busy = phase !== 'idle', stale = item.revision > base.revision
  useEffect(() => () => { request.current?.abort() }, [])

  async function refresh() {
    if (request.current) return
    const controller = new AbortController(); request.current = controller
    setPhase('reading'); setError(''); setMessage('')
    try {
      const snapshot = parseStickerLibrarySnapshot(await api.get('/api/chat/stickers/library', controller.signal))
      if (controller.signal.aborted) return
      if (!snapshot) throw new ApiError('invalid_sticker_library_response', 503)
      const latest = snapshot.items.find(value => value.id === item.id)
      if (!latest) {
        setMissing(!snapshot.limited)
        setError(snapshot.limited ? '当前列表仅显示部分表情，尚未找到这张图，请稍后重新核对。' : '这张表情已不在库中，无法保存角色。')
        return
      }
      const unsettled = pending.get(item.id)
      const confirmed = unsettled && latest.revision > unsettled.revision && sameIdentity(latest.identity, unsettled.identity)
      // A fresh local snapshot establishes the next CAS revision. It never replays a write.
      const byId = new Map(snapshot.items.map(value => [value.id, value]))
      for (const [id] of pending) if (byId.get(id)?.state === 'ready' || !snapshot.limited && !byId.has(id)) pending.delete(id)
      setBase(latest); setMissing(false); setBlocked(latest.state !== 'ready')
      if (confirmed) { onSaved(snapshot); onClose(); return }
      setMessage(latest.state === 'ready' ? '已读取当前标注；草稿保留，尚未重新提交。核对后可保存。' : '这张表情的状态仍待核对，请稍后刷新。')
    } catch (failure) { if (!controller.signal.aborted) setError(`读取失败，草稿已保留。${errorMessage(failure)}`) }
    finally { if (request.current === controller) request.current = null; if (!controller.signal.aborted) setPhase('idle') }
  }

  async function save() {
    if (request.current || blocked || stale || missing || base.state !== 'ready') return
    setNameError(''); setAliasError(''); setError(''); setMessage('')
    const name = character.trim(), distinct = new Map<string, string>()
    const invalidText = (value: string) => /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value)
    if (!name || name.length > 64 || !normalizedName(name) || invalidText(name)) {
      setNameError('请输入有效的角色名，最多64字，不含不可见控制字符。'); return
    }
    for (const raw of aliases.split(/[,，、;；\r\n]+/)) {
      const alias = raw.trim()
      if (!alias) continue
      if (alias.length > 64 || !normalizedName(alias) || invalidText(alias)) {
        setAliasError('每个别名最多64字，不含不可见控制字符。'); return
      }
      const key = normalizedName(alias)
      if (key !== normalizedName(name) && !distinct.has(key)) distinct.set(key, alias)
    }
    if (distinct.size > 8) { setAliasError('最多填写8个不同的别名。'); return }
    const input = parseStickerLibraryIdentityUpdate({ id: base.id, revision: base.revision, identity: { character: name, aliases: [...distinct.values()] } })
    if (!input) { setError('请检查角色名和别名后再保存。'); return }
    if (!pending.has(item.id) && pending.size >= 64) { setError('仍有角色保存等待核对，请先刷新当前表情库。'); return }
    const controller = new AbortController(); request.current = controller
    pending.set(item.id, input); setPhase('saving')
    try {
      const result = parseStickerLibraryIdentityUpdateResult(await api.post('/api/chat/stickers/identity', input, controller.signal))
      if (controller.signal.aborted) return
      if (!result || result.id !== input.id || result.revision <= input.revision || !sameIdentity(result.identity, input.identity)) {
        throw new ApiError('sticker_identity_result_unknown', 504)
      }
      pending.delete(item.id); onSaved(); onClose()
    } catch (failure) {
      if (controller.signal.aborted) return
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500 && failure.status !== 409) {
        pending.delete(item.id)
        if (failure.status === 404) { setMissing(true); setError('这张表情已不在库中，请刷新核对。') }
        else setError(errorMessage(failure))
      } else {
        setBlocked(true)
        setError(failure instanceof ApiError && failure.status === 409 ? '表情已在其他位置更新，草稿已保留，请先刷新核对。'
          : '保存结果尚未确认，草稿已保留。请先刷新核对，不会自动重试。')
      }
    } finally { if (request.current === controller) request.current = null; if (!controller.signal.aborted) setPhase('idle') }
  }

  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent showCloseButton={!busy} className="sm:max-w-[480px]">
      <form className="grid gap-3" onSubmit={event => { event.preventDefault(); void save() }}>
        <DialogHeader><DialogTitle>标注角色</DialogTitle><DialogDescription>填写这张表情的角色名与别名。保存后记为用户确认，用于角色检索和选图。</DialogDescription></DialogHeader>
        <div className="rounded border bg-muted/30 px-2 py-1.5 text-xs leading-5">
          <p className="break-words">当前标注：{base.identity?.character ?? '未识别'}{base.identity && ` · ${sources[base.identity.source]}`}</p>
          {!!base.identity?.aliases.length && <p className="break-words text-muted-foreground">别名：{base.identity.aliases.join(' · ')}</p>}
        </div>
        <label htmlFor={nameId} className="grid gap-1 text-xs">角色名<Input id={nameId} autoComplete="off" value={character} maxLength={64}
          disabled={busy || blocked || missing} aria-invalid={!!nameError} aria-describedby={`${nameId}-help`} placeholder="填写可确认的角色名"
          onChange={event => { setCharacter(event.target.value); setNameError('') }} />
          <span id={`${nameId}-help`} className={nameError ? 'text-destructive' : 'text-muted-foreground'}>{nameError || '必填，最多64字。'}</span>
        </label>
        <label htmlFor={aliasId} className="grid gap-1 text-xs">别名<Input id={aliasId} autoComplete="off" value={aliases} maxLength={1024}
          disabled={busy || blocked || missing} aria-invalid={!!aliasError} aria-describedby={`${aliasId}-help`} placeholder="多个别名用逗号分隔"
          onChange={event => { setAliases(event.target.value); setAliasError('') }} />
          <span id={`${aliasId}-help`} className={aliasError ? 'text-destructive' : 'text-muted-foreground'}>{aliasError || '可留空，最多8个，每个最多64字；重复别名会合并。'}</span>
        </label>
        {blocked && !error && <p role="status" className="text-xs">上次保存结果尚待核对，请先刷新当前标注。</p>}
        {stale && !blocked && <p role="status" className="text-xs">表情已更新，请刷新核对后继续保存。</p>}
        {error && <p role="alert" className="text-xs leading-5 text-destructive">{error}</p>}
        {message && <p role="status" className="text-xs leading-5 text-muted-foreground">{message}</p>}
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>关闭</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => void refresh()}>{phase === 'reading' ? '正在核对…' : '刷新核对'}</Button>
          <Button type="submit" disabled={busy || blocked || stale || missing || base.state !== 'ready'}>{phase === 'saving' ? '正在保存…' : '保存角色'}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}
