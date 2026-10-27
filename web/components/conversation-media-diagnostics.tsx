import { NATIVE_MEDIA_DIAGNOSTICS_PATH, parseNativeMediaDiagnostics, type NativeMediaDiagnosticItem } from '../../src/contracts/native-media-diagnostics.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import type { ApiClient } from '../lib/api.ts';
import { Button } from './ui/button.tsx';
import { ReadOnlyDetails, TechnicalDetails } from './read-only-details.tsx';
const kinds = { image: '图片', audio: '语音', file: '文件', video: '视频抽样画面', forward: '合并转发', quote: '引用消息' };
function reason(code: string): string {
  const labels: Readonly<Record<string, string>> = {
    native_media_transcriber_not_connected: '语音转写尚未接通', native_media_reader_not_connected: '文件下载尚未接通', native_media_read_unknown: '下载结果尚未确认', native_media_read_rejected: '下载被拒绝', native_media_too_large: '内容太大', onebot_media_too_large: '原文件超过下载大小上限', onebot_media_timeout_unknown: '下载超时', onebot_media_read_unknown: '下载中断，未取得完整内容', onebot_media_http_rejected: '图片来源暂时无法下载', onebot_media_encoding_rejected: '下载编码不受支持', onebot_media_origin_rejected: '下载地址不可用', onebot_media_empty: '下载内容为空', image_decode_failed: '图片无法解码', image_pixel_limit: '图片分辨率过大', image_processing_timeout: '图片处理超时', image_too_large_after_compression: '图片压缩后仍过大', image_download_too_large: '原图超过下载大小上限', image_too_large: '图片太大', unsupported_image_format: '不支持这种图片格式', unsupported_file_format: '不支持这种文件格式', quoted_context_unavailable: '暂时无法读取引用消息', quoted_context_scope_mismatch: '引用消息不属于此会话', native_quote_scope_mismatch: '引用消息不属于此会话',
  }; return labels[code.toLowerCase()] ?? '读取遇到问题，可查看详细记录';
}
function state(item: NativeMediaDiagnosticItem): string {
  if (item.lastRead?.status === 'rejected') return '最近一次读取失败';
  if (item.lastRead?.status === 'unknown') return '最近一次读取结果未确认';
  if (item.contentRead) return '已读取内容';
  if (item.bytesRead) return item.kind === 'image' ? '已下载，尚未确认模型读取' : '已下载，尚未读取内容';
  return '已收到，尚未读取';
}
export function ConversationMediaDiagnostics({ api, connected, conversationId }: { readonly api: ApiClient; readonly connected: boolean; readonly conversationId: string | null }) {
  const valid = typeof conversationId === 'string' && /^(group|private):[1-9][0-9]{0,31}$/.test(conversationId);
  const resource = useReadResource(api, `${NATIVE_MEDIA_DIAGNOSTICS_PATH}?${new URLSearchParams({ conversationId: conversationId ?? '', limit: '100' })}`, connected && valid, parseNativeMediaDiagnostics);
  const value = connected && resource.snapshot?.conversationId === conversationId ? resource.snapshot : null;
  return <div className="grid gap-3 border-t pt-4 text-xs" data-conversation-media>
    <div className="flex items-center justify-between gap-2"><h3 className="font-medium">图片与附件</h3><Button size="sm" variant="outline" disabled={!connected || !valid || resource.loading} onClick={resource.refresh}>刷新</Button></div>
    {resource.error && <p role="status">暂时无法更新，以下可能是上次读取的记录。</p>}
    {resource.loading && !value && <p role="status">正在读取…</p>}
    {value && <>
      {value.coverage !== 'complete' && <p className="text-muted-foreground">当前只能查看部分记录。</p>}
      <div className="max-h-80 overflow-auto rounded-lg border">{value.items.length === 0 ? <p className="p-3 text-muted-foreground">当前没有可显示的附件记录。</p> : value.items.map(item => <div key={item.assetId} className="flex items-center gap-3 border-b px-3 py-1.5 last:border-b-0" data-media-observation={item.kind}>
        <span className="min-w-0 flex-1 truncate" title={`${kinds[item.kind]} · ${state(item)}`}>{kinds[item.kind]} · {state(item)}</span>
        <time className="shrink-0 text-muted-foreground">{new Date(item.lastRead?.at ?? item.registeredAt).toLocaleTimeString()}</time>
        <ReadOnlyDetails title={`${kinds[item.kind]}详情`} description={state(item)}>
          <div className="grid gap-4"><p>{item.lastRead?.code ? reason(item.lastRead.code) : item.contentRead ? '已有内容读取记录。' : item.bytesRead ? '文件已经下载；这条记录不能确认模型是否看到了内容。' : '聊天中已收到这份附件，尚无下载或内容读取记录。'}</p>
            <TechnicalDetails fields={[
              { label: '收到时间', value: new Date(item.registeredAt).toLocaleString() },
              { label: '临时记录有效至', value: new Date(item.expiresAt).toLocaleString() },
              { label: '读取服务', value: item.readingAvailable ? '可用' : '尚未接通' },
              { label: '最近一次下载或读取', value: item.lastRead ? `${item.lastRead.status === 'confirmed' ? '该次操作已完成' : item.lastRead.status === 'rejected' ? '该次操作被拒绝' : '该次操作结果未确认'} · ${new Date(item.lastRead.at).toLocaleString()}` : '无记录' },
              { label: '资源标识', value: item.assetId }, { label: '来源消息标识', value: item.messageId },
              { label: '技术原因', value: [item.lastRead?.code, ...item.missingReasons].filter(Boolean).join('\n') || '无' },
            ]} />
          </div>
        </ReadOnlyDetails>
      </div>)}</div>
      {value.quote && <div className="flex items-center justify-between gap-2"><span>引用消息 · {value.quote.status === 'confirmed' ? '已读取' : value.quote.status === 'rejected' ? '读取失败' : '读取结果未确认'}</span><ReadOnlyDetails title="引用消息详情" description="最近一次引用读取记录。"><TechnicalDetails fields={[{ label: '时间', value: new Date(value.quote.at).toLocaleString() }, { label: '消息标识', value: value.quote.messageId }, { label: '技术原因', value: value.quote.code ?? '无' }]} /></ReadOnlyDetails></div>}
    </>}
  </div>;
}
