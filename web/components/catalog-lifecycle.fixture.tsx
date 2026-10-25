import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PersonaPage } from '../pages/persona.tsx';
import { AccessPage } from '../pages/access.tsx';
import { ChatPlanManager } from './chat-plan-manager.tsx';
import { ConfigurationEditor } from './configuration-editor.tsx';
import { ApiError, asRecord, type ApiClient } from '../lib/api.ts';
import type { PageProps } from '../lib/types.ts';
import '../console.css';

interface FixtureRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly generation: number;
  readonly signal?: AbortSignal;
  readonly body?: unknown;
}

interface PendingRequest {
  readonly resolve: () => void;
  readonly reject: () => void;
}

const requests: FixtureRequest[] = [];
const pending: PendingRequest[] = [];
let holdGet = false;
let holdPost = false;

function publish() { dispatchEvent(new Event('fixture-request-change')); }

function fixtureApi(generation: number): ApiClient {
  const additional = new URLSearchParams(location.search).has('many') ? 127 : 0;
  const basePersona = { id: 'persona:imported', name: `重连人设 ${generation}`, identity: '合成身份正文', style: '合成表达风格' };
  const basePlan = { id: 'plan:imported', name: `重连方案 ${generation}`, description: '', instructions: '合成方案指令', personaId: 'persona:imported', provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'low', contextLimits: { group: 128_000, private: 128_000 } };
  let personas: unknown = { revision: `persona-${generation}`, personas: [basePersona, ...Array.from({ length: additional }, (_, index) => ({ ...basePersona, id: `persona:${index + 1}`, name: `列表人设 ${index + 1}` }))] };
  let plans: unknown = { revision: (generation * 2).toString(16).padStart(64, '0'), activePlanId: 'plan:imported', plans: [basePlan, ...Array.from({ length: additional }, (_, index) => ({ ...basePlan, id: `plan:${index + 1}`, name: `列表方案 ${index + 1}` }))] };
  let gatewayId = 'fixture-outbound';
  let access: unknown = { revision: `access-${generation}`, allow: ['private:123'], deny: [], owner: String(700_000 + generation) };
  function configuration() {
    return { capabilities: { apply: false }, groups: [{ id: 'gateway-persona', title: '网关人格标识', description: '出站网关身份，与人设正文分开保存。', source: 'gateway', category: 'settings', revision: `gateway-${generation}`, fields: [{ id: 'persona.id', label: '人格 ID', description: '出站网关身份标识。', type: 'text', value: gatewayId }, { id: 'persona.version', label: '人格版本', description: '出站网关身份版本。', type: 'text', value: 'v1' }] }] };
  }
  function delayed(value: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => { pending.push({ resolve: () => resolve(value), reject: () => reject(new ApiError('operation_unknown', 504)) }); publish(); });
  }
  return {
    async get(path, signal) {
      requests.push({ method: 'GET', path, generation, signal });
      signal?.addEventListener('abort', publish, { once: true });
      publish();
      if (path === '/api/chat/personas') {
        if (holdGet) { holdGet = false; return delayed(personas); }
        return personas;
      }
      if (path === '/api/chat/access') {
        if (holdGet) { holdGet = false; return delayed(access); }
        return access;
      }
      if (path === '/api/chat/authorization') return { revision: '0'.repeat(64), version: 'fixture', grants: [] };
      if (path === '/api/chat/plans') return plans;
      if (path === '/api/chat/deployment') return { revision: 'e'.repeat(64), deployment: { target: null, modelSettings: null, namespace: 'fixture' } };
      if (path === '/api/chat/application') return { schema: 1, operation: null };
      if (path === '/api/chat/appearance') return { schema: 1, revision: 'e'.repeat(64), assets: [], bindings: [] };
      if (path === '/api/chat/status') return { runtimeConnected: false };
      if (path === '/api/chat/providers') return { revision: 'fixture-providers', providers: [{ id: 'fixture-provider', name: '合成提供方', enabled: true, models: [{ id: 'fixture-model', name: '合成模型' }] }] };
      if (path === '/api/configuration') return configuration();
      throw new Error('fixture_unknown_get');
    },
    async post(path, body, signal) {
      requests.push({ method: 'POST', path, generation, body, signal });
      signal?.addEventListener('abort', publish, { once: true });
      publish();
      const record = asRecord(body);
      if (path === '/api/chat/personas') {
        const result = { revision: `saved-persona-${generation}`, personas: record.personas };
        if (holdPost) { holdPost = false; return delayed(result); }
        personas = result;
        return result;
      }
      if (path === '/api/chat/access') {
        const result = { revision: `saved-access-${generation}`, allow: record.allow, deny: record.deny, owner: record.owner };
        if (holdPost) { holdPost = false; return delayed(result); }
        access = result;
        return result;
      }
      if (path === '/api/chat/plans') {
        plans = { revision: (generation * 2 + 1).toString(16).padStart(64, '0'), activePlanId: record.activePlanId, plans: record.plans };
        return plans;
      }
      if (path === '/api/configuration') {
        const changes = asRecord(record.changes);
        if (typeof changes['persona.id'] === 'string') gatewayId = changes['persona.id'];
        return { ok: true, revision: `saved-gateway-${generation}` };
      }
      throw new Error('fixture_unknown_post');
    },
  };
}

