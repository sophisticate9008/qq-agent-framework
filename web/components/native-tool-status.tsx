import type { ApiClient } from '../lib/api.ts';
import type { PageProps } from '../lib/types.ts';
import { nativePackageStateLabels, parseNativeToolRuntimeStatus } from '../lib/native-tool-status.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import { Section } from './management.tsx';
import { Button } from './ui/button.tsx';

const packageNames: Readonly<Record<string, string>> = { 'chat-input': '聊天输入', media: '会话媒体', reminders: '提醒调度' };
export function NativeToolStatus({ api, connected, navigate }: { readonly api: ApiClient; readonly connected: boolean; readonly navigate: PageProps['navigate'] }) {
  const resource = useReadResource(api, '/api/chat/runtime', connected, parseNativeToolRuntimeStatus, { intervalMs: 5_000 });
  const snapshot = resource.snapshot;
  const tools = snapshot?.frameworkTools;
  return <Section id="native-tool-runtime" title="框架功能包与工具通道" scrollable description="这里展示宿主实际运行快照；功能声明、工具授权和会话中实际可见的工具分别核对。">
    <div className="grid gap-3 text-xs leading-6">
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={!connected || resource.loading} onClick={resource.refresh}>读取实际安装状态</Button><Button size="sm" variant="outline" onClick={() => navigate('security', { title: '框架工具授权', sectionId: 'native-tool-permissions', kind: 'section' })}>管理框架工具授权</Button></div>
      {resource.error || !snapshot ? <p role="status">实际安装状态尚未读到，不能用声明或保存的开关认定已运行。</p> : <>
        {snapshot.packages.length === 0 && <p>当前运行快照没有已装配的功能包。</p>}
        {snapshot.packages.map(item => <div key={item.id} className="rounded-lg border p-3"><strong>{Object.hasOwn(packageNames, item.id) ? packageNames[item.id] : item.id} · {nativePackageStateLabels[item.state]}</strong>{item.reason && <p>此功能包有待核对的运行条件，请查看连接与运行状态。</p>}<details><summary className="cursor-pointer text-muted-foreground">版本与资源状态</summary><p>{item.id} · {item.version} · {item.phase ?? '无进行中的阶段'}</p><p>{item.resources.filter(resource => resource.state === 'active').length} 项活动资源，{item.resources.filter(resource => resource.state === 'unknown').length} 项待核对</p></details></div>)}
        {!tools ? <p>框架工具通道尚未接入。已保存的权限不会使未接入的通道自动可用。</p> : <div className="grid gap-2 rounded-lg border p-3"><strong>{!tools.available || tools.channel.state === 'unknown' ? '工具通道结果待核对' : tools.channel.state === 'closed' ? '工具通道已关闭' : tools.channel.state === 'running' ? '工具通道运行中' : '工具通道已接入，等待会话投影'}</strong><p>已注册{tools.tools.length}个工具，已投影{tools.projections}个会话，正在处理{tools.channel.pending}个调用。</p>{tools.tools.map(tool => <p key={tool.name}>{tool.name} · {tool.capability}</p>)}<p className="text-muted-foreground">注册不等于已授权；实际调用仍需所属会话、权限和资源范围均通过检查。</p></div>}
      </>}
    </div>
  </Section>;
}
