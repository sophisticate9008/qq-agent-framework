import { createDraftKey, retainDraft, retainedDraft } from '../lib/retained-drafts.ts';
import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../lib/api.ts';
import { errorMessage } from '../lib/api.ts';
import { parseChatAssistant } from '../lib/chat-assistant.ts';
import { parsePlanCatalog } from '../lib/chat-plans.ts';
import { providerReferences, type ProviderReference } from '../lib/provider-references.ts';
import { modelReasoningEffortLabel, modelCapabilitiesUnavailableMessage, parseModelCapabilities, type ModelCapabilities } from '../lib/model-capabilities.ts';
import { isChatPlanReasoningEffort } from '../../src/contracts/chat-plans.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import { useNativeCatalogOperation } from '../lib/use-native-catalog-operation.ts';
import { writeResource } from '../lib/resource-reader.ts';
import { NativeCatalogRecovery } from './native-catalog-recovery.tsx';
import { Button } from './ui/button.tsx';
import { Field } from './management.tsx';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog.tsx';

interface ProviderChoice {
  readonly id: string; readonly name: string; readonly enabled: boolean;
  readonly models: readonly { readonly id: string; readonly name: string }[];
}

/** Reference changes have their own CAS and never delete providers or apply a running configuration. */
const referenceDraftKey = createDraftKey<{ readonly providerId: string; readonly editing: ProviderReference; readonly target: string; readonly effort: string; readonly unlink: boolean }>('provider-references');

export function retainedProviderReferenceId(api: ApiClient): string | undefined { return retainedDraft(api, referenceDraftKey)?.providerId; }

