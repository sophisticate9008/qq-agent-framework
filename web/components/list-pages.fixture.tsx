import { useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionsPage } from '../pages/sessions.tsx';
import { UsagePage } from '../pages/usage.tsx';
import { ProviderManager } from './provider-manager.tsx';
import { virtualizedPagesFixture } from '../../test/fixtures/virtualized-pages.ts';
import { ApiError, type ApiClient } from '../lib/api.ts';
import type { PageId, PageProps } from '../lib/types.ts';
import '../console.css';

const data = virtualizedPagesFixture();
const api: ApiClient = {
  async get(path) {
    const url = new URL(path, 'http://fixture.invalid');
    if (url.pathname === '/api/chat/sessions') return data.sessions;
    if (url.pathname === '/api/chat/providers') return data.providers;
    if (url.pathname === '/api/chat/usage') return data.summary;
    if (url.pathname === '/api/chat/usage/turns') return data.turns(url.searchParams.get('key') ?? 'group:100000');
    if (url.pathname === '/api/chat/usage/recent') return data.recent;
    if (url.pathname === '/api/chat/usage/series') return data.series(Number(url.searchParams.get('hours') ?? 24));
    throw new Error('isolated_fixture_path_unknown');
  },
  async post() { throw new ApiError('isolated_fixture_writes_disabled', 405); },
};

function Fixture() {
  const [page, setPage] = useState<PageId>('sessions');
  const [dirty, setDirty] = useState(false);
  const reportDirty = useCallback((value: boolean) => setDirty(value), []);
  const props: PageProps = { api, connected: true, snapshot: {}, connect() {}, async refresh() {}, navigate: setPage, setDirty: reportDirty };
  return <main className="mx-auto grid max-w-[90rem] gap-5 p-5">
    <nav className="flex gap-3"><button data-fixture-page="sessions" onClick={() => setPage('sessions')}>会话</button><button data-fixture-page="usage" onClick={() => setPage('usage')}>用量</button><button data-fixture-page="providers" onClick={() => setPage('providers')}>提供方</button><span data-fixture-dirty={dirty}>{dirty ? '未保存' : '已载入'}</span></nav>
    {page === 'sessions' ? <SessionsPage {...props} /> : page === 'usage' ? <UsagePage {...props} /> : <ProviderManager {...props} />}
  </main>;
}

const root = document.getElementById('root');
if (!root) throw new Error('fixture_root_missing');
createRoot(root).render(<Fixture />);
