import { createDraftKey, retainDraft, retainedDraft } from '../lib/retained-drafts.ts';
import { catalogFailureState } from '../lib/native-catalog-operation.ts';
import { useNativeCatalogOperation } from '../lib/use-native-catalog-operation.ts';
import { NativeCatalogRecovery } from './native-catalog-recovery.tsx';
import { readResource, writeResource } from '../lib/resource-reader.ts';
import { nativeFormMetadata } from '../lib/native-form-metadata.ts';
import { presentOneBotConnection, type OneBotConnectionSnapshot } from '../lib/onebot-connection-presentation.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, LoaderCircle, Plug, RefreshCw, Unplug } from 'lucide-react';
import { ApiError, asRecord, errorMessage } from '../lib/api.ts';
import type { PageProps } from '../lib/types.ts';
import { AdapterCredentialField, AdapterEndpointField, AdapterNumberField, unchangedCredential, type CredentialDraft } from './adapter-connection-fields.tsx';
import { ConnectPrompt, EmptyState, Field, PageHeading, SaveBar, Section, StatusPill, ToggleField } from './management.tsx';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { ChatRuntimeControls } from './chat-runtime-controls.tsx';
import { ReadOnlyDetails, TechnicalDetails } from './read-only-details.tsx';
import { SettingsWindow } from './settings-window.tsx';

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
  readonly connection?: OneBotConnectionSnapshot;
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
  { id: 'onebotHttp', title: nativeFormMetadata.onebot.title, description: 'HTTP 用于发送，WebSocket 用于收消息；连接后自动识别机器人账号。', credentialFlag: 'secretConfigured', credentialKey: 'secret', clearKey: 'clearSecret', credentialLabel: nativeFormMetadata.onebot.fields.credential, credentialDescription: '复制协议端 HTTP 服务设置中的 accessToken。不是本管理后台的管理员令牌或登录会话；协议端未启用认证时可不填。', placeholder: 'http://127.0.0.1:3000' },
  { id: 'dshAgent', title: nativeFormMetadata.dsh.title, description: '自动发现本机 DSH；远程连接可在手动设置中配置。', credentialFlag: 'authConfigured', credentialKey: 'auth', clearKey: 'clearAuth', credentialLabel: nativeFormMetadata.dsh.fields.credential, credentialDescription: '由 DSH 服务提供，与管理后台登录凭据分开。', placeholder: 'https://agent.example.com' },
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
      || typeof value.chatReady !== 'boolean'
      || [value.accountOnline, value.accountGood].some(item => item !== undefined && item !== null && typeof item !== 'boolean')) return null;
    connection = { state: value.state as NonNullable<AdapterSnapshot['connection']>['state'],
      selfId: value.selfId as string | null, lastError: value.lastError as string | null,
      received: value.received, dropped: value.dropped, chatReady: value.chatReady,
      accountOnline: typeof value.accountOnline === 'boolean' ? value.accountOnline : null,
      accountGood: typeof value.accountGood === 'boolean' ? value.accountGood : null };
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
  if (state === 'saved') return '连接配置已保存，聊天需单独启动。';
  if (state === 'conflict') return '配置已在其他窗口更新，请先重新读取后再编辑。';
  if (state === 'busy') return '另一项配置正在保存，请稍后重新读取；不会自动重试。';
  if (state === 'unknown') return '保存结果未知，请先重新读取核对；不要重复提交。';
  return dirty ? '连接设置有尚未保存的更改。' : '连接配置已读取。';
}

function OutboundStatus({ adapter }: { readonly adapter: OutboundConfiguration }) {
  if (adapter.localAuthConfigured === true) return <StatusPill tone={adapter.enabled ? 'success' : 'neutral'}>{adapter.enabled ? '本机连接已配置' : '本机连接 · 未启用'}</StatusPill>;
  return <StatusPill>{adapter.endpoint ? adapter.enabled ? '已配置' : '已配置 · 未启用' : '未配置'}</StatusPill>;
}

type AdapterRetainedDraft = { readonly snapshot: AdapterSnapshot; readonly draft: AdapterDraft };
const adapterDraftKey = createDraftKey<AdapterRetainedDraft>('adapters');
const compactAdapterDraftKeys = { onebot: createDraftKey<AdapterRetainedDraft>('adapters-home-onebot'), dsh: createDraftKey<AdapterRetainedDraft>('adapters-home-dsh') };

