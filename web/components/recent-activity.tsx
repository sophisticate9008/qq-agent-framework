import { readResource } from '../lib/resource-reader.ts';
import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { errorMessage, type ApiClient } from '../lib/api.ts';
import { activityStateLabel, activityTypeLabel, activityTypeShortLabel, parseRecentActivity, type RecentActivitySnapshot } from '../lib/recent-activity.ts';
import { Section } from './management.tsx';
import { Button } from './ui/button.tsx';
import { VirtualList } from './virtual-list.tsx';

export function RecentActivity({ api, connected }: { readonly api: ApiClient; readonly connected: boolean }) {
  const [snapshot, setSnapshot] = useState<{ api: ApiClient; generation: number; value: RecentActivitySnapshot } | null>(null);
  const [failure, setFailure] = useState<{ api: ApiClient; generation: number; text: string } | null>(null);
  const [loading, setLoading] = useState(false);
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
        const value = await readResource(api, '/api/chat/activity', controller.signal);
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
  }, [api, connected]);

  const current = snapshot?.api === api && snapshot.generation === epoch.current && connected ? snapshot.value : null;
  const error = failure?.api === api && failure.generation === epoch.current && connected ? failure.text : null;
  const stateText = current ? { stopped: '未启动', starting: '启动中', running: '运行中', stopping: '停止中', error: '异常' }[current.state]
    : !connected ? '未连接' : error ? '读取失败' : loading ? '读取中' : '未读取';

  return <Section id="recent-activity" title="最近活动（100条）" scrollable className="[&>.panel-body]:h-[260px] [&>.panel-body]:p-0"
    actions={<div className="flex items-center gap-2"><span role="status" className="text-[10px] text-muted-foreground" title={`${current ? activityStateLabel(current.state) : stateText}；仅保留当前进程最近100条，重启清空。`}>{stateText}</span><Button variant="outline" size="sm" aria-label="刷新活动" disabled={!connected || loading} onClick={() => refresh.current()}><RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />刷新</Button></div>}>
    <div data-recent-activity-scroll className="h-full min-h-0 overflow-auto overscroll-contain bg-muted/20 px-3 py-2 font-mono text-xs leading-5 text-foreground">
      {!connected ? <p role="status" className="text-muted-foreground">连接工作台后可查看原生聊天活动。</p> : <>
        {error && <p role="alert" className="text-destructive">暂时无法读取最近活动。{error}{current ? ' 以下为上次读取的活动。' : ' 不会将不可用显示为零活动。'}</p>}
        {current ? <>
          {current.items.length === 0 ? !error && <p className="text-muted-foreground">当前进程尚无活动记录。</p>
            : <VirtualList items={current.items} getItemKey={item => item.id} estimateSize={20}>{item => {
              const content = item.content?.trim() ? item.content : null;
              const preview = content ?? item.summary;
              const line = `[${new Date(item.at).toLocaleTimeString('zh-CN', { hour12: false })}] ${item.conversationId ?? 'system'} [${activityTypeShortLabel(item.type)}] ${preview.replace(/\s+/gu, ' ').trim()}`;
              return <details data-activity-id={item.id} className="min-w-0">
                <summary title={`${activityTypeLabel(item.type)}；点击展开正文`} className={`w-max min-w-full cursor-pointer list-none whitespace-pre outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden ${item.level === 'error' ? 'text-destructive' : item.level === 'warning' ? 'text-amber-700 dark:text-amber-400' : ''}`}>
                  {line}
                </summary>
                <pre className="my-1 max-h-48 max-w-full overflow-auto overscroll-contain font-mono text-xs leading-5 break-words whitespace-pre-wrap">{content ?? `未提供文字正文，活动摘要：${item.summary}`}</pre>
              </details>;
            }}</VirtualList>}
        </> : !error && <p role="status" className="text-muted-foreground">{loading ? '正在读取最近活动…' : '尚未读取最近活动，页面可见时会更新。'}</p>}
      </>}
    </div>
  </Section>;
}
