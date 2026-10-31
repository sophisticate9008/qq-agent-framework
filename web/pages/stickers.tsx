import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Popover } from '@base-ui/react/popover'
import { parseStickerLibrarySnapshot, parseStickerLibraryDeleteResult, type StickerImageDimensions, type StickerLibraryItem,
  type StickerLibraryThumbnail } from '../../src/contracts/sticker-library.ts'
import { PackageConfigurationManager } from '../components/package-configuration-manager.tsx'
import { ConnectPrompt, PageHeading, Section } from '../components/management.tsx'
import { VirtualMasonry, type VirtualMasonryItemContext } from '../components/virtual-masonry.tsx'
import { StickerCharacterEditor } from '../components/sticker-character-editor.tsx'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.tsx'
import { errorMessage, type ApiClient } from '../lib/api.ts'
import { useReadResource } from '../lib/use-read-resource.ts'
import { clearFailedStickerPreviews, peekStickerPreview, readStickerPreview } from '../lib/sticker-previews.ts'
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
const identitySources = { model: '模型推测', user: '用户确认', web: '网页依据' } as const
const searchText = (value: string): string => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s_]+/g, ' ').trim()
function metadataSearchText(item: StickerLibraryItem): string {
  const { identity, facets, visual } = item
  return searchText([item.name, item.description, ...item.tags, identity?.character ?? '', ...(identity?.aliases ?? []),
    identity ? identitySources[identity.source] : '', ...(facets?.emotions ?? []), ...(facets?.actions ?? []),
    ...(facets?.intents ?? []), ...(facets?.scenes ?? []), facets?.visibleText ?? '', ...(visual?.colors ?? []),
    ...(visual?.styles ?? []), ...(visual?.entities ?? [])].join(' '))
}

function StickerMetadata({ item }: { readonly item: StickerLibraryItem }) {
  const { identity, facets, visual } = item
  const rows = [
    ['情绪', facets?.emotions.join(' · ')], ['动作', facets?.actions.join(' · ')], ['用途', facets?.intents.join(' · ')],
    ['场景', facets?.scenes.join(' · ')], ['图中文字', facets?.visibleText], ['颜色', visual?.colors.join(' · ')],
    ['画风', visual?.styles.join(' · ')], ['可见元素', visual?.entities.join(' · ')],
  ].filter(([, value]) => Boolean(value))
  return <div className="grid min-w-0 gap-1 text-xs text-muted-foreground">
    <p className="break-words">角色：{identity?.character ?? '未识别'}{identity && <span className="ml-1 rounded bg-muted px-1 py-0.5">{identitySources[identity.source]}</span>}</p>
    {identity && identity.aliases.length > 0 && <p className="break-words">别名：{identity.aliases.join(' · ')}</p>}
    {rows.length > 0 && <dl className="grid gap-1">{rows.map(([label, value]) => <div key={label} className="flex min-w-0"><dt className="shrink-0">{label}：</dt><dd className="min-w-0 break-words">{value}</dd></div>)}</dl>}
    {identity && (identity.evidence || !!identity.references?.length) && <div className="min-w-0">
      <p className="mt-2 font-medium text-foreground">识别依据</p>
      {identity.evidence && <p className="mt-1 break-words">{identity.evidence}</p>}
      {!!identity.references?.length && <ul className="mt-1 grid gap-1">{identity.references.map(reference => <li key={reference.url}><a href={reference.url} target="_blank" rel="noopener noreferrer" className="break-words underline underline-offset-2">{reference.title}</a></li>)}</ul>}
    </div>}
  </div>
}

