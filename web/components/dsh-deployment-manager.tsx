import { HelpTip, ActionTip } from './help-tip.tsx';
import { validateDshModelSettings } from '../../src/contracts/dsh-model-settings.ts';
import { CHAT_PLAN_REASONING_EFFORTS as efforts } from '../../src/contracts/chat-plans.ts';
import { useChatApplication } from '../lib/use-chat-application.ts';
import { parseNativeDeploymentPreparationResult, parseNativeDeploymentApplyResult } from '../../src/contracts/native-deployment.ts';
import { parsePublicDeploymentReconciliation } from '../lib/deployment-review.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import type { PageProps } from '../lib/types.ts';
import { readResource, writeResource } from '../lib/resource-reader.ts';
import { nativeFormMetadata } from '../lib/native-form-metadata.ts';
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Check, Eye, RefreshCw, Upload } from 'lucide-react';
import { ApiError, asRecord, errorMessage, type ApiClient } from '../lib/api.ts';
import { chatRuntimeReason, parseChatRuntimeStatus } from '../lib/chat-runtime.ts';
import { applyAndStartChat, chatApplicationCanReconcile, chatApplicationPhaseLabels, chatApplicationPrimaryAction, chatApplicationStore, reconcileChatApplication, type ChatApplicationPrimaryAction } from '../lib/chat-application.ts';
import { Field, SaveBar, Section, ToggleField } from './management.tsx';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { Textarea } from './ui/textarea.tsx';
import { SettingsWindow } from './settings-window.tsx';
import { DshRestartControl } from './dsh-restart-control.tsx';
import { useDshRestart } from '../lib/use-dsh-restart.ts';
import { parsePlanCatalog } from '../lib/chat-plans.ts';
import { ReadOnlyDetails, TechnicalDetails } from './read-only-details.tsx';

type Effort = typeof efforts[number];

export interface PreparedChatConfiguration {
  readonly revision: string;
  isCurrent(): boolean;
  complete(): void;
}

export interface DshDeploymentHandle {
  updateChat(): Promise<void>;
}

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

