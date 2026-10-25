import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionsPage } from '../pages/sessions.tsx';
import { ApiError, asRecord, type ApiClient } from '../lib/api.ts';
import type { PageProps } from '../lib/types.ts';
import '../console.css';

let bindings = Array.from({ length: 320 }, (_, index) => ({ key: `group:${100_000 + index}`, sessionId: `synthetic-session-${index}`, owner: index === 0, generation: 1, bindingRevision: index.toString(16).padStart(64, '0') }));
let writable: boolean | undefined = false;
let hold = false;
let cycle = false;
let changed = false;
let emptyFirst = false;
let resetMode = 'success';
let posts: unknown[] = [];
let aborted = 0;
let pending: { resolve: () => void; reject: () => void } | null = null;
const publish = () => dispatchEvent(new Event('session-fixture-change'));
const api: ApiClient = {
  async get(path, signal) {
    const url = new URL(path, 'http://fixture.invalid');
    if (url.pathname !== '/api/chat/sessions' || url.searchParams.get('limit') !== '100') throw new Error('fixture_invalid_page_query');
    signal?.addEventListener('abort', () => { aborted++; publish(); }, { once: true });
    const after = url.searchParams.get('after');
    const rows = bindings.filter(binding => after === null || binding.key > after).slice(0, 100);
    const selected = emptyFirst && after === null ? [] : changed && after ? [{ ...bindings[0], sessionId: 'binding-changed-during-page' }, ...rows] : rows;
    const response = { sessions: selected, revision: `page-${after ?? 'first'}-${bindings.length}-${changed}`, next: cycle && after ? after : rows.length === 100 ? rows.at(-1)?.key ?? null : null,
      ...(writable === undefined ? {} : { resetAvailable: writable }) };
    if (hold && after) {
      hold = false;
      return new Promise((resolve, reject) => { pending = { resolve: () => resolve(response), reject: () => reject(new ApiError('service_unavailable', 504)) }; publish(); });
    }
    return response;
  },
  async post(path, body) {
    if (path !== '/api/chat/sessions/reset') throw new Error('fixture_invalid_reset_path');
    posts.push(body);
    publish();
    if (writable !== true) throw new ApiError('session_reset_not_enabled', 405);
    if (resetMode === 'conflict') throw new ApiError('session_revision_conflict', 409);
    if (resetMode === 'unknown') throw new ApiError('session_reset_unknown', 504);
    const record = asRecord(body);
    const target = bindings.find(binding => binding.key === record.key);
    if (!target || record.sessionId !== target.sessionId || record.generation !== target.generation || record.bindingRevision !== target.bindingRevision || record.confirm !== true) throw new ApiError('session_reset_conflict', 409);
    bindings = bindings.filter(binding => binding.key !== record.key);
    return { ok: true, key: record.key, previousSessionId: record.sessionId, bridgeBindingRemoved: true, externalWorkStopped: 'unverified', previousGeneration: target.generation, nextGeneration: target.generation + 1, historyPreserved: true, contextReset: true };
  },
};

function Fixture() {
  const [connected, setConnected] = useState(true);
  const [, render] = useState(0);
  const reportDirty = useCallback(() => {}, []);
  useEffect(() => {
    const refresh = () => render(value => value + 1);
    addEventListener('session-fixture-change', refresh);
    return () => removeEventListener('session-fixture-change', refresh);
  }, []);
  const props: PageProps = { api, connected, snapshot: {}, connect() {}, async refresh() {}, navigate() {}, setDirty: reportDirty };
  return <main className="mx-auto grid max-w-[90rem] gap-5 p-5"><nav className="flex flex-wrap gap-3">
    <button id="session-fixture-hold" onClick={() => { hold = true; }}>延迟下一页</button><button id="session-fixture-resolve" onClick={() => { pending?.resolve(); pending = null; publish(); }}>完成旧页</button><button id="session-fixture-reject" onClick={() => { pending?.reject(); pending = null; publish(); }}>拒绝旧页</button>
    <button id="session-fixture-disconnect" onClick={() => setConnected(false)}>断开</button><button id="session-fixture-connect" onClick={() => setConnected(true)}>重连</button>
    <button id="session-fixture-writable" onClick={() => { writable = true; }}>显式允许测试重置</button><button id="session-fixture-omit" onClick={() => { writable = undefined; }}>不声明重置能力</button>
    <button id="session-fixture-change" onClick={() => { changed = true; }}>变更重复绑定</button><button id="session-fixture-cycle" onClick={() => { cycle = true; }}>返回循环游标</button>
    <button id="session-fixture-empty-first" onClick={() => { emptyFirst = true; }}>首批尚未就绪</button>
    <button id="session-fixture-conflict" onClick={() => { resetMode = 'conflict'; }}>测试重置冲突</button><button id="session-fixture-unknown" onClick={() => { resetMode = 'unknown'; }}>测试重置未知</button>
    <output id="session-fixture-state" data-posts={posts.length} data-aborted={aborted} data-pending={pending !== null} data-last-post={JSON.stringify(posts.at(-1) ?? null)} />
  </nav><SessionsPage {...props} /></main>;
}
const root = document.getElementById('root');
if (!root) throw new Error('fixture_root_missing');
createRoot(root).render(<Fixture />);
