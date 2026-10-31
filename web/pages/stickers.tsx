import { useEffect, useMemo, useRef, useState } from 'react'
import { parseStickerLibrarySnapshot, parseStickerLibraryThumbnail, parseStickerLibraryDeleteResult, type StickerLibraryItem } from '../../src/contracts/sticker-library.ts'
import { PackageConfigurationManager } from '../components/package-configuration-manager.tsx'
import { ConnectPrompt, PageHeading, Section } from '../components/management.tsx'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.tsx'
import { errorMessage, type ApiClient } from '../lib/api.ts'
import { useReadResource } from '../lib/use-read-resource.ts'
import type { PageProps } from '../lib/types.ts'

// Account clients are separate objects. Keep uncertain writes locked across navigation,
// without keeping an account identifier or allowing a new operation to repeat the write.
const clientIds = new WeakMap<ApiClient, number>()
const pendingDeletes = new WeakMap<ApiClient, Map<string, { readonly operationId: string; readonly storage: StickerLibraryItem['storage'] }>>()
let nextClientId = 0
function clientId(api: ApiClient): number {
  const existing = clientIds.get(api)
  if (existing !== undefined) return existing
  const id = ++nextClientId; clientIds.set(api, id); return id
}
function deletionLocks(api: ApiClient) {
  let locks = pendingDeletes.get(api)
  if (!locks) { locks = new Map(); pendingDeletes.set(api, locks) }
  return locks
}

function StickerPreview({ api, item }: { readonly api: ApiClient; readonly item: StickerLibraryItem }) {
  const [image, setImage] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setImage(null)
    void api.get(`/api/chat/stickers/preview?id=${item.id}`, controller.signal).then(value => {
      const thumbnail = parseStickerLibraryThumbnail(value)
      if (!controller.signal.aborted && thumbnail) setImage(thumbnail.image)
    }).catch(() => undefined)
    return () => controller.abort()
  }, [api, item.id, item.revision, item.state])
  return <div className="flex h-36 items-center justify-center overflow-hidden rounded-md bg-muted/40">{image
    ? <img src={image} alt={item.description || item.name || '表情预览'} className="max-h-full max-w-full object-contain" />
    : <span className="text-xs text-muted-foreground">{item.state === 'unknown' ? '等待核对' : '预览暂不可用'}</span>}</div>
}

export function StickersPage(props: PageProps) {
  if (!props.connected) return <ConnectPrompt connect={props.connect} />
  return <ConnectedStickersPage key={clientId(props.api)} {...props} />
}

