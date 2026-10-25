import { createDraftKey, retainDraft, retainedDraft } from '../lib/retained-drafts.ts';
import { readResource, writeResource } from '../lib/resource-reader.ts';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ExternalLink, LoaderCircle, RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import { ConfigurationEditor } from '../components/configuration-editor.tsx';
import { ChatExecutionSettings } from '../components/chat-execution-settings.tsx';
import { ConnectPrompt, Field, NumberField, PageHeading, SaveBar, Section, StatusPill, ToggleField } from '../components/management.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { ApiError, asRecord, errorMessage } from '../lib/api.ts';
import { nativeFormMetadata } from '../lib/native-form-metadata.ts';
import { configurationOperationStore, type ConfigurationOperationSource } from '../lib/configuration-operation-recovery.ts';
import type { PageProps } from '../lib/types.ts';

interface GatewayValues {
  budgetEnabled: boolean;
  maxSendUses: number | null;
  grantTtlMs: number | null;
  timeoutMs: number;
  maxPending: number;
  maxBodyBytes: number;
  maxRecords: number;
}

interface GatewayForm {
  budgetEnabled: boolean;
  maxSendUses: number | null;
  grantTtlHours: number | null;
  timeoutSeconds: number | null;
  maxPending: number | null;
  maxBodyMegabytes: number | null;
  maxRecords: number | null;
}

interface AdminValues {
  host: string;
  port: number;
}

interface SettingsState {
  gateway: { revision: string; values: GatewayValues };
  admin: { revision: string; values: AdminValues };
  capabilities: { applyGateway: boolean; applyAdmin: boolean };
}

const settingsDraftKey = createDraftKey<{ readonly settings: SettingsState; readonly gateway: GatewayForm; readonly admin: AdminValues }>('settings');

type GatewayErrors = Partial<Record<keyof GatewayForm, string>>;
type AdminErrors = Partial<Record<keyof AdminValues, string>>;

interface SettingsRequest {
  api: PageProps['api'];
  epoch: number;
  generation: number;
  controller: AbortController;
  operation?: { store: ReturnType<typeof configurationOperationStore>; source: ConfigurationOperationSource; token: object };
  review?: { source: ConfigurationOperationSource; token: object };
}

interface SettingsOwner {
  api: PageProps['api'];
  epoch: number;
}

function parseSettings(value: unknown): SettingsState {
  const root = asRecord(value);
  const gateway = asRecord(root.gateway);
  const gatewayValues = asRecord(gateway.values);
  const admin = asRecord(root.admin);
  const adminValues = asRecord(admin.values);
  const capabilities = asRecord(root.capabilities);
  const maxSendUses = gatewayValues.maxSendUses;
  const grantTtlMs = gatewayValues.grantTtlMs;
  if (typeof gateway.revision !== 'string' || typeof admin.revision !== 'string'
    || typeof gatewayValues.budgetEnabled !== 'boolean'
    || maxSendUses !== null && typeof maxSendUses !== 'number'
    || grantTtlMs !== null && typeof grantTtlMs !== 'number'
    || typeof gatewayValues.timeoutMs !== 'number' || typeof gatewayValues.maxPending !== 'number'
    || typeof gatewayValues.maxBodyBytes !== 'number' || typeof gatewayValues.maxRecords !== 'number'
    || typeof adminValues.host !== 'string' || typeof adminValues.port !== 'number'
    || typeof capabilities.applyGateway !== 'boolean' || typeof capabilities.applyAdmin !== 'boolean') {
    throw new Error('invalid_settings_response');
  }
  return {
    gateway: {
      revision: gateway.revision,
      values: {
        budgetEnabled: gatewayValues.budgetEnabled,
        maxSendUses,
        grantTtlMs,
        timeoutMs: gatewayValues.timeoutMs,
        maxPending: gatewayValues.maxPending,
        maxBodyBytes: gatewayValues.maxBodyBytes,
        maxRecords: gatewayValues.maxRecords,
      },
    },
    admin: { revision: admin.revision, values: { host: adminValues.host, port: adminValues.port } },
    capabilities: { applyGateway: capabilities.applyGateway, applyAdmin: capabilities.applyAdmin },
  };
}

