import { chatRuntimeReason } from '../lib/chat-runtime.ts';
import { ConversationMediaDiagnostics } from './conversation-media-diagnostics.tsx';
import { useEffect, useState } from 'react';
import { parseNativeConversationDiagnostics, type NativeConversationDiagnostics } from '../../src/contracts/native-diagnostics.ts';
import { readResource } from '../lib/resource-reader.ts';
import type { PageId, PageProps } from '../lib/types.ts';
import { Button } from './ui/button.tsx';
import { StatusPill } from './management.tsx';
import { ReadOnlyDetails, TechnicalDetails } from './read-only-details.tsx';
const destinations: Readonly<Record<string, PageId>> = { chat: 'adapters', adapters: 'adapters', security: 'security', input: 'persona', features: 'features', executions: 'sessions', sessions: 'sessions', assistant: 'model', model: 'model' };
const labels = { ready: '未发现阻碍', waiting: '正在等待', blocked: '需要处理', unknown: '尚未确认' };
function plain(text: string): string { return text.replace(/（[A-Z][A-Z0-9_:-]+）/g, '').replace(/\b[a-zA-Z]+(?:_[a-zA-Z0-9]+)+\b/g, '具体原因见技术详情'); }
export function ConversationDiagnostics({ api, connected, navigate, conversationId }: PageProps & { readonly conversationId: string | null }) {
  const [version, setVersion] = useState(0);
  const [value, setValue] = useState<NativeConversationDiagnostics | null>(null);
  const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  useEffect(() => {
    setValue(null); setError('');
    if (!conversationId || !connected) return;
    const controller = new AbortController(); setLoading(true);
    void readResource(api, `/api/chat/diagnostics?conversationId=${encodeURIComponent(conversationId)}`, controller.signal).then(input => {
      const parsed = parseNativeConversationDiagnostics(input);
      if (!parsed || parsed.conversationId !== conversationId) throw new Error('invalid_diagnostics');
      if (!controller.signal.aborted) setValue(parsed);
    }).catch(() => { if (!controller.signal.aborted) setError('暂时无法检查，请稍后重试。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, connected, conversationId, version]);
  const current = connected && value?.conversationId === conversationId ? value : null;
  const checks = current ? [...current.checks].sort((a, b) => ({ blocked: 0, waiting: 1, unknown: 2, ready: 3 })[a.state] - ({ blocked: 0, waiting: 1, unknown: 2, ready: 3 })[b.state]) : [];
  return <div className="grid gap-4" id="conversation-diagnostics">
    <div className="flex items-center justify-between gap-2"><span className="text-sm text-muted-foreground">{loading ? '正在检查…' : current ? `检查于 ${new Date(current.observedAt).toLocaleTimeString()}` : '选择会话后自动检查'}</span><Button size="sm" variant="outline" disabled={!connected || loading || !conversationId} onClick={() => setVersion(value => value + 1)}>重新检查</Button></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {current && <><StatusPill tone={current.state === 'ready' ? 'success' : 'warning'}>{labels[current.state]}</StatusPill>
      {current.state === 'ready' && <p>当前连接与会话状态正常。此检查不能确认历史上每条消息都已回复。</p>}
      {checks.map((item, index) => {
        const page = item.href ? destinations[item.href.replace(/^[#/]/, '')] : undefined;
        return <div key={`${item.code}:${index}`} className="rounded-lg border p-3 text-sm"><p className="font-medium">{plain(item.summary.startsWith('运行条件未满足：') ? chatRuntimeReason(item.code).text : item.summary)}</p>{item.nextAction && <p className="mt-1 text-muted-foreground">{plain(item.nextAction)}</p>}{page && page !== 'sessions' && <Button size="sm" variant="ghost" onClick={() => navigate(page)}>打开设置</Button>}</div>;
      })}
      {current.coverage.history !== 'complete' && <p className="text-xs text-muted-foreground">历史记录不完整，以上只列出目前能够确认的情况。</p>}
      <ReadOnlyDetails title="检查详情" label="技术详情" description="运行状态、配置与原始原因码。"><TechnicalDetails fields={[
        { label: '会话', value: current.conversationId }, { label: '检查时间', value: new Date(current.observedAt).toLocaleString() },
        { label: '唤醒设置', value: current.input }, { label: '模型容量', value: current.context ?? '尚未确认' },
        { label: '记录覆盖', value: current.coverage }, { label: '检查记录与原因码', value: current.checks },
      ]} /></ReadOnlyDetails>
    </>}
    <ConversationMediaDiagnostics api={api} connected={connected} conversationId={conversationId} />
  </div>;
}
