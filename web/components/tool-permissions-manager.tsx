import { useEffect, useMemo, useRef, useState } from 'react';
import { NATIVE_TOOL_CAPABILITY_CATALOG, NATIVE_TOOL_PERMISSION_MAX_USES, NATIVE_TOOL_PERMISSIONS_PATH, parseNativeToolPermissionInput,
  parseNativeToolPermissionsSnapshot, type NativeToolCapability } from '../../src/contracts/native-tool-permissions.ts';
import { errorMessage, type ApiClient } from '../lib/api.ts';
import { newChatApplicationId } from '../lib/chat-application.ts';
import { createDraftKey, retainedDraft, retainDraft } from '../lib/retained-drafts.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import { writeResource } from '../lib/resource-reader.ts';
import { useNativeCatalogOperation } from '../lib/use-native-catalog-operation.ts';
import { NativeCatalogRecovery } from './native-catalog-recovery.tsx';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { Field, Section, ToggleField } from './management.tsx';

interface PermissionDraft {
  readonly id: string; readonly conversationId: string; readonly capabilities: readonly NativeToolCapability[];
  readonly limits: Readonly<Record<NativeToolCapability, string>>; readonly unlimited: readonly NativeToolCapability[];
  readonly hours: string; readonly permanent: boolean;
}
const empty = (): PermissionDraft => ({ id: newChatApplicationId(), conversationId: '', capabilities: [],
  limits: Object.fromEntries(NATIVE_TOOL_CAPABILITY_CATALOG.map(item => [item.capability, '10'])) as Record<NativeToolCapability, string>, unlimited: [], hours: '24', permanent: false });
const key = createDraftKey<PermissionDraft>('tool-permissions');