function ConnectedStickersPage({ api, connected, setDirty }: PageProps) {
  // The fresh reader owns this mount, so a reconnect does not reveal a cached account snapshot.
  const reader = useMemo<ApiClient>(() => ({ get: (path, signal) => api.get(path, signal), post: (path, body, signal) => api.post(path, body, signal) }), [api])
  const resource = useReadResource(reader, '/api/chat/stickers/library', connected, parseStickerLibrarySnapshot)
  const [filter, setFilter] = useState('all'), [query, setQuery] = useState(''), [page, setPage] = useState(0)
  const [deleting, setDeleting] = useState<StickerLibraryItem | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const [, updateLocks] = useState(0)
  const request = useRef<AbortController | null>(null)
  const locks = deletionLocks(api)
  useEffect(() => () => { request.current?.abort() }, [])
  useEffect(() => {
    const snapshot = resource.snapshot
    if (!snapshot || snapshot.limited) return
    let changed = false
    for (const [id, lock] of locks) {
      if ((lock.storage === 'extra' || snapshot.accountCollection === 'confirmed') && !snapshot.items.some(item => item.id === id)) {
        locks.delete(id); changed = true
      }
    }
    if (changed) updateLocks(value => value + 1)
  }, [resource.snapshot, locks])
  const items = useMemo(() => (resource.snapshot?.items ?? []).filter(item => (filter === 'all' || item.storage === filter)
    && `${item.name} ${item.description} ${item.tags.join(' ')}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [resource.snapshot, filter, query])
  useEffect(() => { setPage(0) }, [filter, query])
  const pages = Math.max(1, Math.ceil(items.length / 24)), currentPage = Math.min(page, pages - 1)
  async function remove() {
    if (!deleting || busy || request.current || locks.has(deleting.id) || resource.error) return
    const latest = resource.snapshot?.items.find(item => item.id === deleting.id)
    if (!latest?.canDelete || latest.revision !== deleting.revision) { setDeleting(null); setMessage('表情状态已变化，请刷新后核对。'); return }
    const controller = new AbortController(), operationId = crypto.randomUUID(), item = deleting
    request.current = controller
    locks.set(item.id, { operationId, storage: item.storage }); updateLocks(value => value + 1)
    setBusy(true); setMessage('')
    try {
      const result = parseStickerLibraryDeleteResult(await api.post('/api/chat/stickers/delete', { id: item.id, revision: item.revision, operationId }, controller.signal))
      if (controller.signal.aborted) return
      if (result?.status === 'rejected') { locks.delete(item.id); updateLocks(value => value + 1) }
      setMessage(result?.status === 'confirmed' ? '表情已删除。' : result?.status === 'rejected' ? '账号服务拒绝了删除，表情仍保留。' : '删除结果尚未确认，请刷新核对；不会自动重复删除。')
    } catch (error) { if (!controller.signal.aborted) setMessage(`${errorMessage(error)} 此表情的删除已锁定，请刷新核对。`) }
    finally {
      if (request.current === controller) request.current = null
      if (!controller.signal.aborted) { setDeleting(null); setBusy(false); resource.refresh() }
    }
  }
  const snapshot = resource.snapshot
  return <div className="grid gap-4">
    <PageHeading title="表情库" description="管理账号收藏和额外保存的表情，按含义挑选和使用。" />
    <Section title="自动收藏设置" description="两个概率依次抽取。明确要求收藏时跳过概率，仍会筛选和去重；收藏与选图各用独立绑定会话。">
      <PackageConfigurationManager api={api} connected={connected} setDirty={setDirty} onlyIds={['sticker-library']} embedded />
    </Section>
    <Section title="已有表情" description={snapshot ? `账号${snapshot.accountCollection === 'confirmed' ? '已读取' : '上次读取'} ${snapshot.capacity.count} 张；总容量未知，达到 ${snapshot.capacity.nearFullAt} 张后新收藏转存额外库。` : '启动聊天后可查看、筛选和管理表情。'}>
      <div className="flex flex-wrap items-center gap-2">
        {([['all', '全部'], ['account', '账号收藏'], ['extra', '额外存储']] as const).map(([value, label]) => <Button key={value} size="sm" variant={filter === value ? 'default' : 'outline'} onClick={() => setFilter(value)}>{label} {value === 'all' ? snapshot?.items.length ?? 0 : snapshot?.items.filter(item => item.storage === value).length ?? 0}</Button>)}
        <Input aria-label="搜索表情含义或标签" className="max-w-xs" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索含义或标签" />
        <Button size="sm" variant="outline" disabled={resource.loading || busy} onClick={resource.refresh}>刷新</Button>
      </div>
      {resource.error && <p role="alert" className="text-sm text-destructive">{errorMessage(resource.error)}</p>}
      {snapshot?.accountCollection === 'unavailable' && <p role="status" className="text-sm text-muted-foreground">账号收藏暂未读取成功，保留上次结果；账号删除暂不可用。</p>}
      {snapshot?.limited && <p role="status" className="text-sm text-muted-foreground">当前仅显示部分表情，账号数量与转存阈值保持实际读取结果。</p>}
      {!!snapshot?.pending && <p role="status" className="text-sm text-muted-foreground">正在处理 {snapshot.pending} 项表情任务。</p>}
      {message && <p role="status" className="text-sm">{message}</p>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
        {items.slice(currentPage * 24, currentPage * 24 + 24).map(item => <article key={item.id} className="grid content-start gap-2 rounded-lg border p-3">
          <StickerPreview api={api} item={item} />
          <p className="text-sm">{item.description || item.name || '尚未分类'}</p>
          <p className="text-xs text-muted-foreground">{item.storage === 'account' ? '账号收藏' : '额外存储'} · {item.state === 'unknown' || locks.has(item.id) ? '结果待核对' : item.tags.join(' · ') || '待打标'}</p>
          {item.avoid && <p className="text-xs text-muted-foreground">慎用：{item.avoid}</p>}
          <Button size="sm" variant="outline" disabled={!item.canDelete || locks.has(item.id) || busy || resource.loading || resource.error !== null} onClick={() => setDeleting(item)}>删除</Button>
        </article>)}
      </div>
      {items.length === 0 && <p className="text-sm text-muted-foreground">{resource.loading ? '正在读取…' : '没有符合条件的表情。'}</p>}
      {pages > 1 && <div className="flex items-center gap-3"><Button variant="outline" size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</Button><span className="text-xs">{currentPage + 1} / {pages}</span><Button variant="outline" size="sm" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>下一页</Button></div>}
    </Section>
    <Dialog open={deleting !== null} onOpenChange={open => { if (!open && !busy) setDeleting(null) }}><DialogContent><DialogHeader><DialogTitle>删除这张表情？</DialogTitle><DialogDescription>{deleting?.storage === 'account' ? '将从QQ账号收藏中删除，表情库也会同步移除。' : '将删除框架额外保存的图片。'} 删除后不会自动重新收藏。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setDeleting(null)}>取消</Button><Button variant="destructive" disabled={busy} onClick={() => void remove()}>{busy ? '正在删除…' : '删除'}</Button></DialogFooter></DialogContent></Dialog>
  </div>
}
