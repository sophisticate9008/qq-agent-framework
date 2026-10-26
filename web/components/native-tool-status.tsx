import { useState } from 'react';
import { errorMessage, type ApiClient } from '../lib/api.ts';
import type { PageProps } from '../lib/types.ts';
import { parseNativeToolRuntimeStatus } from '../lib/native-tool-status.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import { DetailsWindow, TechnicalDetails } from './read-only-details.tsx';
import { Button } from './ui/button.tsx';

export function NativeToolStatus({ api, connected, navigate }: { readonly api: ApiClient; readonly connected: boolean; readonly navigate: PageProps['navigate'] }) {
  const [open, setOpen] = useState(false);
  const resource = useReadResource(api, '/api/chat/runtime', connected && open, parseNativeToolRuntimeStatus);
  const tools = resource.snapshot?.frameworkTools;
  return <><Button size="sm" variant="ghost" disabled={!connected} onClick={() => setOpen(true)}>框架工具详情</Button><DetailsWindow open={open} onOpenChange={setOpen} title="框架工具详情" description="查看工具状态与当前读取结果。">
    <div className="grid gap-3 text-sm">
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={!connected || resource.loading} onClick={resource.refresh}>重新读取</Button><Button size="sm" variant="outline" onClick={() => navigate('security', { title: '主人与白名单', sectionId: 'security-access', kind: 'section' })}>管理主人与白名单</Button></div>
      {resource.loading && <p role="status" className="text-xs text-muted-foreground">正在读取工具状态。</p>}
      {resource.error ? <p role="alert" className="text-destructive">工具状态读取失败，结果待核对。</p> : resource.snapshot && <p>{!tools ? '当前未接入框架工具。' : !tools.available || tools.channel.state === 'unknown' ? '工具状态待核对。' : tools.channel.state === 'closed' ? '框架工具当前已关闭。' : '框架工具已接入，具体可用性按会话核对。'}</p>}
      <TechnicalDetails fields={[{ label: '读取错误', value: resource.error ? errorMessage(resource.error) : null }, { label: '工具运行状态', value: tools }, { label: '功能运行记录', value: resource.snapshot?.packages }]} />
    </div>
  </DetailsWindow></>;
}