const compact = (value: string, maximum: number): string => {
  const characters = Array.from(value)
  return characters.length > maximum ? `${characters.slice(0, maximum).join('')}…` : value
}
function StickerDetails({ item, open, onOpenChange, onEditRole, canEditRole }: { readonly item: StickerLibraryItem; readonly open: boolean;
  readonly onOpenChange: (id: string, open: boolean) => void; readonly onEditRole: (item: StickerLibraryItem) => void; readonly canEditRole: boolean }) {
  const triggerId = useId()
  const description = item.description || item.name || '尚未分类'
  return <Popover.Root open={open} onOpenChange={next => onOpenChange(item.id, next)} triggerId={triggerId} modal={false}>
    <Popover.Trigger id={triggerId} type="button" openOnHover delay={250} closeDelay={150}
      aria-label={`查看表情详情：${compact(item.name || description, 36)}`}
      onFocus={event => { if (event.currentTarget.matches(':focus-visible')) onOpenChange(item.id, true) }}
      className="grid min-w-0 gap-1 rounded-sm text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
      <span className="line-clamp-2 break-words text-sm leading-5">{compact(description, 56)}</span>
      {item.identity && <span className="truncate text-xs text-muted-foreground">{compact(item.identity.character, 18)}</span>}
      {item.tags.length > 0 && <span className="truncate text-xs text-muted-foreground">{item.tags.slice(0, 3).map(tag => compact(tag, 8)).join(' · ')}{item.tags.length > 3 ? ` +${item.tags.length - 3}` : ''}</span>}
    </Popover.Trigger>
    <Popover.Portal><Popover.Positioner side="right" align="start" sideOffset={8} collisionPadding={12} className="z-[80]">
      <Popover.Popup initialFocus={false} finalFocus={false}
        className="grid max-h-[min(70dvh,var(--available-height))] w-80 max-w-[calc(100vw-1.5rem)] gap-3 overflow-y-auto overscroll-contain rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg outline-none">
        <div className="flex items-start justify-between gap-3">
          <Popover.Title className="min-w-0 break-words text-sm font-medium">{item.name || '表情详情'}</Popover.Title>
          <Popover.Close render={<Button type="button" size="sm" variant="ghost" className="h-6 shrink-0 px-2 text-xs" />}>关闭</Popover.Close>
        </div>
        <Popover.Description className="whitespace-pre-wrap break-words text-sm leading-relaxed">{description}</Popover.Description>
        <p className="break-words text-xs text-muted-foreground">{item.storage === 'account' ? '账号收藏' : '额外存储'}{item.dimensions ? ` · ${item.dimensions.width} × ${item.dimensions.height}` : ''}</p>
        {item.tags.length > 0 && <p className="break-words text-xs leading-relaxed">标签：{item.tags.join(' · ')}</p>}
        <StickerMetadata item={item} />
        {item.avoid && <p className="break-words text-xs text-muted-foreground">慎用：{item.avoid}</p>}
        <div className="flex justify-end border-t pt-2"><Button type="button" size="sm" variant="outline" disabled={!canEditRole} onClick={() => onEditRole(item)}>标角色</Button></div>
      </Popover.Popup>
    </Popover.Positioner></Popover.Portal>
  </Popover.Root>
}

// Bound unusually long or wide images without cropping their actual content.
const previewRatio = (dimensions: StickerImageDimensions | undefined): number => dimensions
  ? Math.max(1 / 3, Math.min(3, dimensions.width / dimensions.height)) : 1
const stickerKey = (item: StickerLibraryItem): string => item.id

