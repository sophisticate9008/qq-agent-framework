import { useEffect, useRef, useState } from 'react';
import { NATIVE_ACCOUNTS_PATH, parseNativeAccountsSnapshot, parseNativeLegacyAdoptionPreview, type NativeLegacyAdoptionPreview } from '../../src/contracts/native-accounts.ts';
import { parseAccountScope } from '../../src/contracts/account-scope.ts';
import { useAccountWorkspace } from '../lib/account-workspace.tsx';
import { useReadResource } from '../lib/use-read-resource.ts';
import { useNativeCatalogOperation } from '../lib/use-native-catalog-operation.ts';
import { createDraftKey, retainedDraft, retainDraft } from '../lib/retained-drafts.ts';
import { writeResource } from '../lib/resource-reader.ts';
import { errorMessage } from '../lib/api.ts';
import type { PageProps } from '../lib/types.ts';
import { Field, StatusPill } from './management.tsx';
import { NativeCatalogRecovery } from './native-catalog-recovery.tsx';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
const key = createDraftKey<{ readonly label: string; readonly protocol: string; readonly account: string; readonly preview: NativeLegacyAdoptionPreview | null; readonly intent: 'create' | 'adopt-legacy' | null }>('account-management');
export function AccountManager({ connected }: Pick<PageProps, 'connected'>) {
  const workspace = useAccountWorkspace(); if (!workspace) return null;
  return <ManagedAccounts connected={connected} workspace={workspace} />;
}
function ManagedAccounts({ connected, workspace }: { readonly connected: boolean; readonly workspace: NonNullable<ReturnType<typeof useAccountWorkspace>> }) {
  const api = workspace.globalApi; const resource = useReadResource(api, NATIVE_ACCOUNTS_PATH, connected, parseNativeAccountsSnapshot);
  const recovery = useNativeCatalogOperation(api, 'accounts'); const saved = retainedDraft(api, key);
  const [label, setLabel] = useState(saved?.label ?? ''); const [protocol, setProtocol] = useState(saved?.protocol ?? 'onebot'); const [account, setAccount] = useState(saved?.account ?? '');
  const [preview, setPreview] = useState<NativeLegacyAdoptionPreview | null>(saved?.preview ?? null); const [intent, setIntent] = useState(saved?.intent ?? null);
  const [confirmed, setConfirmed] = useState(false); const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => setConfirmed(false), [resource.snapshot?.revision]);
  useEffect(() => { retainDraft(api, key, label || account || preview || intent ? { label, protocol, account, preview, intent } : null); }, [api, label, protocol, account, preview, intent]);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => { if (resource.updatedAt > 0 && resource.snapshot && !resource.error && !resource.loading) recovery.review(); }, [resource.updatedAt, resource.snapshot, resource.error, resource.loading]);
  const unresolvedAdoption = intent === 'adopt-legacy' && recovery.blocked || resource.snapshot?.accounts.some(item => item.source === 'legacy-adopted' && item.adoption === 'unknown') === true;
  const adoptionTarget = resource.snapshot?.accounts.find(item => item.source === 'legacy-adopted' && item.accountScope.protocolId === protocol && item.accountScope.accountId === account.trim());
  async function act(action: 'create' | 'preview-legacy-adoption' | 'adopt-legacy' | 'reconcile-legacy-adoption', targetId?: string): Promise<void> {
    const snapshot = resource.snapshot; const selectedTarget = snapshot?.accounts.find(item => item.id === targetId) ?? adoptionTarget; const accountScope = selectedTarget && action === 'reconcile-legacy-adoption' ? selectedTarget.accountScope : parseAccountScope({ protocolId: protocol, accountId: account.trim() });
    const reconciling = action === 'reconcile-legacy-adoption';
    if (!connected || !snapshot || !accountScope || busy || resource.loading || resource.error || !confirmed || recovery.blocked && !reconciling || reconciling && !selectedTarget) return;
    const controller = new AbortController(); const token = reconciling && recovery.blocked ? null : recovery.begin(snapshot.revision, controller.signal); if (!(reconciling && recovery.blocked) && !token) return;
    request.current = controller; setBusy(true); setConfirmed(false); setMessage('');
    if (action === 'create' || action === 'adopt-legacy') { setIntent(action); retainDraft(api, key, { label, protocol, account, preview, intent: action }); }
    try {
      const body = action === 'create' ? { action, revision: snapshot.revision, label: label.trim(), accountScope } : action === 'preview-legacy-adoption' ? { action, accountScope } : action === 'adopt-legacy' ? { action, preview, label: label.trim() } : { action, id: selectedTarget?.id, revision: snapshot.revision };
      const input = await writeResource(api, NATIVE_ACCOUNTS_PATH, body, controller.signal); if (controller.signal.aborted) return;
      if (action === 'preview-legacy-adoption') {
        const parsed = parseNativeLegacyAdoptionPreview(input); if (!parsed || parsed.accountScope.protocolId !== accountScope.protocolId || parsed.accountScope.accountId !== accountScope.accountId) throw new Error('invalid_legacy_preview');
        setPreview(parsed); setMessage('原单账号配置与持久记录预览已核验；尚未迁入账号。');
      } else {
        const parsed = parseNativeAccountsSnapshot(input); if (!parsed) throw new Error('invalid_accounts_snapshot');
        const target = parsed.accounts.find(item => item.accountScope.protocolId === accountScope.protocolId && item.accountScope.accountId === accountScope.accountId);
        if (!target || target.adoption !== 'ready' || action !== 'create' && target.source !== 'legacy-adopted') throw new Error('account_result_unconfirmed');
        if (reconciling) { const actual = parsed.accounts.find(item => item.id === selectedTarget?.id); if (actual?.adoption !== 'ready') throw new Error('account_adoption_unconfirmed'); recovery.review(); recovery.release(); }
        if (token) recovery.complete(token);
        retainDraft(api, key, null);
        if (action !== 'create') workspace.select(target);
        setPreview(null); setIntent(null); setLabel(''); setAccount(''); setMessage(action === 'create' ? '独立账号已创建，尚未启动；选择后可配置并明确应用。' : '账号采用结果已核验。旧单账号入口不再用于启动。');
      }
      if (token) recovery.complete(token); resource.refresh();
    } catch (error) { if (token) recovery.fail(token, error); if (!controller.signal.aborted) setMessage(errorMessage(error)); }
    finally { if (request.current === controller) { request.current = null; if (!controller.signal.aborted) setBusy(false); } }
  }
  const locked = busy || resource.loading || recovery.blocked;
  return <details className="rounded-xl border p-4" data-account-management><summary className="cursor-pointer text-sm font-medium">高级：独立账号与原账号采用</summary><div className="mt-4 grid gap-4 text-xs leading-6">
    <p className="text-muted-foreground">当前工作空间：{workspace.selected ? `${workspace.selected.label}（${workspace.selected.accountScope.protocolId} / ${workspace.selected.accountScope.accountId}）` : '原单账号入口'}。账号独立保存配置、授权、会话与操作证据；切换不执行启动、停止或应用。</p>
    {resource.error && <p role="status">账号目录暂不可读，当前选择保持，不按空目录覆盖。</p>}
    <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={!connected || busy || resource.loading} onClick={resource.refresh}>读取账号目录</Button>{workspace.selected && resource.snapshot?.legacy.adoptedBy === null && <Button size="sm" variant="outline" disabled={busy} onClick={() => workspace.select(null)}>切换到原单账号入口</Button>}</div>
    {resource.snapshot && <><p>原单账号状态：{resource.snapshot.legacy.adoptedBy ? '已由明确账号采用，原入口启动受限' : '隔离保留，尚未自动归属任何账号'}。</p>{resource.snapshot.accounts.map(item => <div key={item.id} className="grid gap-2 rounded-lg border p-3"><div className="flex flex-wrap gap-2"><strong>{item.label}</strong><StatusPill tone={item.state === 'running' ? 'success' : item.state === 'unknown' ? 'warning' : 'neutral'}>{item.state}</StatusPill><span>{item.accountScope.protocolId} / {item.accountScope.accountId}</span></div><p>来源：{item.source === 'legacy-adopted' ? '明确采用原单账号' : '独立创建'}；采用核验：{item.adoption}。</p>{item.missingReasons.length > 0 && <p>待处理：{item.missingReasons.join('、')}</p>}<Button size="sm" variant="outline" disabled={busy || workspace.selected?.id === item.id} onClick={() => workspace.select(item)}>{workspace.selected?.id === item.id ? '当前工作空间' : '管理此账号'}</Button>{item.source === 'legacy-adopted' && item.adoption === 'unknown' && <Button size="sm" variant="outline" disabled={busy || resource.loading || !confirmed} onClick={() => void act('reconcile-legacy-adoption', item.id)}>核对原账号采用结果</Button>}</div>)}</>}
    {!unresolvedAdoption && <NativeCatalogRecovery recovery={recovery} reading={busy || resource.loading} onRead={resource.refresh} onReleased={() => { setIntent(null); setMessage('已核对当前目录；新建或采用仍需明确确认，不会重试原写入。'); }} />}
    <div className="grid gap-3 sm:grid-cols-3"><Field label="账号显示名称"><Input value={label} disabled={locked} maxLength={80} onChange={event => { setLabel(event.target.value); setConfirmed(false); }} /></Field><Field label="接入协议"><select value={protocol} disabled={locked} className="h-9 rounded-md border bg-background px-3" onChange={event => { setProtocol(event.target.value); setPreview(null); setConfirmed(false); }}>{(resource.snapshot?.protocols ?? ['onebot']).map(id => <option key={id} value={id}>{id}</option>)}</select></Field><Field label="协议账号标识"><Input value={account} disabled={locked} maxLength={128} onChange={event => { setAccount(event.target.value); setPreview(null); setConfirmed(false); }} /></Field></div>
    <p className="text-muted-foreground">填写实际协议账号。启动时必须由协议连接核验身份；这里的名称和账号选择不授予聊天或工具权限。独立账号不会自动复制原配置。</p>
    {preview && <div className="rounded-lg border p-3"><p>采用预览：{preview.accountScope.protocolId} / {preview.accountScope.accountId}；持久库 {preview.databases.join('、') || '暂无'}。操作只采用已核验的原配置与记录，需原聊天已停止；不会恢复未知执行或补发旧结果。</p><p className="break-all text-muted-foreground">来源指纹：{preview.sourceFingerprint}</p></div>}
    <label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={busy || resource.loading} onChange={event => setConfirmed(event.target.checked)} />我已核对账号归属，明确进行本次管理操作</label>
    <div className="flex flex-wrap gap-2"><Button size="sm" disabled={locked || !confirmed || !label.trim() || !account.trim()} onClick={() => void act('create')}>创建独立账号</Button><Button size="sm" variant="outline" disabled={locked || !confirmed || !account.trim() || resource.snapshot?.legacy.adoptedBy !== null} onClick={() => void act('preview-legacy-adoption')}>预览采用原单账号</Button>{preview && <Button size="sm" variant="outline" disabled={locked || !confirmed || !label.trim()} onClick={() => void act('adopt-legacy')}>确认采用预览中的原单账号</Button>}</div>
    {unresolvedAdoption && !adoptionTarget && <p>原账号采用结果尚未确认，请只读取账号目录；没有已记录的目标时不会创建第二份采用请求。</p>}
    {message && <p role="status">{message}</p>}
  </div></details>;
}
