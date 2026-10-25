import { validateDshModelSettings } from '../../src/contracts/dsh-model-settings.ts';
import { CHAT_PLAN_REASONING_EFFORTS as efforts } from '../../src/contracts/chat-plans.ts';
import { useChatApplication } from '../lib/use-chat-application.ts';
import { parseNativeDeploymentPreparationResult, parseNativeDeploymentApplyResult } from '../../src/contracts/native-deployment.ts';
import { parsePublicDeploymentReconciliation } from '../lib/deployment-review.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import type { PageProps } from '../lib/types.ts';
import { readResource, writeResource } from '../lib/resource-reader.ts';
import { nativeFormMetadata } from '../lib/native-form-metadata.ts';
import { useEffect, useRef, useState } from 'react';
import { Check, Eye, RefreshCw, Upload } from 'lucide-react';
import { asRecord, errorMessage, type ApiClient } from '../lib/api.ts';
import { chatRuntimeReason, parseChatRuntimeStatus } from '../lib/chat-runtime.ts';
import { applyAndStartChat, chatApplicationPhaseLabels, chatApplicationStore, reconcileChatApplication } from '../lib/chat-application.ts';
import { Field, SaveBar, Section, StatusPill, ToggleField } from './management.tsx';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { Textarea } from './ui/textarea.tsx';

type Effort = typeof efforts[number];

interface DeploymentForm {
  readonly profilePath: string;
  readonly credentialsPath: string;
  readonly layerPaths: string;
  readonly namespace: string;
  readonly contextWindow: string;
  readonly maxTokens: string;
  readonly inputModalities?: readonly ('text' | 'image')[];
  readonly reasoning: boolean;
  readonly mapping: Readonly<Record<Effort, string>>;
}

interface DeploymentSnapshot { readonly revision: string; readonly form: DeploymentForm }
interface Preview { readonly revisions: Readonly<Record<string, string>>; readonly targetRevision: string | null; readonly ready: boolean; readonly reasons: readonly string[] }

function sameRevisions(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => left[key] === right[key]);
}

function parsePreview(value: unknown, revisions: Readonly<Record<string, string>>): Preview | null {
  const result = parseNativeDeploymentPreparationResult(value);
  if (!result) return null;
  return { revisions, targetRevision: result.targetRevision ?? null, ready: result.state === 'prepared',
    reasons: result.state === 'prepared' ? result.summary.missingReasons : result.missingReasons };
}

function parseDeployment(value: unknown): DeploymentSnapshot | null {
  const root = asRecord(value);
  const deployment = asRecord(root.deployment);
  const target = asRecord(deployment.target);
  let observedSettings: ReturnType<typeof validateDshModelSettings> | null;
  try { observedSettings = deployment.modelSettings === null ? null : validateDshModelSettings(deployment.modelSettings); } catch { return null; }
  const settings = asRecord(observedSettings);
  const mapping = asRecord(settings.reasoningEfforts);
  if (typeof root.revision !== 'string' || !/^[a-f0-9]{64}$/.test(root.revision)
    || typeof deployment.namespace !== 'string'
    || deployment.target !== null && (typeof target.profilePath !== 'string' || typeof target.credentialsPath !== 'string'
      || target.layerPaths !== undefined && (!Array.isArray(target.layerPaths) || target.layerPaths.some(path => typeof path !== 'string')))
  ) return null;
  return { revision: root.revision, form: {
    profilePath: typeof target.profilePath === 'string' ? target.profilePath : '',
    credentialsPath: typeof target.credentialsPath === 'string' ? target.credentialsPath : '',
    layerPaths: Array.isArray(target.layerPaths) ? target.layerPaths.join('\n') : '', namespace: deployment.namespace,
    contextWindow: settings.contextWindow === undefined ? '' : String(settings.contextWindow),
    maxTokens: settings.maxTokens === undefined ? '' : String(settings.maxTokens),
    ...(observedSettings?.inputModalities ? { inputModalities: observedSettings.inputModalities } : {}),
    reasoning: settings.reasoningEfforts !== undefined && settings.reasoningEfforts !== false,
    mapping: Object.fromEntries(efforts.map(effort => [effort, typeof mapping[effort] === 'string' ? mapping[effort] : ''])) as Record<Effort, string>,
  } };
}

