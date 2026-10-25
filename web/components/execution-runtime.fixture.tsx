import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { bootstrapRuntimeRecord } from '../../test/fixtures/bootstrap-records.ts';
import { executionRecord } from '../../test/fixtures/execution-records.ts';
import { ApiError, asRecord, type ApiClient } from '../lib/api.ts';
import { parseExecutionConfiguration, type ExecutionConfiguration } from '../lib/execution-policy.ts';
import { parseChatAuthorization, type ChatAuthorization } from '../lib/chat-runtime.ts';
import type { PageProps } from '../lib/types.ts';
import { NativeBootstrapSummary } from './native-bootstrap-summary.tsx';
import { ChatExecutionSettings } from './chat-execution-settings.tsx';
import { ChatAuthorizationManager } from './chat-authorization-manager.tsx';
import { ChatRuntimeControls } from './chat-runtime-controls.tsx';
import { SessionsPage } from '../pages/sessions.tsx';
import { ExecutionJournal } from './execution-journal.tsx';
import { FeaturesPage } from '../pages/features.tsx';
import { ChatPlanManager } from './chat-plan-manager.tsx';
import { ThemeProvider, useTheme, type Theme } from './theme-provider.tsx';
import '../console.css';

type Source = 'A' | 'B';
type WriteMode = 'success' | 'conflict' | 'unknown';
const sources: readonly Source[] = ['A', 'B'];
const configurationApply = new URLSearchParams(location.search).get('applyConfig') === '1';
const catalogState = new URLSearchParams(location.search).get('catalogState');
const layoutLarge = new URLSearchParams(location.search).get('layoutLarge') === '1';
const defaultPolicy = { schema: 1 as const, turnTimeoutMs: 60_000, cancelTimeoutMs: 5000, noticeTimeoutMs: 5000,
  noticeEnabled: true, noticeText: '合成提醒 A：超时后仅尝试一次', cancelOnTimeout: true, unknownHandling: 'isolate-session' as const, lateFinal: 'record-only' as const, maxActive: 256 };
const execution: Record<Source, ExecutionConfiguration> = {
  A: { revision: 'a'.repeat(64), policy: defaultPolicy },
  B: { revision: 'b'.repeat(64), policy: { ...defaultPolicy, turnTimeoutMs: 90_000, noticeText: '合成提醒 B：新连接的草稿来源' } },
};
const authorization: Record<Source, ChatAuthorization> = {
  A: { revision: 'a'.repeat(64), version: 'fixture-A', grants: [{ conversationId: 'group:100000', submitUses: 7, sendUses: 9, expiresAt: null }], cancelAvailable: false },
  B: { revision: 'b'.repeat(64), version: 'fixture-B', grants: [{ conversationId: 'group:200000', submitUses: 3, sendUses: 5, expiresAt: null }], cancelAvailable: true },
};
const configuration: Record<Source, { revision: string; value: string }> = {
  A: { revision: 'fixture-config-A', value: 'saved-A' },
  B: { revision: 'fixture-config-B', value: 'saved-B' },
};
let holdRead = false;
let holdWrite = false;
let holdConfiguration = new URLSearchParams(location.search).get('holdConfig') === '1';
let mode: WriteMode = 'success';
let bootstrapMode = 'running';
let featureCount = layoutLarge ? 64 : 3;
let runtimeError: string | null = null;
let gets = 0;
let aborted = 0;
let sequence = 10;
const writes: { readonly source: Source; readonly path: string; readonly body: unknown }[] = [];
const pending: { readonly kind: 'read' | 'write'; readonly source: Source; readonly resolve: () => void; readonly reject: (status?: number) => void }[] = [];
const publish = () => dispatchEvent(new Event('execution-runtime-fixture-change'));

