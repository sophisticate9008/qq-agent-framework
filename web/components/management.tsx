import { HelpTip } from './help-tip.tsx';
import { Inbox, LoaderCircle, LockKeyhole } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { Switch } from './ui/switch.tsx';
import { cn } from '../lib/utils.ts';

export function PageHeading({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return <div className="page-heading"><div className="page-heading-copy"><h1 className="page-title">{title}</h1><p className="page-description">{description}</p></div>{actions && <div className="page-heading-actions">{actions}</div>}</div>;
}

export function Section({ id, title, description, children, footer, actions, className, scrollable = false, height = 'md' }: { id?: string; title: string; description?: string; children?: ReactNode; footer?: ReactNode; actions?: ReactNode; className?: string; scrollable?: boolean; height?: 'sm' | 'md' | 'lg' }) {
  const contentHeight = height === 'sm' ? 'max-h-64' : height === 'lg' ? 'max-h-[32rem]' : 'max-h-96';
  return <section id={id} className={cn('panel min-w-0', className)}><div className="panel-header flex-wrap"><div className="min-w-0 flex-1 break-words"><h2 className="panel-title">{title}</h2>{description && <p className="panel-description">{description}</p>}</div>{actions && <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div>}</div><div data-bounded-card={scrollable ? height : undefined} className={cn('panel-body', scrollable && `${contentHeight} min-h-0 overflow-auto overscroll-contain`)}>{children}</div>{footer && <div className="panel-footer">{footer}</div>}</section>;
}

export function Field({ label, description, tip, error, children, className, layout = 'inline', id }: { label: string; description?: string; tip?: string; error?: string; children: ReactNode; className?: string; layout?: 'inline' | 'stacked'; id?: string }) {
  return <div className={cn('management-field', layout === 'stacked' && 'management-field-stacked', className)}><label htmlFor={id} className="management-field-label"><span className="field-label">{label}</span><div className="management-field-control">{children}</div></label>{(tip || description) && <HelpTip label={label}>{tip ?? description ?? ''}</HelpTip>}{error && <span className="management-field-error text-xs text-destructive" role="alert">{error}</span>}</div>;
}

export function ToggleField({ label, description, tip, checked, onChange, disabled = false }: { label: string; description?: string; tip?: string; checked: boolean; onChange(value: boolean): void; disabled?: boolean }) {
  return <div data-page-field className="management-toggle"><div className="min-w-0"><div className="flex items-center gap-1"><p className="field-label">{label}</p>{tip && <HelpTip label={label}>{tip}</HelpTip>}</div>{description && <p className="field-hint mt-0.5 max-w-xl">{description}</p>}</div><Switch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} /></div>;
}

export function NumberField({ label, value, onChange, description, unit, min = 0, max, disabled }: { label: string; value: number | null; onChange(value: number | null): void; description?: string; unit?: string; min?: number; max?: number; disabled?: boolean }) {
  return <Field label={label} description={description}><div className="relative max-w-32"><Input type="number" value={value ?? ''} min={min} max={max} disabled={disabled} onChange={event => onChange(event.target.value === '' ? null : Number(event.target.value))} className={unit ? 'pr-16' : ''} placeholder="不限制" />{unit && <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">{unit}</span>}</div></Field>;
}

export function EmptyState({ title, description, action, locked = false }: { title: string; description: string; action?: ReactNode; locked?: boolean }) {
  const Icon = locked ? LockKeyhole : Inbox;
  return <div className="flex min-h-20 flex-col items-center justify-center gap-1.5 px-2.5 py-3 text-center"><span className="mb-0.5 flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Icon className="size-4" /></span><strong className="text-sm font-medium">{title}</strong><p className="max-w-md text-xs leading-[1.45] text-muted-foreground">{description}</p>{action && <div className="mt-2">{action}</div>}</div>;
}

export function ConnectPrompt({ connect }: { connect(): void }) {
  return <div className="panel"><EmptyState title="连接后管理你的设置" description="使用本机文件中的管理员令牌创建访问会话，再读取配置和保存更改。" locked action={<Button onClick={connect}>连接工作台</Button>} /></div>;
}

export function SaveBar({ dirty, saving, message, onSave, onReset, label = '保存设置', disabled = false, compact = false, children }: { dirty: boolean; saving: boolean; message?: string; onSave(): void; onReset?(): void; label?: string; disabled?: boolean; compact?: boolean; children?: ReactNode }) {
  return <>{(!compact || dirty || saving || disabled) && <span className={cn('min-w-0 text-xs text-muted-foreground', !compact && 'mr-auto flex-1 basis-40')} role="status">{compact && dirty && !disabled ? '未保存' : message ?? (dirty ? '未保存' : '未修改')}</span>}{children}{onReset && (!compact || dirty) && <Button variant="ghost" disabled={!dirty || saving} onClick={onReset}>撤销更改</Button>}<Button disabled={!dirty || saving || disabled} onClick={onSave}>{saving && <LoaderCircle className="size-4 animate-spin" />}{saving ? '正在保存' : label}</Button></>;
}

export function StatusPill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'success' | 'warning' | 'neutral' | 'info' }) {
  return <span className={cn('inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap', tone === 'success' ? 'status-success' : tone === 'warning' ? 'status-warning' : tone === 'info' ? 'bg-sky-500/10 text-sky-700 dark:text-sky-300' : 'bg-muted text-muted-foreground')}><span className="size-1 rounded-full bg-current" />{children}</span>;
}
