import { useDeferredValue, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VirtualList, VirtualTableBody, type VirtualListHandle } from './virtual-list.tsx';

const largeRows = Array.from({ length: 50_000 }, (_, index) => ({ id: `fixture-${index}`, index }));
const smallRows = largeRows.slice(0, 40);
const getKey = (row: { readonly id: string }) => row.id;

function Fixture() {
  const table = useRef<VirtualListHandle>(null);
  const list = useRef<VirtualListHandle>(null);
  const [filter, setFilter] = useState('');
  const query = useDeferredValue(filter);
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [expanded, setExpanded] = useState(false);
  const filtered = useMemo(() => query ? largeRows.filter(row => row.id.includes(query)) : largeRows, [query]);
  return <main>
    <h1>隔离虚拟列表性能夹具 · 每组 50,000 行</h1>
    <label>全量筛选 <input id="fixture-filter" value={filter} onChange={event => setFilter(event.target.value)} /></label>
    <label>不参与虚拟化的只写密钥 <input id="fixture-secret" type="password" autoComplete="new-password" /></label>
    <button id="table-end" onClick={() => table.current?.scrollToIndex(filtered.length - 1)}>表格末行</button>
    <button id="list-end" onClick={() => list.current?.scrollToIndex(largeRows.length - 1)}>列表末行</button>
    <button id="expand" onClick={() => setExpanded(value => !value)}>切换动态高度</button>
    <div id="table-scroll" className="viewport" tabIndex={0}>
      <table aria-rowcount={filtered.length + 1}>
        <thead><tr><th>标识</th><th>不等高内容</th><th>选择</th></tr></thead>
        <VirtualTableBody items={filtered} getItemKey={getKey} columns={3} estimateSize={64} listRef={table}>{row => <tr data-fixture-table-row={row.index}>
          <td>{row.id}</td><td><div style={{ minHeight: 28 + row.index % 5 * (expanded ? 27 : 11) }}>纯合成非生产数据 {row.index % 7 === 0 ? '可换行的示例内容。'.repeat(8) : '短内容'}</div></td><td><button>选择 {row.index}</button></td>
        </tr>}</VirtualTableBody>
      </table>
    </div>
    <div id="list-scroll" className="viewport" tabIndex={0}>
      <VirtualList items={largeRows} getItemKey={getKey} estimateSize={92} listRef={list} itemClassName="list-item">{row => <div data-fixture-list-row={row.index} style={{ minHeight: 50 + row.index % 4 * (expanded ? 33 : 13) }}>
        <label>{row.id} <input data-draft={row.index} value={drafts[row.id] ?? ''} onChange={event => setDrafts(current => ({ ...current, [row.id]: event.target.value }))} /></label>
      </div>}</VirtualList>
    </div>
    <div id="small-scroll" className="viewport">
      <VirtualList items={smallRows} getItemKey={getKey}>{row => <div data-small-row={row.index}>{row.id}</div>}</VirtualList>
    </div>
  </main>;
}

const root = document.getElementById('root');
if (!root) throw new Error('fixture_root_missing');
createRoot(root).render(<Fixture />);