function runtimeRecord(source: Source) {
  const selected = bootstrapRuntimeRecord(bootstrapMode === 'not-started' || bootstrapMode === 'unsettled-create' ? 'not-started' : bootstrapMode === 'unknown' ? 'unknown' : 'running', featureCount);
  const bootstrap = bootstrapMode === 'null' ? null : { ...selected.bootstrap,
    manifest: { ...selected.bootstrap.manifest, version: source === 'A' ? '1.2.3' : '2.0.0' }, codeFingerprint: (source === 'A' ? 'b' : 'c').repeat(64),
    ...(bootstrapMode === 'pending-stop' ? { pendingStop: true } : {}),
    ...(bootstrapMode === 'unsettled-create' ? { state: 'unknown', unsettledLifecycle: true } : {}) };
  return { packages: [], frameworkTools: null, state: runtimeError ? 'error' : 'stopped', canStart: false, canApplyDeployment: false, chatReady: false, protocolConnected: false,
    missingReasons: runtimeError ? ['host_not_ready'] : ['runtime_not_started'], configurationIssues: [],
    revisions: Object.fromEntries(['plans', 'personas', 'access', 'adapters', 'providers', 'authorization', 'deployment', 'execution'].map(key => [key, 'a'.repeat(64)])),
    activeRevisions: null, lastError: runtimeError, readinessScope: 'verified-protocol-dsh-configuration-and-local-file-provenance',
    modelExecutionVerified: false, credentialValueIdentityVerified: false, unverified: ['credential_loaded_value_identity'],
    ...(bootstrapMode === 'missing' ? {} : { bootstrap }),
  };
}

function settle(source: Source, kind: 'read' | 'write', value: unknown, failure: ApiError | null, signal?: AbortSignal, forceHold = false): Promise<unknown> {
  signal?.addEventListener('abort', () => { aborted++; publish(); }, { once: true });
  const captured = structuredClone(value);
  if (forceHold || (kind === 'read' ? holdRead : holdWrite)) {
    if (kind === 'read') holdRead = false;
    else holdWrite = false;
    return new Promise((resolve, reject) => { pending.push({ kind, source,
      resolve: () => failure ? reject(failure) : resolve(captured), reject: (status = 504) => reject(new ApiError(kind === 'write' ? 'operation_unknown' : 'service_unavailable', status)) }); publish(); });
  }
  queueMicrotask(publish);
  return failure ? Promise.reject(failure) : Promise.resolve(captured);
}

