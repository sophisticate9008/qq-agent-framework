import { DshDeploymentManager } from './dsh-deployment-manager.tsx';
import { NativeRuntimeCompatibility } from './native-runtime-compatibility.tsx';
import { createDraftKey, retainDraft, retainedDraft } from '../lib/retained-drafts.ts';
import { catalogFailureState } from '../lib/native-catalog-operation.ts';
import { useNativeCatalogOperation } from '../lib/use-native-catalog-operation.ts';
import { NativeCatalogRecovery } from './native-catalog-recovery.tsx';
import { readResource, writeResource } from '../lib/resource-reader.ts';
import { nativeFormMetadata } from '../lib/native-form-metadata.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, LoaderCircle, MessagesSquare, Plug, RefreshCw, ShieldCheck, Unplug, Workflow } from 'lucide-react';
import { ApiError, asRecord, errorMessage } from '../lib/api.ts';
import type { PageProps } from '../lib/types.ts';
import { AdapterCredentialField, AdapterEndpointField, AdapterNumberField, unchangedCredential, type CredentialDraft } from './adapter-connection-fields.tsx';
import { ConnectPrompt, EmptyState, Field, PageHeading, SaveBar, Section, StatusPill, ToggleField } from './management.tsx';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { ChatRuntimeControls } from './chat-runtime-controls.tsx';

type OutboundId = 'onebotHttp' | 'dshAgent';
type AdapterId = OutboundId | 'onebotWebhook' | 'onebotWs';
type WriteState = 'idle' | 'saved' | 'error' | 'conflict' | 'busy' | 'unknown';

interface OutboundConfiguration {
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly credentialConfigured: boolean;
  readonly localAuthConfigured?: boolean;
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
  readonly websocket: OutboundConfiguration;
  readonly webhook: WebhookConfiguration;
  readonly connection?: {
    readonly state: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';
    readonly selfId: string | null;
    readonly lastError: string | null;
    readonly received: number;
    readonly dropped: number;
    readonly chatReady: boolean;
  };
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
  readonly websocket: OutboundDraft;
  readonly webhook: WebhookDraft;
}

