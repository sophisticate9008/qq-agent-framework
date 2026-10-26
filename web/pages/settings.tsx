import { createDraftKey, retainDraft, retainedDraft } from '../lib/retained-drafts.ts';
import { readResource, writeResource } from '../lib/resource-reader.ts';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ExternalLink, LoaderCircle, RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import { ConfigurationEditor } from '../components/configuration-editor.tsx';
import { ChatExecutionSettings } from '../components/chat-execution-settings.tsx';
import { ConnectPrompt, Field, PageHeading, SaveBar, Section, StatusPill } from '../components/management.tsx';
import { SettingsWindow } from '../components/settings-window.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { ApiError, asRecord, errorMessage } from '../lib/api.ts';
import { nativeFormMetadata } from '../lib/native-form-metadata.ts';
import { configurationOperationStore, type ConfigurationOperationSource } from '../lib/configuration-operation-recovery.ts';
import type { PageProps } from '../lib/types.ts';

interface AdminValues {
  host: string;
  port: number;
}

interface SettingsState {
  admin: { revision: string; values: AdminValues };
  capabilities: { applyAdmin: boolean };
}

const settingsDraftKey = createDraftKey<{ readonly settings: SettingsState; readonly admin: AdminValues }>('settings');

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
  const admin = asRecord(root.admin);
  const values = asRecord(admin.values);
  const capabilities = asRecord(root.capabilities);
  if (typeof admin.revision !== 'string' || typeof values.host !== 'string' || typeof values.port !== 'number'
    || typeof capabilities.applyAdmin !== 'boolean') throw new Error('invalid_settings_response');
  return { admin: { revision: admin.revision, values: { host: values.host, port: values.port } },
    capabilities: { applyAdmin: capabilities.applyAdmin } };
}

