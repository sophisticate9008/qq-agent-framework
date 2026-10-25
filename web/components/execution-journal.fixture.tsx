import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { executionRecord } from '../../test/fixtures/execution-records.ts';
import { bootstrapRuntimeRecord } from '../../test/fixtures/bootstrap-records.ts';
import { ApiError, type ApiClient } from '../lib/api.ts';
import type { ExecutionJournalEntry } from '../lib/execution-journal.ts';
import { SessionsPage } from '../pages/sessions.tsx';
import { ExecutionJournal } from './execution-journal.tsx';
import '../console.css';

let version = 0;
let holdNext = false;
let partial = false;
let cycle = false;
let duplicateChanged = false;
let emptyFirst = false;
let failure: number | null = null;
let gets = 0;
let posts = 0;
let aborted = 0;
const pending: { readonly resolve: () => void; readonly reject: () => void }[] = [];
const publish = () => dispatchEvent(new Event('execution-fixture-change'));

function fixtureRecord(index: number) {
  const changes: Partial<ExecutionJournalEntry> = index === 0
    ? { status: 'timed-out', externalStatus: 'unknown', deadlineReached: true, cancelStatus: 'accepted', noticeStatus: 'unknown', lastError: 'FIXTURE_PRIVATE_ERROR_NEVER_DISPLAY' }
    : index === 1 ? { status: 'completed', externalStatus: 'completed', isolated: false,
      userMessage: { eventId: 'isolated-message-proof', messageId: 'isolated-message-1' },
      turn: { id: 'isolated-turn-1', evidenceId: 'isolated-turn-proof' }, lastEventId: 'isolated-final-1' }
      : index === 2 ? { status: 'unknown', externalStatus: 'unknown' }
        : index === 3 ? { status: 'failed', externalStatus: 'failed', isolated: false }
          : index === 4 ? { status: 'rejected', externalStatus: 'rejected', isolated: false }
            : index === 5 ? { status: 'timed-out', externalStatus: 'completed', deadlineReached: true, isolated: false, lateOutcome: { eventId: 'isolated-late-final', outcome: 'completed' } }
              : {};
  return { ...executionRecord(index, changes), revision: version + 1,
    binding: { conversationId: `group:${100_000 + version * 100_000 + index}`, sessionId: `isolated-session-${version}-${index}`, generation: version + 1 } };
}

const api: ApiClient = {
  async get(path, signal) {
    const url = new URL(path, 'http://isolated.invalid');
    if (url.pathname === '/api/chat/runtime') return bootstrapRuntimeRecord();
    if (url.pathname === '/api/chat/sessions' && url.searchParams.get('limit') === '100') {
      return { revision: 'isolated-session-page', resetAvailable: false, next: null,
        sessions: [{ key: 'group:100000', sessionId: 'isolated-page-session', owner: false }] };
    }
    if (url.pathname !== '/api/chat/executions' || url.searchParams.get('limit') !== '100') throw new Error('isolated_unexpected_execution_request');
    gets++;
    signal?.addEventListener('abort', () => { aborted++; publish(); }, { once: true });
    const after = url.searchParams.get('after');
    const batch = Array.from({ length: 320 }, (_, index) => fixtureRecord(index)).filter(item => after === null || item.cursor > after).slice(0, 100);
    const items = emptyFirst && after === null ? [] : duplicateChanged && after
      ? [{ ...fixtureRecord(0), revision: version + 10, status: 'unknown', externalStatus: 'unknown' }, ...batch] : batch;
    const response = { native: true, items, next: cycle && after ? after : batch.length === 100 ? batch.at(-1)?.cursor ?? null : null, partial, manualCancelAvailable: false };
    const error = failure === null ? null : new ApiError(failure === 403 ? 'forbidden' : 'execution_journal_unavailable', failure);
    if (holdNext) {
      holdNext = false;
      return new Promise((resolve, reject) => { pending.push({ resolve: () => error ? reject(error) : resolve(response), reject: () => reject(new ApiError('service_unavailable', 504)) }); publish(); });
    }
    publish();
    if (error) throw error;
    return response;
  },
  async post() { posts++; publish(); throw new Error('execution_journal_must_not_write'); },
};

function Fixture() {
  const [connected, setConnected] = useState(true);
  const [mounted, setMounted] = useState(true);
  const [, render] = useState(0);
  const sessionsMode = new URLSearchParams(location.search).get('mount') === 'sessions';
  useEffect(() => {
    const update = () => render(value => value + 1);
    addEventListener('execution-fixture-change', update);
    return () => removeEventListener('execution-fixture-change', update);
  }, []);
  return <main className="mx-auto grid max-w-[90rem] gap-4 p-5">
    <p className="text-xs">016 合成只读执行日志夹具；不连接生产服务，不证明实际路由已装配。</p>
    <nav className="flex flex-wrap gap-3 text-xs" aria-label="隔离夹具控制">
      <button id="execution-fixture-hold" onClick={() => { holdNext = true; }}>延迟下一次读取</button>
      <button id="execution-fixture-resolve" onClick={() => { pending.shift()?.resolve(); publish(); }}>完成最旧读取</button>
      <button id="execution-fixture-reject" onClick={() => { pending.shift()?.reject(); publish(); }}>拒绝最旧读取</button>
      <button id="execution-fixture-disconnect" onClick={() => setConnected(false)}>断开</button>
      <button id="execution-fixture-connect" onClick={() => setConnected(true)}>重连</button>
      <button id="execution-fixture-version" onClick={() => { version++; publish(); }}>切换合成新记录</button>
      <button id="execution-fixture-partial" onClick={() => { partial = true; }}>部分记录</button>
      <button id="execution-fixture-cycle" onClick={() => { cycle = true; }}>循环后续位置</button>
      <button id="execution-fixture-change" onClick={() => { duplicateChanged = true; }}>变化的重复记录</button>
      <button id="execution-fixture-empty" onClick={() => { emptyFirst = true; }}>空首批仍有后续</button>
      <button id="execution-fixture-forbidden" onClick={() => { failure = 403; }}>读取被拒绝</button>
      <button id="execution-fixture-unavailable" onClick={() => { failure = 404; }}>读取不可用</button>
      <button id="execution-fixture-unmount" onClick={() => setMounted(false)}>卸载</button>
      <button id="execution-fixture-mount" onClick={() => setMounted(true)}>重新挂载</button>
    </nav>
    <output id="execution-fixture-state" data-gets={gets} data-posts={posts} data-aborted={aborted} data-pending={pending.length} data-version={version} />
    {mounted && (sessionsMode ? <SessionsPage api={api} connected={connected} snapshot={{}} connect={() => setConnected(true)} refresh={async () => {}} navigate={() => {}} setDirty={() => {}} /> : <ExecutionJournal api={api} connected={connected} />)}
  </main>;
}

const root = document.getElementById('root');
if (!root) throw new Error('execution_fixture_root_missing');
createRoot(root).render(<Fixture />);