export function ToolPermissionsManager({ api, connected, setDirty }: {
  readonly api: ApiClient; readonly connected: boolean; readonly setDirty: (value: boolean, scope?: string) => void;
}) {
  const initial = useMemo(() => retainedDraft(api, key) ?? empty(), [api]);
  const [draft, setDraft] = useState(initial);
  const [confirmed, setConfirmed] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const request = useRef<AbortController | null>(null);
  const draftApi = useRef(api);
  const resource = useReadResource(api, NATIVE_TOOL_PERMISSIONS_PATH, connected, parseNativeToolPermissionsSnapshot,
    { intervalMs: 5_000, pollWhen: () => !request.current });
  const recovery = useNativeCatalogOperation(api, 'tool-permissions');
  const dirty = draft.conversationId !== '' || draft.capabilities.length > 0 || draft.permanent || draft.hours !== '24'
    || Object.values(draft.limits).some(value => value !== '10') || draft.unlimited.length > 0;
  const locked = saving || recovery.blocked;
  useEffect(() => { setDirty(dirty, 'tool-permissions'); }, [dirty, setDirty]);
  useEffect(() => { if (draftApi.current === api) retainDraft(api, key, connected && dirty ? draft : null); }, [api, connected, dirty, draft]);
  useEffect(() => {
    if (draftApi.current !== api) { draftApi.current = api; setDraft(empty()); }
    setConfirmed(false); setSaving(false); setRevokeTarget(null);
    return () => request.current?.abort();
  }, [api, connected]);
  useEffect(() => () => setDirty(false, 'tool-permissions'), [setDirty]);
  useEffect(() => { if (resource.updatedAt > 0 && !resource.loading && !resource.error) recovery.review(); }, [resource.updatedAt, resource.loading, resource.error]);

  function update(patch: Partial<PermissionDraft>): void { if (!locked) { setDraft(current => ({ ...current, ...patch })); setConfirmed(false); setError(''); setNotice(''); } }
  async function commit(action: 'grant' | 'revoke', id?: string): Promise<void> {
    const snapshot = resource.snapshot;
    if (locked || request.current || !snapshot || resource.error || !connected || action === 'grant' && (!confirmed || snapshot.runtime.state === 'unknown')) return;
    let body: unknown;
    if (action === 'grant') {
      const expiresAt = draft.permanent ? null : Date.now() + Number(draft.hours) * 3_600_000;
      const grant = parseNativeToolPermissionInput({ id: draft.id, conversationId: draft.conversationId.trim(), capabilities: draft.capabilities,
        maxUses: Object.fromEntries(draft.capabilities.map(capability => [capability, draft.unlimited.includes(capability) ? null : Number(draft.limits[capability])])), expiresAt });
      if (!grant || !draft.permanent && (!/^\d+(?:\.\d+)?$/.test(draft.hours) || Number(draft.hours) <= 0 || !Number.isSafeInteger(expiresAt))) {
        setError('请填写明确会话、至少一项能力，以及每项能力的正整数次数或明确不限；有效小时数需大于0。'); return;
      }
      body = { revision: snapshot.revision, action, grant };
    } else {
      if (!id || revokeTarget !== id) return;
      body = { revision: snapshot.revision, action, id };
    }
    const controller = new AbortController(); request.current = controller;
    const token = recovery.begin(snapshot.revision, controller.signal);
    if (!token) { request.current = null; return; }
    setSaving(true); setError(''); setNotice('');
    try {
      const result = parseNativeToolPermissionsSnapshot(await writeResource(api, NATIVE_TOOL_PERMISSIONS_PATH, body, controller.signal));
      if (!result) throw new Error('invalid_tool_permissions_response');
      if (controller.signal.aborted) return;
      recovery.complete(token); setRevokeTarget(null); setConfirmed(false);
      if (action === 'grant') setDraft(empty());
      setNotice(result.runtime.state === 'applied' ? '授权配置已保存并同步到当前运行权限；实际调用仍需通过会话与资源检查。'
        : result.runtime.state === 'unknown' ? '授权配置已保存，运行同步结果未知。先读取核对，不会再次提交同一授权。' : '授权配置已保存，当前运行权限尚未确认应用。');
      resource.refresh();
    } catch (failure) { recovery.fail(token, failure); if (!controller.signal.aborted) setError(`${errorMessage(failure)} 不会自动重试授权写入。`); }
    finally { if (!controller.signal.aborted) setSaving(false); if (request.current === controller) request.current = null; }
  }

  if (!connected) return null;
  return <Section id="native-tool-permissions" title="框架工具授权" scrollable height="lg" description="独立授权选定 QQ 会话使用指定能力；不启用功能包，不执行工具，也不替代 QQ 内的逐次工具确认。">
    <div className="grid gap-4 text-xs leading-6">
      <NativeCatalogRecovery recovery={recovery} reading={resource.loading || saving} onRead={resource.refresh} onReleased={() => setError('')} />
      <div className="flex flex-wrap items-center gap-3"><span>{!resource.snapshot ? '尚未读取工具授权' : resource.snapshot.runtime.state === 'applied' ? '当前运行权限已同步' : resource.snapshot.runtime.state === 'unknown' ? '运行同步结果待核对' : resource.snapshot.runtime.state === 'not-running' ? '工具通道未运行，授权配置已保存' : '运行权限待应用'}</span><Button size="sm" variant="outline" disabled={saving} onClick={resource.refresh}>读取工具授权</Button></div>
      {resource.error && <p role="status">授权配置暂时不可读，现有草稿保留，不能据此确认权限生效。</p>}
      <div className="grid gap-3 rounded-lg border p-4" aria-label="新增框架工具授权">
        <Field label="授权 QQ 会话" description="只对这个会话生效，仍需已在消息白名单中。"><Input value={draft.conversationId} maxLength={40} placeholder="group:123456或private:123456" disabled={locked} onChange={event => update({ conversationId: event.target.value })} /></Field>
        {NATIVE_TOOL_CAPABILITY_CATALOG.map(item => <div key={item.capability} className="grid gap-2 rounded-md border p-3"><label className="flex gap-2"><input type="checkbox" checked={draft.capabilities.includes(item.capability)} disabled={locked} onChange={event => update({ capabilities: event.target.checked ? [...draft.capabilities, item.capability] : draft.capabilities.filter(capability => capability !== item.capability) })} /><strong>{item.name}</strong></label><p className="text-muted-foreground">{item.tool} · {item.capability}</p>{draft.capabilities.includes(item.capability) && <><ToggleField label={`${item.name}不限次数`} checked={draft.unlimited.includes(item.capability)} disabled={locked} onChange={unlimited => update({ unlimited: unlimited ? [...draft.unlimited, item.capability] : draft.unlimited.filter(capability => capability !== item.capability) })} /><Field label={`${item.name}最多调用次数`}><Input type="number" min={1} max={NATIVE_TOOL_PERMISSION_MAX_USES} step={1} value={draft.limits[item.capability]} disabled={locked || draft.unlimited.includes(item.capability)} onChange={event => update({ limits: { ...draft.limits, [item.capability]: event.target.value } })} /></Field></>}</div>)}
        <ToggleField label="授权不过期" checked={draft.permanent} disabled={locked} onChange={permanent => update({ permanent })} />
        {!draft.permanent && <Field label="授权有效小时数" description="从本次明确保存开始计算；到期后不再授予新调用。"><Input type="number" min={0.001} step="any" value={draft.hours} disabled={locked} onChange={event => update({ hours: event.target.value })} /></Field>}
        <label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={locked || !dirty} onChange={event => setConfirmed(event.target.checked)} />确认独立授予以上会话、能力、次数和期限</label>
        <div className="flex flex-wrap gap-2"><Button disabled={locked || !confirmed || !resource.snapshot || !!resource.error || resource.snapshot.runtime.state === 'unknown'} onClick={() => void commit('grant')}>{saving ? '正在保存…' : '创建工具授权'}</Button><Button variant="ghost" disabled={locked || !dirty} onClick={() => { setDraft(empty()); setConfirmed(false); }}>撤销授权草稿</Button></div>
      </div>
      {resource.snapshot && <div className="grid max-h-96 gap-2 overflow-auto" aria-label="已保存工具授权">{resource.snapshot.grants.length === 0 && <p>尚未配置框架工具授权。工具安装或开关不会自动授权。</p>}{resource.snapshot.grants.map(grant => <div key={grant.id} className="grid gap-2 rounded-lg border p-3"><strong>{grant.conversationId} · {grant.revokedAt !== null ? '已撤销' : grant.expiresAt !== null && grant.expiresAt <= Date.now() ? '已到期' : '已保存'}</strong><p>{grant.capabilities.map(capability => `${NATIVE_TOOL_CAPABILITY_CATALOG.find(item => item.capability === capability)?.name ?? capability}：${grant.maxUses[capability] === null ? '明确不限次数' : `最多${grant.maxUses[capability]}次`}`).join('；')}</p><p>到期：{grant.expiresAt === null ? '明确不过期' : new Date(grant.expiresAt).toLocaleString()}</p><details><summary className="cursor-pointer">授权标识与记录</summary><p className="break-all">{grant.id}</p><p>撤销后保留记录与消耗，不会恢复额度；修改会话或额度需明确新建授权。</p></details>{grant.revokedAt === null && <div className="flex flex-wrap gap-2">{revokeTarget !== grant.id ? <Button size="sm" variant="outline" disabled={locked} onClick={() => setRevokeTarget(grant.id)}>撤销此授权</Button> : <><span>确认撤销此会话的这一项授权？</span><Button size="sm" variant="destructive" disabled={locked} onClick={() => void commit('revoke', grant.id)}>确认撤销工具授权</Button><Button size="sm" variant="ghost" disabled={saving} onClick={() => setRevokeTarget(null)}>保留授权</Button></>}</div>}</div>)}</div>}
      {(error || notice) && <p role="status" className={error ? 'text-destructive' : ''}>{error || notice}</p>}
    </div>
  </Section>;
}
