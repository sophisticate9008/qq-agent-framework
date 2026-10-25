import { NATIVE_MEDIA_DIAGNOSTICS_PATH, parseNativeMediaDiagnostics } from '../../src/contracts/native-media-diagnostics.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import type { ApiClient } from '../lib/api.ts';
import { Button } from './ui/button.tsx';
const kinds = { image: '图片', audio: '语音', file: '文件', forward: '合并转发', quote: '引用消息' };
const statuses = { confirmed: '已确认读取结果', rejected: '读取被拒绝', unknown: '读取结果未知' };
function reason(code: string): string {
  const labels: Readonly<Record<string, string>> = {
    native_media_transcriber_not_connected: '语音转写服务尚未接入', native_media_reader_not_connected: '媒体字节读取服务尚未接入', native_media_read_unknown: '协议读取结果未知', native_media_read_rejected: '协议拒绝读取', native_media_too_large: '内容超过读取上限', image_too_large: '图片超过大小上限', unsupported_image_format: '图片格式不受支持', unsupported_file_format: '文件格式不受支持', quoted_context_unavailable: '引用消息暂不可读取', quoted_context_scope_mismatch: '引用归属与当前会话不匹配', native_quote_scope_mismatch: '引用归属与当前会话不匹配',
  }; return labels[code.toLowerCase()] ?? code;
}
export function ConversationMediaDiagnostics({ api, connected, conversationId }: { readonly api: ApiClient; readonly connected: boolean; readonly conversationId: string | null }) {
  const valid = typeof conversationId === 'string' && /^(group|private):[1-9][0-9]{0,31}$/.test(conversationId);
  const path = `${NATIVE_MEDIA_DIAGNOSTICS_PATH}?${new URLSearchParams({ conversationId: conversationId ?? '', limit: '100' })}`;
  const resource = useReadResource(api, path, connected && valid, parseNativeMediaDiagnostics);
  const value = resource.snapshot?.conversationId === conversationId ? resource.snapshot : null;
  return <div className="grid gap-3 border-t pt-4 text-xs" data-conversation-media>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">媒体、文件、转发与引用接入</h3><Button size="sm" variant="outline" disabled={!connected || !valid || resource.loading} onClick={resource.refresh}>读取接入状态</Button></div>
    <p className="text-muted-foreground">这里只读查看已登记资源与实际读取结果，不下载媒体、不展开引用，也不授予工具权限。读取链已接通、历史曾读取与最近结果分别显示。</p>
    {!valid && <p>先选择或检查一条 QQ 会话。</p>}
    {resource.error && <p role="status">媒体状态暂时无法核实；上次结果保留供核对，不作为本次读取成功。</p>}
    {resource.loading && !value && valid && <p role="status">正在读取登记与读取证据…</p>}
    {value && <><p className="text-muted-foreground">{value.conversationId} · {new Date(value.observedAt).toLocaleString()} · {value.running ? '聊天运行中' : '聊天未运行'} · 记录覆盖 {value.coverage}。{value.coverage !== 'complete' && '这份结果不能用于确认没有其他资源或失败。'}</p>
      <div className="flex flex-wrap gap-3">{Object.entries(value.capabilities).map(([kind, available]) => <p key={kind}>{kinds[kind as keyof typeof kinds]}读取链：{available ? '已接通' : '未接通'}</p>)}</div>
      <p className="text-muted-foreground">图片字节读取不代表当前模型理解图片；语音需要真实转写服务，文件与转发仍受格式、大小、会话归属和独立授权约束。</p>
      {value.quote ? <div className="rounded-lg border p-3" data-quote-observation><strong>最近引用读取：{statuses[value.quote.status]}</strong><p>{value.quote.code ? reason(value.quote.code) : value.quote.status === 'confirmed' ? '已核对同会话引用结果。' : '没有可核实的具体原因，保持当前未确认状态。'} · {new Date(value.quote.at).toLocaleString()}</p></div> : <p>当前没有已观察到的引用读取结果，不能当作引用已展开。</p>}
      <div className="max-h-72 overflow-auto rounded-lg border">{value.items.length === 0 ? <p className="p-3">本次范围没有返回媒体登记记录；不推断其他历史为空。</p> : value.items.map(item => <div key={item.assetId} className="grid gap-1 border-b p-3" data-media-observation={item.kind}><strong>{kinds[item.kind]} · {item.contentRead ? '曾读取内容' : '已登记，内容未读取'}</strong><p>字节：{item.bytesRead ? '曾读取字节' : '未读取'}；读取链：{item.readingAvailable ? '可用' : '不可用'}；登记到期 {new Date(item.expiresAt).toLocaleString()}。</p>{item.lastRead && <p>{statuses[item.lastRead.status]}{item.lastRead.code ? `：${reason(item.lastRead.code)}` : ''} · {new Date(item.lastRead.at).toLocaleString()}</p>}{item.missingReasons.length > 0 && <p>待处理：{item.missingReasons.map(reason).join('、')}</p>}<details><summary className="cursor-pointer text-muted-foreground">登记标识与原始原因码</summary><p className="break-all">{item.assetId} · 来源消息 {item.messageId}</p><p className="break-all">{item.lastRead?.code} {item.missingReasons.join('、')}</p></details></div>)}</div>
    </>}
  </div>;
}
