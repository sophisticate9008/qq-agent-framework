import { createDraftKey, retainDraft, retainedDraft } from '../lib/retained-drafts.ts';
import { useNativeCatalogOperation } from '../lib/use-native-catalog-operation.ts';
import { readResource, writeResource } from '../lib/resource-reader.ts';
import { nativeFormMetadata } from '../lib/native-form-metadata.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { errorMessage, type ApiClient } from '../lib/api.ts';
import { newChatConfigurationId, parseChatAuthorization, type ChatAuthorization } from '../lib/chat-runtime.ts';
import { authorizationDrafts as drafts, authorizationValues as values, type GrantDraft } from '../lib/chat-authorization-draft.ts';
import { authorizationMode, canEditCountedAuthorization, countedAuthorizationRequest, whitelistAuthorizationRequest } from '../lib/chat-authorization-mode.ts';
import { Field, Section } from './management.tsx';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { VirtualList } from './virtual-list.tsx';

const authorizationDraftKey = createDraftKey<{ readonly saved: ChatAuthorization; readonly entries: GrantDraft[] }>('chat-authorization');

export function ChatAuthorizationManager({ api, connected, setDirty }: {
  readonly api: ApiClient; readonly connected: boolean; setDirty(value: boolean, scope?: string): void;
}) {
  const recovery = useNativeCatalogOperation(api, 'authorization');
  const retained = useMemo(() => retainedDraft(api, authorizationDraftKey), [api]);
  const draftApi = useRef(api);
  const [saved, setSaved] = useState<ChatAuthorization | null>(retained?.saved ?? null);
  const [entries, setEntries] = useState<GrantDraft[]>(retained?.entries ?? []);
  const [changed, setChanged] = useState(retained !== undefined);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [localBlocked, setBlocked] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [migrationConfirmed, setMigrationConfirmed] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [legacyExpanded, setLegacyExpanded] = useState(false);
  const request = useRef<{ api: ApiClient; controller: AbortController } | null>(null);
  const recoveries = useRef(new Map<ApiClient, { document: ChatAuthorization | null; generation: number }>());
  const documentOwner = useRef<{ api: ApiClient; generation: number; document: ChatAuthorization } | null>(null);
  const migrationTarget = useRef<{ api: ApiClient; generation: number; document: ChatAuthorization; confirmed: boolean } | null>(null);
  const epoch = useRef(0);
  const connection = useRef({ api, connected });
  connection.current = { api, connected };
  const blocked = localBlocked || recovery.blocked;
  const view = useRef({ api, saved, entries, changed, confirmed, busy, blocked });
  view.current = { api: draftApi.current, saved, entries, changed, confirmed, busy, blocked };
  useEffect(() => {
    if (draftApi.current !== api) return;
    retainDraft(api, authorizationDraftKey, connected && changed && saved ? { saved, entries } : null);
  }, [api, connected, changed, saved, entries]);
  const dirtyCallback = useRef(setDirty);
  useEffect(() => { dirtyCallback.current = setDirty; }, [setDirty]);
  useEffect(() => { setDirty(changed, 'chat-authorization'); }, [changed, setDirty]);
  useEffect(() => () => { epoch.current++; request.current?.controller.abort(); dirtyCallback.current(false, 'chat-authorization'); }, []);
  useEffect(() => { setLegacyExpanded(false); }, [api, connected]);
  useEffect(() => {
    const generation = ++epoch.current;
    const controller = new AbortController();
    documentOwner.current = null;
    migrationTarget.current = null;
    const current = () => !controller.signal.aborted && generation === epoch.current
      && connection.current.api === api && connection.current.connected;
    const prior = view.current.api === api ? view.current : null;
    draftApi.current = api;
    const preserveDraft = prior?.changed === true;
    if (!prior || !connected) setSaved(null);
    if (!preserveDraft) setChanged(false);
    setConfirmed(false);
    setMigrationOpen(false);
    setMigrationConfirmed(false);
    setReviewed(false);
    setError('');
    setNotice('');
    setBlocked(recoveries.current.has(api));
    setBusy(connected);
    if (!connected) return () => controller.abort();
    void readResource(api, '/api/chat/authorization', controller.signal).then(value => {
      if (!current()) return;
      const next = parseChatAuthorization(value);
      if (!next) throw new Error('invalid_chat_authorization');
      documentOwner.current = { api, generation, document: next };
      setSaved(next); if (!preserveDraft) setEntries(drafts(next.grants));
      recovery.review();
      if (recoveries.current.has(api) || recovery.store.getSnapshot().authorization?.phase === 'blocked') {
        recoveries.current.set(api, { document: next, generation });
        setReviewed(true);
      }
    }).catch(failure => { if (current()) setError(errorMessage(failure)); })
      .finally(() => { if (current()) setBusy(false); });
    return () => {
      controller.abort(); epoch.current++;
      const pending = request.current;
      if (pending) {
        recoveries.current.set(pending.api, { document: null, generation: -1 });
        pending.controller.abort();
        if (request.current === pending) request.current = null;
      }
    };
  }, [api, connected, reload]);

  function currentDocument(document: ChatAuthorization): boolean {
    const owner = documentOwner.current;
    return connection.current.api === api && connection.current.connected
      && owner?.api === api && owner.generation === epoch.current && owner.document === document;
  }

  function available(document: ChatAuthorization): boolean {
    return currentDocument(document) && !view.current.busy && !view.current.blocked
      && !recoveries.current.has(api) && !request.current;
  }

  function changeEntries(next: GrantDraft[]): void {
    if (!saved || !available(saved) || migrationTarget.current || !canEditCountedAuthorization(saved)) return;
    view.current.entries = next; view.current.changed = true; view.current.confirmed = false;
    setEntries(next); setChanged(true); setConfirmed(false); setError(''); setNotice('');
  }

  function update(key: string, patch: Partial<GrantDraft>): void {
    changeEntries(view.current.entries.map(entry => entry.key === key ? { ...entry, ...patch } : entry));
  }

  async function save(): Promise<void> {
    if (!saved || !available(saved) || migrationTarget.current || !view.current.changed || !view.current.confirmed) return;
    const grants = values(view.current.entries);
    if (!grants) { setError('请检查号码、重复会话、有效期和次数。次数必须为 0–1000000 的整数。'); return; }
    if (grants.some(grant => grant.expiresAt !== null && grant.expiresAt <= Date.now())) {
      setError('新授权的有效期必须晚于当前时间；也可以留空。'); return;
    }
    const body = countedAuthorizationRequest(saved, newChatConfigurationId(), grants);
    if (body) await write(saved, body, false);
  }

  async function write(document: ChatAuthorization, body: NonNullable<ReturnType<typeof countedAuthorizationRequest>> | NonNullable<ReturnType<typeof whitelistAuthorizationRequest>>, migration: boolean): Promise<void> {
    if (!available(document)) return;
    const controller = new AbortController();
    const generation = epoch.current;
    const operation = { api, controller };
    request.current = operation;
    const operationToken = recovery.begin(document.revision, controller.signal);
    if (!operationToken) { request.current = null; return; }
    view.current.busy = true; view.current.confirmed = false;
    migrationTarget.current = null;
    setMigrationOpen(false); setMigrationConfirmed(false); setConfirmed(false);
    const current = () => !controller.signal.aborted && generation === epoch.current
      && request.current === operation && connection.current.api === api && connection.current.connected;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await writeResource(api, '/api/chat/authorization', body, controller.signal);
      if (!current()) return;
      const next = parseChatAuthorization(response);
      if (!next || next.version !== body.version
        || (migration ? authorizationMode(next) !== 'whitelist' : next.mode === 'whitelist' || body.mode === 'counted' && next.mode !== 'counted')) throw new Error('invalid_chat_authorization');
      documentOwner.current = { api, generation, document: next };
      recovery.complete(operationToken);
      setSaved(next); setEntries(drafts(next.grants)); setChanged(false);
      setNotice(migration ? '白名单模式已保存；尚未启动或重启聊天。请在连接页检查实际生效状态。'
        : '兼容授权已保存；运行中的聊天需停止后重新启动才会使用新授权。');
    } catch (failure) {
      const failureState = recovery.fail(operationToken, failure);
      if (current()) {
        if (failureState === 'idle') { setError(errorMessage(failure)); return; }
        recoveries.current.set(api, { document: null, generation: -1 });
        view.current.blocked = true;
        setError(`${errorMessage(failure)} 请重新读取核对，不会自动重复保存。`); setBlocked(true); setReviewed(false);
      }
    } finally {
      if (current()) { request.current = null; view.current.busy = false; setBusy(false); }
    }
  }

  function openMigration(): void {
    if (!saved || !available(saved) || view.current.changed || !whitelistAuthorizationRequest(saved, newChatConfigurationId())) return;
    migrationTarget.current = { api, generation: epoch.current, document: saved, confirmed: false };
    setMigrationOpen(true); setMigrationConfirmed(false);
  }

  function confirmMigration(checked: boolean): void {
    const target = migrationTarget.current;
    if (!target || target.document !== saved || target.api !== api || target.generation !== epoch.current || !available(target.document)) return;
    target.confirmed = checked; setMigrationConfirmed(checked);
  }

  async function migrate(): Promise<void> {
    const target = migrationTarget.current;
    if (!target || target.document !== saved || !target.confirmed || target.api !== api || target.generation !== epoch.current
      || !available(target.document) || view.current.changed) return;
    const body = whitelistAuthorizationRequest(target.document, newChatConfigurationId());
    if (body) await write(target.document, body, true);
  }

  function acknowledgeRecovery(): void {
    if (!saved || !currentDocument(saved) || view.current.busy || request.current) return;
    const review = recoveries.current.get(api);
    if (!review || review.generation !== epoch.current || review.document !== saved) return;
    if (recovery.block && !recovery.release()) return;
    recoveries.current.delete(api);
    view.current.blocked = false; view.current.confirmed = false;
    setBlocked(false); setReviewed(false); setConfirmed(false); setError('');
    setNotice('已允许新的管理操作；不会重复上次请求，也不表示运行中的聊天已经切换。');
  }

  function reloadAuthorization(): void {
    if (connection.current.api !== api || !connection.current.connected || view.current.busy
      || view.current.changed && !view.current.blocked || saved && !currentDocument(saved)) return;
    documentOwner.current = null; migrationTarget.current = null; view.current.busy = true;
    setBusy(true); setReload(value => value + 1);
  }

  if (!connected) return null;
  const mode = saved ? authorizationMode(saved) : 'unconfirmed';
  const editingDisabled = busy || blocked || migrationOpen || !saved || !canEditCountedAuthorization(saved);
  const canMigrate = saved !== null && mode === 'counted';
  const legacyEditor = saved && canEditCountedAuthorization(saved) ? <Section id={nativeFormMetadata.authorization.id} title={nativeFormMetadata.authorization.title} description="高级兼容配置：这些是旧模式的每会话限制，不是普通 MCP、技能或独立工作委派的开关。上限不代表剩余次数，重启不补额。" scrollable
    actions={<Button variant="outline" size="sm" disabled={busy || changed && !blocked} onClick={reloadAuthorization}><RefreshCw className="size-3.5" />重新读取</Button>}
    footer={<><span className="mr-auto text-xs text-muted-foreground" role="status">{changed ? '保存会创建新一轮兼容授权，请明确确认。' : `${saved.grants.length} 个会话保留旧授权；显示上限，不是剩余次数。`}</span><Button variant="outline" disabled={!changed || editingDisabled} onClick={() => { if (!available(saved) || migrationTarget.current) return; view.current.changed = false; view.current.confirmed = false; setEntries(drafts(saved.grants)); setChanged(false); setConfirmed(false); }}>撤销更改</Button><Button disabled={!changed || !confirmed || editingDisabled} onClick={() => void save()}>{busy ? '正在处理' : '保存新授权'}</Button></>}>
    {!saved ? <p role="status" className="text-xs text-muted-foreground">{busy ? '正在读取消息授权' : '无法读取消息授权，请重试。'}</p> : <>
      <VirtualList items={entries} getItemKey={entry => entry.key} estimateSize={260}>{entry => <div className="mb-4 rounded-lg border p-3">
        <div className="grid grid-cols-[7rem_minmax(0,1fr)_auto] items-end gap-2"><Field label={nativeFormMetadata.authorization.fields.kind}><select className="h-9 rounded-md border bg-background px-2 text-xs" value={entry.kind} disabled={editingDisabled} onChange={event => update(entry.key, { kind: event.target.value === 'group' ? 'group' : 'private' })}><option value="group">群聊</option><option value="private">私聊</option></select></Field><Field label={entry.kind === 'group' ? nativeFormMetadata.authorization.fields.group : nativeFormMetadata.authorization.fields.private}><Input value={entry.account} inputMode="numeric" disabled={editingDisabled} onChange={event => update(entry.key, { account: event.target.value })} /></Field><Button variant="ghost" size="icon" disabled={editingDisabled} aria-label={`移除${entry.account || '未填写'}授权`} onClick={() => changeEntries(view.current.entries.filter(item => item.key !== entry.key))}><Trash2 className="size-4" /></Button></div>
        <div className="mt-3 grid gap-3 sm:grid-cols-3"><Field label={nativeFormMetadata.authorization.fields.submitUses}><Input type="number" min={0} max={1_000_000} value={entry.submitUses} disabled={editingDisabled} onChange={event => update(entry.key, { submitUses: event.target.value })} /></Field><Field label={nativeFormMetadata.authorization.fields.sendUses}><Input type="number" min={0} max={1_000_000} value={entry.sendUses} disabled={editingDisabled} onChange={event => update(entry.key, { sendUses: event.target.value })} /></Field><Field label={nativeFormMetadata.authorization.fields.expires}><Input type="datetime-local" value={entry.expires} disabled={editingDisabled} onChange={event => update(entry.key, { expires: event.target.value })} /></Field></div>
        <div className="mt-3"><Field label="合并转发次数" description="独立的合并转发授权次数，0 为不授权；转发仍同时消耗普通发送额度。"><Input type="number" min={0} max={1_000_000} value={entry.forwardUses ?? '0'} disabled={editingDisabled} onChange={event => update(entry.key, { forwardUses: event.target.value })} /></Field></div>
        {saved.cancelAvailable === true && <div className="mt-3"><Field label={nativeFormMetadata.authorization.fields.cancelUses} description="旧模式的有限停止尝试；请求受理不等于模型已停止。"><Input type="number" min={0} max={1_000_000} value={entry.cancelUses ?? '0'} disabled={editingDisabled} onChange={event => update(entry.key, { cancelUses: event.target.value })} /></Field></div>}
        {saved.toolDelegationAvailable === true ? <div className="mt-3 grid gap-2 rounded-md border p-3">
          <label className="flex items-start gap-2 text-xs leading-6"><input type="checkbox" className="mt-1.5" checked={entry.toolDelegationUses !== undefined} disabled={editingDisabled} onChange={event => update(entry.key, { toolDelegationUses: event.target.checked ? '0' : undefined })} /><span><span className="field-label">{nativeFormMetadata.authorization.fields.toolDelegationEnabled}</span>（旧模式兼容项，不自动新增额度）</span></label>
          {entry.toolDelegationUses !== undefined && <Field label={nativeFormMetadata.authorization.fields.toolDelegationUses} description="旧模式按轮提交给含工具的 DSH 会话的尝试上限，不是逐次工具调用，也不是独立工作委派许可。"><Input type="number" min={0} max={1_000_000} value={entry.toolDelegationUses} disabled={editingDisabled} onChange={event => update(entry.key, { toolDelegationUses: event.target.value })} /></Field>}
          <p className="text-xs leading-6 text-muted-foreground">此兼容限制不是普通 MCP、技能的启用开关。外部权限仍由外部系统管理，未由桥核验；已观察的工具范围不证明具体动作已获授权。</p>
        </div> : entry.toolDelegationUses !== undefined && <p className="mt-3 text-xs text-muted-foreground">当前服务未声明支持工具委派编辑；已保存委派字段只读保留，不自动升级或删除。</p>}
      </div>}</VirtualList>
      <Button variant="outline" disabled={editingDisabled || entries.length >= 1024} onClick={() => changeEntries([...view.current.entries, { key: newChatConfigurationId(), kind: 'group', account: '', submitUses: '', sendUses: '', expires: '' }])}><Plus className="size-3.5" />添加会话授权</Button>
      {changed && <label className="mt-5 flex items-start gap-2 text-xs leading-6"><input type="checkbox" className="mt-1.5" checked={confirmed} disabled={editingDisabled} onChange={event => { if (!available(saved) || migrationTarget.current) return; view.current.confirmed = event.target.checked; setConfirmed(event.target.checked); }} /><span>我确认这些数值是新一轮旧模式授权上限，不是剩余次数；不会切换白名单模式，不授予具体外部工具动作或独立工作权限。</span></label>}
    </>}
  </Section> : null;

  return <div role="region" aria-label="访问模式" className="grid min-w-0 gap-3 text-xs leading-6">
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {notice && <p role="status" className="text-muted-foreground">{notice}</p>}
    {blocked && <div role="alert" className="grid gap-2 rounded-lg border border-amber-500/30 p-3">
      <p>上次管理操作尚未核对，写入已冻结。重新读取只核对保存的配置，不会重放请求，也不证明运行中的聊天已切换。</p>
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={reloadAuthorization}>重新读取核对</Button><Button variant="outline" disabled={busy || !reviewed} onClick={acknowledgeRecovery}>我已核对，允许新的管理操作</Button></div>
    </div>}
    {!saved ? <div className="flex flex-wrap items-center gap-3" role="status"><span>{busy ? '正在检查访问模式…' : '无法确认访问模式，不会自动开启白名单模式。'}</span>{!busy && <Button variant="outline" onClick={reloadAuthorization}>重新读取访问模式</Button>}</div>
      : mode === 'whitelist' ? <p className="text-muted-foreground">已保存白名单模式：普通聊天不要求逐会话填写次数，工具与技能仍以实际挂载和外部权限为准。保存不等于已启动或生效。</p>
        : <>
          <div className="flex flex-wrap items-center gap-3"><p className="min-w-0 flex-1">{mode === 'counted' ? '当前使用旧限制模式：聊天仍受已保存的次数与有效期限制。' : '当前服务尚未确认白名单模式支持，保留兼容配置；不会自动切换。'}</p>{canMigrate && <Button variant="outline" disabled={busy || blocked || changed || migrationOpen} onClick={openMigration}>切换到白名单模式</Button>}</div>
          {saved.migrationRequired === true && <p role="alert" className="text-amber-700 dark:text-amber-400">检测到历史授权状态但授权文件缺失，需要核对备份并明确迁移。不会自动创建新授权，也不会清除历史。</p>}
          {migrationOpen && <div className="grid gap-3 rounded-lg border border-amber-500/30 p-3">
            <p>切换后，白名单内普通聊天及已挂载工具不再受这份旧次数配置限制。服务端将保留旧授权备份和计数；不会清除会话、历史或运行记录，不会自动启动、重启或授予独立工作权限。</p>
            <label className="flex items-start gap-2"><input type="checkbox" checked={migrationConfirmed} disabled={busy || blocked} onChange={event => confirmMigration(event.target.checked)} /><span>我已核对影响，确认以新版本切换到白名单模式</span></label>
            <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => { if (!saved || !available(saved)) return; migrationTarget.current = null; setMigrationOpen(false); setMigrationConfirmed(false); }}>取消切换</Button><Button disabled={busy || blocked || !migrationConfirmed} onClick={() => void migrate()}>确认切换到白名单模式</Button></div>
          </div>}
          {legacyEditor && <details className="min-w-0 rounded-lg border" open={legacyExpanded || undefined} onToggle={event => { if (connection.current.api === api && connection.current.connected) setLegacyExpanded(event.currentTarget.open); }}><summary className="cursor-pointer px-4 py-3 text-muted-foreground">高级：旧模式授权与次数</summary>{legacyEditor}</details>}
        </>}
    {saved?.taskDelegationAvailable === false && mode !== 'whitelist' && <p className="text-muted-foreground">当前服务不提供独立工作委派；此兼容配置不代表已有工作执行器。</p>}
  </div>;
}
