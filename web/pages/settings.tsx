import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, LoaderCircle, RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import { ConfigurationEditor } from '../components/configuration-editor.tsx';
import { ConnectPrompt, Field, NumberField, PageHeading, SaveBar, Section, StatusPill, ToggleField } from '../components/management.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { ApiError, asRecord, errorMessage } from '../lib/api.ts';
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

type GatewayErrors = Partial<Record<keyof GatewayForm, string>>;
type AdminErrors = Partial<Record<keyof AdminValues, string>>;

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

export function SettingsPage(props: PageProps) {
  const { api, connected, connect, refresh, setDirty } = props;
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

  const loadSettings = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const next = parseSettings(await api.get('/api/settings', signal));
    setSettings(next);
    setGateway(gatewayForm(next.gateway.values));
    setAdmin(next.admin.values);
    setGatewayErrors({});
    setAdminErrors({});
    setLoadError('');
  }, [api]);

  useEffect(() => {
    if (!connected) {
      setSettings(null);
      setGateway(null);
      setAdmin(null);
      setPendingGatewayRevision(null);
      setPendingAdminRevision(null);
      setReconnectUrl(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    void loadSettings(controller.signal).catch(error => {
      if (!controller.signal.aborted) setLoadError(errorMessage(error));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [connected, loadSettings]);

  const gatewayDirty = settings !== null && gateway !== null
    && !sameGateway(gateway, gatewayForm(settings.gateway.values));
  const adminDirty = settings !== null && admin !== null
    && (admin.host !== settings.admin.values.host || admin.port !== settings.admin.values.port);
  const dirty = gatewayDirty || adminDirty;

  useEffect(() => setDirty(dirty || configurationDirty), [configurationDirty, dirty, setDirty]);
  useEffect(() => () => setDirty(false), [setDirty]);

  async function saveGateway(): Promise<void> {
    if (!settings || !gateway || !gatewayDirty || saving !== null) return;
    const errors = validateGateway(gateway);
    setGatewayErrors(errors);
    if (Object.keys(errors).length > 0) {
      toast.error('请先修正网关设置中的数值范围。');
      return;
    }
    const values = gatewayPayload(gateway);
    setSaving('gateway');
    try {
      const revision = responseRevision(await api.post('/api/settings/gateway', {
        revision: settings.gateway.revision,
        values,
      }));
      setSettings(current => current ? { ...current, gateway: { revision, values } } : current);
      setGateway(gatewayForm(values));
      setPendingGatewayRevision(revision);
      toast.success('网关设置已保存，尚未应用。');
    } catch (error) {
      toast.error(settingsError(error));
    } finally {
      setSaving(null);
    }
  }

  async function saveAdmin(): Promise<void> {
    if (!settings || !admin || !adminDirty || saving !== null) return;
    const values = { host: admin.host.trim(), port: admin.port };
    const errors = validateAdmin(values);
    setAdminErrors(errors);
    if (Object.keys(errors).length > 0) {
      toast.error('请先修正管理端监听设置。');
      return;
    }
    setSaving('admin');
    try {
      const revision = responseRevision(await api.post('/api/settings/admin', {
        revision: settings.admin.revision,
        values,
      }));
      setSettings(current => current ? { ...current, admin: { revision, values } } : current);
      setAdmin(values);
      setPendingAdminRevision(revision);
      setReconnectUrl(null);
      toast.success('管理端设置已保存，尚未应用。');
    } catch (error) {
      toast.error(settingsError(error));
    } finally {
      setSaving(null);
    }
  }

  async function refreshAfterApply(): Promise<void> {
    try {
      await Promise.all([loadSettings(), refresh()]);
    } catch (error) {
      toast.error(`设置已应用，但刷新状态失败。${errorMessage(error)}`);
    }
  }

  async function apply(target: 'gateway' | 'admin'): Promise<void> {
    const revision = target === 'gateway' ? pendingGatewayRevision ?? settings?.gateway.revision : pendingAdminRevision ?? settings?.admin.revision;
    if (!revision || dirty || applying !== null || saving !== null) return;
    setApplying(target);
    try {
      const response = asRecord(await api.post('/api/settings/apply', { target, revision }));
      const application = asRecord(response.application);
      if (response.ok !== true || response.target !== target || response.revision !== revision) {
        throw new Error('invalid_settings_apply_response');
      }
      if (application.applied === true) {
        if (target === 'gateway') setPendingGatewayRevision(null);
        else setPendingAdminRevision(null);
        toast.success(target === 'gateway' ? '网关设置已应用。' : '管理端设置已应用。');
        await refreshAfterApply();
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
        toast.info('管理端正在重启，请使用新地址重新连接。');
        return;
      }
      throw new Error('invalid_settings_apply_response');
    } catch (error) {
      toast.error(settingsError(error));
    } finally {
      setApplying(null);
    }
  }

  function resetGateway(): void {
    if (!settings) return;
    setGateway(gatewayForm(settings.gateway.values));
    setGatewayErrors({});
  }

  function resetAdmin(): void {
    if (!settings) return;
    setAdmin(settings.admin.values);
    setAdminErrors({});
  }

  let content;
  if (!connected) {
    content = <ConnectPrompt connect={connect} />;
  } else if (loading && !settings) {
    content = <Section title="正在读取运行设置"><div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在连接配置服务</div></Section>;
  } else if (loadError || !settings || !gateway || !admin) {
    content = <Section title="暂时无法读取设置" description={loadError || '配置服务返回了无法识别的内容。'}><Button variant="outline" onClick={() => { setLoading(true); void loadSettings().catch(error => setLoadError(errorMessage(error))).finally(() => setLoading(false)); }}><RotateCw className="size-4" />重新读取</Button></Section>;
  } else {
    const busy = saving !== null || applying !== null;
    content = <>
      <Section title="运营预算" description="限制消息发送授权的次数和有效时间；关闭预算不会清空已填写的额度。">
        <div className="divide-y">
          <ToggleField label="启用发送预算" description="开启后，每次授权按次数与有效时间限制；关闭时保留下面的数值供以后恢复。" checked={gateway.budgetEnabled} disabled={busy} onChange={budgetEnabled => setGateway(current => current ? { ...current, budgetEnabled } : current)} />
          <div className="grid gap-5 py-5 sm:grid-cols-2">
            <div><NumberField label="每次授权最多发送" description="不设值代表次数无限。" unit="次" min={1} value={gateway.maxSendUses} disabled={!gateway.budgetEnabled || busy} onChange={maxSendUses => setGateway(current => current ? { ...current, maxSendUses } : current)} />{gatewayErrors.maxSendUses && <p className="mt-2 text-xs text-destructive" role="alert">{gatewayErrors.maxSendUses}</p>}</div>
            <div><NumberField label="授权有效时间" description="支持小数；不设值代表时间无限，最长 168 小时。" unit="小时" min={1 / 3_600} max={168} value={gateway.grantTtlHours} disabled={!gateway.budgetEnabled || busy} onChange={grantTtlHours => setGateway(current => current ? { ...current, grantTtlHours } : current)} />{gatewayErrors.grantTtlHours && <p className="mt-2 text-xs text-destructive" role="alert">{gatewayErrors.grantTtlHours}</p>}</div>
          </div>
        </div>
      </Section>
      <Section title="技术约束" description="控制网关等待时间、并发量、请求大小与持久记录容量。" footer={<SaveBar dirty={gatewayDirty} saving={saving === 'gateway'} message={pendingGatewayRevision ? '网关设置已保存，尚未应用' : gatewayDirty ? undefined : settings.capabilities.applyGateway ? '已载入保存的网关配置' : '保存后需手动重启网关'} onSave={() => void saveGateway()} onReset={resetGateway}><Button variant="outline" disabled={dirty || busy || !settings.capabilities.applyGateway} onClick={() => void apply('gateway')}>{applying === 'gateway' && <LoaderCircle className="size-4 animate-spin" />}{applying === 'gateway' ? '正在应用' : '应用到网关'}</Button></SaveBar>}>
        <div className="grid gap-5 sm:grid-cols-2">
          <div><NumberField label="请求超时" description="允许 0.01 到 120 秒。" unit="秒" min={0.01} max={120} value={gateway.timeoutSeconds} disabled={busy} onChange={timeoutSeconds => setGateway(current => current ? { ...current, timeoutSeconds } : current)} />{gatewayErrors.timeoutSeconds && <p className="mt-2 text-xs text-destructive" role="alert">{gatewayErrors.timeoutSeconds}</p>}</div>
          <div><NumberField label="并发请求上限" description="同时等待处理的请求数量。" unit="个" min={1} max={64} value={gateway.maxPending} disabled={busy} onChange={maxPending => setGateway(current => current ? { ...current, maxPending } : current)} />{gatewayErrors.maxPending && <p className="mt-2 text-xs text-destructive" role="alert">{gatewayErrors.maxPending}</p>}</div>
          <div><NumberField label="单次请求体上限" description="允许约 0.001 到 32 MB。" unit="MB" min={1 / 1_024} max={32} value={gateway.maxBodyMegabytes} disabled={busy} onChange={maxBodyMegabytes => setGateway(current => current ? { ...current, maxBodyMegabytes } : current)} />{gatewayErrors.maxBodyMegabytes && <p className="mt-2 text-xs text-destructive" role="alert">{gatewayErrors.maxBodyMegabytes}</p>}</div>
          <div><NumberField label="持久记录上限" description="允许 100 到 100000 条。" unit="条" min={100} max={100_000} value={gateway.maxRecords} disabled={busy} onChange={maxRecords => setGateway(current => current ? { ...current, maxRecords } : current)} />{gatewayErrors.maxRecords && <p className="mt-2 text-xs text-destructive" role="alert">{gatewayErrors.maxRecords}</p>}</div>
        </div>
      </Section>
      <Section title="管理端监听" description="配置工作台监听的本机地址与端口。更改后需要单独应用并重新连接。" footer={<SaveBar dirty={adminDirty} saving={saving === 'admin'} message={reconnectUrl ? '正在重启，使用新地址重新连接' : pendingAdminRevision ? '管理端设置已保存，尚未应用' : adminDirty ? undefined : settings.capabilities.applyAdmin ? '已载入保存的管理端配置' : '保存后需手动重启管理端'} onSave={() => void saveAdmin()} onReset={resetAdmin}><Button variant="outline" disabled={dirty || busy || !settings.capabilities.applyAdmin} onClick={() => void apply('admin')}>{applying === 'admin' && <LoaderCircle className="size-4 animate-spin" />}{applying === 'admin' ? '正在提交重启' : '应用并重启'}</Button></SaveBar>}>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="监听地址" description="可填写 localhost、IPv4 或 IPv6 地址。" error={adminErrors.host}><Input value={admin.host} disabled={busy} spellCheck={false} onChange={event => setAdmin(current => current ? { ...current, host: event.target.value } : current)} placeholder="127.0.0.1" /></Field>
          <div><NumberField label="监听端口" description="允许 1 到 65535。" min={1} max={65_535} value={admin.port} disabled={busy} onChange={port => setAdmin(current => current ? { ...current, port: port ?? 0 } : current)} />{adminErrors.port && <p className="mt-2 text-xs text-destructive" role="alert">{adminErrors.port}</p>}</div>
        </div>
        {reconnectUrl && <div className="mt-5 flex flex-col items-start gap-2 rounded-lg border p-4"><StatusPill tone="warning">重启已受理</StatusPill><p className="text-xs leading-6 text-muted-foreground">管理端正在重启。新页面不会自动携带当前访问令牌，请重新登录。</p><a href={reconnectUrl} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1.5 break-all text-xs font-medium text-primary underline underline-offset-4">{reconnectUrl}<ExternalLink className="size-3.5 shrink-0" /></a></div>}
      </Section>
    </>;
  }

  return <div className="page-stack" data-page="settings">
    <PageHeading title="运行设置" description="管理发送预算、网关容量和工作台监听地址。保存不会自动应用到运行中的服务。" />
    {content}
    {connected && <ConfigurationEditor category="settings" {...props} setDirty={setConfigurationDirty} />}
  </div>;
}
