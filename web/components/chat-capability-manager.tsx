import { readResource, writeResource } from '../lib/resource-reader.ts';
import { NATIVE_CONFIGURATION_REVISION_KEYS } from '../../src/contracts/native-revisions.ts';
import { useEffect, useRef, useState } from 'react';
import { Eye, RefreshCw } from 'lucide-react';
import { asRecord, errorMessage, type ApiClient } from '../lib/api.ts';
import { nativeFormMetadata } from '../lib/native-form-metadata.ts';
import { capabilityRevisions, parseCapabilityApproval, parseCapabilityPreview, parseCapabilitySnapshot, sameCapabilitySelection,
  type CapabilityPreview, type CapabilitySelection, type CapabilitySnapshot } from '../lib/chat-capability-ui.ts';
import { Field, Section, StatusPill } from './management.tsx';
import { Button } from './ui/button.tsx';

export function ChatCapabilityManager({ api, connected, planId, selection, dirty, disabled, planRevision, onSelect, onApply }: {
  readonly api: ApiClient;
  readonly connected: boolean;
  readonly planId: string;
  readonly selection: CapabilitySelection | null | undefined;
  readonly dirty: boolean;
  readonly disabled: boolean;
  readonly planRevision: string;
  onSelect(value: CapabilitySelection | null): void;
  onApply?(): void;
}) {
  const [snapshot, setSnapshot] = useState<CapabilitySnapshot | null>(null);
  const [preview, setPreview] = useState<CapabilityPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const epoch = useRef(0);
  const request = useRef<AbortController | null>(null);
  const frozen = useRef(false);
  const review = useRef<{ api: ApiClient; generation: number; snapshot: CapabilitySnapshot } | null>(null);
  const snapshotOwner = useRef<{ api: ApiClient; generation: number; snapshot: CapabilitySnapshot } | null>(null);
  const connection = useRef({ api, connected, planId, selection, dirty, disabled });
  connection.current = { api, connected, planId, selection, dirty, disabled };

  useEffect(() => {
    const generation = ++epoch.current;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    snapshotOwner.current = null;
    const current = () => !controller.signal.aborted && generation === epoch.current
      && request.current === controller && connection.current.api === api && connection.current.connected;
    setBusy(connected); setSnapshot(null); setPreview(null); setConfirmed(false); setReviewed(false); setError('');
    review.current = null;
    if (!connected) { request.current = null; return () => controller.abort(); }
    void readResource(api, '/api/chat/capabilities', controller.signal).then(value => {
      if (!current()) return;
      const next = parseCapabilitySnapshot(value);
      if (!next) throw new Error('invalid_capability_catalog');
      snapshotOwner.current = { api, generation, snapshot: next };
      setSnapshot(next);
      review.current = frozen.current ? { api, generation, snapshot: next } : null;
      setReviewed(frozen.current);
    }).catch(failure => { if (current()) setError(`${errorMessage(failure)} 已保存的设置未改变，请稍后刷新列表重试。`); })
      .finally(() => { if (current()) { setBusy(false); request.current = null; } });
    return () => { controller.abort(); epoch.current++; if (request.current === controller) request.current = null; };
  }, [api, connected, reload, planRevision]);
  useEffect(() => { setPreview(null); setConfirmed(false); }, [planId, selection, dirty]);
  useEffect(() => () => { epoch.current++; request.current?.abort(); }, []);

  const activeSaved = snapshot !== null && snapshot.activePlanId === planId && snapshot.revisions.plans === planRevision && !dirty
    && sameCapabilitySelection(snapshot.selection, selection ?? null);
  const matched = snapshot?.presets.find(preset => sameCapabilitySelection({ schema: 1, presetId: preset.presetId, revision: preset.revision }, selection));
  const drifted = selection != null && snapshot !== null && snapshot.available && !matched;
  const selectedValue = selection == null ? 'text' : matched ? `preset:${snapshot?.presets.indexOf(matched)}` : 'preserved';
  const approvalRequired = snapshot?.compositionApprovalRequired !== false;
  const workStatus = dirty || !planId ? '未保存' : !snapshot?.available ? '列表暂不可用' : drifted ? '需要重新选择' : '已保存';

  async function perform(operation: 'preview' | 'approval' | 'revoke'): Promise<void> {
    const owner = connection.current;
    if (!connected || connection.current.api !== api || !owner.connected || !snapshot || !snapshot.compositionApprovalRequired
      || snapshotOwner.current?.snapshot !== snapshot || snapshotOwner.current.api !== api || snapshotOwner.current.generation !== epoch.current
      || request.current || frozen.current || disabled || owner.disabled || owner.dirty
      || owner.planId !== planId || !sameCapabilitySelection(owner.selection, selection) || !activeSaved) return;
    if (operation === 'approval' && (!confirmed || !preview?.ready || !preview.request || !preview.targetRevision)) return;
    if (operation === 'revoke' && (!confirmed || !snapshot.approval)) return;
    const controller = new AbortController();
    const generation = epoch.current;
    request.current = controller;
    const current = () => !controller.signal.aborted && epoch.current === generation && request.current === controller
      && connection.current.api === api && connection.current.connected;
    const sameDraft = () => connection.current.planId === owner.planId && connection.current.dirty === owner.dirty
      && sameCapabilitySelection(connection.current.selection, owner.selection);
    setBusy(true); setError(''); setNotice('');
    try {
      const body = operation === 'preview' ? { revisions: snapshot.revisions }
        : operation === 'approval' ? { revisions: preview?.revisions, targetRevision: preview?.targetRevision,
          compositionRevision: preview?.request?.compositionRevision, confirm: true }
          : { revisions: snapshot.revisions, approvalId: snapshot.approval?.approvalId, confirm: true };
      const value = await writeResource(api, `/api/chat/capabilities/${operation}`, body, controller.signal);
      if (!current()) return;
      if (operation === 'preview') {
        const next = parseCapabilityPreview(value);
        if (!next || !sameCapabilitySelection(next.selection, snapshot.selection)
          || NATIVE_CONFIGURATION_REVISION_KEYS.some(key => next.revisions[key] !== snapshot.revisions[key])) throw new Error('invalid_capability_preview');
        if (sameDraft()) { setPreview(next); setConfirmed(false); setNotice(next.ready ? '检查通过，确认后请到“连接与安全”应用。' : '检查未通过，请到“连接与安全”检查后重试。'); }
      } else {
        const result = asRecord(value);
        const revisions = capabilityRevisions(result.revisions);
        const approval = result.approval === null ? null : parseCapabilityApproval(result.approval);
        if (!revisions || result.requiresNewPreview !== true || operation === 'approval' && !approval
          || operation === 'revoke' && result.approval !== null) throw new Error('invalid_capability_approval');
        if (operation === 'approval' && approval && (!sameCapabilitySelection(approval.source, preview?.request?.source)
          || approval.compositionRevision !== preview?.request?.compositionRevision
          || JSON.stringify(approval.target) !== JSON.stringify(preview?.request?.target))) throw new Error('capability_approval_mismatch');
        const next = { ...snapshot, revisions, approval };
        snapshotOwner.current = { api, generation, snapshot: next };
        setSnapshot(next);
        setPreview(null); setConfirmed(false);
        setNotice(operation === 'approval' ? '已确认，请到“连接与安全”应用。'
          : '已取消确认，正在运行的工具不受影响。');
      }
    } catch (failure) {
      if (current()) {
        frozen.current = true; setBlocked(true); setReviewed(false); setConfirmed(false); setPreview(null);
        setError(`${errorMessage(failure)} 请先刷新状态并核对，再进行新操作；不会自动重试。`);
      }
    } finally {
      if (current()) { setBusy(false); request.current = null; }
    }
  }

  if (!connected) return null;
  return <Section id={nativeFormMetadata.capabilities.id} title="聊天工具" scrollable
    description="选择聊天时可使用的工具；留空只聊天。"
    actions={<Button variant="outline" disabled={busy} onClick={() => { if (!request.current) setReload(value => value + 1); }}><RefreshCw className="size-3.5" />刷新列表</Button>}>
    <div className="grid gap-4 text-xs leading-6">
      <div aria-label="聊天工具保存状态"><StatusPill tone={dirty || drifted || !snapshot?.available ? 'warning' : 'neutral'}>{workStatus}</StatusPill></div>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {blocked && <div role="alert" className="rounded-lg border border-amber-500/30 p-3">
        <p>上次操作的结果尚未确认。请刷新列表，核对后再继续。</p>
        <Button variant="outline" disabled={!reviewed || busy} onClick={() => {
          if (!frozen.current || !reviewed || request.current || !snapshot || review.current?.snapshot !== snapshot
            || review.current.api !== api || review.current.generation !== epoch.current
            || connection.current.api !== api || !connection.current.connected) return;
          review.current = null;
          frozen.current = false; setBlocked(false); setReviewed(false); setError(''); setConfirmed(false); setPreview(null);
          setNotice('已允许新的操作，不会重复上次请求。');
        }}>我已核对，继续操作</Button>
      </div>}
      {!snapshot || !snapshot.available ? <p role="status">{busy ? '正在读取工具列表…' : '工具列表暂时无法读取，不代表没有工具。请检查连接后刷新，已保存的选择会保留。'}</p> : null}
      {drifted && <p role="alert" className="text-amber-700 dark:text-amber-400">原工具组合已变化或无法找到。已保留原选择，请核对后重新选择。</p>}
      <Field label="工具组合" description="更改后，点击上方“保存聊天方案”。">
        <select className="h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm" value={selectedValue}
          disabled={disabled || busy || blocked} onChange={event => {
            if (connection.current.api !== api || !connection.current.connected || !snapshot
              || snapshotOwner.current?.snapshot !== snapshot || snapshotOwner.current.generation !== epoch.current
              || connection.current.disabled || request.current || frozen.current) return;
            if (event.target.value === 'text') onSelect(null);
            else {
              const preset = snapshot?.presets[Number(event.target.value.replace('preset:', ''))];
              if (snapshot?.available && preset?.composable && preset.missingReasons.length === 0) onSelect({ schema: 1, presetId: preset.presetId, revision: preset.revision });
            }
            setPreview(null); setConfirmed(false);
          }}>
          <option value="text">仅聊天</option>
          {selection != null && !matched && <option value="preserved" disabled>保留原选择（暂时无法读取）</option>}
          {snapshot?.available && snapshot.presets.map((preset, index) => <option key={preset.presetId} value={`preset:${index}`} disabled={!preset.composable || preset.missingReasons.length !== 0}>{preset.name || '未命名工具组合'}{preset.composable && preset.missingReasons.length === 0 ? '' : '（暂不可用）'}</option>)}
        </select>
      </Field>
      {matched && <p className="text-muted-foreground">{matched.description || '此方案暂未提供用途说明。'}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-muted-foreground">保存后，到“连接与安全”应用。</p>
        {onApply && <Button disabled={dirty || busy || disabled || blocked} onClick={onApply}>去连接与安全应用</Button>}
      </div>
      <p className="text-muted-foreground">选择聊天工具不会授予独立工作权限。</p>
      <details className="rounded-lg border bg-muted/20 p-3">
        <summary className="cursor-pointer text-xs text-muted-foreground">高级设置</summary>
        <div className="mt-3 grid max-h-64 gap-3 overflow-auto overscroll-contain">
      {snapshot && approvalRequired && (selection != null || snapshot.approval) && <>
        <p className="font-medium">兼容旧授权设置</p>
        {!activeSaved && <p className="text-muted-foreground">请先保存并启用当前聊天方案，再检查工具设置。</p>}
        {selection == null && snapshot?.approval && <p className="text-muted-foreground">原确认记录仍保留，不再使用时可取消确认。</p>}
        <Button variant="outline" disabled={!activeSaved || busy || blocked || disabled} onClick={() => void perform('preview')}><Eye className="size-3.5" />检查方案</Button>
        {preview && <div className="grid gap-2 rounded-lg border p-3">
          <p>{preview.ready ? '检查通过，可以确认使用。' : '检查未通过，请核对方案设置。'}{preview.approvalMatchesPreview ? '已确认方案与本次检查一致。' : ''}</p>
          {preview.routes.map((route, index) => <p key={`${route.conversationKind}-${index}`}>{route.conversationKind === 'group' ? '群聊' : '私聊'}设置 · 上下文 {route.contextWindow.toLocaleString()} token</p>)}
        </div>}
        <label className="flex items-start gap-2"><input type="checkbox" className="mt-1.5" checked={confirmed} disabled={!activeSaved || busy || blocked || disabled} onChange={event => setConfirmed(event.target.checked)} /><span className="field-label">我确认使用这个工具组合</span></label>
        <div className="flex flex-wrap gap-2"><Button disabled={!activeSaved || !preview?.ready || !preview.request || !confirmed || busy || blocked || disabled} onClick={() => void perform('approval')}>确认使用</Button><Button variant="outline" disabled={!activeSaved || !snapshot?.approval || !confirmed || busy || blocked || disabled} onClick={() => void perform('revoke')}>取消确认</Button></div>
      </>}
          <p className="font-medium">固定版本</p>
          <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all text-[10px]">{selection == null ? (approvalRequired ? '纯文本；缺省和显式 null 在原方案中保持原语义。' : '未附加额外工具方案；缺省和显式 null 保持原语义，不表示已卸载既有工具。') : `${selection.presetId}\n${selection.revision}`}</pre>
          {matched && <p>声明 {matched.packages.length} 个包，不代表挂载或授权。</p>}
          <div className="flex flex-wrap gap-2"><StatusPill tone={approvalRequired && !snapshot?.approval ? 'warning' : 'neutral'}>{!snapshot ? '确认状态暂不可用' : approvalRequired ? (snapshot.approval ? '组合批准已保存（不代表已应用）' : '没有保存的组合批准') : (snapshot.approval ? '保留历史组合记录（只读）' : '当前模式不要求额外组合批准')}</StatusPill><StatusPill tone="warning">外部工具授权未由桥核验</StatusPill></div>
          <p>保存、确认或取消确认都不会自动应用、重启服务或改变外部工具权限。实际可用工具仍由 DSH 运行检查决定。</p>
          {approvalRequired && <p>旧次数模式仍需有效的模型提交与工具委派许可，重启不会补额。</p>}
          {!approvalRequired && snapshot?.approval && <><p className="font-medium">历史组合记录（只读）</p><pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all text-[10px]">{JSON.stringify(snapshot.approval, null, 2)}</pre></>}
          {preview?.request && <><p className="font-medium">组合版本与文件目标</p><pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all text-[10px]">{JSON.stringify(preview.request, null, 2)}</pre></>}
        </div>
      </details>
    </div>
  </Section>;
}
