import { useEffect, useRef, useState } from 'react';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { errorMessage, type ApiClient } from '../lib/api.ts';
import { newChatConfigurationId, parseChatAuthorization, type ChatAuthorization, type ChatGrant } from '../lib/chat-runtime.ts';
import { Field, Section } from './management.tsx';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { VirtualList } from './virtual-list.tsx';

interface GrantDraft {
  readonly key: string;
  readonly kind: 'group' | 'private';
  readonly account: string;
  readonly submitUses: string;
  readonly sendUses: string;
  readonly expires: string;
}

function drafts(grants: readonly ChatGrant[]): GrantDraft[] {
  return grants.map(grant => {
    const [kind, account] = grant.conversationId.split(':');
    const date = grant.expiresAt === null ? null : new Date(grant.expiresAt);
    const local = date === null ? '' : new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    return { key: newChatConfigurationId(), kind: kind === 'group' ? 'group' : 'private', account,
      submitUses: String(grant.submitUses), sendUses: String(grant.sendUses), expires: local };
  });
}

function values(entries: readonly GrantDraft[]): ChatGrant[] | null {
  const grants = entries.map(entry => ({ conversationId: `${entry.kind}:${entry.account.trim()}`,
    submitUses: /^\d+$/.test(entry.submitUses) ? Number(entry.submitUses) : -1,
    sendUses: /^\d+$/.test(entry.sendUses) ? Number(entry.sendUses) : -1,
    expiresAt: entry.expires === '' ? null : new Date(entry.expires).getTime() }));
  return parseChatAuthorization({ revision: '0'.repeat(64), version: 'draft', grants })?.grants.slice() ?? null;
}

