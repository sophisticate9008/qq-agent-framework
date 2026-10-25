import { readResource } from '../lib/resource-reader.ts';
import { useEffect, useRef, useState } from 'react';
import { Clipboard, LoaderCircle, RefreshCw } from 'lucide-react';
import { ApiError, type ApiClient } from '../lib/api.ts';
import { bootstrapDeclarationLabels, bootstrapLifecycleLabel, parseNativeBootstrapSummary, type BootstrapFeatureSummary, type BootstrapRuntimeSummary } from '../lib/native-bootstrap-summary.ts';
import { Section, StatusPill } from './management.tsx';
import { Button } from './ui/button.tsx';
import { VirtualList } from './virtual-list.tsx';

function bootstrapFeatureKey(feature: BootstrapFeatureSummary): string {
  return feature.id;
}

function TechnicalValue({ label, value, copy }: { readonly label: string; readonly value: string; readonly copy: (label: string, value: string) => Promise<void> }) {
  return <div className="grid gap-1 text-xs"><dt className="text-muted-foreground">{label}</dt><dd className="flex min-w-0 items-start gap-2"><code className="min-w-0 flex-1 select-text whitespace-pre-wrap break-all">{value}</code><Button size="icon-xs" variant="ghost" aria-label={`复制${label}`} onClick={() => void copy(label, value)}><Clipboard className="size-3.5" /></Button></dd></div>;
}

