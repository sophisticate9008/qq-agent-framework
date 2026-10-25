import type { useNativeCatalogOperation } from '../lib/use-native-catalog-operation.ts';
import { Button } from './ui/button.tsx';

export function NativeCatalogRecovery({ recovery, reading, onRead, onReleased }: {
  readonly recovery: ReturnType<typeof useNativeCatalogOperation>;
  readonly reading: boolean;
  readonly onRead: () => void;
  readonly onReleased: () => void;
}) {
  if (!recovery.block) return null;
  const pending = recovery.block.phase === 'pending';
  return <div className="grid gap-2 rounded-lg border p-3 text-xs leading-6" role="status">
    <p>{pending ? '配置写入进行中，其他保存已暂停。' : recovery.block.reason === 'unknown'
      ? '上次写入结果待核对；草稿保留，不会自动重试。' : recovery.block.reason === 'busy'
        ? '服务正在处理另一项配置；草稿保留，请先读取已保存内容。' : '已保存版本发生变化；草稿保留，请先读取核对。'}</p>
    {!pending && <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={reading} onClick={onRead}>读取已保存内容</Button>
      <Button size="sm" variant="outline" disabled={reading || !recovery.reviewed} onClick={() => { if (recovery.release()) onReleased(); }}>已核对，允许新的保存</Button></div>}
    {recovery.reviewed && <p className="text-muted-foreground">已读取当前保存版本；保留的草稿尚未重新提交，可撤销草稿后采用已保存内容。</p>}
  </div>;
}
