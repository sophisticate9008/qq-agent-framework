import { useState, type ReactNode } from 'react';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { Button } from './ui/button.tsx';

/** Keep editable children mounted so closing the window retains unsaved fields. */
export function SettingsWindow({ title, label = title, description = '修改后使用对应的保存操作。', children, open: controlledOpen, onOpenChange, disabled = false, triggerVariant = 'outline' }: {
  readonly title: string;
  readonly label?: string;
  readonly description?: string;
  readonly children: ReactNode;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly disabled?: boolean;
  readonly triggerVariant?: 'outline' | 'destructive' | 'ghost' | 'default';
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  function change(value: boolean): void { setLocalOpen(value); onOpenChange?.(value); }
  return <DialogPrimitive.Root open={open} onOpenChange={change} modal>
    <DialogPrimitive.Trigger disabled={disabled} render={<Button type="button" variant={triggerVariant} size="sm" />}>{label}</DialogPrimitive.Trigger>
    <DialogPrimitive.Portal keepMounted>
      <DialogPrimitive.Backdrop hidden={!open} style={{ display: open ? undefined : 'none', pointerEvents: open ? undefined : 'none' }} className="fixed inset-0 z-50 bg-black/20" />
      <DialogPrimitive.Popup hidden={!open} inert={!open} aria-hidden={!open} style={{ display: open ? undefined : 'none' }} className="fixed left-1/2 top-1/2 z-50 flex max-h-[85dvh] w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col gap-2 rounded-[7px] border bg-popover p-2.5 text-sm text-popover-foreground shadow-lg outline-none">
        <div className="shrink-0 pr-8"><DialogPrimitive.Title className="text-base font-semibold">{title}</DialogPrimitive.Title><DialogPrimitive.Description className="mt-0.5 text-xs text-muted-foreground">{description}</DialogPrimitive.Description></div>
        <DialogPrimitive.Close aria-label="关闭" render={<Button type="button" variant="ghost" size="icon-sm" className="absolute right-2 top-2" />}><X className="size-4" /></DialogPrimitive.Close>
        <div className="min-h-0 overflow-y-auto overscroll-contain">{children}</div>
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}