export function AdapterManager({ api, connected, connect, setDirty, navigate, compact, active = true }: PageProps & { readonly compact?: 'onebot' | 'dsh'; readonly active?: boolean }) {
  const recovery = useNativeCatalogOperation(api, 'adapters');
  const draftKey = compact ? compactAdapterDraftKeys[compact] : adapterDraftKey;
  const dirtyScope = compact ? `adapters-home-${compact}` : 'adapters';
  const retained = useMemo(() => retainedDraft(api, draftKey), [api, draftKey]);
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
    retainDraft(api, draftKey, connected && dirty && snapshot && draft ? { snapshot, draft: clearCredentials(draft) } : null);
  }, [api, connected, dirty, snapshot, draft, draftKey]);
  useEffect(() => { setDirtyRef.current = setDirty; }, [setDirty]);
  useEffect(() => {
    if (reportedDirty.current === dirty) return;
    reportedDirty.current = dirty;
    setDirty(dirty, dirtyScope);
  }, [dirty, setDirty, dirtyScope]);
  useEffect(() => () => {
    saveController.current?.abort();
    setDirtyRef.current(false, dirtyScope);
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
    if (!active || !connected || !snapshot?.status.applyAvailable || dirty || disabled) return;
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
  }, [api, connected, dirty, disabled, active, snapshot?.status.applyAvailable]);

  useEffect(() => {
    if (!active) setDraft(current => current ? clearCredentials(current) : current);
  }, [active]);

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
    if (!snapshot || disabled || dirty || action === 'disconnect' && chatRunning || !snapshot.status.applyAvailable || saveController.current) return;
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
      if (current()) {
        const code = error instanceof ApiError ? error.code : '';
        setConnectionError(code === 'adapter_runtime_busy' ? '聊天正在启动或停止，请稍后重试。'
          : code === 'adapter_connected_chat_restore_failed' ? 'QQ 连接已恢复，但聊天未能启动。请查看首页的聊天状态。'
            : code === 'chat_revision_conflict' ? '连接设置已变化，请重新读取并应用已保存的设置。'
              : `连接未恢复：${errorMessage(error)}。请确认 NapCat 或 SnowLuma 已登录，协议服务已启动。`);
      }
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

  const heading = compact ? null : <PageHeading title="连接" description="QQ 收发、聊天引擎与运行状态" actions={connected && <Button variant="ghost" disabled={saving || controlling || loading || dirty && !blocked} onClick={reload}><RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />重新读取</Button>} />;
  if (!connected) return <>{heading}<ConnectPrompt connect={connect} /></>;
  if (loading && !snapshot) return <>{heading}<Section title="连接配置"><div className="empty" role="status"><LoaderCircle className="size-4 animate-spin" />正在读取连接配置</div></Section></>;
  if (!snapshot || !draft) return <>{heading}<Section title="连接设置暂时不可用" description={loadError || '暂时无法读取连接配置。'}><EmptyState locked title="无法读取连接配置" description="检查管理服务连接后重新读取。" action={<Button variant="outline" onClick={reload}><RefreshCw className="size-3.5" />重试</Button>} /></Section></>;
  const protocol = snapshot.connection ? presentOneBotConnection(snapshot.connection) : null;
  const savedDsh = snapshot.outbound.dshAgent;
  const saveBar = <div className="flex flex-wrap items-center gap-1.5 border-t pt-2" data-adapter-save-bar><SaveBar dirty={dirty} saving={saving} disabled={blocked || loading || controlling} message={writeMessage(result, dirty)} onSave={() => void save()} onReset={blocked ? undefined : reset} label="保存连接配置" /></div>;
  const operationRecovery = <NativeCatalogRecovery recovery={recovery} reading={loading || saving || controlling} onRead={reload} onReleased={() => { setResult('idle'); setFormError(''); }} />;
  const feedback = <>{loadError && <p className="text-xs text-destructive" role="alert">读取失败，保留当前快照与草稿：{loadError}</p>}{operationRecovery}{formError && <p role="alert" className="text-xs leading-5 text-destructive">{formError}</p>}{saveBar}</>;
  const connectionFields = (id: OutboundId) => {
    const definition = definitions[id === 'onebotHttp' ? 0 : 1];
    const adapter = draft.outbound[id];
    return <>
      <ToggleField label={id === 'onebotHttp' ? nativeFormMetadata.onebot.fields.enabled : nativeFormMetadata.dsh.fields.enabled} tip="保存连接设置后，仍需单独启动聊天。" checked={adapter.enabled} disabled={disabled} onChange={enabled => updateOutbound(id, { enabled })} />
      <AdapterEndpointField id={`adapter-${id}-endpoint`} label={id === 'onebotHttp' ? nativeFormMetadata.onebot.fields.endpoint : nativeFormMetadata.dsh.fields.endpoint} value={adapter.endpoint} placeholder={definition.placeholder} disabled={disabled} onChange={endpoint => updateOutbound(id, { endpoint })} />
      <AdapterCredentialField id={`adapter-${id}-credential`} label={definition.credentialLabel} description={definition.credentialDescription} configured={snapshot.outbound[id].credentialConfigured} draft={adapter.credential} disabled={disabled} onChange={credential => updateOutbound(id, { credential })} />
    </>;
  };
  const qqDetails = <ReadOnlyDetails title="QQ 连接详情" description="消息接收情况、连接设置与最近诊断。"><TechnicalDetails fields={[
    { label: '连接状态', value: protocol?.statusLabel ?? '未知' }, { label: '机器人账号', value: snapshot.connection?.selfId ?? '尚未识别' },
    { label: '接收消息', value: snapshot.connection?.received ?? '未知' }, { label: '丢弃消息', value: snapshot.connection?.dropped ?? '未知' },
    { label: 'WebSocket', value: snapshot.websocket.enabled ? snapshot.websocket.endpoint : '未启用' },
    { label: 'HTTP 发送', value: snapshot.outbound.onebotHttp.enabled ? snapshot.outbound.onebotHttp.endpoint : '未启用' },
    ...(snapshot.connection?.lastError ? [{ label: '最近异常记录（历史）', value: snapshot.connection.lastError }] : []),
    ...(protocol?.diagnostic ? [{ label: '最近诊断', value: protocol.diagnostic.title }, { label: '诊断说明', value: protocol.diagnostic.message }, ...(protocol.diagnostic.code ? [{ label: '诊断码', value: protocol.diagnostic.code }] : [])] : []),
  ]} /></ReadOnlyDetails>;

  const qqEditor = <div className="stack">
            <h3>WebSocket 收消息</h3>
            <ToggleField label={nativeFormMetadata.onebot.fields.websocket} tip="聊天停止时，保存启用设置会自动连接，保存禁用设置则断开；账号自动识别。" checked={draft.websocket.enabled} disabled={disabled} onChange={enabled => updateWebSocket({ enabled })} />
            <AdapterEndpointField id="adapter-onebotWs-endpoint" label={nativeFormMetadata.onebot.fields.websocketEndpoint} value={draft.websocket.endpoint} placeholder="ws://127.0.0.1:3001" disabled={disabled} onChange={endpoint => updateWebSocket({ endpoint })} />
            <AdapterCredentialField id="adapter-onebotWs-credential" label={nativeFormMetadata.onebot.fields.websocketKey} description="填写协议端 WebSocket 服务的 accessToken，可能与 HTTP 密钥不同。" configured={snapshot.websocket.credentialConfigured} draft={draft.websocket.credential} disabled={disabled} onChange={credential => updateWebSocket({ credential })} />
            <h3 className="border-t pt-2">HTTP 发送</h3>{connectionFields('onebotHttp')}
            <div className="strip">聊天停止时，保存启用设置会自动尝试连接 WebSocket；运行期间的连接变更需重启聊天生效。</div>
            <SettingsWindow title="Webhook 收消息" label="其他接收方式：Webhook" description="协议端主动推送的替代接收方式，与 WebSocket 二选一。关闭保留草稿。"><div className="stack">
              <div className="strip warn">当前实例未启动 webhook 监听，配置状态不代表监听已运行。</div>
              <ToggleField label={nativeFormMetadata.onebot.fields.webhook} tip="需要配置机器人账号与签名密钥。" checked={draft.webhook.enabled} disabled={disabled} onChange={enabled => updateWebhook({ enabled })} />
              <div className="formgrid"><Field label={nativeFormMetadata.onebot.fields.host} tip="只监听本机回环地址。"><Input id="adapter-webhook-host" autoComplete="off" spellCheck={false} value={draft.webhook.host} disabled={disabled} placeholder="127.0.0.1" onChange={event => updateWebhook({ host: event.target.value })} /></Field><AdapterNumberField id="adapter-webhook-port" label={nativeFormMetadata.onebot.fields.port} value={draft.webhook.port} minimum={draft.webhook.enabled ? 1 : 0} maximum={65535} disabled={disabled} onChange={port => updateWebhook({ port })} /></div>
              <Field label={nativeFormMetadata.onebot.fields.account}><Input id="adapter-webhook-self-id" inputMode="numeric" autoComplete="off" maxLength={32} value={draft.webhook.selfId} disabled={disabled} placeholder="机器人 QQ 号" onChange={event => updateWebhook({ selfId: event.target.value })} /></Field>
              <AdapterCredentialField id="adapter-webhook-hmac" label={nativeFormMetadata.onebot.fields.hmac} configured={snapshot.webhook.hmacConfigured} draft={draft.webhook.credential} disabled={disabled} onChange={credential => updateWebhook({ credential })} />{feedback}
            </div></SettingsWindow>{feedback}
          </div>;
  const dshEditor = <div className="stack">{connectionFields('dshAgent')}{feedback}</div>;
  if (compact === 'onebot') return qqEditor;
  if (compact === 'dsh') return <div className="stack">{loadError && <p role="alert" className="text-xs text-destructive">读取失败，保留当前快照与草稿：{loadError}</p>}<div className="row"><OutboundStatus adapter={savedDsh} /><span className="muted small">{savedDsh.localAuthConfigured ? '本机自动发现与鉴权' : '聊天引擎连接'}</span></div><div className="strip">自动发现本机服务地址与鉴权；配置保存后单独启动聊天。</div><div className="actions"><Button disabled={disabled || dirty} onClick={() => void discoverLocalDsh()}><Plug className="size-3.5" />{controlling ? '正在处理…' : '自动连接本机 DSH'}</Button><SettingsWindow title="手动或远程 DSH 连接" label="手动连接" description="填写服务地址与访问凭据，关闭保留常规草稿。" onOpenChange={open => { if (!open) setDraft(current => current ? clearCredentials(current) : current); }}>{dshEditor}</SettingsWindow></div>{dirty && <p className="small muted">先保存或撤销当前草稿，再自动连接。</p>}{operationRecovery}{formError && <p className="text-xs text-destructive" role="alert">{formError}</p>}</div>;

  return <>
    {heading}
    {operationRecovery}
    {loadError && <div className="strip bad" role="alert">读取失败，保留当前快照与草稿：{loadError}</div>}
    {loading && <div className="summaryline" role="status">正在读取连接状态，当前草稿保留。</div>}
    <div className="grid3">
      <section id={nativeFormMetadata.onebot.id} className="panel entity">
        <div className="row"><span className="avatar" aria-hidden="true">↔</span><div className="grow"><h2 className="panel-title">QQ 消息连接</h2><p className="muted small">OneBot · HTTP 发送 / WebSocket 接收</p></div><span data-protocol-connection-state={snapshot.connection?.state}><StatusPill tone={protocol?.statusTone ?? 'neutral'}>{protocol?.statusLabel ?? '连接状态未知'}</StatusPill></span></div>
        <div className="meta"><span>HTTP 发送{snapshot.outbound.onebotHttp.enabled ? '已启用' : '未启用'}</span><span>消息接收：{snapshot.websocket.enabled ? 'WebSocket' : snapshot.webhook.enabled ? 'Webhook' : '未启用'}</span><span>账号：{snapshot.connection?.selfId ?? '尚未识别'}</span></div>
        <div className={`strip ${protocol?.diagnostic?.tone === 'error' ? 'bad' : protocol?.diagnostic?.tone === 'warning' ? 'warn' : ''}`} role="status" data-protocol-diagnostic={protocol?.diagnostic?.category}>{protocol?.diagnostic && protocol.diagnostic.tone !== 'neutral' ? protocol.diagnostic.message : `接收 ${snapshot.connection?.received ?? '未知'} 条 · 丢弃 ${snapshot.connection?.dropped ?? '未知'} 条。协议连接与聊天启停分别管理。`}</div>
        <div className="actions">
          <SettingsWindow title="QQ 消息收发" label="编辑连接" description="HTTP 发送与 WebSocket 接收分别配置；关闭保留常规草稿。" onOpenChange={open => { if (!open) setDraft(current => current ? clearCredentials(current) : current); }}>{qqEditor}</SettingsWindow>
          <SettingsWindow title="QQ 连接维护" label="连接维护" description="重新连接 QQ；原本已启用的聊天会一并恢复。"><div className="stack"><div className="row">{protocol && <StatusPill tone={protocol.statusTone}>{protocol.statusLabel}</StatusPill>}<span className="muted">{snapshot.connection?.selfId ? `账号 ${snapshot.connection.selfId}` : '机器人账号尚未识别'}</span></div><p className="small muted">协议端临时离线会自动重连。手动重新连接保留会话；主动停止聊天后不会自动启动。断开连接前请先停止聊天。</p>
            <div className="actions"><Button variant="outline" disabled={disabled || dirty || !snapshot.status.applyAvailable || !snapshot.websocket.enabled} onClick={() => void controlConnection('connect')}><Plug className="size-3.5" />{controlling ? '正在处理' : snapshot.connection?.state === 'connected' ? '重新连接' : '重试连接'}</Button><Button variant="outline" disabled={disabled || dirty || chatRunning || !snapshot.status.applyAvailable || !snapshot.connection || snapshot.connection.state === 'disconnected'} onClick={() => void controlConnection('disconnect')}><Unplug className="size-3.5" />断开连接</Button></div>{connectionError && <p role="alert" className="text-xs text-destructive">{connectionError}</p>}{operationRecovery}
          </div></SettingsWindow>{qqDetails}
        </div>
      </section>
      <section id={nativeFormMetadata.dsh.id} className="panel entity">
        <div className="row"><span className="avatar" aria-hidden="true">◇</span><div className="grow"><h2 className="panel-title">DSH 聊天引擎</h2><p className="muted small">{savedDsh.localAuthConfigured ? '本机自动发现与鉴权' : '聊天引擎连接'}</p></div><OutboundStatus adapter={savedDsh} /></div>
        <div className="meta"><span>连接{savedDsh.enabled ? '已启用' : '未启用'}</span><span>{savedDsh.localAuthConfigured ? '本机鉴权已配置' : savedDsh.credentialConfigured ? '访问凭据已保存' : '访问凭据未设置'}</span></div>
        <div className="strip">配置就绪与运行状态分别显示；启动聊天时核对实际连接。</div>
        <div className="actions">
          <SettingsWindow title="自动连接本机 DSH" label="自动连接本机" triggerVariant="default" description="自动发现本机服务地址并保存本机鉴权，连接后单独启动聊天。"><div className="stack"><div className="strip">将明确切换为本机自动发现的地址与鉴权；已有会话历史保留。</div>{dirty && <p className="small muted">先保存或撤销当前草稿，再自动连接。</p>}<Button disabled={disabled || dirty} onClick={() => void discoverLocalDsh()}><Plug className="size-3.5" />{controlling ? '正在处理…' : '自动连接本机 DSH'}</Button>{operationRecovery}{formError && <p className="text-xs text-destructive" role="alert">{formError}</p>}</div></SettingsWindow>
          <SettingsWindow title="手动或远程 DSH 连接" label="手动连接" description="填写服务地址与访问凭据。关闭保留常规草稿，保存后需重启聊天生效。" onOpenChange={open => { if (!open) setDraft(current => current ? clearCredentials(current) : current); }}>{dshEditor}</SettingsWindow>
          <ReadOnlyDetails title="DSH 连接详情"><TechnicalDetails fields={[{ label: '服务地址', value: savedDsh.endpoint || '未配置' }, { label: '连接启用', value: savedDsh.enabled }, { label: '本机鉴权', value: savedDsh.localAuthConfigured === true }, { label: '访问凭据', value: savedDsh.credentialConfigured ? '已保存' : '未设置' }]} /></ReadOnlyDetails>
        </div>
      </section>
      <ChatRuntimeControls api={api} connected={connected} dirty={dirty} navigate={navigate} onRunningChange={setChatRunning} />
    </div>
    <div className="summaryline"><span className="muted">相关设置</span><Button variant="ghost" size="sm" onClick={() => navigate('security')}>主人与白名单</Button><Button variant="ghost" size="sm" onClick={() => navigate('model')}>聊天方案</Button><span className="push muted small" role="status">{writeMessage(result, dirty)}</span></div>
    {(formError || connectionError) && <div className="strip bad row" role="alert"><CircleAlert className="size-3.5 shrink-0" /><span className="grow">{formError || connectionError}</span>{blocked && <Button size="sm" variant="outline" disabled={loading || saving || controlling} onClick={reload}>重新读取</Button>}</div>}
  </>;
}
