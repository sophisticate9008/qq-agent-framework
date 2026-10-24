import { KeyRound } from 'lucide-react';
import { Field } from './management.tsx';
import { Input } from './ui/input.tsx';

export type CredentialAction = 'keep' | 'replace' | 'clear';

export interface CredentialDraft {
  readonly action: CredentialAction;
  readonly value: string;
}

export const unchangedCredential: CredentialDraft = { action: 'keep', value: '' };

export function AdapterCredentialField({ id, label, description, configured, draft, disabled = false, onChange }: {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly configured: boolean;
  readonly draft: CredentialDraft;
  readonly disabled?: boolean;
  onChange(value: CredentialDraft): void;
}) {
  return <div className="grid gap-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <label htmlFor={`${id}-action`} className="field-label">{label}</label>
      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"><KeyRound className="size-3" aria-hidden="true" />{configured ? '已保存凭据' : '尚未设置'}</span>
    </div>
    {description && <p id={`${id}-description`} className="field-hint">{description}</p>}
    <select id={`${id}-action`} aria-describedby={description ? `${id}-description` : undefined} className="h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-xs" value={draft.action} disabled={disabled} onChange={event => {
      const action = event.target.value;
      if (action === 'keep' || action === 'replace' || action === 'clear') onChange({ action, value: '' });
    }}>
      <option value="keep">{configured ? '保留已保存凭据' : '暂不设置'}</option>
      <option value="replace">输入新凭据</option>
      {configured && <option value="clear">清除已保存凭据</option>}
    </select>
    {draft.action === 'replace' && <Input
      id={`${id}-value`}
      type="password"
      aria-label={`新${label}`}
      value={draft.value}
      autoComplete="new-password"
      spellCheck={false}
      autoCapitalize="none"
      maxLength={4096}
      disabled={disabled}
      placeholder="输入新凭据"
      onChange={event => onChange({ action: 'replace', value: event.target.value })}
    />}
    <p className="field-hint">{draft.action === 'clear' ? '保存后将清除该凭据。' : '已保存的凭据不会回显；新输入只用于本次保存。'}</p>
  </div>;
}

export function AdapterEndpointField({ id, label, value, placeholder, disabled = false, onChange }: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly placeholder: string;
  readonly disabled?: boolean;
  onChange(value: string): void;
}) {
  return <Field label={label} description="填写固定服务地址，凭据在下方单独设置。">
    <Input id={id} type="url" value={value} autoComplete="off" spellCheck={false} autoCapitalize="none" disabled={disabled} placeholder={placeholder} maxLength={2048} onChange={event => onChange(event.target.value)} />
  </Field>;
}

export function AdapterNumberField({ id, label, value, minimum, maximum, unit, disabled = false, onChange }: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly minimum: number;
  readonly maximum: number;
  readonly unit?: string;
  readonly disabled?: boolean;
  onChange(value: string): void;
}) {
  return <Field label={label}>
    <div className="relative"><Input id={id} type="number" inputMode="numeric" value={value} min={minimum} max={maximum} step={1} disabled={disabled} className={unit ? 'pr-12' : undefined} onChange={event => onChange(event.target.value)} />{unit && <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-[11px] text-muted-foreground">{unit}</span>}</div>
  </Field>;
}