function fixtureApi(source: Source): ApiClient {
  return {
    async get(path, signal) {
      gets++;
      const url = new URL(path, 'http://fixture.invalid');
      if (url.pathname === '/api/chat/execution') return settle(source, 'read', execution[source], null, signal);
      if (url.pathname === '/api/chat/authorization') return new URLSearchParams(location.search).get('view')?.startsWith('features')
        ? authorization[source] : settle(source, 'read', authorization[source], null, signal);
      if (url.pathname === '/api/chat/runtime') return new URLSearchParams(location.search).get('view')?.startsWith('features')
        ? runtimeRecord(source) : settle(source, 'read', runtimeRecord(source), null, signal);
      if (url.pathname === '/api/chat/status') return { runtimeConnected: false, state: catalogState === 'error' ? 'error' : 'stopped' };
      if (url.pathname === '/api/chat/plans') return { revision: 'f'.repeat(64), activePlanId: 'fixture-plan', plans: [{
        id: 'fixture-plan', name: '合成聊天方案', description: '', instructions: '仅隔离验证状态说明', personaId: 'fixture-persona',
        provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'low', contextLimits: { group: 128_000, private: 128_000 },
      }] };
      if (url.pathname === '/api/chat/personas') return { revision: 'fixture-personas', personas: [{ id: 'fixture-persona', name: '合成人设' }] };
      if (url.pathname === '/api/chat/providers') return { revision: 'fixture-providers', providers: [{ id: 'fixture-provider', name: '合成提供方', enabled: true, models: [{ id: 'fixture-model', name: '合成模型' }] }] };
      if (url.pathname === '/api/chat/features') return settle(source, 'read', { runtimeConnected: catalogState !== 'stopped' && catalogState !== 'error', editableResources: new URLSearchParams(location.search).get('view') === 'features-draft',
        capabilities: Array.from({ length: catalogState ? 4 : 320 }, (_, index) => ({ id: ['chat-plans', 'personas', 'model-settings', 'access-policy'][index] ?? `fixture.capability-${index}`, installed: catalogState !== 'stopped' })),
        features: catalogState === 'stopped' ? [] : catalogState === 'error' ? [{ id: 'agent-relay', version: '1.0.0', status: 'active', capabilities: ['agent.submit', 'messaging.send'] }]
          : Array.from({ length: 320 }, (_, index) => ({ id: `fixture.feature-${index}`, name: `fixture.feature-${index}`,
            description: `合成功能 ${source} ${index}`, status: index === 1 ? 'unknown' : 'active' })) }, null, signal);
      if (url.pathname === '/api/configuration') {
        const deferConfiguration = holdConfiguration;
        holdConfiguration = false;
        return settle(source, 'read', { capabilities: { apply: configurationApply }, groups: [{ id: 'fixture-features', title: '合成功能设置',
          ...(configurationApply ? { applyLabel: '应用合成配置' } : {}),
          description: '仅隔离验证配置草稿不因重读功能清单丢失。', source: 'gateway', category: 'features', revision: configuration[source].revision,
          fields: [{ id: 'fixture.draft', label: '合成功能草稿', description: '仅隔离夹具字段，不连接真实配置。', type: 'text', value: configuration[source].value }] }] }, null, signal, deferConfiguration);
      }
      if (url.pathname === '/api/chat/sessions') return { revision: 'isolated-sessions', sessions: [{ key: 'group:100000', sessionId: 'isolated-session', owner: false }], resetAvailable: false, next: null };
      if (url.pathname === '/api/chat/executions') return settle(source, 'read', { native: true,
        items: Array.from({ length: layoutLarge ? 100 : 1 }, (_, index) => executionRecord((source === 'A' ? 0 : 100_000) + index)), next: null, manualCancelAvailable: false }, null, signal);
      throw new Error('isolated_unknown_runtime_read');
    },
    async post(path, body, signal) {
      writes.push({ source, path, body: structuredClone(body) });
      const input = asRecord(body);
      if (path === '/api/configuration/apply' && configurationApply) {
        if (input.source !== 'gateway' || input.revision !== configuration[source].revision) return settle(source, 'write', null, new ApiError('configuration_revision_conflict', 409), signal);
        return settle(source, 'write', { ok: true, source: input.source, revision: input.revision, application: { applied: true } }, null, signal);
      }
      if (path === '/api/configuration') {
        if (input.source !== 'gateway' || input.revision !== configuration[source].revision) return settle(source, 'write', null, new ApiError('configuration_revision_conflict', 409), signal);
        const changes = asRecord(input.changes);
        if (Object.keys(changes).length !== 1 || typeof changes['fixture.draft'] !== 'string') throw new ApiError('invalid_fixture_configuration', 400);
        configuration[source] = { revision: `fixture-config-${source}-${++sequence}`, value: changes['fixture.draft'] };
        return settle(source, 'write', { ok: true, revision: configuration[source].revision, applyRequired: configurationApply }, null, signal);
      }
      if (path !== '/api/chat/execution' && path !== '/api/chat/authorization') throw new Error('isolated_unexpected_mutation');
      const current = path === '/api/chat/execution' ? execution[source] : authorization[source];
      const conflict = mode === 'conflict' || input.revision !== current.revision;
      if (conflict) return settle(source, 'write', null, new ApiError('chat_revision_conflict', 409), signal);
      const revision = (++sequence).toString(16).padStart(64, '0');
      let result: unknown;
      if (path === '/api/chat/execution') {
        const parsed = parseExecutionConfiguration({ revision, policy: input.policy });
        if (!parsed) throw new ApiError('invalid_execution_policy', 400);
        execution[source] = parsed;
        result = parsed;
      } else {
        const parsed = parseChatAuthorization({ revision, version: input.version, grants: input.grants, cancelAvailable: authorization[source].cancelAvailable });
        if (!parsed) throw new ApiError('invalid_authorization', 400);
        authorization[source] = parsed;
        result = parsed;
      }
      return settle(source, 'write', result, mode === 'unknown' ? new ApiError('operation_unknown', 504) : null, signal);
    },
  };
}
const clients = Object.fromEntries(sources.map(source => [source, fixtureApi(source)])) as Record<Source, ApiClient>;

