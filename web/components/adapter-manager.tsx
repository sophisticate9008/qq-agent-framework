import { useEffect, useRef, useState } from 'react';
import { CircleAlert, LoaderCircle, MessagesSquare, Play, RefreshCw, Server, ServerOff, ShieldCheck, Workflow } from 'lucide-react';
import { ApiError, asRecord, errorMessage } from '../lib/api.ts';
import type { PageProps } from '../lib/types.ts';
import { AdapterCredentialField, AdapterEndpointField, AdapterNumberField, unchangedCredential, type CredentialDraft } from './adapter-connection-fields.tsx';
import { ConnectPrompt, EmptyState, Field, PageHeading, SaveBar, Section, StatusPill, ToggleField } from './management.tsx';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';

type OutboundId = 'onebotHttp' | 'dshAgent';
type AdapterId = OutboundId | 'onebotWebhook';
type WriteState = 'idle' | 'saved' | 'error' | 'conflict' | 'busy' | 'unknown';

interface OutboundConfiguration {
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly credentialConfigured: boolean;
}

interface WebhookConfiguration {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly selfId: string;
  readonly hmacConfigured: boolean;
}

interface AdapterSnapshot {
  readonly revision: string;
  readonly outbound: Readonly<Record<OutboundId, OutboundConfiguration>>;
  readonly webhook: WebhookConfiguration;
  readonly status: {
    readonly assembled: boolean;
    readonly running: boolean;
    readonly applyAvailable: boolean;
  };
}

interface OutboundDraft {
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly credential: CredentialDraft;
}

interface WebhookDraft {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: string;
  readonly selfId: string;
  readonly credential: CredentialDraft;
}

interface AdapterDraft {
  readonly outbound: Readonly<Record<OutboundId, OutboundDraft>>;
  readonly webhook: WebhookDraft;
}

const definitions = [
  { id: 'onebotHttp', title: 'OneBot', description: '填写协议端提供的 HTTP API 地址和密钥，用于发送消息。接收消息另外设置 webhook。', credentialFlag: 'secretConfigured', credentialKey: 'secret', clearKey: 'clearSecret', credentialLabel: '协议端 API 密钥（可选）', credentialDescription: '复制协议端 HTTP 服务设置中的 accessToken。不是本管理后台的管理员令牌或登录会话；协议端未启用认证时可不填。', placeholder: 'http://127.0.0.1:3000', icon: MessagesSquare },
  { id: 'dshAgent', title: 'DSH 聊天引擎', description: '连接 agent 服务，处理会话与回复。', credentialFlag: 'authConfigured', credentialKey: 'auth', clearKey: 'clearAuth', credentialLabel: '引擎访问凭据', credentialDescription: '由 DSH 服务提供，与管理后台登录凭据分开。', placeholder: 'https://agent.example.com', icon: Workflow },
] as const;

function parseSnapshot(value: unknown): AdapterSnapshot | null {
  const root = asRecord(value);
  const adapters = asRecord(root.adapters);
  const status = asRecord(root.status);
  if (typeof root.revision !== 'string' || root.revision.length === 0
    || typeof status.assembled !== 'boolean' || typeof status.running !== 'boolean'
    || typeof status.applyAvailable !== 'boolean' || status.running && !status.assembled) return null;
  const outbound = {} as Record<OutboundId, OutboundConfiguration>;
  for (const definition of definitions) {
    const adapter = asRecord(adapters[definition.id]);
    const credentialConfigured = adapter[definition.credentialFlag];
    if (typeof adapter.enabled !== 'boolean' || typeof adapter.endpoint !== 'string'
      || typeof credentialConfigured !== 'boolean') return null;
    outbound[definition.id] = { enabled: adapter.enabled, endpoint: adapter.endpoint, credentialConfigured };
  }
  const webhook = asRecord(adapters.onebotWebhook);
  if (typeof webhook.enabled !== 'boolean' || typeof webhook.host !== 'string'
    || typeof webhook.port !== 'number' || !Number.isSafeInteger(webhook.port)
    || webhook.port < 0 || webhook.port > 65535 || typeof webhook.selfId !== 'string'
    || typeof webhook.hmacConfigured !== 'boolean') return null;
  return {
    revision: root.revision,
    outbound,
    webhook: { enabled: webhook.enabled, host: webhook.host, port: webhook.port, selfId: webhook.selfId, hmacConfigured: webhook.hmacConfigured },
    status: { assembled: status.assembled, running: status.running, applyAvailable: status.applyAvailable },
  };
}