export function ProviderReferenceManager({ api, connected, providerId, revision, providers, disabled, onSaved, onEditingChange, setDirty, onManageCapabilities }: {
  readonly api: ApiClient; readonly connected: boolean; readonly providerId: string; readonly revision: string;
  readonly providers: readonly ProviderChoice[]; readonly disabled: boolean; readonly onSaved?: () => void;
  readonly onEditingChange: (editing: boolean) => void;
  readonly setDirty: (dirty: boolean, scope: string) => void;
  readonly onManageCapabilities?: (provider: string, model: string, updated: (capabilities: ModelCapabilities) => void) => void;
}) {
  const plans = useReadResource(api, '/api/chat/plans', connected, parsePlanCatalog);
  const assistant = useReadResource(api, '/api/chat/assistant', connected, parseChatAssistant);
  const planRecovery = useNativeCatalogOperation(api, 'plans');
  const assistantRecovery = useNativeCatalogOperation(api, 'assistant');
  const [editing, setEditing] = useState<ProviderReference | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [target, setTarget] = useState('');
  const [effort, setEffort] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [unlink, setUnlink] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [capabilityUpdate, setCapabilityUpdate] = useState<{ readonly api: ApiClient; readonly value: ModelCapabilities } | null>(null);
  const request = useRef<AbortController | null>(null);
  const draftOwner = useRef<{ readonly api: ApiClient; readonly providerId: string } | null>(null);
  const choices = providers.filter(provider => provider.enabled).flatMap(provider => provider.models.map(model => ({
    key: JSON.stringify([provider.id, model.id]), provider: provider.id, model: model.id, label: `${provider.name} / ${model.name}`,
  })));
  const choice = choices.find(choice => choice.key === target);
  const capabilities = useReadResource(api, `/api/chat/model-capabilities?${new URLSearchParams({ provider: choice?.provider ?? '', model: choice?.model ?? '' })}`,
    connected && choice !== undefined && !unlink, parseModelCapabilities);
  const updatedCapabilities = capabilityUpdate?.api === api && capabilityUpdate.value.provider === choice?.provider
    && capabilityUpdate.value.model === choice?.model ? capabilityUpdate.value : null;
  const observedCapabilities = updatedCapabilities ?? capabilities.snapshot;
  const knownCapabilities = observedCapabilities?.provider === choice?.provider && observedCapabilities?.model === choice?.model
    && observedCapabilities?.state === 'available' && (updatedCapabilities !== null || capabilities.error === null) ? observedCapabilities : null;
  const references = providerReferences(providerId, plans.snapshot, assistant.snapshot);
  const recovery = editing?.kind === 'assistant' ? assistantRecovery : planRecovery;
  const unavailable = plans.loading || assistant.loading || plans.error !== null || assistant.error !== null
    || plans.snapshot === null || assistant.snapshot === null;
  const locked = disabled || saving || recovery.blocked;
  const draftDirty = editing !== null && (target !== '' || unlink);

  useEffect(() => { onEditingChange(editing !== null); }, [editing, onEditingChange]);
  useEffect(() => {
    if (draftOwner.current?.api === api && draftOwner.current.providerId === providerId) retainDraft(api, referenceDraftKey, draftDirty && editing ? { providerId, editing, target, effort, unlink } : null);
    setDirty(draftDirty, 'provider-references');
  }, [api, providerId, editing, target, effort, unlink, draftDirty, setDirty]);
  useEffect(() => () => { onEditingChange(false); setDirty(false, 'provider-references'); }, [onEditingChange, setDirty]);

  useEffect(() => {
    const retained = retainedDraft(api, referenceDraftKey);
    const restored = retained?.providerId === providerId ? retained : undefined;
    draftOwner.current = { api, providerId };
    setEditorOpen(restored !== undefined);
    setEditing(restored?.editing ?? null); setTarget(restored?.target ?? ''); setEffort(restored?.effort ?? ''); setConfirmed(false); setUnlink(restored?.unlink ?? false); setMessage(''); setSaving(false);
    return () => request.current?.abort();
  }, [api, providerId]);
  useEffect(() => { plans.refresh(); assistant.refresh(); }, [revision]);
  useEffect(() => { if (plans.updatedAt > 0 && !plans.error && !plans.loading) planRecovery.review(); }, [plans.updatedAt, plans.error, plans.loading]);
  useEffect(() => { if (assistant.updatedAt > 0 && !assistant.error && !assistant.loading) assistantRecovery.review(); }, [assistant.updatedAt, assistant.error, assistant.loading]);

  function edit(reference: ProviderReference): void {
    if (locked) return;
    setEditorOpen(true);
    if (editing?.kind === reference.kind && editing.id === reference.id) return;
    setEditing(reference); setTarget(''); setEffort(''); setConfirmed(false); setUnlink(false); setMessage('');
  }

  async function save(): Promise<void> {
    if (!editing || locked || !confirmed || unavailable || request.current || !plans.snapshot || !assistant.snapshot
      || !references.some(reference => reference.kind === editing.kind && reference.id === editing.id && reference.model === editing.model)) return;
    if (!unlink && (!choice || choice.provider === editing.provider && choice.model === editing.model || !knownCapabilities
      || !isChatPlanReasoningEffort(effort) || !knownCapabilities.reasoningEfforts.includes(effort))) return;
    if (unlink && editing.kind !== 'assistant') return;
    const controller = new AbortController();
    request.current = controller;
    const token = recovery.begin(editing.kind === 'plan' ? plans.snapshot.revision : assistant.snapshot.revision, controller.signal);
    if (!token) { request.current = null; return; }
    setSaving(true); setMessage('');
    try {
      if (editing.kind === 'plan') {
        if (!choice || !isChatPlanReasoningEffort(effort)) throw new Error('invalid_reference_target');
        const snapshot = plans.snapshot;
        const updated = snapshot.plans.map(plan => plan.id === editing.id ? { ...plan, provider: choice.provider, model: choice.model, reasoningEffort: effort } : plan);
        const value = await writeResource(api, '/api/chat/plans', { revision: snapshot.revision, activePlanId: snapshot.activePlanId, plans: updated }, controller.signal);
        if (!parsePlanCatalog(value)) throw new Error('invalid_reference_response');
      } else {
        const configuration = unlink ? { ...assistant.snapshot.configuration, mode: 'chat-only' as const, provider: null, model: null, reasoningEffort: null }
          : choice && isChatPlanReasoningEffort(effort) ? { ...assistant.snapshot.configuration, provider: choice.provider, model: choice.model, reasoningEffort: effort } : null;
        if (!configuration) throw new Error('invalid_reference_target');
        const value = await writeResource(api, '/api/chat/assistant', { revision: assistant.snapshot.revision, configuration }, controller.signal);
        if (!parseChatAssistant(value)) throw new Error('invalid_reference_response');
      }
      if (controller.signal.aborted) return;
      recovery.complete(token); setEditing(null); setConfirmed(false); setMessage('引用更改已保存。可读取核对后，再明确删除或调整提供方；运行中的聊天需另行应用。');
      plans.refresh(); assistant.refresh(); onSaved?.();
    } catch (error) {
      recovery.fail(token, error);
      if (!controller.signal.aborted) setMessage(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setSaving(false);
      if (request.current === controller) request.current = null;
    }
  }

  return <div className="stack"><div className="strip">方案与助手保留的模型选择都会限制删除。引用更改单独保存，运行中的聊天另行应用。</div>
    <div className="grid gap-2 text-sm leading-5">
      <NativeCatalogRecovery recovery={planRecovery} reading={plans.loading || saving} onRead={plans.refresh} onReleased={() => setMessage('')} />
      <NativeCatalogRecovery recovery={assistantRecovery} reading={assistant.loading || saving} onRead={assistant.refresh} onReleased={() => setMessage('')} />
      <Button size="sm" variant="outline" className="justify-self-start" disabled={saving} onClick={() => { plans.refresh(); assistant.refresh(); }}>重新读取引用</Button>
      {unavailable && <p role="status" className="text-muted-foreground">部分引用尚未读到，不能确认没有使用者。</p>}
      {!unavailable && references.length === 0 && <p className="text-muted-foreground">当前没有方案或助手引用此提供方。</p>}
      {references.length > 0 && <div className="tablewrap"><table><thead><tr><th>使用者</th><th>API 模型 ID</th><th>操作</th></tr></thead><tbody>{references.map(reference => <tr key={`${reference.kind}:${reference.id}`}><td>{reference.name}</td><td className="font-mono">{reference.model}</td><td><Button size="sm" variant="link" disabled={disabled || saving || (reference.kind === 'plan' ? planRecovery.blocked : assistantRecovery.blocked)} onClick={() => edit(reference)}>{editing?.kind === reference.kind && editing.id === reference.id ? '继续修改' : reference.kind === 'assistant' ? '更换或解除' : '更换模型'}</Button></td></tr>)}</tbody></table></div>}
      <Dialog open={editing !== null && editorOpen} onOpenChange={open => { if (!saving) setEditorOpen(open); }}><DialogContent showCloseButton={!saving}><DialogHeader><DialogTitle>{editing?.kind === 'assistant' ? '更换或解除助手引用' : '更换方案模型引用'}</DialogTitle><DialogDescription>保留其他配置，单独保存这项引用更改。</DialogDescription></DialogHeader>
      {editing && <div className="stack" aria-label="修改模型引用">
        <p>正在修改：{editing.name}</p>
        {editing.kind === 'assistant' && <label className="flex gap-2"><input type="checkbox" checked={unlink} disabled={locked} onChange={event => { setUnlink(event.target.checked); setConfirmed(false); }} />停用独立助手并清除其模型引用</label>}
        {!unlink && <>
          <Field label="更换到模型"><select className="h-[27px] w-full rounded-md border bg-background px-2 text-sm" value={target} disabled={locked} onChange={event => { setTarget(event.target.value); setEffort(''); setConfirmed(false); }}><option value="">选择其他提供方或模型</option>{choices.filter(choice => choice.provider !== editing.provider || choice.model !== editing.model).map(choice => <option key={choice.key} value={choice.key}>{choice.label}</option>)}</select></Field>
          <Field label="新模型思考强度" description={choice && !knownCapabilities ? '供应商能力缓存尚待核对，未知时不能保存。' : '明确选择新模型支持的档位，原方案的其他配置保持。'}><select className="h-[27px] w-full rounded-md border bg-background px-2 text-sm" value={effort} disabled={locked || !knownCapabilities} onChange={event => { setEffort(event.target.value); setConfirmed(false); }}><option value="">选择已确认支持的档位</option>{knownCapabilities?.reasoningEfforts.map(value => <option key={value} value={value}>{modelReasoningEffortLabel(value)}</option>)}</select></Field>
          {choice && !knownCapabilities && <p className="text-xs text-muted-foreground">{modelCapabilitiesUnavailableMessage(observedCapabilities?.missingReasons ?? [])}</p>}{choice && <Button size="sm" variant="outline" disabled={locked || !onManageCapabilities} onClick={() => onManageCapabilities?.(choice.provider, choice.model, value => setCapabilityUpdate({ api, value }))}>管理能力缓存</Button>}
        </>}
        <label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={locked} onChange={event => setConfirmed(event.target.checked)} />确认单独保存这项引用更改</label>
        <div className="flex flex-wrap gap-2"><Button size="sm" disabled={locked || unavailable || !confirmed || !unlink && (!choice || !knownCapabilities || !isChatPlanReasoningEffort(effort) || !knownCapabilities.reasoningEfforts.includes(effort))} onClick={() => void save()}>{saving ? '正在保存引用' : '保存引用更改'}</Button><Button size="sm" variant="ghost" disabled={saving} onClick={() => setEditing(null)}>取消修改</Button></div>
      </div>}
      {message && <p role="status" className="text-xs">{message}</p>}
      </DialogContent></Dialog>
      {message && <p role="status">{message}</p>}
    </div>
  </div>;
}