export function NativeBootstrapSummary({ api, connected }: { readonly api: ApiClient; readonly connected: boolean }) {
  const [loaded, setLoaded] = useState<BootstrapRuntimeSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const [reload, setReload] = useState(0);
  const epoch = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const loadedApi = useRef(api);
  const connection = useRef({ api, connected });
  connection.current = { api, connected };

  useEffect(() => {
    const generation = ++epoch.current;
    const controller = new AbortController();
    requestController.current?.abort();
    requestController.current = controller;
    const current = () => !controller.signal.aborted && epoch.current === generation && connection.current.api === api && connection.current.connected;
    if (loadedApi.current !== api || !connected) setLoaded(null);
    loadedApi.current = api;
    setLoading(connected);
    setError('');
    setNotice('');
    setCopyStatus('');
    if (connected) void readResource(api, '/api/chat/runtime', controller.signal).then(value => {
      if (!current()) return;
      const parsed = parseNativeBootstrapSummary(value);
      if (!parsed) throw new Error('invalid_bootstrap_summary');
      setLoaded(parsed);
    }).catch(error => {
      if (!current()) return;
      setError(error instanceof ApiError && error.status === 403 ? '当前连接没有读取扩展摘要的权限。'
        : '暂时无法核对可信扩展摘要；状态仍待确认，不代表没有扩展或已安全停止。');
    }).finally(() => { if (current()) { requestController.current = null; setLoading(false); } });
    return () => { epoch.current += 1; controller.abort(); requestController.current = null; };
  }, [api, connected, reload]);

  function readAgain(): void {
    if (!connected || loading) return;
    epoch.current += 1;
    requestController.current?.abort();
    requestController.current = null;
    setLoading(true);
    setReload(value => value + 1);
  }

  function cancelRead(): void {
    epoch.current += 1;
    requestController.current?.abort();
    requestController.current = null;
    setLoading(false);
    setNotice('已取消本次摘要读取；这不是停止扩展，当前装配状态未重新确认。');
  }

  async function copy(label: string, value: string): Promise<void> {
    const generation = epoch.current;
    const current = () => generation === epoch.current && connection.current.api === api && connection.current.connected;
    try {
      if (!navigator.clipboard) throw new Error('clipboard_unavailable');
      await navigator.clipboard.writeText(value);
      if (current()) setCopyStatus(`已复制${label}`);
    } catch { if (current()) setCopyStatus('复制未完成，可手动选中技术标识复制。'); }
  }

  const available = connected && loadedApi.current === api ? loaded : null;
  const bootstrap = available?.bootstrap ?? null;
  const details = bootstrap?.details ?? null;
  const uncertain = bootstrap?.state === 'failed' || bootstrap?.state === 'unknown' || bootstrap?.unsettledLifecycle || details?.pendingStart || details?.pendingStop;
  const runtimeLabel = available ? { stopped: '已停止', starting: '正在启动', running: '运行中', stopping: '正在停止', error: '存在异常' }[available.runtimeState] : '待核对';

  return <Section id="native-bootstrap-summary" title="可信扩展装配摘要" description="只读查看运维选定的本地扩展、功能声明与安装记录；此处不安装代码、不编辑模块路径、不创建授权。"
    actions={<><Button size="sm" variant="outline" disabled={!connected || loading} onClick={readAgain}><RefreshCw className="size-3.5" />重新读取扩展摘要</Button>{loading && <Button size="sm" variant="ghost" onClick={cancelRead}>取消摘要读取</Button>}</>}>
    <details data-native-bootstrap-summary>
      <summary className="cursor-pointer text-xs font-medium">查看功能声明、安装记录与权限边界</summary>
      <div className="mt-3 grid gap-3">
        <p className="text-xs leading-5 text-muted-foreground">这是按需读取的装配快照，不实时跟踪。功能声明、安装和注册回调都不等于获得授权，也不证明工具或真实模型调用已经就绪。</p>
        {!connected && <p role="status" className="text-xs text-muted-foreground">连接后才能核对扩展装配摘要。</p>}
        {loading && <p role="status" className="flex items-center gap-2 text-xs"><LoaderCircle className="size-3.5 animate-spin" />正在读取扩展摘要{available ? '；当前为上次读取的状态' : ''}</p>}
        {error && <p role="alert" className="text-xs leading-5 text-destructive">{error}{available ? ' 当前保留的摘要尚未重新确认。' : ''}</p>}
        {notice && <p role="status" className="text-xs leading-5 text-muted-foreground">{notice}</p>}
        {available?.availability === 'not-provided' && <p className="text-xs leading-5 text-muted-foreground">当前服务没有提供可信扩展摘要，扩展状态未知；不会按零个功能或已停用处理。</p>}
        {available?.availability === 'not-configured' && <p className="text-xs leading-5 text-muted-foreground">当前宿主未配置运维选择的可信扩展。这不代表内核功能全部关闭，也不说明其他授权不存在。</p>}
        {bootstrap && <>
          <div className="flex flex-wrap items-center justify-between gap-2"><StatusPill tone={uncertain ? 'warning' : 'neutral'}>{bootstrapLifecycleLabel(bootstrap)}</StatusPill><span className="text-xs text-muted-foreground">宿主状态：{runtimeLabel} · 扩展版本 {bootstrap.manifest.version}</span></div>
          <p className="rounded-lg border p-3 text-xs leading-5 text-muted-foreground">这是可信运维代码，在宿主进程内运行，未受沙箱隔离。此摘要没有会话授权、对象范围、次数、期限或工具执行成功的证明，不应把“已安装”理解为可以调用。</p>
          {uncertain && <p role="status" className="text-xs leading-5 text-muted-foreground">生命周期结果仍需核对。停止受理或客户端取消等待均不保证已开始的外部动作停止，不会从此摘要重放或重新安装。</p>}
          <div className="h-96 overflow-auto overscroll-contain rounded-lg border p-3" role="region" tabIndex={0} aria-label="可信扩展声明详情" data-bootstrap-summary-scroll>
            {!details ? <p className="text-xs leading-5 text-muted-foreground">{bootstrap.unsettledLifecycle ? '扩展创建或生命周期仍未结束，结果未知，目前只有清单与代码指纹。' : '目前只有已选定模块的清单与代码指纹，尚无挂载详情。'}功能、动作入口、安装记录、资源解析与转发配置均未读取，不能当作零项或未启用；宿主可能尚未启动或准备未完成，请结合聊天运行状态核对。</p> : <div className="grid gap-3">
              <dl className="grid gap-3 text-xs sm:grid-cols-2"><div><dt className="text-muted-foreground">功能声明</dt><dd className="mt-1">{details.features.length} 项</dd></div><div><dt className="text-muted-foreground">已有安装记录</dt><dd className="mt-1">{details.installedFeatureIds.length} 项（不代表当前启用或授权）</dd></div>
                <div><dt className="text-muted-foreground">动作入口声明</dt><dd className="mt-1">{details.effectCapabilities.length} 项（不代表允许执行）</dd></div><div><dt className="text-muted-foreground">自定义事件校验声明</dt><dd className="mt-1">{details.eventTypes.length} 项</dd></div>
                <div><dt className="text-muted-foreground">资源解析回调</dt><dd className="mt-1">{details.mediaResolver ? '已接入；不是通用文件访问授权' : '未接入资源解析回调'}</dd></div><div><dt className="text-muted-foreground">合并转发配置</dt><dd className="mt-1">{details.forwardConfigured ? '已提供；仍受消息能力与单独授权限制' : '未提供合并转发配置'}</dd></div></dl>
              <p className="border-t pt-3 text-xs leading-5 text-muted-foreground">安装器没有创建授权；此摘要无法判断是否存在其他可信授权。安装记录只证明曾登记安装，停止后仍可保留，不代表功能当前运行。</p>
              <h3 className="text-xs font-medium">功能声明与安装记录</h3>
              {details.features.length === 0 ? <p className="text-xs text-muted-foreground">本次摘要没有功能声明；不代表已关闭宿主内核功能。</p>
                : <VirtualList items={details.features} getItemKey={bootstrapFeatureKey} estimateSize={220} itemClassName="pb-3">{(feature, index) => {
                  const capabilities = bootstrapDeclarationLabels(feature.capabilities, 'capabilities');
                  const subscriptions = bootstrapDeclarationLabels(feature.subscriptions, 'subscriptions');
                  return <article className="grid gap-2 rounded-lg border p-3" data-bootstrap-feature={index}>
                    <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-xs font-medium">扩展功能 {index + 1} · 版本 {feature.version}</h4><span className="text-[11px] text-muted-foreground">{details.installedFeatureIds.includes(feature.id) ? '已有安装记录' : '只有声明，尚无安装记录'}</span></div>
                    <p className="text-xs leading-5 text-muted-foreground">需要独立授权的动作声明：{capabilities.length ? capabilities.join('、') : '未声明；不代表可以绕过权限检查'}。</p>
                    <p className="text-xs leading-5 text-muted-foreground">订阅的事件声明：{subscriptions.length ? subscriptions.join('、') : '未声明'}；订阅不代表会自动触发或执行成功。</p>
                    <details><summary className="cursor-pointer text-xs text-muted-foreground">此功能的技术标识</summary><dl className="mt-3 grid gap-2"><TechnicalValue label={`功能 ${index + 1} 标识`} value={feature.id} copy={copy} />{feature.capabilities.length > 0 && <TechnicalValue label={`功能 ${index + 1} 动作标识`} value={feature.capabilities.join('\n')} copy={copy} />}{feature.subscriptions.length > 0 && <TechnicalValue label={`功能 ${index + 1} 事件标识`} value={feature.subscriptions.join('\n')} copy={copy} />}</dl></details>
                  </article>;
                }}</VirtualList>}
            </div>}
            <details className="mt-3 border-t pt-3"><summary className="cursor-pointer text-xs text-muted-foreground">装配清单与代码指纹（按需展开复制）</summary><p className="mt-2 text-xs leading-5 text-muted-foreground">代码指纹只核对入口文件字节，不是依赖签名、安全审查或授权证明。</p><dl className="mt-3 grid gap-2">
              <TechnicalValue label="扩展清单标识" value={bootstrap.manifest.id} copy={copy} />
              <TechnicalValue label="扩展清单版本" value={bootstrap.manifest.version} copy={copy} />
              <TechnicalValue label="扩展接口版本" value={String(bootstrap.manifest.apiVersion)} copy={copy} />
              <TechnicalValue label="代码指纹" value={bootstrap.codeFingerprint} copy={copy} />
              {details && details.effectCapabilities.length > 0 && <TechnicalValue label="动作入口标识" value={details.effectCapabilities.join('\n')} copy={copy} />}
              {details && details.eventTypes.length > 0 && <TechnicalValue label="自定义事件校验标识" value={details.eventTypes.join('\n')} copy={copy} />}
            </dl></details>
          </div>
          {copyStatus && <p role="status" className="text-xs">{copyStatus}</p>}
        </>}
      </div>
    </details>
  </Section>;
}