function toDraft(snapshot: AdapterSnapshot): AdapterDraft {
  const outbound = {} as Record<OutboundId, OutboundDraft>;
  for (const definition of definitions) {
    const adapter = snapshot.outbound[definition.id];
    outbound[definition.id] = { enabled: adapter.enabled, endpoint: adapter.endpoint, credential: unchangedCredential };
  }
  return {
    outbound,
    webhook: { enabled: snapshot.webhook.enabled, host: snapshot.webhook.host, port: String(snapshot.webhook.port), selfId: snapshot.webhook.selfId, credential: unchangedCredential },
  };
}

function changedOutbound(saved: OutboundConfiguration, draft: OutboundDraft): boolean {
  return saved.enabled !== draft.enabled || saved.endpoint !== draft.endpoint.trim() || draft.credential.action !== 'keep';
}

function changedWebhook(saved: WebhookConfiguration, draft: WebhookDraft): boolean {
  return saved.enabled !== draft.enabled || saved.host !== draft.host || String(saved.port) !== draft.port
    || saved.selfId !== draft.selfId.trim() || draft.credential.action !== 'keep';
}

function clearCredentials(draft: AdapterDraft): AdapterDraft {
  return {
    outbound: {
      onebotHttp: { ...draft.outbound.onebotHttp, credential: unchangedCredential },
      dshAgent: { ...draft.outbound.dshAgent, credential: unchangedCredential },
    },
    webhook: { ...draft.webhook, credential: unchangedCredential },
  };
}

function credentialPatch(credential: CredentialDraft, key: string, clearKey: string): Record<string, string | boolean> {
  if (credential.action === 'clear') return { [clearKey]: true };
  return credential.action === 'replace' ? { [key]: credential.value } : {};
}

