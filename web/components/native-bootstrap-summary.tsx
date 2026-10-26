import { useState } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { ApiError, errorMessage, type ApiClient } from '../lib/api.ts';
import { bootstrapLifecycleLabel, parseNativeBootstrapSummary } from '../lib/native-bootstrap-summary.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import { DetailsWindow, TechnicalDetails } from './read-only-details.tsx';
import { Button } from './ui/button.tsx';

/** Runtime diagnostics are read only while the details window is open. */
export function NativeBootstrapSummary({ api, connected }: { readonly api: ApiClient; readonly connected: boolean }) {
  const [open, setOpen] = useState(false);
  const resource = useReadResource(api, '/api/chat/runtime', connected && open, parseNativeBootstrapSummary);
  const available = resource.snapshot;
  const bootstrap = available?.bootstrap;
  return <><Button size="sm" variant="ghost" disabled={!connected} onClick={() => setOpen(true)}>扩展运行详情</Button>
    <DetailsWindow open={open} onOpenChange={setOpen} title="扩展运行详情" description="按需读取当前扩展的运行状态与安装记录。">
      <div className="grid gap-3" data-native-bootstrap-summary>
        <div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" disabled={!connected || resource.loading} onClick={resource.refresh}><RefreshCw className="size-3.5" />重新读取</Button>{resource.loading && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />正在读取{available ? '，暂列上次结果' : ''}</p>}</div>
        {!connected && <p role="status">连接后可查看扩展状态。</p>}
        {resource.error && <p role="alert" className="text-destructive">{resource.error instanceof ApiError && resource.error.status === 403 ? '当前连接没有读取扩展状态的权限。' : '扩展状态读取失败，当前结果仍待核对。'}</p>}
        {available?.availability === 'not-provided' && <p>当前服务未提供扩展状态，暂时无法核对。</p>}
        {available?.availability === 'not-configured' && <p>当前未配置本地扩展。</p>}
        {bootstrap && <><p>{bootstrapLifecycleLabel(bootstrap)}</p><p className="text-xs text-muted-foreground">安装记录与运行状态分别核对；工具可用性和会话权限由实际请求确认。</p><TechnicalDetails fields={[
          { label: '宿主状态', value: available?.runtimeState }, { label: '扩展清单', value: bootstrap.manifest },
          { label: '代码指纹', value: bootstrap.codeFingerprint }, { label: '运行边界', value: { trust: bootstrap.trust, sandboxed: bootstrap.sandboxed, requiresSeparateAuthorization: bootstrap.requiresSeparateAuthorization } }, { label: '生命周期未结束', value: bootstrap.unsettledLifecycle },
          { label: '扩展记录', value: bootstrap.details ?? '挂载详情尚未提供，不能按零项或已停止处理。' },
        ]} /></>}
        {resource.error && <TechnicalDetails fields={[{ label: '读取错误', value: errorMessage(resource.error) }]} />}
      </div>
    </DetailsWindow></>;
}
