import type { QzoneToolDefinition, QzoneToolInventory } from '../../src/contracts/qzone-tools.ts';
import type { ApiClient } from '../lib/api.ts';
import { asRecord } from '../lib/api.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import { Layers3, RefreshCw } from 'lucide-react';
import { ReadOnlyDetails, TechnicalDetails } from './read-only-details.tsx';
import { StatusPill } from './management.tsx';
import { Button } from './ui/button.tsx';

function parse(value: unknown): QzoneToolInventory | null {
  const row = asRecord(value);
  if (row.schema !== 1 || !['available', 'unsupported', 'unknown'].includes(String(row.state))
    || !['protocol-actions', 'version-map', 'none'].includes(String(row.source)) || !Array.isArray(row.tools) || row.tools.length > 32
    || row.reason !== null && typeof row.reason !== 'string') return null;
  const implementation = asRecord(row.implementation);
  if (row.implementation !== null && (typeof implementation.name !== 'string' || typeof implementation.version !== 'string')) return null;
  const tools: QzoneToolDefinition[] = [];
  for (const value of row.tools) {
    const tool = asRecord(value);
    if (typeof tool.name !== 'string' || !/^[a-z_]{1,64}$/.test(tool.name) || typeof tool.title !== 'string'
      || typeof tool.description !== 'string' || typeof tool.readOnly !== 'boolean' || !tool.parameters || typeof tool.parameters !== 'object' || Array.isArray(tool.parameters)) return null;
    tools.push({ name: tool.name as QzoneToolDefinition['name'], title: tool.title, description: tool.description,
      readOnly: tool.readOnly, parameters: tool.parameters as QzoneToolDefinition['parameters'] });
  }
  return { schema: 1, state: row.state as QzoneToolInventory['state'], source: row.source as QzoneToolInventory['source'],
    implementation: row.implementation === null ? null : { name: implementation.name as string, version: implementation.version as string },
    tools, reason: row.reason as string | null };
}
export function QzoneServiceCard({ api, connected }: { readonly api: ApiClient; readonly connected: boolean }) {
  const resource = useReadResource(api, '/api/chat/qzone', connected, parse);
  const value = resource.snapshot;
  const available = !resource.error && value?.state === 'available';
  const label = resource.loading && !value ? '正在读取' : resource.error ? '读取失败' : available ? `支持 ${value.tools.length} 项`
    : value?.reason === 'QZONE_SERVICE_NOT_RUNNING' ? '服务未运行' : value?.state === 'unsupported' ? '协议端未提供' : '支持情况待核对';
  return <article aria-label="空间说说" className="min-w-0 overflow-hidden rounded-lg border bg-card">
    <header className="flex items-center gap-2.5 px-3 pt-3"><span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300"><Layers3 className="size-4" aria-hidden="true" /></span><h3 className="flex-1 text-[13px] font-semibold">空间说说</h3><span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">底层服务</span></header>
    <div className="px-3 py-2"><p className="text-xs leading-5 text-muted-foreground">按当前协议端支持的接口提供空间操作，供宿主与扩展调用。</p>
      <div className="mt-1.5 flex flex-wrap gap-1">{value?.tools.map(tool => <span key={tool.name} className="rounded bg-primary/8 px-1.5 py-0.5 text-[11px] text-primary">{tool.title}</span>)}</div>
      {value?.implementation && <p className="mt-1.5 text-[11px] text-muted-foreground">{value.implementation.name} · {value.implementation.version}</p>}
    </div>
    <footer className="flex flex-wrap items-center gap-1 border-t px-3 py-1.5"><StatusPill tone={available ? 'success' : 'neutral'}>{label}</StatusPill><div className="ml-auto flex items-center"><Button size="xs" variant="ghost" disabled={resource.loading} onClick={resource.refresh} aria-label="刷新空间能力"><RefreshCw className={resource.loading ? 'size-3 animate-spin' : 'size-3'} /></Button><ReadOnlyDetails title="空间说说" description="当前协议端开放的底层能力与接入说明。">
      <p className="mb-3 text-xs leading-5 text-muted-foreground">服务标识为 qzone，版本 1。扩展可通过 context.service('qzone', 1) 取得服务，inspect 读取能力，execute 调用具体操作；使用方式由调用方决定。</p>
      <div className="divide-y rounded-md border px-2.5">{value?.tools.map(tool => <div key={tool.name} className="py-2"><div className="flex items-center gap-2 text-xs"><strong>{tool.title}</strong><span className="ml-auto text-muted-foreground">{tool.readOnly ? '读取' : '写入'}</span></div><p className="mt-1 text-xs leading-5 text-muted-foreground">{tool.description}</p><ReadOnlyDetails title={`${tool.title} · 参数`} label="参数说明" description="OneBot 接口名称与参数结构。"><TechnicalDetails fields={[{ label: '接口', value: tool.name }, { label: '参数', value: tool.parameters }]} /></ReadOnlyDetails></div>)}{!value?.tools.length && <p className="py-2 text-xs text-muted-foreground">{label}</p>}</div>
      <div className="mt-3"><ReadOnlyDetails title="空间服务技术详情" label="技术详情" description="协议端能力来源，不代表聊天工具已注册。"><TechnicalDetails fields={[{ label: '能力来源', value: value?.source }, { label: '协议端', value: value?.implementation }, { label: '状态原因', value: value?.reason }, { label: '模型工具注册', value: '未注册，由使用者自行接入' }]} /></ReadOnlyDetails></div>
    </ReadOnlyDetails></div></footer>
  </article>;
}