function integerError(value: number | null, minimum: number, maximum: number, label: string): string | undefined {
  if (value === null || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return `${label}需为 ${minimum} 到 ${maximum} 的整数。`;
  }
  return undefined;
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
  const [admin, setAdmin] = useState<AdminValues | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState<'admin' | null>(null);
  const [applying, setApplying] = useState<'admin' | null>(null);
  const [adminErrors, setAdminErrors] = useState<AdminErrors>({});
  const [pendingAdminRevision, setPendingAdminRevision] = useState<string | null>(null);
  const [reconnectUrl, setReconnectUrl] = useState<string | null>(null);
  const epoch = useRef(0);
  const generation = useRef(0);
  const activeRequest = useRef<SettingsRequest | null>(null);
  const settingsOwner = useRef<SettingsOwner | null>(null);
  const connection = useRef({ api, connected });
  connection.current = { api, connected };
  const recoveryTarget = sourceBlocks.admin?.phase === 'blocked' ? 'admin' as const : null;
  const recovery = recoveryTarget ? { ...sourceBlocks[recoveryTarget]!, target: recoveryTarget } : null;
  const operationBlocked = Boolean(sourceBlocks.admin);
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
    const adminDraft = retained !== undefined && (retained.admin.host !== retained.settings.admin.values.host || retained.admin.port !== retained.settings.admin.values.port);
    setSettings({ ...next, admin: adminDraft ? retained.settings.admin : next.admin });
    setAdmin(adminDraft ? retained.admin : next.admin.values);
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
    setAdmin(retained?.admin ?? null);
    setPendingAdminRevision(null);
    setReconnectUrl(null);
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

  const adminDirty = settings !== null && admin !== null
    && (admin.host !== settings.admin.values.host || admin.port !== settings.admin.values.port);
  const dirty = adminDirty;

  useEffect(() => {
    if (hasCurrentSettings() && settings && admin) retainDraft(api, settingsDraftKey, dirty ? { settings, admin } : null);
    setDirty(dirty, 'settings');
  }, [api, settings, admin, dirty, setDirty]);
  useEffect(() => () => setDirty(false, 'settings'), [setDirty]);

  async function saveAdmin(): Promise<void> {
    if (!settings || !admin || !adminDirty || !hasCurrentSettings() || Boolean(operationStore.getSnapshot().admin)) return;
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

  async function apply(target: 'admin'): Promise<void> {
    const revision = settings?.admin.revision;
    if (!revision || dirty || Boolean(operationStore.getSnapshot().admin)
      || !settings?.capabilities.applyAdmin) return;
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
        setPendingAdminRevision(null);
        toast.success('管理端设置已应用。');
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
    setPendingAdminRevision(null);
    setReconnectUrl(null);
  }

  function resetAdmin(): void {
    if (!settings || !hasCurrentSettings() || activeRequest.current || Boolean(operationStore.getSnapshot().admin)) return;
    setAdmin(settings.admin.values);
    setAdminErrors({});
  }

  let content;
  if (!connected) {
    content = <ConnectPrompt connect={connect} />;
  } else if (loading && !settings) {
    content = <Section title="正在读取运行设置"><div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在连接配置服务</div></Section>;
  } else if (!settings || !admin) {
    content = <Section title="暂时无法读取设置" description={loadError || '配置服务返回了无法识别的内容。'}><Button variant="outline" disabled={loading} onClick={() => void reloadSettings()}><RotateCw className="size-4" />重新读取</Button></Section>;
  } else {
    const busy = loading || saving !== null || applying !== null || operationBlocked || !hasCurrentSettings();
    content = <>
      {operationBlocked && !recovery && saving === null && applying === null && <p role="status" className="text-xs text-muted-foreground">同一配置来源有操作进行中，保存和应用暂时锁定。</p>}
      {recovery && <div role="alert" className="max-h-48 space-y-2 overflow-y-auto rounded-lg border p-4 text-xs leading-6">
        <StatusPill tone="warning">结果待确认 · 写入已冻结</StatusPill>
        <p>管理端{recovery.action === 'apply' ? '应用或重启' : '保存'}尚未确认结束。不会自动重试；重新读取只核对配置，即使内容相等也不能证明外部重启完成。</p>
        <p>请先重新读取，再在外部核实先前操作已经结束。确认后仅允许发起新操作，不表示旧操作成功或可安全重放；未保存草稿会保留。</p>
        {loadError && <p className="text-destructive">{loadError}</p>}
        {recovery.reviewedBy === recoveryOwner && <p role="status">已重新读取配置，外部操作结果仍待人工核实。</p>}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={loading || saving !== null || applying !== null} onClick={() => void recheck(recoveryOwner)}>{loading ? '正在核对' : '重新读取并核对'}</Button>
          <Button variant="outline" disabled={loading || recovery.reviewedBy !== recoveryOwner} onClick={() => allowNewOperation(recoveryOwner)}>确认旧操作已结束，允许新操作</Button>
        </div>
      </div>}
      <Section id={nativeFormMetadata.listener.id} title="管理服务" actions={<Button variant="ghost" size="sm" disabled={loading || saving !== null || applying !== null || adminDirty && !operationBlocked} onClick={() => void reloadSettings()}><RotateCw className="size-3.5" />重新读取</Button>}
        footer={<SaveBar dirty={adminDirty} saving={saving === 'admin'} disabled={busy} message={recovery ? '结果待确认，写入已冻结' : pendingAdminRevision ? '已保存，尚未应用；重启后需重新登录' : '先保存，再应用并重启；重启后需重新登录'} onSave={() => void saveAdmin()} onReset={busy ? undefined : resetAdmin} label="保存监听设置">
          <SettingsWindow title="管理端高级设置" label="高级设置" description="调整低频管理服务参数；关闭窗口保留未保存草稿。"><ConfigurationEditor category="settings" {...props} /></SettingsWindow>
          <SettingsWindow title="应用并重启管理端" label="应用并重启" description="使用已保存的监听设置重启管理服务。"><div className="stack"><dl className="info"><dt>监听地址</dt><dd>{settings.admin.values.host}</dd><dt>监听端口</dt><dd>{settings.admin.values.port}</dd></dl><div className="strip warn">重启会断开当前管理连接。重新打开页面后，需使用管理员令牌登录。</div>{dirty && <p className="small muted">请先保存或撤销当前监听草稿。</p>}{!settings.capabilities.applyAdmin && <p className="small muted">当前宿主不支持在线应用，保存后需手动重启管理端。</p>}{recovery && <p className="small muted">先核对原操作，再允许新的重启请求。</p>}<div className="actions border-t pt-2"><Button disabled={dirty || busy || !settings.capabilities.applyAdmin} onClick={() => void apply('admin')}>{applying === 'admin' && <LoaderCircle className="size-3.5 animate-spin" />}{applying === 'admin' ? '正在提交重启' : '应用并重启'}</Button></div></div></SettingsWindow>
        </SaveBar>}>
        <div className="stack"><div className="formgrid three">
          <Field id="settings-admin-host" label={nativeFormMetadata.listener.fields.host} tip="可填写 localhost、IPv4 或 IPv6，保存后需应用并重启。" error={adminErrors.host}>
            <Input id="settings-admin-host" value={admin.host} disabled={busy} spellCheck={false} aria-invalid={Boolean(adminErrors.host)} onChange={event => setAdmin(current => current ? { ...current, host: event.target.value } : current)} placeholder="127.0.0.1" />
          </Field>
          <Field id="settings-admin-port" label={nativeFormMetadata.listener.fields.port} tip="端口范围为 1 到 65535。" error={adminErrors.port}>
            <Input id="settings-admin-port" type="number" min={1} max={65_535} value={admin.port} disabled={busy} aria-invalid={Boolean(adminErrors.port)} onChange={event => setAdmin(current => current ? { ...current, port: event.target.value === '' ? 0 : Number(event.target.value) } : current)} />
          </Field>
          <div className="row"><span className="muted">应用状态</span><StatusPill tone={recovery ? 'warning' : 'neutral'}>{reconnectUrl ? '重启已受理' : recovery ? '结果待核对' : pendingAdminRevision ? '已保存 · 待应用' : adminDirty ? '草稿未保存' : '已载入保存配置'}</StatusPill></div>
        </div>
          {loadError && <p className="text-xs text-destructive" role="alert">读取失败，保留现有草稿：{loadError}</p>}
          {reconnectUrl && <div className="strip warn stack"><StatusPill tone="warning">重启已受理</StatusPill><p>管理端正在重启。新页面需重新登录。</p><a href={reconnectUrl} target="_blank" rel="noreferrer" className="row break-all text-xs text-primary underline underline-offset-4">{reconnectUrl}<ExternalLink className="size-3.5 shrink-0" /></a></div>}
        </div>
      </Section>
    </>;
  }

  return <div className="page-stack" data-page="settings">
    {!props.embedded && <PageHeading title="运行设置" description="聊天处理期限与管理服务。" />}
    {connected && !props.embedded && <ChatExecutionSettings {...props} />}
    {content}
  </div>;
}