function loopbackHost(value: string): boolean {
  return value === 'localhost' || value === '::1'
    || /^127(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(value) && value.split('.').every(part => Number(part) <= 255);
}

function validEndpoint(value: string): boolean {
  if (value.length > 2048 || !/^https?:\/\//.test(value) || /[\u0000-\u0020\u007f\\?#]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;
    const authority = value.slice('http://'.length).split('/', 1)[0];
    const host = /^(localhost|127(?:\.[0-9]{1,3}){3}|\[::1\])(?::[0-9]{1,5})?$/.exec(authority ?? '')?.[1];
    return host !== undefined && loopbackHost(host === '[::1]' ? '::1' : host);
  } catch {
    return false;
  }
}

function credentialError(credential: CredentialDraft, label: string): string | null {
  return credential.action === 'replace' && !/^[\x21-\x7e]{1,4096}$/.test(credential.value)
    ? `${label}需要填写 1–4096 个可见英文字符，不含空格、换行或中文。`
    : null;
}

function validationError(snapshot: AdapterSnapshot, draft: AdapterDraft): string | null {
  for (const definition of definitions) {
    const adapter = draft.outbound[definition.id];
    if (!changedOutbound(snapshot.outbound[definition.id], adapter)) continue;
    const endpoint = adapter.endpoint.trim();
    if (adapter.enabled && endpoint === '' || endpoint !== '' && !validEndpoint(endpoint)) {
      return `${definition.title}需要有效的固定服务地址：本机可用 HTTP，远程请使用 HTTPS，地址中不要包含凭据、查询参数或片段。`;
    }
    const error = credentialError(adapter.credential, definition.credentialLabel);
    if (error) return error;
  }
  if (changedWebhook(snapshot.webhook, draft.webhook)) {
    const webhook = draft.webhook;
    const port = Number(webhook.port);
    if (!loopbackHost(webhook.host)) return 'webhook 监听地址需要使用本机回环地址，例如 127.0.0.1 或 ::1。';
    if (!/^\d+$/.test(webhook.port) || !Number.isSafeInteger(port) || port < 0 || port > 65535 || webhook.enabled && port === 0) {
      return 'webhook 监听端口必须在 1–65535 之间；停用时可保留为 0。';
    }
    if ((webhook.enabled || webhook.selfId.trim() !== '') && !/^[1-9][0-9]{0,31}$/.test(webhook.selfId.trim())) {
      return '请填写 webhook 机器人账号，使用 1–32 位正整数。';
    }
    const error = credentialError(webhook.credential, 'webhook 签名密钥');
    if (error) return error;
    const hasHmac = webhook.credential.action === 'replace'
      || webhook.credential.action === 'keep' && snapshot.webhook.hmacConfigured;
    if (webhook.enabled && !hasHmac) return '启用 webhook 前需要设置签名密钥。';
  }
  return null;
}

function writeState(error: unknown): WriteState {
  if (!(error instanceof ApiError)) return 'unknown';
  if (error.code === 'chat_storage_busy') return 'busy';
  if (/conflict|stale|revision/.test(error.code)) return 'conflict';
  if (/unknown/.test(error.code) || error.status >= 500) return 'unknown';
  return 'error';
}

function writeMessage(state: WriteState, dirty: boolean): string {
  if (state === 'saved') return '连接配置已保存到本机，实际运行状态尚未改变。';
  if (state === 'conflict') return '配置已在其他窗口更新，请先重新读取后再编辑。';
  if (state === 'busy') return '另一项配置正在保存，请稍后重新读取；不会自动重试。';
  if (state === 'unknown') return '保存结果未知，请先重新读取核对；不要重复提交。';
  return dirty ? '连接设置有尚未保存的更改。' : '已配置不代表运行中。';
}

function OutboundStatus({ adapter }: { readonly adapter: OutboundConfiguration }) {
  return <StatusPill>{adapter.endpoint ? adapter.enabled ? '已配置' : '已配置 · 未启用' : '未配置'}</StatusPill>;
}

export function AdapterManager({ api, connected, connect, setDirty }: PageProps) {
  const [snapshot, setSnapshot] = useState<AdapterSnapshot | null>(null);
  const [draft, setDraft] = useState<AdapterDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [formError, setFormError] = useState('');
  const [result, setResult] = useState<WriteState>('idle');
  const [reloadVersion, setReloadVersion] = useState(0);
  const saveController = useRef<AbortController | null>(null);
  const reportedDirty = useRef(false);
  const setDirtyRef = useRef(setDirty);
  const blocked = result === 'unknown' || result === 'conflict' || result === 'busy';
  const disabled = saving || loading || blocked;
  const dirty = snapshot !== null && draft !== null && (definitions.some(definition => changedOutbound(snapshot.outbound[definition.id], draft.outbound[definition.id])) || changedWebhook(snapshot.webhook, draft.webhook));

  useEffect(() => { setDirtyRef.current = setDirty; }, [setDirty]);
  useEffect(() => {
    if (reportedDirty.current === dirty) return;
    reportedDirty.current = dirty;
    setDirty(dirty, 'adapters');
  }, [dirty, setDirty]);
  useEffect(() => () => {
    saveController.current?.abort();
    setDirtyRef.current(false, 'adapters');
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setDraft(null);
    setSnapshot(null);
    setSaving(false);
    if (!connected) {
      setLoading(false);
      return () => controller.abort();
    }
    setLoading(true);
    setLoadError('');
    setFormError('');
    setResult('idle');
    void api.get('/api/chat/adapters', controller.signal).then(value => {
      if (controller.signal.aborted) return;
      const next = parseSnapshot(value);
      if (!next) throw new Error('invalid_adapters_response');
      setSnapshot(next);
      setDraft(toDraft(next));
    }).catch(error => {
      if (!controller.signal.aborted) setLoadError(errorMessage(error));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => {
      controller.abort();
      saveController.current?.abort();
    };
  }, [api, connected, reloadVersion]);

  function updateOutbound(id: OutboundId, patch: Partial<OutboundDraft>): void {
    if (disabled) return;
    setDraft(current => current ? { ...current, outbound: { ...current.outbound, [id]: { ...current.outbound[id], ...patch } } } : current);
    setResult('idle');
    setFormError('');
  }

  function updateWebhook(patch: Partial<WebhookDraft>): void {
    if (disabled) return;
    setDraft(current => current ? { ...current, webhook: { ...current.webhook, ...patch } } : current);
    setResult('idle');
    setFormError('');
  }

  function reload(): void {
    if (saving || loading) return;
    setDraft(null);
    setReloadVersion(version => version + 1);
  }

  function reset(): void {
    if (!snapshot || disabled) return;
    setDraft(toDraft(snapshot));
    setResult('idle');
    setFormError('');
  }

  async function save(): Promise<void> {
    if (!snapshot || !draft || !dirty || disabled) return;
    const error = validationError(snapshot, draft);
    if (error) {
      setFormError(error);
      return;
    }
    const adapters: Partial<Record<AdapterId, Record<string, string | number | boolean>>> = {};
    for (const definition of definitions) {
      const adapter = draft.outbound[definition.id];
      if (!changedOutbound(snapshot.outbound[definition.id], adapter)) continue;
      adapters[definition.id] = { enabled: adapter.enabled, endpoint: adapter.endpoint.trim(), ...credentialPatch(adapter.credential, definition.credentialKey, definition.clearKey) };
    }
    if (changedWebhook(snapshot.webhook, draft.webhook)) {
      adapters.onebotWebhook = {
        enabled: draft.webhook.enabled,
        host: draft.webhook.host,
        port: Number(draft.webhook.port),
        selfId: draft.webhook.selfId.trim(),
        ...credentialPatch(draft.webhook.credential, 'hmac', 'clearHmac'),
      };
    }
    const controller = new AbortController();
    saveController.current = controller;
    setSaving(true);
    setFormError('');
    setDraft(clearCredentials(draft));
    try {
      const response = await api.post('/api/chat/adapters', { revision: snapshot.revision, adapters }, controller.signal);
      if (controller.signal.aborted) return;
      const next = parseSnapshot(response);
      if (!next) throw new Error('invalid_adapters_response');
      setSnapshot(next);
      setDraft(toDraft(next));
      setResult('saved');
    } catch (error) {
      if (!controller.signal.aborted) {
        const state = writeState(error);
        setResult(state);
        setFormError(state === 'error' ? `${errorMessage(error)} 本次凭据输入已清空，更新凭据时请重新输入。` : writeMessage(state, true));
      }
    } finally {
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  const heading = <PageHeading title="适配器" description="设置消息收发和聊天引擎连接。保存参数不代表连接已建立。" actions={connected && <Button variant="outline" disabled={saving || loading || dirty && !blocked} onClick={reload}><RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />重新读取</Button>} />;
  if (!connected) return <>{heading}<ConnectPrompt connect={connect} /></>;
  if (loading) return <>{heading}<Section scrollable title="适配器配置"><div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground" role="status"><LoaderCircle className="size-4 animate-spin" />正在读取连接配置</div></Section></>;
  if (!snapshot || !draft) return <>{heading}<Section scrollable title="适配器暂时不可用" description={loadError || '暂时无法读取连接配置。'}><EmptyState locked title="无法读取适配器配置" description="检查管理服务连接后重新读取。" action={<Button variant="outline" onClick={reload}><RefreshCw className="size-3.5" />重试</Button>} /></Section></>;

  const configuredCount = definitions.filter(definition => snapshot.outbound[definition.id].endpoint !== '').length
    + (snapshot.webhook.port > 0 && snapshot.webhook.selfId && snapshot.webhook.hmacConfigured ? 1 : 0);
  const RuntimeIcon = snapshot.status.running ? Server : ServerOff;
  return <>
    {heading}
    <Section scrollable height="sm" id="adapter-runtime" title="运行状态" description="当前页面可保存连接设置；聊天收发服务尚未接入，不能仅靠填写这些参数开始聊天。" actions={<StatusPill tone={snapshot.status.running ? 'success' : snapshot.status.assembled ? 'neutral' : 'warning'}>{snapshot.status.running ? '运行中' : snapshot.status.assembled ? '已接入 · 未运行' : '尚未接入'}</StatusPill>} footer={<><span className="mr-auto text-xs text-muted-foreground">{snapshot.status.running ? '配置更新尚不能自动应用到运行中的服务。' : '当前版本尚未提供聊天服务的启动入口，不是你漏填了配置。'}</span><Button disabled title="当前版本尚未提供聊天服务的启动入口"><Play className="size-3.5" />{snapshot.status.running ? '服务已运行' : '启动聊天服务'}</Button></>}>
      <dl className="grid grid-cols-3 divide-x text-xs"><div className="pr-3"><dt className="text-muted-foreground">已配置连接</dt><dd className="mt-2 text-lg font-semibold tabular-nums">{configuredCount}<span className="ml-1 text-xs font-normal text-muted-foreground">/ 3</span></dd></div><div className="px-3"><dt className="text-muted-foreground">连接组件</dt><dd className="mt-2 font-medium">{snapshot.status.assembled ? '已接入' : '尚未接入'}</dd></div><div className="pl-3"><dt className="text-muted-foreground">服务状态</dt><dd className="mt-2 font-medium">{snapshot.status.running ? '运行中' : '未运行'}</dd></div></dl>
      <div className="mt-5 flex items-start gap-3 border-t pt-4"><RuntimeIcon className="mt-1 size-4 shrink-0 text-muted-foreground" /><p className="text-xs leading-6"><strong>{snapshot.status.running ? '连接服务已报告运行。' : snapshot.status.assembled ? '连接组件已接入，服务尚未运行。' : '聊天收发尚未接通。'}</strong><span className="block text-muted-foreground">{snapshot.status.assembled ? '保存只更新设置，不会自动更新运行中的连接。' : '消息接收、聊天引擎和回复发送尚未组成可运行的聊天服务。此处先保存参数，不能据此判断机器人已上线。'}</span></p></div>
    </Section>
    <div className="grid items-start gap-5 xl:grid-cols-2">
      {definitions.map(definition => {
        const adapter = draft.outbound[definition.id];
        const saved = snapshot.outbound[definition.id];
        const Icon = definition.icon;
        return <Section scrollable key={definition.id} id={`adapter-${definition.id}`} title={definition.title} description={definition.description} actions={<OutboundStatus adapter={saved} />} footer={<span className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className="size-3.5" />{saved.enabled ? '已保存启用选项，不代表已连接。' : '此连接已停用，填写的设置仍会保留。'}</span>}>
          <div className="grid gap-5">
            <ToggleField label="启用此连接" description="保存启用选项；当前版本不会因此立即建立连接。" checked={adapter.enabled} disabled={disabled} onChange={enabled => updateOutbound(definition.id, { enabled })} />
            <AdapterEndpointField id={`adapter-${definition.id}-endpoint`} label="服务地址" value={adapter.endpoint} placeholder={definition.placeholder} disabled={disabled} onChange={endpoint => updateOutbound(definition.id, { endpoint })} />
            <AdapterCredentialField id={`adapter-${definition.id}-credential`} label={definition.credentialLabel} description={definition.credentialDescription} configured={saved.credentialConfigured} draft={adapter.credential} disabled={disabled} onChange={credential => updateOutbound(definition.id, { credential })} />
            {definition.id === 'onebotHttp' && <div className="grid gap-5 border-t pt-5">
              <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-xs font-medium">webhook 消息收取</h3><StatusPill>{snapshot.webhook.port > 0 && snapshot.webhook.selfId && snapshot.webhook.hmacConfigured ? snapshot.webhook.enabled ? '已配置' : '已配置 · 未启用' : '未配置'}</StatusPill></div>
              <ToggleField label="收取 OneBot 上报" description="可选；需要单独配置机器人账号与签名密钥。" checked={draft.webhook.enabled} disabled={disabled} onChange={enabled => updateWebhook({ enabled })} />
              <Field label="监听地址" description="只监听本机回环地址。"><Input id="adapter-webhook-host" list="adapter-webhook-hosts" autoComplete="off" spellCheck={false} value={draft.webhook.host} disabled={disabled} placeholder="127.0.0.1" onChange={event => updateWebhook({ host: event.target.value })} /><datalist id="adapter-webhook-hosts"><option value="127.0.0.1" /><option value="::1" /><option value="localhost" /></datalist></Field>
              <AdapterNumberField id="adapter-webhook-port" label="监听端口" value={draft.webhook.port} minimum={draft.webhook.enabled ? 1 : 0} maximum={65535} disabled={disabled} onChange={port => updateWebhook({ port })} />
              <Field label="机器人账号"><Input id="adapter-webhook-self-id" inputMode="numeric" autoComplete="off" maxLength={32} value={draft.webhook.selfId} disabled={disabled} placeholder="机器人 QQ 号" onChange={event => updateWebhook({ selfId: event.target.value })} /></Field>
              <AdapterCredentialField id="adapter-webhook-hmac" label="签名密钥" configured={snapshot.webhook.hmacConfigured} draft={draft.webhook.credential} disabled={disabled} onChange={credential => updateWebhook({ credential })} />
            </div>}
          </div>
        </Section>;
      })}
    </div>
    {formError && <div className="flex max-h-32 items-start gap-2 overflow-auto overscroll-contain rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs leading-5 text-destructive" role="alert"><CircleAlert className="mt-0.5 size-4 shrink-0" /><span className="min-w-0 flex-1 break-words">{formError}</span>{blocked && <Button size="sm" variant="outline" disabled={loading || saving} onClick={reload}><RefreshCw className="size-3.5" />重新读取</Button>}</div>}
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><ShieldCheck className="size-3.5 shrink-0" /><span>凭据只写入服务端，不会回显；本次输入在提交后清空。</span></div>
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t bg-background py-3" data-adapter-save-bar><SaveBar dirty={dirty} saving={saving} disabled={blocked || loading} message={writeMessage(result, dirty)} onSave={() => void save()} onReset={blocked ? undefined : reset} label="保存连接配置" />{blocked && <Button variant="outline" disabled={loading || saving} onClick={reload}><RefreshCw className="size-3.5" />重新读取</Button>}</div>
  </>;
}