function StickerPreview({ api, item, context, knownDimensions, onDimensions, refreshEpoch }: { readonly api: ApiClient; readonly item: StickerLibraryItem;
  readonly context: VirtualMasonryItemContext; readonly knownDimensions?: StickerImageDimensions;
  readonly onDimensions: (id: string, dimensions: StickerImageDimensions) => void; readonly refreshEpoch: number }) {
  const root = useRef<HTMLDivElement>(null)
  const [nearViewport, setNearViewport] = useState(false)
  const key = `${item.id}:${item.revision}`
  const [loaded, setLoaded] = useState<{ readonly key: string; readonly value: StickerLibraryThumbnail | null }>(() => ({ key, value: peekStickerPreview(api, item.id, item.revision) }))
  const [failed, setFailed] = useState(false)
  const preview = loaded.key === key ? loaded.value : peekStickerPreview(api, item.id, item.revision)
  const dimensions = item.dimensions ?? knownDimensions ?? (preview?.width && preview.height ? { width: preview.width, height: preview.height } : undefined)
  useEffect(() => {
    const element = root.current
    if (!element || !context.active) { setNearViewport(false); return }
    const observer = new IntersectionObserver(entries => setNearViewport(entries[0]?.isIntersecting ?? false),
      { root: context.viewport, rootMargin: '240px 0px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [context.active, context.viewport])
  useEffect(() => {
    if (!nearViewport || !context.active || item.state !== 'ready') return
    const controller = new AbortController()
    setFailed(false)
    void readStickerPreview(api, item.id, item.revision, controller.signal).then(value => {
      if (controller.signal.aborted) return
      setLoaded({ key, value }); setFailed(value === null)
      if (value?.width && value.height) onDimensions(item.id, { width: value.width, height: value.height })
    })
    return () => controller.abort()
  }, [api, item.id, item.revision, item.state, key, nearViewport, context.active, onDimensions, refreshEpoch])
  return <div ref={root} className="flex w-full items-center justify-center overflow-hidden rounded-md bg-muted/40" style={{ aspectRatio: previewRatio(dimensions) }}>
    {preview && item.state === 'ready' ? <img src={preview.image} alt={item.description || item.name || '表情预览'} loading="lazy" decoding="async" className="h-full w-full object-contain" />
      : <span className="px-2 text-center text-xs text-muted-foreground">{item.state === 'unknown' ? '等待核对' : failed ? '预览暂不可用' : nearViewport ? '正在载入…' : '表情预览'}</span>}
  </div>
}

export function StickersPage(props: PageProps) {
  if (!props.connected) return <ConnectPrompt connect={props.connect} />
  return <ConnectedStickersPage key={clientId(props.api)} {...props} />
}

function ConnectedStickersPage({ api, connected, setDirty }: PageProps) {
  // The fresh reader owns this mount, so a reconnect does not reveal a cached account snapshot.
  const reader = useMemo<ApiClient>(() => ({ get: (path, signal) => api.get(path, signal), post: (path, body, signal) => api.post(path, body, signal) }), [api])
  const resource = useReadResource(reader, '/api/chat/stickers/library', connected, parseStickerLibrarySnapshot)
  const [filter, setFilter] = useState('all'), [query, setQuery] = useState('')
  const [previewEpoch, setPreviewEpoch] = useState(0)
  const [detailsId, setDetailsId] = useState<string | null>(null)
  const learnedDimensions = useRef(new Map<string, StickerImageDimensions>())
  const [character, setCharacter] = useState('all'), [identitySource, setIdentitySource] = useState('all')
  const [deleting, setDeleting] = useState<StickerLibraryItem | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const [editing, setEditing] = useState<StickerLibraryItem | null>(null)
  const [, updateLocks] = useState(0)
  const request = useRef<AbortController | null>(null)
  const dialogFrame = useRef<number | null>(null)
  const locks = deletionLocks(api)
  const onDimensions = useCallback((id: string, dimensions: StickerImageDimensions) => {
    learnedDimensions.current.delete(id); learnedDimensions.current.set(id, dimensions)
    if (learnedDimensions.current.size > 7000) learnedDimensions.current.delete(learnedDimensions.current.keys().next().value!)
  }, [])
  const onDetailsChange = useCallback((id: string, open: boolean) => {
    if (open && (deleting || editing || dialogFrame.current !== null)) return
    setDetailsId(current => open ? id : current === id ? null : current)
  }, [deleting, editing])
  const showItemDialog = useCallback((item: StickerLibraryItem, kind: 'identity' | 'delete') => {
    if (busy || deleting || editing || dialogFrame.current !== null) return
    setDetailsId(null)
    // Let the nonmodal popup close before the modal dialog takes focus.
    dialogFrame.current = requestAnimationFrame(() => {
      dialogFrame.current = null
      if (kind === 'identity') setEditing(item)
      else setDeleting(item)
    })
  }, [busy, deleting, editing])
  const editRole = useCallback((item: StickerLibraryItem) => showItemDialog(item, 'identity'), [showItemDialog])
  useEffect(() => () => { request.current?.abort(); if (dialogFrame.current !== null) cancelAnimationFrame(dialogFrame.current) }, [])
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
  const characters = useMemo(() => {
    const names = new Map<string, string>()
    for (const item of resource.snapshot?.items ?? []) if (item.identity) names.set(searchText(item.identity.character), item.identity.character)
    return [...names].sort((left, right) => left[1].localeCompare(right[1], 'zh-CN'))
  }, [resource.snapshot])
  const searchEntries = useMemo(() => (resource.snapshot?.items ?? []).map(item => ({ item, text: metadataSearchText(item) })), [resource.snapshot])
  const items = useMemo(() => {
    const terms = searchText(query).split(' ').filter(Boolean).slice(0, 16)
    return searchEntries.filter(({ item, text }) => {
      if (filter !== 'all' && item.storage !== filter
        || character !== 'all' && (character === 'unknown' ? !!item.identity : !item.identity || `role:${searchText(item.identity.character)}` !== character)
        || identitySource !== 'all' && (item.identity?.source ?? 'unknown') !== identitySource) return false
      return terms.every(term => text.includes(term))
    }).map(({ item }) => item)
  }, [searchEntries, filter, query, character, identitySource])
  useEffect(() => { if (detailsId && !items.some(item => item.id === detailsId)) setDetailsId(null) }, [detailsId, items])
  const masonryReset = JSON.stringify([filter, query, character, identitySource])
  const estimateHeight = useCallback((item: StickerLibraryItem, _index: number, width: number) => {
    const contentWidth = Math.max(56, width - 26), perLine = Math.max(8, Math.floor(contentWidth / 7))
    const lines = (text: string) => Math.max(1, Math.ceil(text.length / perLine))
    const textHeight = Math.min(2, lines(compact(item.description || item.name || '尚未分类', 56))) * 20
      + (item.identity ? 20 : 0) + (item.tags.length ? 20 : 0)
    return contentWidth / previewRatio(item.dimensions ?? learnedDimensions.current.get(item.id)) + textHeight + 76
  }, [])
  const refresh = () => { clearFailedStickerPreviews(api); setPreviewEpoch(value => value + 1); resource.refresh() }
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
    <Section title="收藏与发送设置" description="收藏在后台筛选打标；发送可选择独立意图转换、本地匹配或DSH选图。">
      <PackageConfigurationManager api={api} connected={connected} setDirty={setDirty} onlyIds={['sticker-library', 'sticker-sending']} embedded />
    </Section>
    <Section title="已有表情" description={snapshot ? `账号${snapshot.accountCollection === 'confirmed' ? '已读取' : '上次读取'} ${snapshot.capacity.count} 张；总容量未知，达到 ${snapshot.capacity.nearFullAt} 张后新收藏转存额外库。` : '启动聊天后可查看、筛选和管理表情。'}>
      <div className="flex flex-wrap items-center gap-2">
        {([['all', '全部'], ['account', '账号收藏'], ['extra', '额外存储']] as const).map(([value, label]) => <Button key={value} size="sm" variant={filter === value ? 'default' : 'outline'} onClick={() => setFilter(value)}>{label} {value === 'all' ? snapshot?.items.length ?? 0 : snapshot?.items.filter(item => item.storage === value).length ?? 0}</Button>)}
        <Input aria-label="搜索表情角色、别名或标签" className="max-w-xs" maxLength={480} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索角色、别名、动作或标签" />
        <Button size="sm" variant="outline" disabled={resource.loading || busy} onClick={refresh}>刷新</Button>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2"><span id="sticker-character-label">角色</span><Select value={character} onValueChange={value => setCharacter(typeof value === 'string' ? value : 'all')}>
          <SelectTrigger aria-labelledby="sticker-character-label" className="max-w-52"><SelectValue>{character === 'all' ? '全部角色' : character === 'unknown' ? '未识别角色' : characters.find(([key]) => `role:${key}` === character)?.[1] ?? '原角色已不在当前列表'}</SelectValue></SelectTrigger>
          <SelectContent><SelectItem value="all">全部角色</SelectItem><SelectItem value="unknown">未识别角色</SelectItem>{characters.map(([key, name]) => <SelectItem key={key} value={`role:${key}`}>{name}</SelectItem>)}</SelectContent>
        </Select></div>
        <div className="flex min-w-0 items-center gap-2"><span id="sticker-identity-source-label">角色来源</span><Select value={identitySource} onValueChange={value => setIdentitySource(typeof value === 'string' ? value : 'all')}>
          <SelectTrigger aria-labelledby="sticker-identity-source-label"><SelectValue>{identitySource === 'all' ? '全部来源' : identitySource === 'unknown' ? '未识别' : identitySources[identitySource as keyof typeof identitySources]}</SelectValue></SelectTrigger>
          <SelectContent><SelectItem value="all">全部来源</SelectItem>{Object.entries(identitySources).map(([source, label]) => <SelectItem key={source} value={source}>{label}</SelectItem>)}<SelectItem value="unknown">未识别</SelectItem></SelectContent>
        </Select></div>
        <span>角色与来源按已有索引展示，推测不等同确认。</span>
      </div>
      {resource.error && <p role="alert" className="text-sm text-destructive">{errorMessage(resource.error)}</p>}
      {snapshot?.accountCollection === 'unavailable' && <p role="status" className="text-sm text-muted-foreground">账号收藏暂未读取成功，保留上次结果；账号删除暂不可用。</p>}
      {snapshot?.limited && <p role="status" className="text-sm text-muted-foreground">当前仅显示部分表情，账号数量与转存阈值保持实际读取结果。</p>}
      {!!snapshot?.pending && <p role="status" className="text-sm text-muted-foreground">正在处理 {snapshot.pending} 项表情任务。</p>}
      {message && <p role="status" className="text-sm">{message}</p>}
      <VirtualMasonry items={items} getItemKey={stickerKey} estimateSize={estimateHeight} resetKey={masonryReset}
        pinnedKeys={[...(deleting ? [deleting.id] : []), ...(editing ? [editing.id] : []), ...(detailsId ? [detailsId] : [])]}>
        {(item, _index, context) => <article className="grid min-w-0 content-start gap-2 rounded-lg border p-3">
          <StickerPreview api={api} item={item} context={context} knownDimensions={learnedDimensions.current.get(item.id)} onDimensions={onDimensions} refreshEpoch={previewEpoch} />
          <StickerDetails item={item} open={detailsId === item.id} onOpenChange={onDetailsChange} onEditRole={editRole}
            canEditRole={item.state === 'ready' && !locks.has(item.id) && !busy && !resource.loading && resource.error === null} />
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className="min-w-0 truncate text-xs text-muted-foreground">{item.state === 'unknown' || locks.has(item.id) ? '待核对' : item.storage === 'account' ? '账号收藏' : '额外存储'}</span>
            <div className="flex shrink-0 items-center gap-1">
              <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={item.state !== 'ready' || locks.has(item.id) || busy || resource.loading || resource.error !== null} onClick={() => editRole(item)}>标角色</Button>
              <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={!item.canDelete || locks.has(item.id) || busy || resource.loading || resource.error !== null} onClick={() => showItemDialog(item, 'delete')}>删除</Button>
            </div>
          </div>
        </article>}
      </VirtualMasonry>
      {items.length === 0 && <p className="text-sm text-muted-foreground">{resource.loading ? '正在读取…' : '没有符合条件的表情。'}</p>}
    </Section>
    <StickerCharacterEditor api={api} item={editing && (snapshot?.items.find(item => item.id === editing.id) ?? editing)}
      onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setMessage('角色已保存为用户确认。'); resource.refresh() }} />
    <Dialog open={deleting !== null} onOpenChange={open => { if (!open && !busy) setDeleting(null) }}><DialogContent><DialogHeader><DialogTitle>删除这张表情？</DialogTitle><DialogDescription>{deleting?.storage === 'account' ? '将从QQ账号收藏中删除，表情库也会同步移除。' : '将删除框架额外保存的图片。'} 删除后不会自动重新收藏。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setDeleting(null)}>取消</Button><Button variant="destructive" disabled={busy} onClick={() => void remove()}>{busy ? '正在删除…' : '删除'}</Button></DialogFooter></DialogContent></Dialog>
  </div>
}