const definitions = [
  { id: 'onebotHttp', title: nativeFormMetadata.onebot.title, description: 'HTTP 用于发送，WebSocket 用于收消息；连接后自动识别机器人账号。', credentialFlag: 'secretConfigured', credentialKey: 'secret', clearKey: 'clearSecret', credentialLabel: nativeFormMetadata.onebot.fields.credential, credentialDescription: '复制协议端 HTTP 服务设置中的 accessToken。不是本管理后台的管理员令牌或登录会话；协议端未启用认证时可不填。', placeholder: 'http://127.0.0.1:3000', icon: MessagesSquare },
  { id: 'dshAgent', title: nativeFormMetadata.dsh.title, description: '自动发现本机 DSH；远程连接可在手动设置中配置。', credentialFlag: 'authConfigured', credentialKey: 'auth', clearKey: 'clearAuth', credentialLabel: nativeFormMetadata.dsh.fields.credential, credentialDescription: '由 DSH 服务提供，与管理后台登录凭据分开。', placeholder: 'https://agent.example.com', icon: Workflow },
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
      || typeof credentialConfigured !== 'boolean'
      || definition.id === 'dshAgent' && adapter.localAuthConfigured !== undefined && typeof adapter.localAuthConfigured !== 'boolean') return null;
    outbound[definition.id] = { enabled: adapter.enabled, endpoint: adapter.endpoint, credentialConfigured,
      ...(definition.id === 'dshAgent' && adapter.localAuthConfigured !== undefined ? { localAuthConfigured: adapter.localAuthConfigured as boolean } : {}) };
  }
  const webhook = asRecord(adapters.onebotWebhook);
  const websocket = adapters.onebotWs === undefined ? { enabled: false, endpoint: '', secretConfigured: false } : asRecord(adapters.onebotWs);
  if (typeof websocket.enabled !== 'boolean' || typeof websocket.endpoint !== 'string'
    || typeof websocket.secretConfigured !== 'boolean') return null;
  let connection: AdapterSnapshot['connection'];
  if (root.connection !== undefined) {
    const value = asRecord(root.connection);
    if (!['disconnected', 'connecting', 'connected', 'reconnecting', 'error'].includes(String(value.state))
      || value.selfId !== null && typeof value.selfId !== 'string'
      || value.lastError !== null && typeof value.lastError !== 'string'
      || typeof value.received !== 'number' || !Number.isSafeInteger(value.received) || value.received < 0
      || typeof value.dropped !== 'number' || !Number.isSafeInteger(value.dropped) || value.dropped < 0
      || typeof value.chatReady !== 'boolean') return null;
    connection = { state: value.state as NonNullable<AdapterSnapshot['connection']>['state'],
      selfId: value.selfId as string | null, lastError: value.lastError as string | null,
      received: value.received, dropped: value.dropped, chatReady: value.chatReady };
  }
  if (typeof webhook.enabled !== 'boolean' || typeof webhook.host !== 'string'
    || typeof webhook.port !== 'number' || !Number.isSafeInteger(webhook.port)
    || webhook.port < 0 || webhook.port > 65535 || typeof webhook.selfId !== 'string'
    || typeof webhook.hmacConfigured !== 'boolean') return null;
  return {
    revision: root.revision,
    outbound,
    websocket: { enabled: websocket.enabled, endpoint: websocket.endpoint, credentialConfigured: websocket.secretConfigured },
    ...(connection === undefined ? {} : { connection }),
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
    websocket: { enabled: snapshot.websocket.enabled, endpoint: snapshot.websocket.endpoint, credential: unchangedCredential },
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
    websocket: { ...draft.websocket, credential: unchangedCredential },
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
  if (draft.websocket.enabled && draft.webhook.enabled) return 'WebSocket 与 webhook 只能选择一种接收方式。';
  if (changedOutbound(snapshot.websocket, draft.websocket)) {
    const endpoint = draft.websocket.endpoint.trim();
    if (draft.websocket.enabled && endpoint === '' || endpoint !== '' && (!/^wss?:\/\//.test(endpoint) || !validEndpoint(endpoint.replace(/^ws/, 'http')))) {
      return 'WebSocket 地址需使用本机 ws:// 或远程 wss://，不要包含密钥或查询参数。';
    }
    const error = credentialError(draft.websocket.credential, 'WebSocket API 密钥');
    if (error) return error;
  }
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
  const state = catalogFailureState(error);
  return state === 'idle' ? 'error' : state;
}

function writeMessage(state: WriteState, dirty: boolean): string {
  if (state === 'saved') return '连接配置已保存；聊天停止时，已启用的 WebSocket 会自动尝试连接，禁用则断开。聊天不会自动启动。';
  if (state === 'conflict') return '配置已在其他窗口更新，请先重新读取后再编辑。';
  if (state === 'busy') return '另一项配置正在保存，请稍后重新读取；不会自动重试。';
  if (state === 'unknown') return '保存结果未知，请先重新读取核对；不要重复提交。';
  return dirty ? '连接设置有尚未保存的更改。' : '已配置不代表运行中。';
}

function OutboundStatus({ adapter }: { readonly adapter: OutboundConfiguration }) {
  if (adapter.localAuthConfigured === true) return <StatusPill tone="success">已自动连接本机 DSH</StatusPill>;
  return <StatusPill>{adapter.endpoint ? adapter.enabled ? '已配置' : '已配置 · 未启用' : '未配置'}</StatusPill>;
}

const adapterDraftKey = createDraftKey<{ readonly snapshot: AdapterSnapshot; readonly draft: AdapterDraft }>('adapters');

export function AdapterManager({ api, connected, connect, setDirty, navigate }: PageProps) {
  const recovery = useNativeCatalogOperation(api, 'adapters');
  const retained = useMemo(() => retainedDraft(api, adapterDraftKey), [api]);
  const draftApi = useRef(api);
  const [snapshot, setSnapshot] = useState<AdapterSnapshot | null>(retained?.snapshot ?? null);
  const [draft, setDraft] = useState<AdapterDraft | null>(retained?.draft ?? null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [controlling, setControlling] = useState(false);
  const [chatRunning, setChatRunning] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [formError, setFormError] = useState('');
  const [result, setResult] = useState<WriteState>('idle');
  const [reloadVersion, setReloadVersion] = useState(0);
  const saveController = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const connection = useRef({ api, connected });
  connection.current = { api, connected };
  const reportedDirty = useRef(false);
  const setDirtyRef = useRef(setDirty);
  const blocked = recovery.blocked || result === 'unknown' || result === 'conflict' || result === 'busy';
  const disabled = saving || controlling || loading || blocked;
  const dirty = snapshot !== null && draft !== null && (definitions.some(definition => changedOutbound(snapshot.outbound[definition.id], draft.outbound[definition.id])) || changedWebhook(snapshot.webhook, draft.webhook) || changedOutbound(snapshot.websocket, draft.websocket));
  const view = useRef({ api, snapshot, draft, dirty, disabled });
  view.current = { api: draftApi.current, snapshot, draft, dirty, disabled };

  useEffect(() => {
    if (draftApi.current !== api) return;
    retainDraft(api, adapterDraftKey, connected && dirty && snapshot && draft ? { snapshot, draft: clearCredentials(draft) } : null);
  }, [api, connected, dirty, snapshot, draft]);
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
    const generation = ++epoch.current;
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && epoch.current === generation && connection.current.api === api && connection.current.connected;
    const prior = view.current.api === api ? view.current : null;
    draftApi.current = api;
    const preserveDraft = prior?.dirty === true && prior.draft !== null;
    if (!connected || !prior) { setDraft(null); setSnapshot(null); }
    setSaving(false);
    setControlling(false);
    setConnectionError('');
    if (!connected) {
      setLoading(false);
      return () => controller.abort();
    }
    setLoading(true);
    setLoadError('');
    setFormError('');
    setResult('idle');
    void readResource(api, '/api/chat/adapters', controller.signal).then(value => {
      if (!current()) return;
      const next = parseSnapshot(value);
      if (!next) throw new Error('invalid_adapters_response');
      recovery.review();
      setSnapshot(next);
      setDraft(preserveDraft && prior?.draft ? clearCredentials(prior.draft) : toDraft(next));
    }).catch(error => {
      if (current()) setLoadError(errorMessage(error));
    }).finally(() => {
      if (current()) setLoading(false);
    });
    return () => {
      controller.abort();
      epoch.current++;
      saveController.current?.abort();
      saveController.current = null;
    };
  }, [api, connected, reloadVersion]);

  useEffect(() => {
    if (!connected || !snapshot?.status.applyAvailable || dirty || disabled) return;
    const controller = new AbortController();
    let pending = false;
    const timer = setInterval(() => {
      if (pending || document.visibilityState === 'hidden') return;
      pending = true;
      void readResource(api, '/api/chat/adapters', controller.signal).then(value => {
        if (controller.signal.aborted || saveController.current) return;
        const next = parseSnapshot(value);
        if (!next) return;
        setSnapshot(next);
        setDraft(toDraft(next));
      }).catch(() => undefined).finally(() => { pending = false; });
    }, 2_500);
    return () => { clearInterval(timer); controller.abort(); };
  }, [api, connected, dirty, disabled, snapshot?.status.applyAvailable]);

  function updateWebSocket(patch: Partial<OutboundDraft>): void {
    if (disabled || saveController.current) return;
    setDraft(current => current ? { ...current, websocket: { ...current.websocket, ...patch },
      webhook: patch.enabled === true ? { ...current.webhook, enabled: false } : current.webhook } : current);
    setResult('idle');
    setFormError('');
  }

  function updateOutbound(id: OutboundId, patch: Partial<OutboundDraft>): void {
    if (disabled || saveController.current) return;
    setDraft(current => current ? { ...current, outbound: { ...current.outbound, [id]: { ...current.outbound[id], ...patch } } } : current);
    setResult('idle');
    setFormError('');
  }

  function updateWebhook(patch: Partial<WebhookDraft>): void {
    if (disabled || saveController.current) return;
    setDraft(current => current ? { ...current, webhook: { ...current.webhook, ...patch },
      websocket: patch.enabled === true ? { ...current.websocket, enabled: false } : current.websocket } : current);
    setResult('idle');
    setFormError('');
  }

  function reload(): void {
    if (saving || controlling || loading || saveController.current) return;
    setDraft(null);
    setReloadVersion(version => version + 1);
  }

  function reset(): void {
    if (!snapshot || disabled || saveController.current) return;
    setDraft(toDraft(snapshot));
    setResult('idle');
    setFormError('');
  }

  async function save(): Promise<void> {
    if (!snapshot || !draft || !dirty || disabled || saveController.current) return;
    const error = validationError(snapshot, draft);
    if (error) {
      setFormError(error);
      return;
    }
    const adapters: Partial<Record<AdapterId, Record<string, string | number | boolean>>> = {};
    if (changedOutbound(snapshot.websocket, draft.websocket)) {
      adapters.onebotWs = { enabled: draft.websocket.enabled, endpoint: draft.websocket.endpoint.trim(), ...credentialPatch(draft.websocket.credential, 'secret', 'clearSecret') };
    }
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
    const generation = epoch.current;
    saveController.current = controller;
    const operationToken = recovery.begin(snapshot.revision, controller.signal);
    if (!operationToken) { saveController.current = null; return; }
    const current = () => !controller.signal.aborted && epoch.current === generation && saveController.current === controller
      && connection.current.api === api && connection.current.connected;
    setSaving(true);
    setFormError('');
    setDraft(clearCredentials(draft));
    try {
      const response = await writeResource(api, '/api/chat/adapters', { revision: snapshot.revision, adapters }, controller.signal);
      if (!current()) return;
      const next = parseSnapshot(response);
      if (!next) throw new Error('invalid_adapters_response');
      recovery.complete(operationToken);
      setSnapshot(next);
      setDraft(toDraft(next));
      setResult('saved');
    } catch (error) {
      recovery.fail(operationToken, error);
      if (current()) {
        const state = writeState(error);
        setResult(state);
        setFormError(state === 'error' ? `${errorMessage(error)} 本次凭据输入已清空，更新凭据时请重新输入。` : writeMessage(state, true));
      }
    } finally {
      if (current()) { saveController.current = null; setSaving(false); }
    }
  }

  async function controlConnection(action: 'connect' | 'disconnect'): Promise<void> {
    if (!snapshot || disabled || dirty || chatRunning || !snapshot.status.applyAvailable || saveController.current) return;
    const controller = new AbortController();
    const generation = epoch.current;
    saveController.current = controller;
    const operationToken = recovery.begin(snapshot.revision, controller.signal);
    if (!operationToken) { saveController.current = null; return; }
    const current = () => !controller.signal.aborted && epoch.current === generation && saveController.current === controller
      && connection.current.api === api && connection.current.connected;
    setControlling(true);
    setConnectionError('');
    try {
      const value = await writeResource(api, `/api/chat/adapters/${action}`, action === 'connect' ? { revision: snapshot.revision } : {}, controller.signal);
      if (!current()) return;
      const next = parseSnapshot(value);
      if (!next) throw new Error('invalid_adapters_response');
      recovery.complete(operationToken);
      setSnapshot(next);
      setDraft(toDraft(next));
    } catch (error) {
      recovery.fail(operationToken, error);
      if (current()) setConnectionError(`未能确认连接操作结果：${errorMessage(error)}。请先重新读取状态；WebSocket 与 HTTP 可能使用不同的密钥。`);
    } finally {
      if (current()) { saveController.current = null; setControlling(false); }
    }
  }

  async function discoverLocalDsh(): Promise<void> {
    if (!snapshot || !draft || !connection.current.connected || connection.current.api !== api
      || view.current.snapshot !== snapshot || view.current.dirty || view.current.disabled || saveController.current) return;
    const controller = new AbortController();
    const generation = epoch.current;
    saveController.current = controller;
    const operationToken = recovery.begin(snapshot.revision, controller.signal);
    if (!operationToken) { saveController.current = null; return; }
    const current = () => !controller.signal.aborted && epoch.current === generation && saveController.current === controller
      && connection.current.api === api && connection.current.connected;
    setControlling(true); setFormError('');
    try {
      const response = await writeResource(api, '/api/chat/adapters/discover-dsh', { revision: snapshot.revision }, controller.signal);
      if (!current()) return;
      const saved = parseSnapshot(response);
      if (!saved || saved.outbound.dshAgent.localAuthConfigured !== true) throw new Error('invalid_dsh_discovery_response');
      const responseSnapshot = await readResource(api, '/api/chat/adapters', controller.signal);
      if (!current()) return;
      const next = parseSnapshot(responseSnapshot);
      if (!next || next.outbound.dshAgent.localAuthConfigured !== true) throw new Error('invalid_dsh_discovery_readback');
      recovery.complete(operationToken);
      setSnapshot(next); setDraft(toDraft(next)); setResult('saved');
    } catch (failure) {
      recovery.fail(operationToken, failure);
      if (current()) {
        const state = writeState(failure);
        setResult(state);
        setFormError(state === 'unknown' ? '暂时无法确认自动连接结果，请重新读取核对；不会自动重试。'
          : state === 'conflict' ? '连接配置已变化，请重新读取核对；当前草稿已保留。'
            : '暂时无法自动连接本机 DSH，请确认本机服务可用；当前草稿已保留。');
      }
    } finally {
      if (current()) { saveController.current = null; setControlling(false); }
    }
  }

  const heading = <PageHeading title="连接" description="设置消息收发和聊天引擎连接。启用的 WebSocket 自动尝试连接，聊天模型仍需单独启停。" actions={connected && <Button variant="outline" disabled={saving || controlling || loading || dirty && !blocked} onClick={reload}><RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />重新读取</Button>} />;
  if (!connected) return <>{heading}<ConnectPrompt connect={connect} /></>;
  if (loading) return <>{heading}<Section scrollable title="连接配置"><div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground" role="status"><LoaderCircle className="size-4 animate-spin" />正在读取连接配置</div></Section></>;
  if (!snapshot || !draft) return <>{heading}<Section scrollable title="连接设置暂时不可用" description={loadError || '暂时无法读取连接配置。'}><EmptyState locked title="无法读取连接配置" description="检查管理服务连接后重新读取。" action={<Button variant="outline" onClick={reload}><RefreshCw className="size-3.5" />重试</Button>} /></Section></>;

  return <>
    {heading}
    <NativeCatalogRecovery recovery={recovery} reading={loading || saving || controlling} onRead={reload} onReleased={() => { setResult('idle'); setFormError(''); }} />
    <ChatRuntimeControls api={api} connected={connected} dirty={dirty} navigate={navigate} onRunningChange={setChatRunning} connectionPanel={<div id="adapter-runtime" className="mt-4 grid gap-3 border-t pt-4">
      <h3 className="text-xs font-medium">协议连接管理</h3>
      <p className="text-xs leading-6 text-muted-foreground">管理服务启动时，以及聊天停止状态下保存参数后，会自动尝试连接已启用的 WebSocket；连接协议不会调用模型。手动断开将保留到下一次保存、管理服务重启或启动聊天，不会被轮询强行复连；已有连接掉线仍有有限重试。聊天运行期间保存参数不会热切连接。{snapshot.connection?.selfId && <span className="block">自动识别账号：{snapshot.connection.selfId}</span>}</p>
      <div className="flex flex-wrap items-center gap-2">
      <span className="mr-auto text-xs text-muted-foreground">{dirty ? '请先保存连接设置；聊天停止时将自动尝试连接已启用的 WebSocket。' : chatRunning ? '运行期间保存参数不会热切连接；手动操作协议连接前请先停止聊天。' : snapshot.status.applyAvailable ? '自动连接失败时可手动重试，连接后自动识别账号。' : '当前管理实例没有接入协议连接控制。'}</span>
      <Button disabled={disabled || dirty || chatRunning || !snapshot.status.applyAvailable || !snapshot.websocket.enabled} onClick={() => void controlConnection('connect')}><Plug className="size-3.5" />{controlling ? '正在处理' : snapshot.connection?.state === 'connected' ? '重新连接 WebSocket' : '重试连接 WebSocket'}</Button>
      <Button variant="outline" disabled={disabled || dirty || chatRunning || !snapshot.status.applyAvailable || !snapshot.connection || snapshot.connection.state === 'disconnected'} onClick={() => void controlConnection('disconnect')}><Unplug className="size-3.5" />断开 WebSocket</Button>
      </div>
      {connectionError && <p className="text-xs leading-5 text-destructive" role="alert">{connectionError}</p>}
      {snapshot.connection?.lastError && <p className="text-xs leading-5 text-destructive">协议连接失败或已中断，请检查 WebSocket 地址与专用密钥。</p>}
    </div>} />
    <div className="grid items-start gap-5 xl:grid-cols-2">
      {definitions.map(definition => {
        const adapter = draft.outbound[definition.id];
        const saved = snapshot.outbound[definition.id];
        const Icon = definition.icon;
        const connectionFields = <>
          <ToggleField label={definition.id === 'onebotHttp' ? nativeFormMetadata.onebot.fields.enabled : nativeFormMetadata.dsh.fields.enabled} description="保存此连接的启用选项；聊天模型仍需单独启动。" checked={adapter.enabled} disabled={disabled} onChange={enabled => updateOutbound(definition.id, { enabled })} />
          <AdapterEndpointField id={`adapter-${definition.id}-endpoint`} label={definition.id === 'onebotHttp' ? nativeFormMetadata.onebot.fields.endpoint : nativeFormMetadata.dsh.fields.endpoint} value={adapter.endpoint} placeholder={definition.placeholder} disabled={disabled} onChange={endpoint => updateOutbound(definition.id, { endpoint })} />
          <AdapterCredentialField id={`adapter-${definition.id}-credential`} label={definition.credentialLabel} description={definition.credentialDescription} configured={saved.credentialConfigured} draft={adapter.credential} disabled={disabled} onChange={credential => updateOutbound(definition.id, { credential })} />
        </>;
        return <Section scrollable key={definition.id} id={definition.id === 'onebotHttp' ? nativeFormMetadata.onebot.id : nativeFormMetadata.dsh.id} title={definition.title} description={definition.description} actions={<OutboundStatus adapter={saved} />} footer={<span className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className="size-3.5" />{saved.enabled ? '已启用；实际状态见“聊天运行”。' : '此连接已停用，填写的设置仍会保留。'}</span>}>
          <div className="grid gap-5">
            {definition.id === 'onebotHttp' && <div className="grid gap-5">
              <h3 className="text-xs font-medium">WebSocket 收消息</h3>
              <ToggleField label={nativeFormMetadata.onebot.fields.websocket} description="聊天停止时，保存启用设置会自动尝试连接，保存禁用设置则断开；账号自动识别。" checked={draft.websocket.enabled} disabled={disabled} onChange={enabled => updateWebSocket({ enabled })} />
              {(draft.websocket.enabled || changedOutbound(snapshot.websocket, draft.websocket)) && <>
                <AdapterEndpointField id="adapter-onebotWs-endpoint" label={nativeFormMetadata.onebot.fields.websocketEndpoint} value={draft.websocket.endpoint} placeholder="ws://127.0.0.1:3001" disabled={disabled} onChange={endpoint => updateWebSocket({ endpoint })} />
                <AdapterCredentialField id="adapter-onebotWs-credential" label={nativeFormMetadata.onebot.fields.websocketKey} description="填写协议端 WebSocket 服务的 accessToken，它可能与 HTTP 密钥不同；不使用管理后台登录令牌。" configured={snapshot.websocket.credentialConfigured} draft={draft.websocket.credential} disabled={disabled} onChange={credential => updateWebSocket({ credential })} />
              </>}
              <details className="min-w-0 border-t pt-3"><summary className="cursor-pointer text-xs text-muted-foreground">其他接收方式（高级）</summary><div className="mt-4 grid gap-5"><p className="text-xs leading-5 text-muted-foreground">HTTP webhook 是协议端主动推送消息的替代方式，不是测试功能。使用 WebSocket 时无需设置；当前实例未启动 webhook 监听。</p>
              <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-xs font-medium">webhook 消息收取</h3><StatusPill>{snapshot.webhook.port > 0 && snapshot.webhook.selfId && snapshot.webhook.hmacConfigured ? snapshot.webhook.enabled ? '已配置' : '已配置 · 未启用' : '未配置'}</StatusPill></div>
              <ToggleField label={nativeFormMetadata.onebot.fields.webhook} description="可选；需要单独配置机器人账号与签名密钥。" checked={draft.webhook.enabled} disabled={disabled} onChange={enabled => updateWebhook({ enabled })} />
              {(draft.webhook.enabled || changedWebhook(snapshot.webhook, draft.webhook)) && <>
              <Field label={nativeFormMetadata.onebot.fields.host} description="只监听本机回环地址。"><Input id="adapter-webhook-host" list="adapter-webhook-hosts" autoComplete="off" spellCheck={false} value={draft.webhook.host} disabled={disabled} placeholder="127.0.0.1" onChange={event => updateWebhook({ host: event.target.value })} /><datalist id="adapter-webhook-hosts"><option value="127.0.0.1" /><option value="::1" /><option value="localhost" /></datalist></Field>
              <AdapterNumberField id="adapter-webhook-port" label={nativeFormMetadata.onebot.fields.port} value={draft.webhook.port} minimum={draft.webhook.enabled ? 1 : 0} maximum={65535} disabled={disabled} onChange={port => updateWebhook({ port })} />
              <Field label={nativeFormMetadata.onebot.fields.account}><Input id="adapter-webhook-self-id" inputMode="numeric" autoComplete="off" maxLength={32} value={draft.webhook.selfId} disabled={disabled} placeholder="机器人 QQ 号" onChange={event => updateWebhook({ selfId: event.target.value })} /></Field>
              <AdapterCredentialField id="adapter-webhook-hmac" label={nativeFormMetadata.onebot.fields.hmac} configured={snapshot.webhook.hmacConfigured} draft={draft.webhook.credential} disabled={disabled} onChange={credential => updateWebhook({ credential })} />
              </>}
              </div></details>
            </div>}
            {definition.id === 'onebotHttp' && <h3 className="border-t pt-5 text-xs font-medium">HTTP 发送</h3>}
            {definition.id === 'dshAgent' ? <>
              <div className="grid gap-3 rounded-lg border bg-accent/20 p-4">
                {saved.localAuthConfigured === true ? <p className="text-sm font-medium" role="status">已自动连接本机 DSH / 无需填写令牌</p> : <p className="text-sm font-medium">使用本机 DSH，无需手填地址或令牌。</p>}
                <Button variant={saved.localAuthConfigured === true ? 'outline' : 'default'} disabled={disabled || dirty} onClick={() => void discoverLocalDsh()}><Plug className="size-3.5" />{controlling ? '正在处理…' : '自动连接本机 DSH'}</Button>
                <p className="text-xs leading-6 text-muted-foreground">{dirty ? '请先保存或撤销尚未保存的连接设置，避免覆盖草稿。' : '只设置本机连接，不会自动启动聊天，也不会调用模型；已有手动设置不会自行切换。'}</p>
              </div>
              <details className="min-w-0 rounded-lg border px-4 py-3"><summary className="cursor-pointer text-xs font-medium">手动连接/远程DSH</summary><div className="mt-4 grid gap-5">{connectionFields}</div></details>
            </> : connectionFields}
          </div>
        </Section>;
      })}
    </div>
    <DshDeploymentManager api={api} connected={connected} setDirty={setDirty} running={chatRunning} configurationDirty={dirty || disabled} />
    <NativeRuntimeCompatibility api={api} connected={connected} dirty={dirty || disabled} navigate={navigate} />
    {formError && <div className="flex max-h-32 items-start gap-2 overflow-auto overscroll-contain rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs leading-5 text-destructive" role="alert"><CircleAlert className="mt-0.5 size-4 shrink-0" /><span className="min-w-0 flex-1 break-words">{formError}</span>{blocked && <Button size="sm" variant="outline" disabled={loading || saving} onClick={reload}><RefreshCw className="size-3.5" />重新读取</Button>}</div>}
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><ShieldCheck className="size-3.5 shrink-0" /><span>凭据只写入服务端，不会回显；本次输入在提交后清空。</span></div>
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t bg-background py-3" data-adapter-save-bar><SaveBar dirty={dirty} saving={saving} disabled={blocked || loading || controlling} message={writeMessage(result, dirty)} onSave={() => void save()} onReset={blocked ? undefined : reset} label="保存连接配置" />{blocked && <Button variant="outline" disabled={loading || saving || controlling} onClick={reload}><RefreshCw className="size-3.5" />重新读取</Button>}</div>
  </>;
}
