import { ConversationMediaDiagnostics } from './conversation-media-diagnostics.tsx';
import { useEffect, useState } from 'react';
import { parseNativeConversationDiagnostics, type NativeConversationDiagnostics } from '../../src/contracts/native-diagnostics.ts';
import { readResource } from '../lib/resource-reader.ts';
import { createDraftKey, retainDraft, retainedDraft } from '../lib/retained-drafts.ts';
import type { PageId, PageProps } from '../lib/types.ts';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { Field, Section, StatusPill } from './management.tsx';
const draftKey = createDraftKey<string>('conversation-diagnostics-filter', { kind: 'state' });
const destinations: Readonly<Record<string, PageId>> = { chat: 'adapters', adapters: 'adapters', security: 'security', input: 'features', features: 'features', executions: 'sessions', sessions: 'sessions', assistant: 'model', model: 'model' };
const labels = { ready: '已核对可用', waiting: '等待处理', blocked: '需要处理', unknown: '尚未确认' };
export function ConversationDiagnostics({ api, connected, navigate, conversationId }: PageProps & { readonly conversationId: string | null }) {
  const [filter, setFilter] = useState(() => retainedDraft(api, draftKey) ?? conversationId ?? ''); const [target, setTarget] = useState(''); const [readVersion, setReadVersion] = useState(0);
  const [value, setValue] = useState<NativeConversationDiagnostics | null>(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  useEffect(() => { if (conversationId && /^(group|private):[1-9][0-9]{0,31}$/.test(conversationId)) { setFilter(conversationId); retainDraft(api, draftKey, conversationId); } }, [api, conversationId]);
  useEffect(() => {
    if (!target || !connected) return;
    const controller = new AbortController(); setLoading(true); setError('');
    void readResource(api, `/api/chat/diagnostics?conversationId=${encodeURIComponent(target)}`, controller.signal).then(input => { const parsed = parseNativeConversationDiagnostics(input); if (!parsed || parsed.conversationId !== target) throw new Error('invalid_diagnostics'); if (!controller.signal.aborted) setValue(parsed); }).catch(() => { if (!controller.signal.aborted) setError('诊断暂时无法读取；保留上次证据，当前状态未知。'); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, connected, target, readVersion]);
  function check(): void { const selected = filter.trim(); if (!/^(group|private):[1-9][0-9]{0,31}$/.test(selected)) { setError('请输入 group:群号 或 private:QQ号。'); return; } setTarget(selected); setReadVersion(value => value + 1); }
  return <Section id="conversation-diagnostics" title="检查此会话为何没有回复" description="只读核对运行、访问、唤醒方式、执行隔离与发送证据；不会提交新消息。">
    <div className="grid gap-3"><div className="flex flex-wrap items-end gap-2"><Field label="诊断会话" className="min-w-48 flex-1"><Input value={filter} onChange={event => { setFilter(event.target.value); retainDraft(api, draftKey, event.target.value); }} placeholder="group:123 / private:123" /></Field><Button disabled={!connected || loading} onClick={check}>{loading ? '正在检查' : '检查会话'}</Button></div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {value && <div className="grid gap-3 text-xs"><div className="flex flex-wrap gap-2"><strong>{value.conversationId}</strong><StatusPill tone={error ? 'warning' : value.state === 'ready' ? 'success' : value.state === 'blocked' ? 'warning' : 'warning'}>{error ? '上次结果，尚未刷新' : labels[value.state]}</StatusPill></div><p className="text-muted-foreground">核对时间 {new Date(value.observedAt).toLocaleString()}；历史覆盖 {value.coverage.history}，每个目录扫描上限 {value.coverage.scannedPerNamespace}；运行实例{value.coverage.live ? '已运行' : '未运行'}。{value.coverage.history !== 'complete' && '历史不完整，未发现不能等同于没有阻碍。'}</p>{value.input && <p>唤醒方式：@提及{value.input.mention ? '开启' : '关闭'}、引用回复{value.input.reply ? '开启' : '关闭'}、称呼 {value.input.nicknames.join('、') || '未配置'}；连续对话窗口 {value.input.continuationMs / 1000} 秒。</p>}
        {value.context ? <p>上下文策略来源：{value.context.source === 'active-session' ? '当前运行会话' : '已保存方案，尚不代表运行值'}；容量 {value.context.limit.toLocaleString()} token；模型窗口 {value.context.modelWindow?.toLocaleString() ?? '未核实'}，最大输出 {value.context.maxOutput?.toLocaleString() ?? '未核实'}，压缩预留 {value.context.headroomTokens?.toLocaleString() ?? '未核实'}。</p> : <p className="text-muted-foreground">尚未核实当前绑定的运行容量；已保存方案不等于此会话已应用。</p>}
        {value.checks.map((item, index) => { const page = item.href ? destinations[item.href.replace(/^[#/]/, '')] : undefined; return <div key={`${item.code}:${index}`} className="rounded-lg border p-3"><p><strong>{labels[item.state]}</strong> · {item.summary}</p>{item.nextAction && <p className="mt-1 text-muted-foreground">{item.nextAction}</p>}{page && <Button size="sm" variant="ghost" onClick={() => navigate(page)}>打开相关设置或记录</Button>}</div>; })}</div>}
      <ConversationMediaDiagnostics api={api} connected={connected} conversationId={target || conversationId} />
    </div>
  </Section>;
}