function Fixture() {
  const { theme, setTheme } = useTheme();
  const [connected, setConnected] = useState(true);
  const [source, setSource] = useState<Source>('A');
  const [mounted, setMounted] = useState(true);
  const [dirty, setDirtyState] = useState<Readonly<Record<string, boolean>>>({});
  const [navigation, setNavigation] = useState('');
  const [, render] = useState(0);
  const view = new URLSearchParams(location.search).get('view') ?? 'bootstrap';
  const setDirty = useCallback((value: boolean, scope = 'default') => setDirtyState(current => current[scope] === value ? current : { ...current, [scope]: value }), []);
  useEffect(() => {
    const update = () => render(value => value + 1);
    addEventListener('execution-runtime-fixture-change', update);
    return () => removeEventListener('execution-runtime-fixture-change', update);
  }, []);
  const props: PageProps = { api: clients[source], connected, snapshot: {}, setDirty, navigate: setNavigation, connect: () => setConnected(true), refresh: async () => {} };
  return <main className="mx-auto grid max-w-[90rem] gap-4 p-5"><p className="text-xs">016 隔离合成 UI 夹具；只模拟响应与延迟，不连接真实模型、生产协议或生产配置。</p>
    <nav className="flex flex-wrap gap-3 text-xs" aria-label="016 隔离控制">
      <label>显示模式<select aria-label="隔离显示模式" value={theme} onChange={event => setTheme(event.target.value as Theme)}><option value="system">跟随系统</option><option value="light">日间模式</option><option value="dark">夜间模式</option></select></label>
      <button id="runtime-fixture-hold-read" onClick={() => { holdRead = true; }}>延迟下次读取</button><button id="runtime-fixture-hold-write" onClick={() => { holdWrite = true; }}>延迟下次写入</button>
      <button id="runtime-fixture-resolve" onClick={() => { pending.shift()?.resolve(); publish(); }}>完成最旧响应</button><button id="runtime-fixture-reject" onClick={() => { pending.shift()?.reject(); publish(); }}>拒绝最旧响应</button>
      <button id="runtime-fixture-reject503" onClick={() => { pending.shift()?.reject(503); publish(); }}>读取服务不可用</button>
      <button id="runtime-fixture-disconnect" onClick={() => setConnected(false)}>断开</button><button id="runtime-fixture-connect" onClick={() => setConnected(true)}>重连</button><button id="runtime-fixture-source-b" onClick={() => setSource('B')}>切换 API B</button>
      <button id="runtime-fixture-success" onClick={() => { mode = 'success'; }}>写入成功</button><button id="runtime-fixture-conflict" onClick={() => { mode = 'conflict'; }}>写入冲突</button><button id="runtime-fixture-unknown" onClick={() => { mode = 'unknown'; }}>写入结果未知</button>
      <button id="runtime-fixture-unmount" onClick={() => setMounted(false)}>卸载</button><button id="runtime-fixture-mount" onClick={() => setMounted(true)}>挂载</button>
      {['not-started', 'running', 'unknown', 'pending-stop', 'unsettled-create', 'null', 'missing'].map(value => <button id={`runtime-fixture-bootstrap-${value}`} key={value} onClick={() => { bootstrapMode = value; }}>{value}</button>)}
      <button id="runtime-fixture-large" onClick={() => { featureCount = 64; }}>64 个功能声明</button>
      <button id="runtime-fixture-cancel-enabled" onClick={() => { authorization[source] = { ...authorization[source], cancelAvailable: true }; }}>声明停止授权能力</button><button id="runtime-fixture-cancel-disabled" onClick={() => { authorization[source] = { ...authorization[source], cancelAvailable: false }; }}>不支持停止授权</button>
      {['NATIVE_CHAT_CORRELATION_PLUGIN_UNAVAILABLE', 'NATIVE_CHAT_PERSONA_VERSION_MIGRATION_REQUIRED', 'NATIVE_CHAT_SESSION_CONFIGURATION_CONFLICT'].map(value => <button id={`runtime-fixture-error-${value}`} key={value} onClick={() => { runtimeError = value; }}>{value}</button>)}
    </nav>
    <output id="runtime-fixture-state" data-source={source} data-gets={gets} data-writes={writes.length} data-pending={pending.length} data-aborted={aborted} data-dirty={JSON.stringify(dirty)} data-navigation={navigation} data-last-write={JSON.stringify(writes.at(-1) ?? null)} />
    {mounted && (view === 'settings' ? <ChatExecutionSettings {...props} /> : view === 'authorization' ? <ChatAuthorizationManager {...props} /> : view === 'plans' ? <ChatPlanManager {...props} />
      : view === 'runtime' ? <ChatRuntimeControls api={props.api} connected={connected} dirty={false} navigate={setNavigation} />
        : view === 'sessions' ? <SessionsPage {...props} /> : view === 'features' || view === 'features-draft' ? <FeaturesPage {...props} /> : view === 'journal' ? <ExecutionJournal api={props.api} connected={connected} /> : <NativeBootstrapSummary api={props.api} connected={connected} />)}
  </main>;
}

const root = document.getElementById('root');
if (!root) throw new Error('execution_runtime_fixture_root_missing');
createRoot(root).render(<ThemeProvider><Fixture /></ThemeProvider>);