function payload(form: DeploymentForm): { readonly deployment?: Record<string, unknown>; readonly error?: string } {
  const profilePath = form.profilePath.trim();
  const credentialsPath = form.credentialsPath.trim();
  const layerPaths = form.layerPaths.split('\n').map(path => path.trim()).filter(Boolean);
  if ((profilePath !== '' || credentialsPath !== '') && (!profilePath.startsWith('/') || !credentialsPath.startsWith('/'))
    || layerPaths.some(path => !path.startsWith('/')) || layerPaths.length > 16
    || new Set(layerPaths).size !== layerPaths.length) return { error: '配置与凭据都需要明确填写服务器绝对路径；基础配置每行一个路径，最多 16 个且不能重复。' };
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(form.namespace.trim())) return { error: '配置名前缀需要 1–64 个英文、数字、短横线或下划线，以英文或数字开头。' };
  const capacity = Number(form.contextWindow);
  const output = Number(form.maxTokens);
  if ((form.contextWindow !== '' || form.maxTokens !== '')
    && (!/^\d+$/.test(form.contextWindow) || !/^\d+$/.test(form.maxTokens)
      || !Number.isSafeInteger(capacity) || capacity <= 0 || capacity > 16_777_216
      || !Number.isSafeInteger(output) || output <= 0 || output >= capacity)) return { error: '模型容量和最大输出必须是正整数，最大输出小于容量；不要超过模型实际支持的范围。' };
  const reasoningEfforts = form.reasoning ? Object.fromEntries(efforts.filter(effort => effort === 'off'
    || form.mapping[effort].trim() !== '').map(effort => [effort, form.mapping[effort].trim() || null])) : false;
  if (form.reasoning && !efforts.some(effort => effort !== 'off' && form.mapping[effort].trim() !== '')) {
    return { error: '请至少填写一个实际支持的推理档位；不支持推理档位的模型请关闭此选项。' };
  }
  let modelSettings: ReturnType<typeof validateDshModelSettings> | null;
  try { modelSettings = form.contextWindow === '' ? null : validateDshModelSettings({ contextWindow: capacity, maxTokens: output, reasoningEfforts, ...(form.inputModalities ? { inputModalities: form.inputModalities } : {}) }); } catch { return { error: '已保存的模型能力尚未通过核验，请重新读取实际模型元数据。' }; }
  return { deployment: {
    target: profilePath === '' ? null : { profilePath, credentialsPath, schemaVersion: '0.2.1-rc.2', ...(layerPaths.length ? { layerPaths } : {}) },
    modelSettings,
    namespace: form.namespace.trim(),
  } };
}