export function DshDeploymentManager({ api, connected, setDirty, running = false, configurationDirty = false, configurationRevision = '', configurationDocument = 'plans', compact = false, minimal = false, navigate,
  prepareConfiguration, configurationUpdateBlocked = false, updateRef, onUpdateAvailable, onUpdateActionChange, selectedPersonaId, configurationActive = true }: {
  readonly api: ApiClient; readonly connected: boolean; readonly running?: boolean; readonly compact?: boolean; readonly minimal?: boolean; readonly navigate?: PageProps['navigate'];
  readonly configurationDirty?: boolean; readonly configurationRevision?: string; readonly configurationDocument?: 'plans' | 'personas'; setDirty(value: boolean, scope?: string): void;
  readonly prepareConfiguration?: (signal: AbortSignal) => Promise<PreparedChatConfiguration | null>;
  readonly configurationUpdateBlocked?: boolean;
  readonly updateRef?: Ref<DshDeploymentHandle>;
  readonly onUpdateAvailable?: (available: boolean) => void;
  readonly onUpdateActionChange?: (action: ChatApplicationPrimaryAction) => void;
  readonly selectedPersonaId?: string;
  readonly configurationActive?: boolean;
}) {
  const { application, state: applicationState, observationError, initialLoading: applicationLoading, refresh: refreshApplication } = useChatApplication(api, connected);
  const restart = useDshRestart(api, connected);
  const runtimeResource = useReadResource(api, '/api/chat/runtime', connected, parseChatRuntimeStatus, { intervalMs: 5_000, pollWhen: () => !application.getSnapshot().busy });
  const planResource = useReadResource(api, '/api/chat/plans', connected && selectedPersonaId !== undefined, parsePlanCatalog, { intervalMs: 10_000 });
  const personaSelected = selectedPersonaId === undefined || planResource.snapshot?.plans.find(plan => plan.id === planResource.snapshot?.activePlanId)?.personaId === selectedPersonaId;
  const [saved, setSaved] = useState<DeploymentSnapshot | null>(null);
  const [form, setForm] = useState<DeploymentForm | null>(null);
  const [localBusy, setBusy] = useState(false);
  const [localBlocked, setBlocked] = useState(false);
  const [manualReview, setManualReview] = useState<symbol | null>(null);
  const busy = localBusy || applicationState.busy || applicationState.reconciling || restart.pending;
  const blocked = localBlocked || applicationState.blocked;
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pendingReload, setPendingReload] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [supportedEfforts, setSupportedEfforts] = useState<readonly Effort[] | null>(null);
  const [reload, setReload] = useState(0);
  const request = useRef<AbortController | null>(null);
  const recoveryRequest = useRef<AbortController | null>(null);
  const configurationRequest = useRef<{ readonly controller: AbortController; preparing: boolean; prepared: PreparedChatConfiguration | null } | null>(null);
  const committedConfiguration = useRef<{ readonly api: ApiClient; readonly revision: string } | null>(null);
  const reconciledDeployment = useRef<string | null>(null);
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
      if (pending) {
        if (configurationRequest.current?.controller !== pending && (application.getSnapshot().kind !== 'application' || !application.getSnapshot().operationId)) frozen.current.add(api);
        pending.abort(); if (request.current === pending) request.current = null;
      }
    };
  }, [api, connected, reload]);

  useEffect(() => {
    if (request.current && recoveryRequest.current === request.current) return;
    const ownUpdate = configurationRequest.current;
    if (ownUpdate && request.current === ownUpdate.controller && (ownUpdate.preparing || ownUpdate.prepared?.isCurrent())) return;
    if (!configurationDirty && committedConfiguration.current?.api === api && committedConfiguration.current.revision === configurationRevision) {
      committedConfiguration.current = null;
      return;
    }
    setPreview(null);
    setNotice(configurationDirty ? '当前伙伴配置未保存或尚待核对，请先保存、撤销更改或重新读取。' : '应用对象为已启用聊天方案及其关联人设，请确认已经保存并选择启用。');
    const pending = request.current;
    if (pending) {
      if (configurationRequest.current?.controller !== pending && (application.getSnapshot().kind !== 'application' || !application.getSnapshot().operationId)) frozen.current.add(api);
      pending.abort();
      if (request.current === pending) request.current = null;
      setBusy(false); setBlocked(frozen.current.has(api));
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
    if (state === 'unknown') {
      frozen.current.add(api); setBlocked(true);
      setError('应用结果尚未确认，请先核对是否生效；不会自动重试。');
    }
    if (state === 'conflict') setError('设置已变化，本次未应用。请刷新状态并重新预览。');
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
    let mutationStarted = false;
    try {
      if (operation === 'save') {
        mutationStarted = true;
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
        mutationStarted = operation === 'apply';
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
      if (current()) {
        const rejected = failure instanceof ApiError && failure.status >= 400 && failure.status < 500 && !/unknown/.test(failure.code);
        if (mutationStarted && !rejected) frozen.current.add(api);
        setError(`${errorMessage(failure)} 请刷新状态后再操作，不会自动重试。`);
        setBlocked(frozen.current.has(api)); setPreview(null);
      }
    } finally {
      if (current()) { request.current = null; setBusy(false); }
      if (sharedOwner) application.release(sharedOwner);
    }
  }

  async function autoApply(): Promise<void> {
    const state = application.getSnapshot();
    if (state.kind === 'manual' && state.blocked && state.manualSource === 'deployment') { await restoreManualOperations(); return; }
    if (application.getSnapshot().kind === 'application' && application.getSnapshot().busy && !request.current) { refreshApplication(); return; }
    if (chatApplicationCanReconcile(application.getSnapshot())) { await reconcileApplication(); return; }
    if (!personaSelected || !saved || !form || !currentDocument() || applicationLoading || (prepareConfiguration ? configurationUpdateBlocked : connection.current.configurationDirty) || busy || blocked || frozen.current.has(api) || dirty || request.current) return;
    if (application.getSnapshot().busy) return;
    const controller = new AbortController();
    const generation = epoch.current;
    request.current = controller;
    const ownUpdate = { controller, preparing: Boolean(prepareConfiguration), prepared: null as PreparedChatConfiguration | null };
    configurationRequest.current = ownUpdate;
    const current = () => !controller.signal.aborted && generation === epoch.current && request.current === controller
      && connection.current.api === api && connection.current.connected
      && (ownUpdate.preparing || ownUpdate.prepared ? ownUpdate.preparing || ownUpdate.prepared?.isCurrent() === true
        : !connection.current.configurationDirty && connection.current.configurationRevision === configurationRevision);
    setBusy(true); setError(''); setNotice(''); setPreview(null);
    try {
      if (prepareConfiguration) {
        ownUpdate.prepared = await prepareConfiguration(controller.signal);
        ownUpdate.preparing = false;
        if (!ownUpdate.prepared || !current()) return;
        committedConfiguration.current = { api, revision: ownUpdate.prepared.revision };
      }
      const result = await applyAndStartChat({ api, signal: controller.signal, isCurrent: current,
        expectedDeploymentRevision: saved.revision, configurationRevision: ownUpdate.prepared?.revision ?? configurationRevision, configurationDocument,
        ...(selectedPersonaId === undefined ? {} : { selectedPersonaId }),
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
        setError(failure instanceof ApiError ? errorMessage(failure) : failure instanceof Error ? failure.message : errorMessage(failure));
      }
    } finally {
      ownUpdate.prepared?.complete();
      if (configurationRequest.current === ownUpdate) configurationRequest.current = null;
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  }

  const canReconcile = chatApplicationCanReconcile(applicationState);
  const waitingForReload = applicationState.operation?.state === 'blocked' && applicationState.operation.phase === 'apply'
    && applicationState.operation.reasons.includes('pending_reload');
  const primaryAction = chatApplicationPrimaryAction(applicationState, { connected, requestActive: request.current !== null,
    updateReady: !applicationLoading && !observationError && !busy && saved !== null && form !== null && currentDocument() && !blocked && !dirty
      && personaSelected && !(prepareConfiguration ? configurationUpdateBlocked : configurationDirty) });
  const updateAvailable = primaryAction === 'update' || primaryAction === 'observe' || primaryAction === 'reconcile' || primaryAction === 'restore';
  useImperativeHandle(updateRef, () => ({ updateChat: autoApply }));
  useEffect(() => { onUpdateAvailable?.(updateAvailable); }, [onUpdateAvailable, updateAvailable]);
  useEffect(() => { onUpdateActionChange?.(primaryAction); }, [onUpdateActionChange, primaryAction]);
  useEffect(() => {
    if (reconciledDeployment.current === applicationState.operation?.id && applicationState.operation.state === 'completed'
      && !dirty && !request.current) { reconciledDeployment.current = null; setReload(value => value + 1); }
  }, [applicationState.operation, dirty]);

  async function reconcileApplication(): Promise<void> {
    const operationId = application.getSnapshot().operationId;
    if (!operationId || request.current || application.getSnapshot().busy || application.getSnapshot().reconciling) return;
    const controller = new AbortController(); const generation = epoch.current;
    request.current = controller;
    recoveryRequest.current = controller;
    const current = () => !controller.signal.aborted && request.current === controller && epoch.current === generation
      && connection.current.api === api && connection.current.connected;
    setError(''); setNotice('正在核对原操作的实际结果；加载已确认后继续衔接并启动，不重复应用。');
    try {
      const result = await reconcileChatApplication(api, operationId, controller.signal);
      if (!current()) return;
      setBlocked(application.getSnapshot().blocked);
      if (result.state === 'running') reconciledDeployment.current = result.id;
      else if ((result.state === 'completed' || result.state === 'blocked' && !application.getSnapshot().blocked) && !dirty) {
        reconciledDeployment.current = null; setReload(value => value + 1);
      }
      setNotice(result.state === 'completed' ? '已核对：原操作已完成，未重复应用。' : result.state === 'running'
        ? '已核验加载结果，正在继续原更新；不会重复应用。' : result.state === 'blocked'
          ? '原更新仍有条件待处理，请核对下方原因；不会重复应用。' : '现有证据仍不足，原操作保持待核对；不会自动重试。');
      runtimeResource.refresh(); refreshApplication();
    } catch (failure) { if (current()) { setBlocked(true); setError(`${errorMessage(failure)} 核对不会自动重试。`); } }
    finally {
      if (recoveryRequest.current === controller) recoveryRequest.current = null;
      if (request.current === controller) request.current = null;
    }
  }

  async function restoreManualOperations(): Promise<void> {
    const state = application.getSnapshot();
    if (!connected || request.current || state.busy || state.reconciling || state.kind !== 'manual'
      || state.manualSource !== 'deployment' || !state.blocked) return;
    const controller = new AbortController();
    const generation = epoch.current;
    request.current = controller;
    recoveryRequest.current = controller;
    const current = () => !controller.signal.aborted && request.current === controller && epoch.current === generation
      && connection.current.api === api && connection.current.connected;
    setBusy(true); setError(''); setManualReview(null);
    try {
      const runtime = parseChatRuntimeStatus(await api.get('/api/chat/runtime', controller.signal));
      if (!current()) return;
      if (!runtime) throw new Error('无法读取当前运行状态，请重试恢复操作。');
      const result = await writeResource(api, '/api/chat/deployment/reconcile', { revisions: runtime.revisions }, controller.signal);
      if (!current()) return;
      const proof = application.reviewManual('deployment', result);
      if (!proof || !application.acknowledgeManual(proof, 'deployment')) {
        showResult(result, 'reconcile');
        setError('尚未确认实际加载结果，原保护保留；可再次恢复操作，不会重复应用。');
        return;
      }
      setBlocked(false); setPreview(null); setNotice('已确认实际加载结果，管理操作已恢复；其他草稿保留，未重复应用。');
      if (!dirty) setReload(value => value + 1);
    } catch (failure) {
      if (current()) setError(`${errorMessage(failure)} 恢复入口仍可重试，不会重复应用。`);
    } finally {
      if (recoveryRequest.current === controller) recoveryRequest.current = null;
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  }

  if (!connected) return null;
  const runtimeStatus = runtimeResource.snapshot;
  const statusLabel = waitingForReload || pendingReload ? '等待加载' : blocked ? '需要核对' : busy ? '正在应用'
    : applicationState.operation?.state === 'blocked' ? '应用未完成' : configurationDirty ? '未保存' : !configurationActive ? '未选用' : runtimeResource.error ? '状态未更新'
      : !runtimeStatus ? '正在读取状态' : runtimeStatus.state === 'stopped' ? '已选用 · 聊天已停止'
        : runtimeStatus.state === 'starting' ? '正在启动聊天' : runtimeStatus.state === 'stopping' ? '正在停止聊天'
          : runtimeStatus.configurationChanged ? '有更改待应用' : runtimeStatus.chatReady ? '已生效' : '聊天未就绪';
  const actionLabel = primaryAction === 'restore' ? '恢复操作' : primaryAction === 'observe' ? '查看进度'
    : primaryAction === 'reconcile' ? '核对并继续' : busy ? '正在应用…' : runtimeStatus?.state === 'stopped' ? '应用并启动' : '应用';
  const advanced = <SettingsWindow title="高级应用设置" label="高级设置" open={advancedOpen} onOpenChange={setAdvancedOpen} description="手动指定部署位置与模型能力，适用于远程或自定义接入。关闭窗口保留草稿。">
    {error && <p className="mb-2 text-sm text-destructive" role="alert">{error}</p>}
    {form ? <div className="grid gap-2">
      <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
        <Field label={nativeFormMetadata.deployment.fields.profile} layout="stacked" tip="DSH 服务器上的 cordis.patch.yml 绝对路径。"><Input value={form.profilePath} disabled={busy || blocked} onChange={event => update({ profilePath: event.target.value })} placeholder="/srv/dsh/profiles/chat/cordis.patch.yml" /></Field>
        <Field label={nativeFormMetadata.deployment.fields.credentials} layout="stacked" tip="服务器上 .credentials.yaml 的绝对路径；只保存路径，不显示密钥内容。"><Input value={form.credentialsPath} disabled={busy || blocked} onChange={event => update({ credentialsPath: event.target.value })} placeholder="/srv/dsh/.credentials.yaml" /></Field>
        <Field label={nativeFormMetadata.deployment.fields.context} tip="模型实际支持的总容量；群聊、私聊设置不能超过它。"><Input type="number" min={1} max={16_777_216} value={form.contextWindow} disabled={busy || blocked} onChange={event => update({ contextWindow: event.target.value })} /></Field>
        <Field label={nativeFormMetadata.deployment.fields.output} tip="实际支持的最大输出 Token 数，小于群聊、私聊上下文。"><Input type="number" min={1} max={16_777_215} value={form.maxTokens} disabled={busy || blocked} onChange={event => update({ maxTokens: event.target.value })} /></Field>
      </div>
      <ToggleField label={nativeFormMetadata.deployment.fields.reasoning} tip="关闭时只允许方案选择关闭推理；开启后按提供方文档填写对应值。" checked={form.reasoning} disabled={busy || blocked} onChange={reasoning => update({ reasoning })} />
      {form.reasoning && <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">{efforts.map(effort => <Field key={effort} label={nativeFormMetadata.deployment.fields[effort]} tip={effort === 'off' ? '留空表示不传推理参数。' : '不支持此档位则留空。'}><Input value={form.mapping[effort]} maxLength={128} disabled={busy || blocked} onChange={event => update({ mapping: { ...form.mapping, [effort]: event.target.value } })} /></Field>)}</div>}
      <div className="grid gap-2 border-t pt-2">
        <Field label={nativeFormMetadata.deployment.fields.layers} layout="stacked" tip="有继承配置时按加载顺序每行填写一个绝对路径；不包括上方目标文件。"><Textarea className="h-20 min-h-20 resize-y font-mono text-sm" value={form.layerPaths} disabled={busy || blocked} onChange={event => update({ layerPaths: event.target.value })} /></Field>
        <Field label={nativeFormMetadata.deployment.fields.namespace} tip="避免与其他 DSH 配置重名；不改变聊天人设。"><Input value={form.namespace} disabled={busy || blocked} onChange={event => update({ namespace: event.target.value })} /></Field>
      </div>
      {pendingReload && <p className="rounded bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400" role="status">设置已写入，等待 DSH 加载。可在本页重启 DSH，维护完成后恢复聊天。</p>}
      {preview && <div className="grid gap-2 rounded bg-muted/50 px-2 py-1.5 text-xs">{preview.reasons.length > 0 && <ul>{[...new Set(preview.reasons.map(reason => chatRuntimeReason(reason).text))].map(reason => <li key={reason}>{reason}</li>)}</ul>}{preview.ready && <><div className="flex flex-wrap items-center gap-2"><span className="mr-auto">应用会备份并写入当前聊天设置，会话保留。</span><Button disabled={busy || blocked || dirty || configurationDirty || running} onClick={() => void perform('apply')}><Upload className="size-3" />应用聊天设置</Button></div>{running && <p className="text-muted-foreground">请先停止聊天，再应用引擎配置。</p>}</>}</div>}
      <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t bg-popover py-2">
        <Button size="sm" variant="outline" disabled={busy || blocked || dirty || configurationDirty} onClick={() => void perform('prepare')}><Eye className="size-3" />预览变更</Button>
        <Button size="sm" variant="outline" disabled={busy || dirty || configurationDirty} onClick={() => void perform('reconcile')}><Check className="size-3" />检查是否生效</Button>
        <HelpTip label="应用检查">核对配置、凭据引用及文件来源。实际密钥、模型可用性和余额以真实消息的使用结果为准。</HelpTip>
        <SaveBar dirty={dirty} saving={busy} disabled={blocked || configurationDirty} onSave={() => void perform('save')} onReset={saved && !blocked ? () => { if (!currentDocument() || busy || request.current || frozen.current.has(api)) return; setForm(saved.form); setPreview(null); } : undefined} label="保存应用设置" message={dirty ? '保存手动设置后再预览应用。' : '手动设置已保存。'} />
      </div>
    </div> : <div className="flex items-center gap-2 text-xs text-muted-foreground"><span>尚未读取高级设置。</span><Button variant="outline" size="sm" disabled={busy || request.current !== null} onClick={() => setReload(value => value + 1)}>重新读取</Button></div>}
  </SettingsWindow>;
  const controls = <div id={compact ? nativeFormMetadata.deployment.id : undefined} className={compact ? "contents text-xs" : "grid gap-2 text-xs"} data-application-controls>
    <div className={minimal ? "contents" : "flex flex-wrap items-center gap-2"}>
      {minimal && <span role="status" className="order-first mr-auto text-muted-foreground">{statusLabel}</span>}
      <ActionTip content={prepareConfiguration ? '保存并启用当前方案，保留聊天历史。' : '应用已保存的人设，保留聊天历史。'}><Button id={prepareConfiguration ? 'native-plan-update' : undefined} disabled={!updateAvailable} onClick={() => void autoApply()}>{busy && <RefreshCw className="size-3.5 animate-spin" />}{minimal && actionLabel === '应用' ? '应用方案' : actionLabel}</Button></ActionTip>{!minimal && <HelpTip label="应用">{prepareConfiguration ? '保存并启用当前方案；通常无需重启 DSH。' : '先保存人设，再应用到当前聊天；通常无需重启 DSH。'}</HelpTip>}
      {!minimal && <span role="status" className="text-muted-foreground">{personaSelected ? statusLabel : planResource.error ? '无法确认当前使用的人设' : '当前方案未使用此人设'}</span>}
      {!minimal && <ReadOnlyDetails title="应用详情" description="查看配置生效状态与操作记录。">
        <p className="mb-3">{prepareConfiguration ? '保存并启用当前方案。' : '应用已保存的人设与聊天设置。'}应用期间可能短暂停止聊天，会话历史保留；通常无需重启 DSH。</p>
        <TechnicalDetails fields={[{ label: '状态', value: statusLabel }, { label: '操作编号', value: applicationState.operationId },
          { label: '处理阶段', value: applicationState.phase ? chatApplicationPhaseLabels[applicationState.phase] : '无' },
          { label: '处理说明', value: notice || '无' }, { label: '原因', value: applicationState.operation?.reasons ?? [] }]} />
      </ReadOnlyDetails>}
      {!minimal && configurationDocument === 'plans' && advanced}
      {(observationError || runtimeResource.error || !form) && <Button variant="ghost" size="sm" onClick={() => { refreshApplication(); runtimeResource.refresh(); planResource.refresh(); if (!request.current && !dirty) setReload(value => value + 1); }}>刷新状态</Button>}
    </div>
    {configurationDirty && !prepareConfiguration && <p className="text-muted-foreground">请先保存人设。</p>}
    {error && <p className="text-destructive" role="alert">{error}</p>}
    {observationError && <p role="status">暂时无法读取应用进度，稍后刷新。</p>}
    {(waitingForReload || pendingReload || restart.pending) && <div className="flex flex-wrap items-center gap-2">
      <span>配置尚未加载，可重启 DSH 后继续应用。</span><DshRestartControl api={api} connected={connected} compact />
    </div>}
  </div>;
  if (compact) return controls;
  return <Section id={nativeFormMetadata.deployment.id} title="聊天设置" scrollable>{controls}</Section>;
}