function Fixture() {
  const [generation, setGeneration] = useState(0);
  const [connected, setConnected] = useState(true);
  const [mounted, setMounted] = useState(true);
  const [page, setPage] = useState('persona');
  const [scopes, setScopes] = useState<Readonly<Record<string, boolean>>>({});
  const [, refreshRequests] = useState(0);
  const api = useMemo(() => fixtureApi(generation), [generation]);
  const reportDirty = useCallback((value: boolean, scope = 'default') => setScopes(current => current[scope] === value ? current : { ...current, [scope]: value }), []);
  useEffect(() => {
    const refresh = () => refreshRequests(value => value + 1);
    addEventListener('fixture-request-change', refresh);
    return () => removeEventListener('fixture-request-change', refresh);
  }, []);
  const props: PageProps = { api, connected, snapshot: {}, connect() {}, async refresh() {}, navigate() {}, setDirty: reportDirty };
  const posts = requests.filter(request => request.method === 'POST');
  const lastPersonaPost = posts.findLast(request => request.path === '/api/chat/personas');
  const lastPlanPost = posts.findLast(request => request.path === '/api/chat/plans');
  const lastAccessPost = posts.findLast(request => request.path === '/api/chat/access');
  return <main className="mx-auto grid max-w-[90rem] gap-5 p-5">
    <nav className="flex flex-wrap gap-3">
      <button id="fixture-hold-get" onClick={() => { holdGet = true; }}>延迟下一次人设读取</button><button id="fixture-hold-post" onClick={() => { holdPost = true; }}>延迟下一次人设保存</button>
      <button id="fixture-resolve" onClick={() => { pending.shift()?.resolve(); publish(); }}>完成最早请求</button><button id="fixture-reject" onClick={() => { pending.shift()?.reject(); publish(); }}>拒绝最早请求</button>
      <button id="fixture-disconnect" onClick={() => setConnected(false)}>断开</button><button id="fixture-reconnect" onClick={() => { setGeneration(value => value + 1); setConnected(true); }}>重新连接</button>
      <button id="fixture-unmount" onClick={() => setMounted(false)}>卸载</button><button id="fixture-mount" onClick={() => { setGeneration(value => value + 1); setMounted(true); }}>重新挂载</button>
      <button id="fixture-persona" onClick={() => setPage('persona')}>人设</button><button id="fixture-plan" onClick={() => setPage('plan')}>方案</button><button id="fixture-access" onClick={() => setPage('access')}>访问</button>
    </nav>
    <output id="fixture-requests" data-posts={posts.length} data-pending={pending.length} data-aborted={requests.filter(request => request.signal?.aborted).length} data-persona-signal={lastPersonaPost?.signal !== undefined} data-access-signal={lastAccessPost?.signal !== undefined} data-persona-id={String(asRecord((asRecord(lastPersonaPost?.body).personas as unknown[] | undefined)?.[0]).id ?? '')} data-plan-id={String(asRecord((asRecord(lastPlanPost?.body).plans as unknown[] | undefined)?.[0]).id ?? '')} />
    <div>{Object.entries(scopes).map(([scope, dirty]) => <output key={scope} data-dirty-scope={scope} data-dirty={dirty}>{scope}</output>)}</div>
    {mounted && (page === 'persona' ? <><PersonaPage {...props} /><ConfigurationEditor category="settings" {...props} /></> : page === 'access' ? <AccessPage {...props} /> : <ChatPlanManager {...props} />)}
  </main>;
}

const root = document.getElementById('root');
if (!root) throw new Error('fixture_root_missing');
createRoot(root).render(<Fixture />);
