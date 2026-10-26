import type { ReactNode } from 'react';
import { cn } from '../lib/utils.ts';
import { useState } from 'react';
import { Button } from './ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog.tsx';

/** Shared details surface: keeps list geometry stable and supports keyboard/focus handling. */
export function ReadOnlyDetails({ title, description = '查看详细记录。', children, label = '详情', compact = false, className }: {
  readonly title: string; readonly description?: string; readonly children: ReactNode; readonly label?: string; readonly compact?: boolean; readonly className?: string;
}) {
  const [open, setOpen] = useState(false);
  return <><Button size="xs" variant="ghost" className={cn(compact && 'h-[18px] px-1 text-xs', className)} onClick={() => setOpen(true)}>{label}</Button>
    <DetailsWindow open={open} onOpenChange={setOpen} title={title} description={description}>{children}</DetailsWindow></>;
}

export function DetailsWindow({ open, onOpenChange, title, description, children }: {
  readonly open: boolean; readonly onOpenChange: (open: boolean) => void; readonly title: string;
  readonly description: string; readonly children: ReactNode;
}) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="!left-auto !right-0 !top-0 !h-dvh !max-h-dvh !w-[min(520px,calc(100vw-24px))] !max-w-none !translate-x-0 !translate-y-0 flex flex-col gap-0 overflow-hidden rounded-l-[9px] rounded-r-none p-0">
      <DialogHeader className="shrink-0 gap-0.5 border-b bg-muted/50 px-3 py-2.5 pr-10"><DialogTitle className="text-base font-semibold leading-5">{title}</DialogTitle><DialogDescription className="text-xs">{description}</DialogDescription></DialogHeader>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 text-sm [overflow-wrap:anywhere]">{children}</div>
    </DialogContent>
  </Dialog>;
}

/** Raw records stay available in a separate window without stretching the summary. */
export function RawDetails({ value, label = '原始记录', title = '技术记录' }: {
  readonly value: unknown; readonly label?: string; readonly title?: string;
}) {
  const [open, setOpen] = useState(false);
  return <><Button size="xs" variant="link" className="h-auto px-0 py-0" onClick={() => setOpen(true)}>{label}</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 gap-0.5 border-b bg-muted/50 px-3 py-2.5 pr-10"><DialogTitle>{title}</DialogTitle><DialogDescription>只读原始数据，可选中复制。</DialogDescription></DialogHeader>
        <pre className="min-h-0 overflow-auto p-3 font-mono text-xs leading-relaxed select-text">{JSON.stringify(value, null, 2) ?? '未记录'}</pre>
      </DialogContent>
    </Dialog>
  </>;
}

export function TechnicalDetails({ fields }: { readonly fields: readonly { readonly label: string; readonly value: unknown }[] }) {
  return <dl className="info select-text">{fields.map(field => <div key={field.label} className="contents">
    <dt>{field.label}</dt><dd className="min-w-0 whitespace-pre-wrap">{field.value == null ? '未记录'
      : typeof field.value === 'boolean' ? field.value ? '是' : '否'
      : typeof field.value === 'object' ? Object.keys(field.value).length === 0 ? '无'
        : <RawDetails title={field.label} value={field.value} label={`查看记录 · ${Object.keys(field.value).length} 项`} />
      : String(field.value)}</dd>
  </div>)}</dl>;
}
