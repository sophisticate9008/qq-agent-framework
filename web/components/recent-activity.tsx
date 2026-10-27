import { ReadOnlyDetails, TechnicalDetails } from './read-only-details.tsx';
import { readResource } from '../lib/resource-reader.ts';
import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { errorMessage, type ApiClient } from '../lib/api.ts';
import { activityStateLabel, activityTypeLabel, activityTypeShortLabel, parseRecentActivity, type RecentActivitySnapshot } from '../lib/recent-activity.ts';
import { Section } from './management.tsx';
import { Button } from './ui/button.tsx';
import { VirtualList } from './virtual-list.tsx';

export function RecentActivity({ api, connected, onViewAll }: { readonly onViewAll?: () => void; readonly api: ApiClient; readonly connected: boolean }) {
  const [snapshot, setSnapshot] = useState<{ api: ApiClient; generation: number; value: RecentActivitySnapshot } | null>(null);
  const [failure, setFailure] = useState<{ api: ApiClient; generation: number; text: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState<'all' | 'qq' | 'simulation'>('all');
  const epoch = useRef(0);
  const connection = useRef({ api, connected });
  connection.current = { api, connected };
  const refresh = useRef<() => void>(() => undefined);

  useEffect(() => {
    const generation = ++epoch.current;
    let active = true;
    let pending: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const current = () => active && epoch.current === generation && connection.current.api === api && connection.current.connected;
    const schedule = () => {
      clearTimeout(timer);
      if (current() && visible()) timer = setTimeout(() => { void load(); }, 5000);
    };
    async function load(): Promise<void> {
      if (!current() || pending || !visible()) return;
      clearTimeout(timer);
      const controller = new AbortController();
      pending = controller;
      const owns = () => current() && pending === controller && !controller.signal.aborted;
      setLoading(true);
      try {
        const value = await readResource(api, `/api/chat/activity?source=${source}`, controller.signal);
        if (!owns()) return;
        const next = parseRecentActivity(value);
        if (!next) throw new Error('invalid_recent_activity');
        setSnapshot({ api, generation, value: next }); setFailure(null);
      } catch (error) {
        if (owns()) setFailure({ api, generation, text: errorMessage(error) });
      } finally {
        if (owns()) { pending = null; setLoading(false); schedule(); }
      }
    }
    const requestRefresh = () => { void load(); };
    refresh.current = requestRefresh;
    const visibilityChanged = () => {
      clearTimeout(timer);
      if (visible()) void load();
    };
    setSnapshot(null); setFailure(null); setLoading(false);
    if (connected) {
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibilityChanged);
      void load();
    }
    return () => {
      active = false; epoch.current++;
      clearTimeout(timer); pending?.abort();
      if (refresh.current === requestRefresh) refresh.current = () => undefined;
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [api, connected, source]);

  const current = snapshot?.api === api && snapshot.generation === epoch.current && connected ? snapshot.value : null;
  const error = failure?.api === api && failure.generation === epoch.current && connected ? failure.text : null;
  const nativeStateText = current ? { stopped: '未启动', starting: '启动中', running: '运行中', stopping: '停止中', error: '异常' }[current.state]
    : !connected ? '未连接' : error ? '读取失败' : loading ? '读取中' : '未读取';

  const stateText = source === 'simulation' && current ? current.simulation?.state === 'available' ? '模拟已更新' : current.simulation?.state === 'unavailable' ? '模拟读取失败' : '暂无模拟' : nativeStateText;
  const items = current?.items ?? [];

  return <Section id="recent-activity" title="最近活动" className="recent-activity"
    actions={<div className="flex flex-wrap items-center gap-1"><div role="group" aria-label="活动来源" className="flex items-center gap-0.5">{([{ id: 'all', label: '全部' }, { id: 'qq', label: 'QQ' }, { id: 'simulation', label: '模拟' }] as const).map(option => <Button key={option.id} variant={source === option.id ? 'secondary' : 'ghost'} size="xs" aria-pressed={source === option.id} onClick={() => setSource(option.id)}>{option.label}</Button>)}</div><span role="status" className="text-xs text-muted-foreground" title={`${current ? activityStateLabel(current.state) : stateText}；QQ活动保留当前进程最近100条；模拟显示7天内最近模拟的本地快照。`}>{stateText}</span><Button variant="outline" size="sm" aria-label="刷新活动" disabled={!connected || loading} onClick={() => refresh.current()}><RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />刷新</Button>{onViewAll && <Button size="xs" variant="link" onClick={onViewAll}>全部记录</Button>}</div>}>
    <div data-recent-activity-scroll className="absolute inset-0 overflow-auto overscroll-contain rounded-b-[7px] bg-muted/20 font-mono text-xs leading-[18px] text-foreground">
      {!connected ? <p role="status" className="text-muted-foreground">连接工作台后可查看原生聊天活动。</p> : <>
        {error && <p role="alert" className="text-destructive">暂时无法读取最近活动。{error}{current ? ' 以下为上次读取的活动。' : ' 不会将不可用显示为零活动。'}</p>}
        {current?.simulation?.state === 'unavailable' && <p role="alert" className="px-2 text-amber-700 dark:text-amber-400">模拟活动读取失败；QQ 活动独立显示。</p>}
        {current && (current.simulation?.state === 'available' || source === 'simulation') && <p className="border-b px-2 text-violet-700 dark:text-violet-300">模拟消息与回复仅在本地捕获，未向真实 QQ 发送。</p>}
        {current ? <>
          {items.length === 0 ? !error && <p className="text-muted-foreground">{source === 'simulation' ? '7 天内尚无已发布的模拟活动。' : '当前范围尚无活动记录。'}</p>
            : <VirtualList items={items} getItemKey={item => item.id} estimateSize={20}>{(item, index) => {
              const simulated = item.origin === 'simulation';
              const content = item.content?.trim() ? item.content : null;
              const preview = content ?? item.summary;
              const sourceLabel = simulated ? '模拟 · 本地捕获' : 'QQ';
              const rowPreview = `${simulated ? `[${item.type === 'sent' ? '本地捕获' : activityTypeShortLabel(item.type)}] ` : ''}${preview.replace(/\s+/gu, ' ').trim()}`;
              const line = `${sourceLabel} [${new Date(item.at).toLocaleTimeString('zh-CN', { hour12: false })}] ${item.conversationId ?? 'system'} [${activityTypeShortLabel(item.type)}] ${(item.count ?? 1) > 1 ? `重复 ${item.count} 次 · ` : ''}${preview.replace(/\s+/gu, ' ').trim()}`;
              return <div data-activity-id={item.id} data-activity-origin={simulated ? 'simulation' : 'qq'} className={`activity-console-row ${index % 2 ? 'activity-alt' : ''} ${item.level === 'error' ? 'text-destructive' : item.level === 'warning' ? 'text-amber-700 dark:text-amber-400' : ''}`}>
                <time className="text-muted-foreground tabular-nums">{new Date(item.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>
                <span className={simulated ? 'font-semibold text-violet-700 dark:text-violet-300' : item.level === 'info' ? 'text-[var(--success)]' : ''}>{simulated ? '模拟' : activityTypeShortLabel(item.type)}</span>
                <span className="activity-source text-muted-foreground" title={`${sourceLabel} · ${item.conversationId ?? '系统'}`}>{simulated ? '模拟' : 'QQ'} · {item.conversationId ?? '系统'}</span>
                <span title={line}>{(item.count ?? 1) > 1 ? `重复 ${item.count} 次 · ` : ''}{rowPreview}</span>
                <ReadOnlyDetails compact label="⋯" title={simulated ? `模拟 · ${item.type === 'sent' ? '本地捕获' : activityTypeLabel(item.type)}` : activityTypeLabel(item.type)} description={item.summary}><TechnicalDetails fields={[{ label: '来源', value: simulated ? '模拟 · 本地捕获，未向真实 QQ 发送' : 'QQ 原生聊天' }, ...(simulated ? [{ label: '模拟轮次', value: item.simulationRunId ?? '未知' }, { label: '原始运行摘要', value: item.nativeSummary ?? item.summary }] : []), { label: '时间', value: new Date(item.at).toLocaleString() }, { label: '会话', value: item.conversationId ?? '系统' }, { label: '内容', value: content ?? '无正文' }, { label: '重复次数', value: item.count ?? 1 }, { label: '技术原因', value: item.errorCode ?? '无' }]} /></ReadOnlyDetails>
              </div>;
            }}</VirtualList>}
        </> : !error && <p role="status" className="text-muted-foreground">{loading ? '正在读取最近活动…' : '尚未读取最近活动，页面可见时会更新。'}</p>}
      </>}
    </div>
  </Section>;
}