export function DshDeploymentManager({ api, connected, setDirty, running = false, configurationDirty = false, configurationRevision = '', configurationDocument = 'plans', compact = false, navigate }: {
  readonly api: ApiClient; readonly connected: boolean; readonly running?: boolean; readonly compact?: boolean; readonly navigate?: PageProps['navigate'];
  readonly configurationDirty?: boolean; readonly configurationRevision?: string; readonly configurationDocument?: 'plans' | 'personas'; setDirty(value: boolean, scope?: string): void;
}) {
  const { application, state: applicationState, observationError, refresh: refreshApplication } = useChatApplication(api, connected);
  const runtimeResource = useReadResource(api, '/api/chat/runtime', connected, parseChatRuntimeStatus, { intervalMs: 5_000, pollWhen: () => !application.getSnapshot().busy });
  const [saved, setSaved] = useState<DeploymentSnapshot | null>(null);
  const [form, setForm] = useState<DeploymentForm | null>(null);
  const [localBusy, setBusy] = useState(false);
  const [localBlocked, setBlocked] = useState(false);
  const [manualReview, setManualReview] = useState<symbol | null>(null);
  const busy = localBusy || applicationState.busy;
  const blocked = localBlocked || applicationState.blocked;
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingReload, setPendingReload] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [supportedEfforts, setSupportedEfforts] = useState<readonly Effort[] | null>(null);
  const [reload, setReload] = useState(0);
  const request = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const connection = useRef({ api, connected, running, configurationDirty, configurationRevision });
  connection.current = { api, connected, running, configurationDirty, configurationRevision };
  const documentOwner = useRef<{ api: ApiClient; generation: number; snapshot: DeploymentSnapshot } | null>(null);
  const frozen = useRef({ has: (client: ApiClient) => chatApplicationStore(client).getSnapshot().blocked,
    add: (client: ApiClient) => chatApplicationStore(client).freeze('deployment') });
  const dirtyCallback = useRef(setDirty);
  const dirty = saved !== null && form !== null && JSON.stringify(saved.form) !== JSON.stringify(form);
  useEffect(() => { dirtyCallback.current = setDirty; }, [setDirty]);
  useEffect(() => {
    if (applicationState.kind === 'application' && !applicationState.blocked) setBlocked(false);
  }, [applicationState.kind, applicationState.blocked]);
  useEffect(() => { setDirty(dirty, 'dsh-deployment'); }, [dirty, setDirty]);
  useEffect(() => () => { request.current?.abort(); dirtyCallback.current(false, 'dsh-deployment'); }, []);
  useEffect(() => {
    const generation = ++epoch.current;
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && generation === epoch.current && connection.current.api === api && connection.current.connected;
    documentOwner.current = null;
    setManualReview(null);
    setSaved(null); setForm(null); setPreview(null); setSupportedEfforts(null); setError(''); setNotice(''); setBlocked(frozen.current.has(api)); setBusy(connected);
    if (!connected) return () => controller.abort();
    void readResource(api, '/api/chat/deployment', controller.signal).then(value => {
      if (!current()) return;
      const next = parseDeployment(value);
      if (!next) throw new Error('invalid_deployment');
      documentOwner.current = { api, generation, snapshot: next };
      setSaved(next); setForm(next.form);
    }).catch(failure => { if (current()) setError(errorMessage(failure)); })
      .finally(() => { if (current()) setBusy(false); });
    return () => {
      controller.abort(); epoch.current++;
      const pending = request.current;
      if (pending) { if (application.getSnapshot().kind !== 'application' || !application.getSnapshot().operationId) frozen.current.add(api); pending.abort(); if (request.current === pending) request.current = null; }
    };
  }, [api, connected, reload]);

  useEffect(() => {
    setPreview(null);
    setNotice(configurationDirty ? '当前伙伴配置未保存或尚待核对，请先保存、撤销更改或重新读取。' : '应用对象为已启用聊天方案及其关联人设，请确认已经保存并选择启用。');
    const pending = request.current;
    if (pending) {
      if (application.getSnapshot().kind !== 'application' || !application.getSnapshot().operationId) frozen.current.add(api);
      pending.abort();
      if (request.current === pending) request.current = null;
      setBusy(false); setBlocked(true);
      setError('伙伴配置已变化，先前应用操作的结果需重新核对；不会自动继续或重试。');
    }
  }, [api, configurationDirty, configurationRevision]);

  function update(patch: Partial<DeploymentForm>): void {
    if (!currentDocument() || busy || blocked || frozen.current.has(api) || request.current) return;
    setForm(current => current ? { ...current, ...patch } : current);
    setPreview(null); setSupportedEfforts(null); setError(''); setNotice('');
  }

  function currentDocument(): boolean {
    const owner = documentOwner.current;
    return saved !== null && owner?.snapshot === saved && owner.api === api && owner.generation === epoch.current
      && connection.current.api === api && connection.current.connected;
  }

  function showResult(value: unknown, operation: 'apply' | 'reconcile' = 'apply'): void {
    if (operation === 'reconcile') {
      const result = parsePublicDeploymentReconciliation(value);
      if (!result) throw new Error('invalid_deployment_reconciliation');
      const reasons = result.missingReasons;
      setPreview(null); setPendingReload(reasons.some(reason => reason === 'pending_reload'));
      setNotice(result.verified ? '当前设置已通过生效检查；不代表模型调用成功。' : '当前设置尚未通过生效检查。');
      if (reasons.length > 0) setError([...new Set(reasons.map(reason => chatRuntimeReason(reason).text))].join(' '));
      else if (!result.verified) setError('缺少已核验的实际预设与配置来源证据，不能解除应用保护。');
      return;
    }
    const result = parseNativeDeploymentApplyResult(value);
    if (!result) throw new Error('invalid_deployment_result');
    const { state, missingReasons: reasons } = result;
    setPendingReload(state === 'pending_reload' || reasons.some(reason => reason === 'pending_reload'));
    setPreview(null);
    if (state === 'blocked') {
      setNotice('本次应用未通过检查，不会自动重试。');
      setError(reasons.length > 0 ? [...new Set(reasons.map(reason => chatRuntimeReason(reason).text))].join(' ') : '应用检查尚未通过，请核对聊天设置。');
      return;
    }
    if (state === 'unknown' || state === 'conflict') {
      frozen.current.add(api); setBlocked(true);
      setError('应用结果尚未确认，请先核对是否生效；不会自动重试。');
    }
    setNotice(state === 'verified' ? '聊天设置已通过 DSH 加载与来源检查，本次设置无需重启 DSH。'
      : state === 'pending_reload' ? '聊天设置已写入，等待 DSH 加载；不会自动重启。' : '请核对本次应用结果，不会重复提交。');
    if (reasons.length > 0 && state !== 'unknown' && state !== 'conflict') setError([...new Set(reasons.map(reason => chatRuntimeReason(reason).text))].join(' '));
  }

  async function perform(operation: 'save' | 'prepare' | 'reconcile' | 'apply'): Promise<void> {
    if (!saved || !form || !currentDocument() || connection.current.configurationDirty || busy || (blocked || frozen.current.has(api)) && operation !== 'reconcile' || request.current || operation !== 'save' && dirty
      || operation === 'apply' && !preview?.ready) return;
    if (operation === 'apply' && connection.current.running) { setError('请先停止聊天，再应用引擎配置。'); return; }
    const input = payload(form);
    if (input.error) { setError(input.error); return; }
    if (application.getSnapshot().busy) return;
    const sharedOwner = operation === 'reconcile' && application.getSnapshot().blocked ? null : application.claim('manual', 'deployment');
    const controller = new AbortController();
    const generation = epoch.current;
    request.current = controller;
    const current = () => !controller.signal.aborted && generation === epoch.current && request.current === controller
      && connection.current.api === api && connection.current.connected && !connection.current.configurationDirty
      && connection.current.configurationRevision === configurationRevision;
    setBusy(true); setError(''); setNotice(''); setManualReview(null);
    try {
      if (operation === 'save') {
        const response = await writeResource(api, '/api/chat/deployment', { revision: saved.revision, ...input }, controller.signal);
        if (!current()) return;
        const next = parseDeployment(response);
        if (!next) throw new Error('invalid_deployment');
        documentOwner.current = { api, generation, snapshot: next };
        setSaved(next); setForm(next.form); setPreview(null); setNotice('应用设置已保存，尚未修改 DSH。下一步预览变更。');
      } else {
        const runtimeValue = await readResource(api, '/api/chat/runtime', controller.signal);
        if (!current()) return;
        const runtime = parseChatRuntimeStatus(runtimeValue);
        if (!runtime || runtime.revisions.deployment !== saved.revision) throw new Error('deployment_revision_changed');
        if (operation === 'apply' && (!runtime.canApplyDeployment || connection.current.running)) {
          setError('聊天处理尚未完全停止或另一项操作仍在进行，请先停止并重新检查状态。');
          return;
        }
        if (operation === 'apply' && (!preview || !sameRevisions(preview.revisions, runtime.revisions))) {
          setPreview(null); setError('设置已变化，请重新预览后再应用。'); return;
        }
        const value = await writeResource(api, `/api/chat/deployment/${operation}`, {
          revisions: operation === 'apply' ? preview?.revisions : runtime.revisions,
          ...(operation === 'apply' ? { targetRevision: preview?.targetRevision } : {}),
        }, controller.signal);
        if (!current()) return;
        const response = asRecord(value);
        if (operation === 'prepare') {
          const next = parsePreview(response, runtime.revisions);
          if (!next) throw new Error('invalid_deployment_preview');
          setPreview(next);
          setNotice(next.ready ? '预览通过：可显式应用聊天设置，不会重置会话或重启 DSH。' : '预览未通过，请核对下方提示。');
        } else {
          showResult(response, operation);
          if (operation === 'reconcile') setManualReview(application.reviewManual('deployment', response));
        }
      }
    } catch (failure) {
      if (current()) { frozen.current.add(api); setError(`${errorMessage(failure)} 请重新读取核对，不会自动重试。`); setBlocked(true); setPreview(null); }
    } finally {
      if (current()) { request.current = null; setBusy(false); }
      if (sharedOwner) application.release(sharedOwner);
    }
  }

  async function autoApply(): Promise<void> {
    if (!saved || !form || !currentDocument() || connection.current.configurationDirty || busy || blocked || frozen.current.has(api) || dirty || request.current) return;
    if (application.getSnapshot().busy) return;
    const controller = new AbortController();
    const generation = epoch.current;
    request.current = controller;
    const current = () => !controller.signal.aborted && generation === epoch.current && request.current === controller
      && connection.current.api === api && connection.current.connected && !connection.current.configurationDirty
      && connection.current.configurationRevision === configurationRevision;
    setBusy(true); setError(''); setNotice(''); setPreview(null);
    try {
      const result = await applyAndStartChat({ api, signal: controller.signal, isCurrent: current,
        expectedDeploymentRevision: saved.revision, configurationRevision, configurationDocument,
        onPhase: phase => { if (current()) setNotice(chatApplicationPhaseLabels[phase]); },
      });
      if (!current()) return;
      const deploymentValue = await readResource(api, '/api/chat/deployment', controller.signal);
      if (!current()) return;
      const next = parseDeployment(deploymentValue);
      if (!next) throw new Error('无法核对当前已保存的应用设置。');
      documentOwner.current = { api, generation, snapshot: next };
      setSaved(next); setForm(next.form); setPreview(null);
      const settings = asRecord(asRecord(asRecord(deploymentValue).deployment).modelSettings);
      const mapping = asRecord(settings.reasoningEfforts);
      setSupportedEfforts(settings.reasoningEfforts === false ? ['off'] : efforts.filter(effort => Object.hasOwn(mapping, effort)));
      if (!current()) return;
      if (result.state === 'running') { setPreview(null); setPendingReload(false); setNotice('已应用已保存设置并启动／更新聊天，原有上下文保留。'); }
      else { setNotice('检查未通过，已停止后续操作；请核对提示。'); setError(result.reasons.map(reason => chatRuntimeReason(reason).text).join(' ') || '当前条件尚不允许继续。'); }
    } catch (failure) {
      if (current()) {
        setBlocked(application.getSnapshot().blocked); setPreview(null);
        setError(failure instanceof Error ? failure.message : errorMessage(failure));
      }
    } finally {
      if (current()) { request.current = null; setBusy(false); }
    }
  }

  async function reconcileApplication(): Promise<void> {
    const operationId = application.getSnapshot().operationId;
    if (!operationId || request.current || application.getSnapshot().busy || application.getSnapshot().reconciling) return;
    const controller = new AbortController(); const generation = epoch.current;
    request.current = controller;
    const current = () => !controller.signal.aborted && request.current === controller && epoch.current === generation
      && connection.current.api === api && connection.current.connected;
    setError(''); setNotice('正在只读核对实际结果；不会再次执行应用或启动。');
    try {
      const result = await reconcileChatApplication(api, operationId, controller.signal);
      if (!current()) return;
      setBlocked(result.state === 'unknown');
      setNotice(result.state === 'completed' ? '已核对：原操作已完成，未重复执行。' : result.state === 'blocked'
        ? '已核对停止状态；请处理缺失条件，再明确发起新的应用。' : '现有证据仍不足，原操作保持待核对；不会自动重试。');
      runtimeResource.refresh(); refreshApplication();
    } catch (failure) { if (current()) { setBlocked(true); setError(`${errorMessage(failure)} 核对不会自动重试。`); } }
    finally { if (request.current === controller) request.current = null; }
  }

  if (!connected) return null;
  return <Section id={nativeFormMetadata.deployment.id} title={nativeFormMetadata.deployment.title} description="应用已保存且已启用的聊天方案及其关联人设；其他草稿或未关联人设不会被选择或应用。" scrollable
    actions={<Button variant="outline" size="sm" disabled={busy || dirty && !blocked} onClick={() => { if (!request.current && connection.current.api === api && connection.current.connected) setReload(value => value + 1); }}><RefreshCw className="size-3.5" />重新读取</Button>}
    footer={<p className="text-xs leading-6 text-muted-foreground" role="status">{notice || (blocked ? '上次操作结果未确认，应用已冻结；请先核对，不会重复应用。' : dirty ? '手动更改尚未保存；保存本身不会修改 DSH。' : '应用已保存设置并启动／更新聊天，保留上下文；不重启 DSH 进程。')}</p>}>
    <div className="mb-3 flex flex-wrap items-center gap-2 text-xs" role="status"><StatusPill tone={blocked ? 'warning' : runtimeResource.snapshot?.chatReady ? 'success' : 'neutral'}>{blocked ? '应用结果待核对' : busy ? '正在应用' : applicationState.operation?.state === 'blocked' ? '应用检查未通过' : runtimeResource.error ? '运行状态待确认' : runtimeResource.snapshot?.chatReady && !runtimeResource.snapshot.configurationChanged ? '当前启用方案运行中' : '已保存待应用'}</StatusPill>{applicationState.busy && applicationState.phase && <span>{chatApplicationPhaseLabels[applicationState.phase]}</span>}</div>
    {observationError && <p role="status" className="mb-3 text-xs text-muted-foreground">暂时无法更新持久应用记录；已保留上次阶段，不会重复提交。</p>}
    {applicationState.kind === 'application' && applicationState.operationId && <details className="mb-3 rounded-lg border p-3 text-xs leading-6"><summary className="cursor-pointer">应用操作详情</summary><p className="mt-2 break-all">操作标识：{applicationState.operationId}</p><p>状态：{applicationState.operation?.state === 'completed' ? '已完成' : applicationState.operation?.state === 'blocked' ? '检查未通过' : applicationState.operation?.state === 'unknown' ? '结果待核对' : applicationState.operation?.state === 'running' ? '后台处理中' : '请求结果待核对'}</p>{applicationState.operation?.reasons.map(reason => <p key={reason}>{chatRuntimeReason(reason).text}</p>)}<div className="mt-2 flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={refreshApplication}>读取同一应用操作</Button>{applicationState.blocked && <Button size="sm" variant="outline" disabled={applicationState.busy || applicationState.reconciling} onClick={() => void reconcileApplication()}>{applicationState.reconciling ? '正在核对…' : '核对实际结果'}</Button>}</div></details>}
    {error && <p className="mb-4 text-xs leading-6 text-destructive" role="alert">{error}</p>}
    {!form ? <p role="status" className="text-xs text-muted-foreground">{busy ? '正在读取应用设置' : '暂时无法读取应用设置，请重试。'}</p> : <div className="grid gap-5">
      <div className="grid gap-3 rounded-lg border bg-accent/20 p-4"><p className="text-sm font-medium">保存后，一次应用并启动／更新聊天。</p><p className="text-xs leading-6 text-muted-foreground">自动识别并应用已启用方案及关联人设；必要时先停止聊天，核对加载和会话衔接后再启动，保留已有上下文。</p>
        <span role="group" aria-label="应用并启动／更新聊天" data-page-field className="justify-self-start"><Button disabled={busy || blocked || dirty || configurationDirty} onClick={() => void autoApply()}><Upload className="size-3.5" />{busy ? '正在处理…' : '应用并启动／更新聊天'}</Button></span>
        <p className="text-xs leading-6 text-muted-foreground">不自动保存草稿、不清除会话、不重启 DSH。检查未通过或结果未知时停止，不自动重试。</p>
        {configurationDirty && <p className="text-xs text-muted-foreground">请先保存或撤销当前人设、方案更改，并核对保存结果；应用只读取已保存配置。</p>}{dirty && <p className="text-xs text-muted-foreground">请先保存或撤销手动更改，避免覆盖草稿。</p>}</div>
      {supportedEfforts !== null && <p className="text-xs leading-6 text-muted-foreground" role="status">已识别模型支持的推理档位：{supportedEfforts.length > 0 ? supportedEfforts.map(effort => ({ off: '关闭', low: '低（low）', medium: '中（medium）', high: '高（high）', max: '最高（max）' })[effort]).join('、') : '暂未提供'}。不会自动修改聊天方案的档位。</p>}
      {blocked && <p className="text-xs leading-6 text-amber-700 dark:text-amber-400" role="status">上次操作结果尚未确认，已冻结新的应用请求；重新读取只核对设置，不会解除保护或重放请求。</p>}
      {applicationState.kind === 'manual' && applicationState.manualSource === 'deployment' && blocked && <Button variant="outline" className="justify-self-start" disabled={busy || request.current !== null || !currentDocument() || !application.canAcknowledgeManual(manualReview, 'deployment')} onClick={() => {
        if (busy || request.current || !currentDocument() || !application.acknowledgeManual(manualReview, 'deployment')) return;
        setManualReview(null); setBlocked(false); setPreview(null); setError(''); setNotice('已确认核对当前保存设置。可以明确发起新的管理操作；上次请求不会重放。');
      }}>我已核对，允许新的管理操作</Button>}
      {compact && navigate && <Button variant="outline" className="justify-self-start" onClick={() => navigate('adapters', { title: nativeFormMetadata.deployment.title, sectionId: nativeFormMetadata.deployment.id, kind: 'section' })}>查看完整应用设置与恢复状态</Button>}
      {!compact && <details className="min-w-0 rounded-lg border px-4 py-3"><summary className="cursor-pointer text-xs font-medium">手动部署/远程 DSH（高级）</summary><div className="mt-4 grid gap-5">
      <p className="text-xs leading-5 text-muted-foreground">检查会核对配置、凭据引用及文件来源，不验证引擎内的实际密钥值、模型可用性或余额；使用结果以实际消息为准。</p>
      <div className="grid gap-4 sm:grid-cols-2"><Field label={nativeFormMetadata.deployment.fields.profile} description="DSH 服务器上的 cordis.patch.yml 绝对路径。"><Input value={form.profilePath} disabled={busy || blocked} onChange={event => update({ profilePath: event.target.value })} placeholder="/srv/dsh/profiles/chat/cordis.patch.yml" /></Field><Field label={nativeFormMetadata.deployment.fields.credentials} description="服务器上 .credentials.yaml 的绝对路径；只保存路径，不显示密钥内容。"><Input value={form.credentialsPath} disabled={busy || blocked} onChange={event => update({ credentialsPath: event.target.value })} placeholder="/srv/dsh/.credentials.yaml" /></Field></div>
      <div className="grid gap-4 sm:grid-cols-2"><Field label={nativeFormMetadata.deployment.fields.context} description="填写模型实际支持的总容量；群聊、私聊设置不能超过它。"><Input type="number" min={1} max={16_777_216} value={form.contextWindow} disabled={busy || blocked} onChange={event => update({ contextWindow: event.target.value })} /></Field><Field label={nativeFormMetadata.deployment.fields.output} description="填写实际支持的最大输出 Token 数，小于群聊、私聊上下文。"><Input type="number" min={1} max={16_777_215} value={form.maxTokens} disabled={busy || blocked} onChange={event => update({ maxTokens: event.target.value })} /></Field></div>
      <ToggleField label={nativeFormMetadata.deployment.fields.reasoning} description="关闭时只允许方案选择关闭推理；开启后按提供方文档填写对应值，不自动猜测。" checked={form.reasoning} disabled={busy || blocked} onChange={reasoning => update({ reasoning })} />
      {form.reasoning && <div className="grid gap-3 sm:grid-cols-2">{efforts.map(effort => <Field key={effort} label={nativeFormMetadata.deployment.fields[effort]} description={effort === 'off' ? '留空表示不传推理参数。' : '不支持此档位则留空。'}><Input value={form.mapping[effort]} maxLength={128} disabled={busy || blocked} onChange={event => update({ mapping: { ...form.mapping, [effort]: event.target.value } })} /></Field>)}</div>}
      <details><summary className="cursor-pointer text-xs text-muted-foreground">高级：基础配置与命名前缀</summary><div className="mt-4 grid gap-4"><Field label={nativeFormMetadata.deployment.fields.layers} description="有继承配置时按加载顺序每行填写一个绝对路径；不包括上方目标文件。"><Textarea className="h-28 resize-none font-mono text-xs" value={form.layerPaths} disabled={busy || blocked} onChange={event => update({ layerPaths: event.target.value })} /></Field><Field label={nativeFormMetadata.deployment.fields.namespace} description="避免与其他 DSH 配置重名；不改变聊天人设。"><Input value={form.namespace} disabled={busy || blocked} onChange={event => update({ namespace: event.target.value })} /></Field></div></details>
      <SaveBar dirty={dirty} saving={busy} disabled={blocked || configurationDirty} onSave={() => void perform('save')} onReset={saved && !blocked ? () => { if (!currentDocument() || busy || request.current || frozen.current.has(api)) return; setForm(saved.form); setPreview(null); } : undefined} label="保存应用设置" message={dirty ? '保存手动应用设置，不会写入 DSH。' : '手动设置已保存。'} />
      <div className="flex flex-wrap gap-2 border-t pt-4"><Button variant="outline" disabled={busy || blocked || dirty || configurationDirty} onClick={() => void perform('prepare')}><Eye className="size-3.5" />预览变更</Button></div>
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy || dirty || configurationDirty} onClick={() => void perform('reconcile')}><Check className="size-3.5" />检查是否生效</Button></div>
      {pendingReload && <p className="text-xs leading-6 text-amber-700 dark:text-amber-400" role="status">设置已写入，但 DSH 尚未加载。请检查热更新状态；如确需重启，请在明确维护窗口重启该 DSH 实例，再点“检查是否生效”。当前页面没有执行 DSH 重启的接口，不会把检查当作重启。</p>}
      {preview && <div className="grid gap-3 rounded-lg border p-3 text-xs leading-6">{preview.reasons.length > 0 && <ul>{[...new Set(preview.reasons.map(reason => chatRuntimeReason(reason).text))].map(reason => <li key={reason}>{reason}</li>)}</ul>}{preview.ready && <><p>点击应用将备份并写入当前聊天设置；不会重置会话或重启 DSH。</p>{running && <p className="text-muted-foreground">请先停止聊天，再应用引擎配置。</p>}<Button disabled={busy || blocked || dirty || configurationDirty || running} onClick={() => void perform('apply')}><Upload className="size-3.5" />应用聊天设置</Button></>}</div>}
      </div></details>}
    </div>}
  </Section>;
}