export function ChatAuthorizationManager({ api, connected, setDirty }: {
  readonly api: ApiClient; readonly connected: boolean; setDirty(value: boolean, scope?: string): void;
}) {
  const [saved, setSaved] = useState<ChatAuthorization | null>(null);
  const [entries, setEntries] = useState<GrantDraft[]>([]);
  const [changed, setChanged] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const request = useRef<AbortController | null>(null);
  const dirtyCallback = useRef(setDirty);
  useEffect(() => { dirtyCallback.current = setDirty; }, [setDirty]);
  useEffect(() => { setDirty(changed, 'chat-authorization'); }, [changed, setDirty]);
  useEffect(() => () => { request.current?.abort(); dirtyCallback.current(false, 'chat-authorization'); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setSaved(null);
    setChanged(false);
    setConfirmed(false);
    setError('');
    setBlocked(false);
    setBusy(connected);
    if (!connected) return () => controller.abort();
    void api.get('/api/chat/authorization', controller.signal).then(value => {
      const next = parseChatAuthorization(value);
      if (!next) throw new Error('invalid_chat_authorization');
      if (!controller.signal.aborted) { setSaved(next); setEntries(drafts(next.grants)); }
    }).catch(failure => { if (!controller.signal.aborted) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => { controller.abort(); request.current?.abort(); };
  }, [api, connected, reload]);

  function update(key: string, patch: Partial<GrantDraft>): void {
    setEntries(current => current.map(entry => entry.key === key ? { ...entry, ...patch } : entry));
    setChanged(true); setConfirmed(false); setError(''); setNotice('');
  }

  async function save(): Promise<void> {
    if (!saved || !changed || !confirmed || busy || blocked || request.current) return;
    const grants = values(entries);
    if (!grants) { setError('请检查号码、重复会话、有效期和次数。次数必须为 0–1000000 的整数。'); return; }
    if (grants.some(grant => grant.expiresAt !== null && grant.expiresAt <= Date.now())) {
      setError('新授权的有效期必须晚于当前时间；也可以留空。'); return;
    }
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(''); setNotice('');
    try {
      const next = parseChatAuthorization(await api.post('/api/chat/authorization', {
        revision: saved.revision, version: newChatConfigurationId(), grants,
      }, controller.signal));
      if (!next) throw new Error('invalid_chat_authorization');
      if (!controller.signal.aborted) {
        setSaved(next); setEntries(drafts(next.grants)); setChanged(false); setConfirmed(false);
        setNotice('授权已保存；运行中的聊天需停止后重新启动才会使用新授权。');
      }
    } catch (failure) {
      if (!controller.signal.aborted) { setError(`${errorMessage(failure)} 请重新读取核对，不会自动重复保存。`); setBlocked(true); }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (request.current === controller) request.current = null;
    }
  }

  if (!connected) return null;
  return <Section id="chat-authorization" title="消息处理授权" description="允许名单决定谁能进入；这里决定可调用模型和发送消息的次数。额度不会因重启自动补充。" scrollable
    actions={<Button variant="outline" size="sm" disabled={busy || changed && !blocked} onClick={() => setReload(value => value + 1)}><RefreshCw className="size-3.5" />重新读取</Button>}
    footer={<><span className="mr-auto text-xs text-muted-foreground" role="status">{notice || (changed ? '保存会创建新一轮授权，请明确确认。' : `${saved?.grants.length ?? 0} 个会话已设置授权；显示的是授权上限，不是剩余次数。`)}</span><Button variant="outline" disabled={!saved || !changed || busy} onClick={() => { setEntries(drafts(saved?.grants ?? [])); setChanged(false); setConfirmed(false); }}>撤销更改</Button><Button disabled={!saved || !changed || !confirmed || busy || blocked} onClick={() => void save()}>{busy ? '正在处理' : '保存新授权'}</Button></>}>
    {error && <p role="alert" className="mb-4 text-xs leading-6 text-destructive">{error}</p>}
    {!saved ? <p role="status" className="text-xs text-muted-foreground">{busy ? '正在读取消息授权' : '无法读取消息授权，请重试。'}</p> : <>
      <VirtualList items={entries} getItemKey={entry => entry.key} estimateSize={260}>{entry => <div className="mb-4 rounded-lg border p-3">
        <div className="grid grid-cols-[7rem_minmax(0,1fr)_auto] items-end gap-2"><Field label="会话类型"><select className="h-9 rounded-md border bg-background px-2 text-xs" value={entry.kind} disabled={busy || blocked} onChange={event => update(entry.key, { kind: event.target.value === 'group' ? 'group' : 'private' })}><option value="group">群聊</option><option value="private">私聊</option></select></Field><Field label={entry.kind === 'group' ? '群号' : '用户号'}><Input value={entry.account} inputMode="numeric" disabled={busy || blocked} onChange={event => update(entry.key, { account: event.target.value })} /></Field><Button variant="ghost" size="icon" disabled={busy || blocked} aria-label={`移除${entry.account || '未填写'}授权`} onClick={() => { setEntries(current => current.filter(item => item.key !== entry.key)); setChanged(true); setConfirmed(false); }}><Trash2 className="size-4" /></Button></div>
        <div className="mt-3 grid gap-3 sm:grid-cols-3"><Field label="模型提交次数"><Input type="number" min={0} max={1_000_000} value={entry.submitUses} disabled={busy || blocked} onChange={event => update(entry.key, { submitUses: event.target.value })} /></Field><Field label="回复发送次数"><Input type="number" min={0} max={1_000_000} value={entry.sendUses} disabled={busy || blocked} onChange={event => update(entry.key, { sendUses: event.target.value })} /></Field><Field label="有效期（可选）"><Input type="datetime-local" value={entry.expires} disabled={busy || blocked} onChange={event => update(entry.key, { expires: event.target.value })} /></Field></div>
      </div>}</VirtualList>
      <Button variant="outline" disabled={busy || blocked || entries.length >= 1024} onClick={() => { setEntries(current => [...current, { key: newChatConfigurationId(), kind: 'group', account: '', submitUses: '', sendUses: '', expires: '' }]); setChanged(true); setConfirmed(false); }}><Plus className="size-3.5" />添加会话授权</Button>
      {changed && <label className="mt-5 flex items-start gap-2 text-xs leading-6"><input type="checkbox" className="mt-1.5" checked={confirmed} disabled={busy || blocked} onChange={event => setConfirmed(event.target.checked)} /><span>我确认这些数值是新一轮授权上限，不是剩余次数；保存并应用将明确授予新的处理和发送次数。</span></label>}
    </>}
  </Section>;
}