function gatewayForm(values: GatewayValues): GatewayForm {
  return {
    budgetEnabled: values.budgetEnabled,
    maxSendUses: values.maxSendUses,
    grantTtlHours: values.grantTtlMs === null ? null : values.grantTtlMs / 3_600_000,
    timeoutSeconds: values.timeoutMs / 1_000,
    maxPending: values.maxPending,
    maxBodyMegabytes: values.maxBodyBytes / (1_024 * 1_024),
    maxRecords: values.maxRecords,
  };
}

function sameGateway(left: GatewayForm, right: GatewayForm): boolean {
  return Object.keys(left).every(key => left[key as keyof GatewayForm] === right[key as keyof GatewayForm]);
}

function integerError(value: number | null, minimum: number, maximum: number, label: string): string | undefined {
  if (value === null || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return `${label}需为 ${minimum} 到 ${maximum} 的整数。`;
  }
  return undefined;
}

function scaledError(value: number | null, minimum: number, maximum: number, unit: string, empty = false): string | undefined {
  if (value === null) return empty ? undefined : `请填写${unit}。`;
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    return `请输入 ${minimum} 到 ${maximum} ${unit}之间的数值。`;
  }
  return undefined;
}

function validateGateway(form: GatewayForm): GatewayErrors {
  const errors: GatewayErrors = {};
  if (form.maxSendUses !== null) {
    errors.maxSendUses = integerError(form.maxSendUses, 1, Number.MAX_SAFE_INTEGER, '发送次数上限');
  }
  errors.grantTtlHours = scaledError(form.grantTtlHours, 1 / 3_600, 168, '小时', true);
  errors.timeoutSeconds = scaledError(form.timeoutSeconds, 0.01, 120, '秒');
  errors.maxPending = integerError(form.maxPending, 1, 64, '并发请求上限');
  errors.maxBodyMegabytes = scaledError(form.maxBodyMegabytes, 1 / 1_024, 32, 'MB');
  errors.maxRecords = integerError(form.maxRecords, 100, 100_000, '记录数量上限');
  return Object.fromEntries(Object.entries(errors).filter(([, message]) => message !== undefined));
}

function isValidHost(value: string): boolean {
  if (value === 'localhost') return true;
  const parts = value.split('.');
  if (parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part)
    && String(Number(part)) === part && Number(part) <= 255)) return true;
  if (!value.includes(':') || !/^[0-9a-f:.]+$/i.test(value)) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.length > 0;
  } catch {
    return false;
  }
}

function validateAdmin(values: AdminValues): AdminErrors {
  const errors: AdminErrors = {};
  if (!isValidHost(values.host.trim())) errors.host = '监听地址只能填写 localhost、IPv4 或 IPv6 地址。';
  const portError = integerError(values.port, 1, 65_535, '监听端口');
  if (portError) errors.port = portError;
  return errors;
}

function gatewayPayload(form: GatewayForm): GatewayValues {
  return {
    budgetEnabled: form.budgetEnabled,
    maxSendUses: form.maxSendUses,
    grantTtlMs: form.grantTtlHours === null ? null : Math.round(form.grantTtlHours * 3_600_000),
    timeoutMs: Math.round(form.timeoutSeconds! * 1_000),
    maxPending: form.maxPending!,
    maxBodyBytes: Math.round(form.maxBodyMegabytes! * 1_024 * 1_024),
    maxRecords: form.maxRecords!,
  };
}

function responseRevision(value: unknown): string {
  const response = asRecord(value);
  if (response.ok !== true || typeof response.revision !== 'string' || response.restartRequired !== true) {
    throw new Error('invalid_settings_response');
  }
  return response.revision;
}

function settingsError(error: unknown): string {
  if (error instanceof ApiError && error.code === 'settings_apply_unavailable') {
    return '当前不支持在线应用，请手动重启对应服务。';
  }
  return errorMessage(error);
}

function safeReconnectUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value, window.location.href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function SettingsPage(props: PageProps & { readonly embedded?: boolean }) {
  const { api, connected, connect, refresh, setDirty } = props;
  const operationStore = useMemo(() => configurationOperationStore(api), [api]);
  const sourceBlocks = useSyncExternalStore(operationStore.subscribe, operationStore.getSnapshot, operationStore.getSnapshot);
  const [settings, setSettings] = useState<SettingsState | null>(null);
  const [gateway, setGateway] = useState<GatewayForm | null>(null);
  const [admin, setAdmin] = useState<AdminValues | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState<'gateway' | 'admin' | null>(null);
  const [applying, setApplying] = useState<'gateway' | 'admin' | null>(null);
  const [gatewayErrors, setGatewayErrors] = useState<GatewayErrors>({});
  const [adminErrors, setAdminErrors] = useState<AdminErrors>({});
  const [pendingGatewayRevision, setPendingGatewayRevision] = useState<string | null>(null);
  const [pendingAdminRevision, setPendingAdminRevision] = useState<string | null>(null);
  const [reconnectUrl, setReconnectUrl] = useState<string | null>(null);
  const [configurationDirty, setConfigurationDirty] = useState(false);
  const epoch = useRef(0);
  const generation = useRef(0);
  const activeRequest = useRef<SettingsRequest | null>(null);
  const settingsOwner = useRef<SettingsOwner | null>(null);
  const connection = useRef({ api, connected });
  connection.current = { api, connected };
  const recoveryTarget = (['gateway', 'admin'] as const).find(source => sourceBlocks[source]?.phase === 'blocked');
  const recovery = recoveryTarget ? { ...sourceBlocks[recoveryTarget]!, target: recoveryTarget } : null;
  const operationBlocked = Boolean(sourceBlocks.gateway || sourceBlocks.admin);
  const recoveryOwner = settingsOwner.current;

  function detachOperation(): void {
    const operation = activeRequest.current?.operation;
    if (operation && operation.store.getSnapshot()[operation.source]?.phase === 'pending') {
      operation.store.block(operation.source, operation.token, 'unknown');
    }
    const owner = settingsOwner.current;
    if (owner) configurationOperationStore(owner.api).invalidateReviews(owner);
  }

  function hasCurrentSettings(): boolean {
    return connection.current.connected && connection.current.api === api
      && settingsOwner.current?.api === api && settingsOwner.current.epoch === epoch.current;
  }

  function beginRequest(requireSettings = true): SettingsRequest | null {
    if (!connection.current.connected || connection.current.api !== api || activeRequest.current
      || requireSettings && !hasCurrentSettings()) return null;
    const request = { api, epoch: epoch.current, generation: ++generation.current, controller: new AbortController() };
    activeRequest.current = request;
    return request;
  }

  function isCurrent(request: SettingsRequest): boolean {
    return !request.controller.signal.aborted && activeRequest.current === request
      && request.epoch === epoch.current && request.generation === generation.current
      && connection.current.connected && connection.current.api === request.api;
  }

  function finishRequest(request: SettingsRequest): void {
    if (!isCurrent(request)) return;
    activeRequest.current = null;
    setLoading(false);
    setSaving(null);
    setApplying(null);
  }

  function beginOperation(request: SettingsRequest, source: ConfigurationOperationSource, revision: string, action: 'save' | 'apply'): boolean {
    const token = operationStore.begin(source, revision, action);
    if (!token) {
      finishRequest(request);
      return false;
    }
    request.operation = { store: operationStore, source, token };
    return true;
  }

  function ownsOperation(request: SettingsRequest): boolean {
    const operation = request.operation;
    const block = operation?.store.getSnapshot()[operation.source];
    return isCurrent(request) && Boolean(operation && block?.phase === 'pending' && block.token === operation.token);
  }

  function completeOperation(request: SettingsRequest): void {
    const operation = request.operation;
    if (operation) operation.store.complete(operation.source, operation.token);
  }

  async function loadSettings(request: SettingsRequest, preserveDrafts = true): Promise<boolean> {
    const result = await readResource(request.api, '/api/settings', request.controller.signal);
    if (!isCurrent(request)) return false;
    if (request.review) {
      const block = operationStore.getSnapshot()[request.review.source];
      if (block?.token !== request.review.token || block.phase !== 'blocked') return false;
    }
    const next = parseSettings(result);
    if (settingsOwner.current?.api !== request.api || settingsOwner.current.epoch !== request.epoch) {
      settingsOwner.current = { api: request.api, epoch: request.epoch };
    }
    const retained = preserveDrafts ? retainedDraft(request.api, settingsDraftKey) : undefined;
    const gatewayDraft = retained !== undefined && !sameGateway(retained.gateway, gatewayForm(retained.settings.gateway.values));
    const adminDraft = retained !== undefined && (retained.admin.host !== retained.settings.admin.values.host || retained.admin.port !== retained.settings.admin.values.port);
    setSettings({ ...next, gateway: gatewayDraft ? retained.settings.gateway : next.gateway, admin: adminDraft ? retained.settings.admin : next.admin });
    setGateway(gatewayDraft ? retained.gateway : gatewayForm(next.gateway.values));
    setAdmin(adminDraft ? retained.admin : next.admin.values);
    setGatewayErrors({});
    setAdminErrors({});
    setLoadError('');
    return true;
  }

  async function reloadSettings(): Promise<void> {
    const request = beginRequest(false);
    if (!request) return;
    setLoading(true);
    try {
      await loadSettings(request);
      if (!isCurrent(request)) return;
    } catch (error) {
      if (isCurrent(request)) setLoadError(errorMessage(error));
    } finally {
      finishRequest(request);
    }
  }

  useEffect(() => {
    epoch.current++;
    detachOperation();
    activeRequest.current?.controller.abort();
    activeRequest.current = null;
    settingsOwner.current = null;
    const retained = connected ? retainedDraft(api, settingsDraftKey) : undefined;
    setSettings(retained?.settings ?? null);
    setGateway(retained?.gateway ?? null);
    setAdmin(retained?.admin ?? null);
    setPendingGatewayRevision(null);
    setPendingAdminRevision(null);
    setReconnectUrl(null);
    setGatewayErrors({});
    setAdminErrors({});
    setSaving(null);
    setApplying(null);
    setLoading(false);
    setLoadError('');
    if (connected) void reloadSettings();
    return () => {
      epoch.current++;
      detachOperation();
      activeRequest.current?.controller.abort();
      activeRequest.current = null;
      settingsOwner.current = null;
    };
  }, [api, connected, operationStore]);

  const gatewayDirty = settings !== null && gateway !== null
    && !sameGateway(gateway, gatewayForm(settings.gateway.values));
  const adminDirty = settings !== null && admin !== null
    && (admin.host !== settings.admin.values.host || admin.port !== settings.admin.values.port);
  const dirty = gatewayDirty || adminDirty;

  useEffect(() => {
    if (hasCurrentSettings() && settings && gateway && admin) retainDraft(api, settingsDraftKey, dirty ? { settings, gateway, admin } : null);
    setDirty(dirty, 'settings');
  }, [api, settings, gateway, admin, configurationDirty, dirty, setDirty]);
  useEffect(() => () => setDirty(false, 'settings'), [setDirty]);

  async function saveGateway(): Promise<void> {
    if (!settings || !gateway || !gatewayDirty || !hasCurrentSettings() || Object.keys(operationStore.getSnapshot()).length > 0) return;
    const errors = validateGateway(gateway);
    setGatewayErrors(errors);
    if (Object.keys(errors).length > 0) {
      toast.error('请先修正网关设置中的数值范围。');
      return;
    }
    const values = gatewayPayload(gateway);
    const request = beginRequest();
    if (!request) return;
    if (!beginOperation(request, 'gateway', settings.gateway.revision, 'save')) return;
    setSaving('gateway');
    try {
      const result = await writeResource(request.api, '/api/settings/gateway', {
        revision: settings.gateway.revision,
        values,
      }, request.controller.signal);
      if (!ownsOperation(request)) return;
      const revision = responseRevision(result);
      completeOperation(request);
      setSettings(current => current ? { ...current, gateway: { revision, values } } : current);
      setGateway(gatewayForm(values));
      setPendingGatewayRevision(revision);
      toast.success('网关设置已保存，尚未应用。');
    } catch (error) {
      if (ownsOperation(request)) handleWriteError(request, error);
    } finally {
      finishRequest(request);
    }
  }

  async function saveAdmin(): Promise<void> {
    if (!settings || !admin || !adminDirty || !hasCurrentSettings() || Object.keys(operationStore.getSnapshot()).length > 0) return;
    const values = { host: admin.host.trim(), port: admin.port };
    const errors = validateAdmin(values);
    setAdminErrors(errors);
    if (Object.keys(errors).length > 0) {
      toast.error('请先修正管理端监听设置。');
      return;
    }
    const request = beginRequest();
    if (!request) return;
    if (!beginOperation(request, 'admin', settings.admin.revision, 'save')) return;
    setSaving('admin');
    try {
      const result = await writeResource(request.api, '/api/settings/admin', {
        revision: settings.admin.revision,
        values,
      }, request.controller.signal);
      if (!ownsOperation(request)) return;
      const revision = responseRevision(result);
      completeOperation(request);
      setSettings(current => current ? { ...current, admin: { revision, values } } : current);
      setAdmin(values);
      setPendingAdminRevision(revision);
      setReconnectUrl(null);
      toast.success('管理端设置已保存，尚未应用。');
    } catch (error) {
      if (ownsOperation(request)) handleWriteError(request, error);
    } finally {
      finishRequest(request);
    }
  }

  function handleWriteError(request: SettingsRequest, error: unknown): void {
    const operation = request.operation;
    if (!operation) return;
    if (!(error instanceof ApiError) || error.status >= 500 || /unknown|conflict|stale|revision/.test(error.code)) {
      operation.store.block(operation.source, operation.token, error instanceof ApiError && error.status === 409 ? 'conflict' : 'unknown');
    } else {
      completeOperation(request);
    }
    toast.error(settingsError(error));
  }

  async function refreshAfterApply(request: SettingsRequest): Promise<void> {
    try {
      await loadSettings(request);
      if (!isCurrent(request)) return;
      await refresh();
      if (!isCurrent(request)) return;
    } catch (error) {
      if (isCurrent(request)) toast.error(`设置已应用，但刷新状态失败。${errorMessage(error)}`);
    }
  }

  async function apply(target: 'gateway' | 'admin'): Promise<void> {
    const revision = target === 'gateway' ? settings?.gateway.revision : settings?.admin.revision;
    if (!revision || dirty || Object.keys(operationStore.getSnapshot()).length > 0
      || !(target === 'gateway' ? settings?.capabilities.applyGateway : settings?.capabilities.applyAdmin)) return;
    const request = beginRequest();
    if (!request) return;
    if (!beginOperation(request, target, revision, 'apply')) return;
    setApplying(target);
    try {
      const result = await writeResource(request.api, '/api/settings/apply', { target, revision }, request.controller.signal);
      if (!ownsOperation(request)) return;
      const response = asRecord(result);
      const application = asRecord(response.application);
      if (response.ok !== true || response.target !== target || response.revision !== revision) {
        throw new Error('invalid_settings_apply_response');
      }
      if (application.applied === true) {
        completeOperation(request);
        if (target === 'gateway') setPendingGatewayRevision(null);
        else setPendingAdminRevision(null);
        toast.success(target === 'gateway' ? '网关设置已应用。' : '管理端设置已应用。');
        await refreshAfterApply(request);
        if (!isCurrent(request)) return;
        return;
      }
      if (target === 'admin' && application.accepted === true) {
        let destination = application.reconnectUrl;
        if (typeof destination !== 'string' && typeof application.port === 'number'
          && Number.isSafeInteger(application.port) && application.port >= 1 && application.port <= 65_535) {
          const address = new URL(window.location.origin);
          address.port = String(application.port);
          destination = address.toString();
        }
        const nextUrl = safeReconnectUrl(destination);
        if (nextUrl === null) throw new Error('invalid_reconnect_url');
        setPendingAdminRevision(null);
        setReconnectUrl(nextUrl);
        const operation = request.operation;
        if (operation) operation.store.block(target, operation.token, 'accepted');
        toast.info('管理端正在重启，请使用新地址重新连接。');
        return;
      }
      throw new Error('invalid_settings_apply_response');
    } catch (error) {
      if (ownsOperation(request)) handleWriteError(request, error);
    } finally {
      finishRequest(request);
    }
  }

  async function recheck(owner: SettingsOwner | null): Promise<void> {
    const block = recovery && operationStore.getSnapshot()[recovery.target];
    if (!recovery || !owner || settingsOwner.current !== owner || block?.token !== recovery.token || block.phase !== 'blocked') return;
    const request = beginRequest();
    if (!request) return;
    request.review = { source: recovery.target, token: recovery.token };
    operationStore.review(recovery.target, recovery.token, null);
    setLoading(true);
    try {
      const loaded = await loadSettings(request, true);
      if (!loaded || !isCurrent(request) || settingsOwner.current !== owner) return;
      operationStore.review(recovery.target, recovery.token, owner);
    } catch (error) {
      if (isCurrent(request)) setLoadError(errorMessage(error));
    } finally {
      finishRequest(request);
    }
  }

  function allowNewOperation(owner: SettingsOwner | null): void {
    if (!hasCurrentSettings() || activeRequest.current || !recovery || !owner || settingsOwner.current !== owner
      || !operationStore.release(recovery.target, recovery.token, owner)) return;
    if (recovery.target === 'gateway') setPendingGatewayRevision(null);
    else setPendingAdminRevision(null);
    setReconnectUrl(null);
  }

  function resetGateway(): void {
    if (!settings || !hasCurrentSettings() || activeRequest.current || Object.keys(operationStore.getSnapshot()).length > 0) return;
    setGateway(gatewayForm(settings.gateway.values));
    setGatewayErrors({});
  }

  function resetAdmin(): void {
    if (!settings || !hasCurrentSettings() || activeRequest.current || Object.keys(operationStore.getSnapshot()).length > 0) return;
    setAdmin(settings.admin.values);
    setAdminErrors({});
  }

  let content;
  if (!connected) {
    content = <ConnectPrompt connect={connect} />;
  } else if (loading && !settings) {
    content = <Section title="正在读取运行设置"><div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在连接配置服务</div></Section>;
  } else if (!settings || !gateway || !admin) {
    content = <Section title="暂时无法读取设置" description={loadError || '配置服务返回了无法识别的内容。'}><Button variant="outline" disabled={loading} onClick={() => void reloadSettings()}><RotateCw className="size-4" />重新读取</Button></Section>;
  } else {
    const busy = loading || saving !== null || applying !== null || operationBlocked || !hasCurrentSettings();
    content = <>
      {operationBlocked && !recovery && saving === null && applying === null && <p role="status" className="text-xs text-muted-foreground">同一配置来源有操作进行中，保存和应用暂时锁定。</p>}
      {recovery && <div role="alert" className="h-48 space-y-2 overflow-y-auto rounded-lg border p-4 text-xs leading-6">
        <StatusPill tone="warning">结果待确认 · 写入已冻结</StatusPill>
        <p>{recovery.target === 'gateway' ? '网关' : '管理端'}{recovery.action === 'apply' ? '应用或重启' : '保存'}尚未确认结束。不会自动重试；重新读取只核对配置，即使内容相等也不能证明外部重启完成。</p>
        <p>请先重新读取，再在外部核实先前操作已经结束。确认后仅允许发起新操作，不表示旧操作成功或可安全重放；未保存草稿会保留。</p>
        {loadError && <p className="text-destructive">{loadError}</p>}
        {recovery.reviewedBy === recoveryOwner && <p role="status">已重新读取配置，外部操作结果仍待人工核实。</p>}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={loading || saving !== null || applying !== null} onClick={() => void recheck(recoveryOwner)}>{loading ? '正在核对' : '重新读取并核对'}</Button>
          <Button variant="outline" disabled={loading || recovery.reviewedBy !== recoveryOwner} onClick={() => allowNewOperation(recoveryOwner)}>确认旧操作已结束，允许新操作</Button>
        </div>
      </div>}
      <details id="program-gateway-settings" className="min-w-0 rounded-lg border bg-card">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">程序出站网关：期限与发送额度（高级）</summary>
        <div className="grid max-h-[40rem] gap-4 overflow-auto overscroll-contain border-t p-4">
          <p className="text-xs leading-6 text-muted-foreground">这些参数用于程序直接调用独立出站接口时的请求和发送授权。主聊天的单次处理期限与超时回复在“回复与超时”中设置；各自保存和应用。</p>
      <Section id={nativeFormMetadata.budget.id} title={nativeFormMetadata.budget.title} description="限制独立出站网关的发送授权次数和有效时间；关闭额度限制会保留已填写的值。">
        <div className="divide-y">
          <ToggleField label={nativeFormMetadata.budget.fields.enabled} description="开启后，每次授权按次数与有效时间限制；关闭时保留下面的数值供以后恢复。" checked={gateway.budgetEnabled} disabled={busy} onChange={budgetEnabled => setGateway(current => current ? { ...current, budgetEnabled } : current)} />
          <div hidden={!gateway.budgetEnabled} className={gateway.budgetEnabled ? 'grid gap-5 py-5 sm:grid-cols-2' : 'hidden'}>
            <div><NumberField label={nativeFormMetadata.budget.fields.uses} description="不设值代表次数无限。" unit="次" min={1} value={gateway.maxSendUses} disabled={!gateway.budgetEnabled || busy} onChange={maxSendUses => setGateway(current => current ? { ...current, maxSendUses } : current)} />{gatewayErrors.maxSendUses && <p className="mt-2 text-xs text-destructive" role="alert">{gatewayErrors.maxSendUses}</p>}</div>
            <div><NumberField label={nativeFormMetadata.budget.fields.ttl} description="支持小数；不设值代表时间无限，最长 168 小时。" unit="小时" min={1 / 3_600} max={168} value={gateway.grantTtlHours} disabled={!gateway.budgetEnabled || busy} onChange={grantTtlHours => setGateway(current => current ? { ...current, grantTtlHours } : current)} />{gatewayErrors.grantTtlHours && <p className="mt-2 text-xs text-destructive" role="alert">{gatewayErrors.grantTtlHours}</p>}</div>
          </div>
        </div>
      </Section>
      <Section id={nativeFormMetadata.constraints.id} title={nativeFormMetadata.constraints.title} description="控制独立出站接口请求期限、并发量、请求大小与持久记录容量。" footer={<SaveBar dirty={gatewayDirty} saving={saving === 'gateway'} disabled={busy} message={recovery ? '结果待确认，写入已冻结' : pendingGatewayRevision ? '网关设置已保存，尚未应用' : gatewayDirty ? undefined : settings.capabilities.applyGateway ? '已载入保存的网关配置' : '保存后需手动重启网关'} onSave={() => void saveGateway()} onReset={busy ? undefined : resetGateway}><Button variant="outline" disabled={dirty || busy || !settings.capabilities.applyGateway} onClick={() => void apply('gateway')}>{applying === 'gateway' && <LoaderCircle className="size-4 animate-spin" />}{applying === 'gateway' ? '正在应用' : '应用到网关'}</Button></SaveBar>}>
        <div className="grid gap-5 sm:grid-cols-2">
          <div><NumberField label={nativeFormMetadata.constraints.fields.timeout} description="允许 0.01 到 120 秒。" unit="秒" min={0.01} max={120} value={gateway.timeoutSeconds} disabled={busy} onChange={timeoutSeconds => setGateway(current => current ? { ...current, timeoutSeconds } : current)} />{gatewayErrors.timeoutSeconds && <p className="mt-2 text-xs text-destructive" role="alert">{gatewayErrors.timeoutSeconds}</p>}</div>
          <div><NumberField label={nativeFormMetadata.constraints.fields.pending} description="同时等待处理的请求数量。" unit="个" min={1} max={64} value={gateway.maxPending} disabled={busy} onChange={maxPending => setGateway(current => current ? { ...current, maxPending } : current)} />{gatewayErrors.maxPending && <p className="mt-2 text-xs text-destructive" role="alert">{gatewayErrors.maxPending}</p>}</div>
          <div><NumberField label={nativeFormMetadata.constraints.fields.body} description="允许约 0.001 到 32 MB。" unit="MB" min={1 / 1_024} max={32} value={gateway.maxBodyMegabytes} disabled={busy} onChange={maxBodyMegabytes => setGateway(current => current ? { ...current, maxBodyMegabytes } : current)} />{gatewayErrors.maxBodyMegabytes && <p className="mt-2 text-xs text-destructive" role="alert">{gatewayErrors.maxBodyMegabytes}</p>}</div>
          <div><NumberField label={nativeFormMetadata.constraints.fields.records} description="允许 100 到 100000 条。" unit="条" min={100} max={100_000} value={gateway.maxRecords} disabled={busy} onChange={maxRecords => setGateway(current => current ? { ...current, maxRecords } : current)} />{gatewayErrors.maxRecords && <p className="mt-2 text-xs text-destructive" role="alert">{gatewayErrors.maxRecords}</p>}</div>
        </div>
      </Section>
        </div>
      </details>
      <Section id={nativeFormMetadata.listener.id} title={nativeFormMetadata.listener.title} description="配置工作台监听的本机地址与端口。更改后需要单独应用并重新连接。" footer={<SaveBar dirty={adminDirty} saving={saving === 'admin'} disabled={busy} message={reconnectUrl ? '正在重启，使用新地址重新连接' : recovery ? '结果待确认，写入已冻结' : pendingAdminRevision ? '管理端设置已保存，尚未应用' : adminDirty ? undefined : settings.capabilities.applyAdmin ? '已载入保存的管理端配置' : '保存后需手动重启管理端'} onSave={() => void saveAdmin()} onReset={busy ? undefined : resetAdmin}><Button variant="outline" disabled={dirty || busy || !settings.capabilities.applyAdmin} onClick={() => void apply('admin')}>{applying === 'admin' && <LoaderCircle className="size-4 animate-spin" />}{applying === 'admin' ? '正在提交重启' : '应用并重启'}</Button></SaveBar>}>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={nativeFormMetadata.listener.fields.host} description="可填写 localhost、IPv4 或 IPv6 地址。" error={adminErrors.host}><Input value={admin.host} disabled={busy} spellCheck={false} onChange={event => setAdmin(current => current ? { ...current, host: event.target.value } : current)} placeholder="127.0.0.1" /></Field>
          <div><NumberField label={nativeFormMetadata.listener.fields.port} description="允许 1 到 65535。" min={1} max={65_535} value={admin.port} disabled={busy} onChange={port => setAdmin(current => current ? { ...current, port: port ?? 0 } : current)} />{adminErrors.port && <p className="mt-2 text-xs text-destructive" role="alert">{adminErrors.port}</p>}</div>
        </div>
        {reconnectUrl && <div className="mt-5 flex flex-col items-start gap-2 rounded-lg border p-4"><StatusPill tone="warning">重启已受理</StatusPill><p className="text-xs leading-6 text-muted-foreground">管理端正在重启。新页面不会自动携带当前访问令牌，请重新登录。</p><a href={reconnectUrl} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1.5 break-all text-xs font-medium text-primary underline underline-offset-4">{reconnectUrl}<ExternalLink className="size-3.5 shrink-0" /></a></div>}
      </Section>
    </>;
  }

  return <div className="page-stack" data-page="settings">
    {props.embedded ? <h2 className="text-base font-semibold">聊天处理与管理服务</h2> : <PageHeading title="运行设置" description="管理发送预算、网关容量和工作台监听地址。保存不会自动应用到运行中的服务。" />}
    <ChatExecutionSettings {...props} />
    {content}
    {connected && <details className="min-w-0 rounded-lg border bg-card">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">程序出站网关：身份与协议（高级）</summary>
      <div className="grid max-h-[32rem] gap-4 overflow-auto overscroll-contain border-t p-4">
        <p className="text-xs leading-6 text-muted-foreground">仅供程序直接调用独立出站接口时配置。下面的标识与版本是该接口核对发送权限的协议字段，不是伙伴人设，也不决定聊天时的身份与表达。普通聊天无需修改；保存不会更改人设库或自动应用。</p>
        <ConfigurationEditor category="settings" {...props} setDirty={(value, scope) => { setConfigurationDirty(value); setDirty(value, scope); }} />
      </div>
    </details>}
  </div>;
}
