import { Inbox, LoaderCircle, LockKeyhole } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { Switch } from './ui/switch.tsx';
import { cn } from '../lib/utils.ts';

export function PageHeading({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="page-title">{title}</h1><p className="page-description">{description}</p></div>{actions && <div className="flex items-center gap-2">{actions}</div>}</div>;
}

export function Section({ title, description, children, footer, actions, className }: { title: string; description?: string; children: ReactNode; footer?: ReactNode; actions?: ReactNode; className?: string }) {
  return <section className={cn('panel', className)}><div className="panel-header"><div><h2 className="panel-title">{title}</h2>{description && <p className="panel-description">{description}</p>}</div>{actions}</div><div className="panel-body">{children}</div>{footer && <div className="panel-footer">{footer}</div>}</section>;
}

export function Field({ label, description, error, children, className }: { label: string; description?: string; error?: string; children: ReactNode; className?: string }) {
  return <label className={cn('grid content-start gap-2', className)}><span className="field-label">{label}</span>{children}{description && <span className="field-hint">{description}</span>}{error && <span className="text-xs text-destructive" role="alert">{error}</span>}</label>;
}

export function ToggleField({ label, description, checked, onChange, disabled = false }: { label: string; description?: string; checked: boolean; onChange(value: boolean): void; disabled?: boolean }) {
  return <div className="flex items-center justify-between gap-6 py-3"><div><p className="field-label">{label}</p>{description && <p className="field-hint mt-1 max-w-xl">{description}</p>}</div><Switch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} /></div>;
}

export function NumberField({ label, value, onChange, description, unit, min = 0, max, disabled }: { label: string; value: number | null; onChange(value: number | null): void; description?: string; unit?: string; min?: number; max?: number; disabled?: boolean }) {
  return <Field label={label} description={description}><div className="relative"><Input type="number" value={value ?? ''} min={min} max={max} disabled={disabled} onChange={event => onChange(event.target.value === '' ? null : Number(event.target.value))} className={unit ? 'pr-16' : ''} placeholder="不限制" />{unit && <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">{unit}</span>}</div></Field>;
}

export function EmptyState({ title, description, action, locked = false }: { title: string; description: string; action?: ReactNode; locked?: boolean }) {
  const Icon = locked ? LockKeyhole : Inbox;
  return <div className="flex min-h-52 flex-col items-center justify-center gap-3 px-6 py-10 text-center"><span className="mb-1 flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground"><Icon className="size-5" /></span><strong className="text-sm font-medium">{title}</strong><p className="max-w-md text-xs leading-relaxed text-muted-foreground">{description}</p>{action && <div className="mt-2">{action}</div>}</div>;
}

export function ConnectPrompt({ connect }: { connect(): void }) {
  return <div className="panel"><EmptyState title="连接后管理你的设置" description="使用本机保存的访问令牌登录，读取当前配置并保存更改。" locked action={<Button onClick={connect}>连接工作台</Button>} /></div>;
}

export function SaveBar({ dirty, saving, message, onSave, onReset, label = '保存设置', disabled = false, children }: { dirty: boolean; saving: boolean; message?: string; onSave(): void; onReset?(): void; label?: string; disabled?: boolean; children?: ReactNode }) {
  return <><span className="mr-auto text-xs text-muted-foreground" role="status">{message ?? (dirty ? '有尚未保存的更改' : '没有未保存的更改')}</span>{children}{onReset && <Button variant="ghost" disabled={!dirty || saving} onClick={onReset}>撤销更改</Button>}<Button disabled={!dirty || saving || disabled} onClick={onSave}>{saving && <LoaderCircle className="size-4 animate-spin" />}{saving ? '正在保存' : label}</Button></>;
}

export function StatusPill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'success' | 'warning' | 'neutral' }) {
  return <span className={cn('inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium', tone === 'success' ? 'status-success' : tone === 'warning' ? 'status-warning' : 'bg-muted text-muted-foreground')}><span className="size-1.5 rounded-full bg-current" />{children}</span>;
}
