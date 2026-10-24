import { useMemo, useRef, useState } from 'react';
import { AlertCircle, Plus, Trash2 } from 'lucide-react';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';

export type StructuredFieldFormat = 'time-windows' | 'model-prices';

export interface StructuredFieldState {
  readonly value?: string | null;
  readonly dirty: boolean;
  readonly error?: string;
}

interface StructuredFieldsProps {
  readonly format: StructuredFieldFormat;
  readonly value: string | null;
  readonly originalValue: string | null;
  readonly disabled: boolean;
  readonly resetToken: string;
  onStateChange(state: StructuredFieldState): void;
}

interface TimeRow {
  readonly key: number;
  readonly start: string;
  readonly end: string;
}

interface ModelPriceRow {
  readonly key: number;
  readonly model: string;
  readonly label: string;
  readonly cacheHit: string;
  readonly cacheMiss: string;
  readonly cacheWrite: string;
  readonly output: string;
}

interface InitialState<Row> {
  readonly mode: 'inherit' | 'invalid' | 'edit';
  readonly rows: readonly Row[];
  readonly error?: string;
}

interface CanonicalValue {
  readonly valid: boolean;
  readonly value: string | null;
}

const forbiddenModelNames = new Set(['__proto__', 'constructor', 'prototype']);

function validModelReference(value: string): boolean {
  return /^[\p{L}\p{N}][\p{L}\p{N}._:/@+-]{0,127}$/u.test(value)
    && !value.includes('..')
    && !forbiddenModelNames.has(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function timeState(value: string | null): InitialState<TimeRow> {
  if (value === null) return { mode: 'inherit', rows: [] };
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every(item => Array.isArray(item) && item.length === 2 && item.every(hour => typeof hour === 'number' && Number.isFinite(hour)))) {
      return { mode: 'invalid', rows: [], error: '现有时间段格式无法读取，请重新设置或恢复继承。' };
    }
    const rows = parsed.map((item, index) => ({ key: index, start: String(item[0]), end: String(item[1]) }));
    return validateTimeRows(rows).error
      ? { mode: 'invalid', rows: [], error: '现有时间段格式无法读取，请重新设置或恢复继承。' }
      : { mode: 'edit', rows };
  } catch {
    return { mode: 'invalid', rows: [], error: '现有时间段格式无法读取，请重新设置或恢复继承。' };
  }
}

function validateTimeRows(rows: readonly TimeRow[]): { value?: string; error?: string } {
  if (rows.length > 24) return { error: '最多可以设置 24 个时间段。' };
  const windows: number[][] = [];
  for (const [index, row] of rows.entries()) {
    if (row.start.trim() === '' || row.end.trim() === '') return { error: `请完整填写第 ${index + 1} 个时间段。` };
    const start = Number(row.start);
    const end = Number(row.end);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > 24 || end < 0 || end > 24) {
      return { error: `第 ${index + 1} 个时间段应填写 0 至 24 之间的整数小时。` };
    }
    if (start >= end) return { error: `第 ${index + 1} 个时间段的结束时间必须晚于开始时间。` };
    windows.push([start, end]);
  }
  return { value: JSON.stringify(windows) };
}

function canonicalTime(value: string | null): CanonicalValue {
  if (value === null) return { valid: true, value: null };
  const state = timeState(value);
  if (state.mode !== 'edit') return { valid: false, value };
  const result = validateTimeRows(state.rows);
  return result.value === undefined ? { valid: false, value } : { valid: true, value: result.value };
}

function modelState(value: string | null): InitialState<ModelPriceRow> {
  if (value === null) return { mode: 'inherit', rows: [] };
  try {
    const parsed = record(JSON.parse(value));
    if (!parsed || Object.keys(parsed).length > 100) return { mode: 'invalid', rows: [], error: '现有模型价格格式无法读取，请重新设置或恢复继承。' };
    const rows: ModelPriceRow[] = [];
    for (const [model, rawPrice] of Object.entries(parsed)) {
      const price = record(rawPrice);
      const off = record(price?.off);
      if (!validModelReference(model) || !price || typeof price.label !== 'string' || price.label.length < 1 || price.label.length > 200 || !off
        || !Object.keys(price).every(key => key === 'label' || key === 'off')
        || !Object.keys(off).every(key => ['cacheHit', 'cacheMiss', 'cacheWrite', 'output'].includes(key))
        || !['cacheHit', 'cacheMiss', 'output'].every(key => typeof off[key] === 'number' && Number.isFinite(off[key]) && Number(off[key]) >= 0 && Number(off[key]) <= 1_000_000)
        || off.cacheWrite !== undefined && (typeof off.cacheWrite !== 'number' || !Number.isFinite(off.cacheWrite) || off.cacheWrite < 0 || off.cacheWrite > 1_000_000)) {
        return { mode: 'invalid', rows: [], error: '现有模型价格格式无法读取，请重新设置或恢复继承。' };
      }
      rows.push({
        key: rows.length,
        model,
        label: price.label,
        cacheHit: String(off.cacheHit),
        cacheMiss: String(off.cacheMiss),
        cacheWrite: off.cacheWrite === undefined ? '' : String(off.cacheWrite),
        output: String(off.output),
      });
    }
    return validateModelRows(rows).error
      ? { mode: 'invalid', rows: [], error: '现有模型价格格式无法读取，请重新设置或恢复继承。' }
      : { mode: 'edit', rows };
  } catch {
    return { mode: 'invalid', rows: [], error: '现有模型价格格式无法读取，请重新设置或恢复继承。' };
  }
}

function validateModelRows(rows: readonly ModelPriceRow[]): { value?: string; error?: string } {
  if (rows.length > 100) return { error: '最多可以设置 100 个模型。' };
  const prices = Object.create(null) as Record<string, { label: string; off: { cacheHit: number; cacheMiss: number; cacheWrite?: number; output: number } }>;
  const modelNames = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const model = row.model;
    const label = row.label;
    if (!model) return { error: `请填写第 ${index + 1} 个模型的标识。` };
    if (!validModelReference(model)) return { error: `第 ${index + 1} 个模型的标识格式不正确。` };
    if (modelNames.has(model)) return { error: `模型标识“${model}”重复，请改为不同的标识。` };
    if (!label) return { error: `请填写第 ${index + 1} 个模型的显示名。` };
    if (label.length > 200) return { error: `第 ${index + 1} 个模型的显示名不能超过 200 个字符。` };
    const rawPrices = [row.cacheHit, row.cacheMiss, row.output];
    if (rawPrices.some(value => value.trim() === '')) return { error: `请完整填写第 ${index + 1} 个模型的价格。` };
    const values = rawPrices.map(Number);
    const cacheWrite = row.cacheWrite.trim() === '' ? undefined : Number(row.cacheWrite);
    if (values.some(value => !Number.isFinite(value) || value < 0 || value > 1_000_000)
      || cacheWrite !== undefined && (!Number.isFinite(cacheWrite) || cacheWrite < 0 || cacheWrite > 1_000_000)) {
      return { error: `第 ${index + 1} 个模型的价格应在 0 至 1000000 之间。` };
    }
    modelNames.add(model);
    prices[model] = {
      label,
      off: {
        cacheHit: values[0]!,
        cacheMiss: values[1]!,
        ...(cacheWrite === undefined ? {} : { cacheWrite }),
        output: values[2]!,
      },
    };
  }
  return { value: JSON.stringify(prices) };
}

function canonicalModels(value: string | null): CanonicalValue {
  if (value === null) return { valid: true, value: null };
  const state = modelState(value);
  if (state.mode !== 'edit') return { valid: false, value };
  const result = validateModelRows(state.rows);
  return result.value === undefined ? { valid: false, value } : { valid: true, value: result.value };
}

function ErrorMessage({ message }: { message?: string }) {
  return message ? <p className="flex items-start gap-2 text-xs leading-5 text-destructive" role="alert"><AlertCircle className="mt-0.5 size-3.5 shrink-0" />{message}</p> : null;
}

function TimeWindowsEditor({ value, originalValue, disabled, onStateChange }: Omit<StructuredFieldsProps, 'format' | 'resetToken'>) {
  const initial = useMemo(() => timeState(value), []);
  const baseline = useMemo(() => canonicalTime(originalValue), [originalValue]);
  const nextKey = useRef(initial.rows.length);
  const [mode, setMode] = useState(initial.mode);
  const [rows, setRows] = useState(initial.rows);
  const [error, setError] = useState(initial.error);

  function publish(nextRows: readonly TimeRow[]): void {
    setRows(nextRows);
    const result = validateTimeRows(nextRows);
    setError(result.error);
    if (result.value === undefined) {
      onStateChange({ dirty: true, error: result.error });
      return;
    }
    onStateChange({ value: result.value, dirty: !baseline.valid || result.value !== baseline.value });
  }

  function startCustom(): void {
    const nextRows = [{ key: nextKey.current++, start: '', end: '' }];
    setMode('edit');
    publish(nextRows);
  }

  function inherit(): void {
    setMode('inherit');
    setRows([]);
    setError(undefined);
    onStateChange({ value: null, dirty: !baseline.valid || baseline.value !== null });
  }

  if (mode === 'inherit') return <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed px-3 py-3"><span className="text-xs text-muted-foreground">当前继承服务默认时间段</span><Button type="button" variant="outline" size="sm" disabled={disabled} onClick={startCustom}>自定义时间段</Button></div>;
  if (mode === 'invalid') return <div className="grid gap-3 rounded-lg border border-destructive/40 p-3"><ErrorMessage message={error} /><div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={inherit}>恢复继承</Button><Button type="button" variant="outline" size="sm" disabled={disabled} onClick={startCustom}>重新设置</Button></div></div>;

  return <div className="grid gap-3">
    {rows.map((row, index) => <div key={row.key} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      <label className="grid gap-1.5"><span className="text-[11px] font-medium">开始时间</span><Input type="number" min={0} max={24} step={1} value={row.start} disabled={disabled} onChange={event => publish(rows.map(item => item.key === row.key ? { ...item, start: event.target.value } : item))} /></label>
      <label className="grid gap-1.5"><span className="text-[11px] font-medium">结束时间</span><Input type="number" min={0} max={24} step={1} value={row.end} disabled={disabled} onChange={event => publish(rows.map(item => item.key === row.key ? { ...item, end: event.target.value } : item))} /></label>
      <Button type="button" variant="ghost" size="icon" disabled={disabled} aria-label={`移除第 ${index + 1} 个时间段`} title="移除时间段" onClick={() => publish(rows.filter(item => item.key !== row.key))}><Trash2 /></Button>
    </div>)}
    {rows.length === 0 && <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">当前没有自定义时间段</p>}
    <ErrorMessage message={error} />
    <div className="flex flex-wrap justify-between gap-2"><Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={inherit}>恢复继承</Button><Button type="button" variant="outline" size="sm" disabled={disabled || rows.length >= 24} onClick={() => publish([...rows, { key: nextKey.current++, start: '', end: '' }])}><Plus />添加时间段</Button></div>
  </div>;
}

function ModelPricesEditor({ value, originalValue, disabled, onStateChange }: Omit<StructuredFieldsProps, 'format' | 'resetToken'>) {
  const initial = useMemo(() => modelState(value), []);
  const baseline = useMemo(() => canonicalModels(originalValue), [originalValue]);
  const nextKey = useRef(initial.rows.length);
  const [mode, setMode] = useState(initial.mode);
  const [rows, setRows] = useState(initial.rows);
  const [error, setError] = useState(initial.error);

  function publish(nextRows: readonly ModelPriceRow[]): void {
    setRows(nextRows);
    const result = validateModelRows(nextRows);
    setError(result.error);
    if (result.value === undefined) {
      onStateChange({ dirty: true, error: result.error });
      return;
    }
    onStateChange({ value: result.value, dirty: !baseline.valid || result.value !== baseline.value });
  }

  function blankRow(): ModelPriceRow {
    return { key: nextKey.current++, model: '', label: '', cacheHit: '', cacheMiss: '', cacheWrite: '', output: '' };
  }

  function startCustom(): void {
    setMode('edit');
    publish([blankRow()]);
  }

  function inherit(): void {
    setMode('inherit');
    setRows([]);
    setError(undefined);
    onStateChange({ value: null, dirty: !baseline.valid || baseline.value !== null });
  }

  function update(key: number, changes: Partial<Omit<ModelPriceRow, 'key'>>): void {
    publish(rows.map(row => row.key === key ? { ...row, ...changes } : row));
  }

  if (mode === 'inherit') return <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed px-3 py-3"><span className="text-xs text-muted-foreground">当前继承服务默认模型价格</span><Button type="button" variant="outline" size="sm" disabled={disabled} onClick={startCustom}>自定义模型价格</Button></div>;
  if (mode === 'invalid') return <div className="grid gap-3 rounded-lg border border-destructive/40 p-3"><ErrorMessage message={error} /><div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={inherit}>恢复继承</Button><Button type="button" variant="outline" size="sm" disabled={disabled} onClick={startCustom}>重新设置</Button></div></div>;

  return <div className="grid gap-3">
    {rows.map((row, index) => <div key={row.key} className="grid gap-3 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-3"><strong className="text-xs font-medium">模型 {index + 1}</strong><Button type="button" variant="ghost" size="icon-sm" disabled={disabled} aria-label={`移除第 ${index + 1} 个模型`} title="移除模型" onClick={() => publish(rows.filter(item => item.key !== row.key))}><Trash2 /></Button></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1.5"><span className="text-[11px] font-medium">模型标识</span><Input value={row.model} maxLength={128} disabled={disabled} onChange={event => update(row.key, { model: event.target.value })} /></label>
        <label className="grid gap-1.5"><span className="text-[11px] font-medium">显示名</span><Input value={row.label} maxLength={200} disabled={disabled} onChange={event => update(row.key, { label: event.target.value })} /></label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="grid gap-1.5"><span className="text-[11px] font-medium">缓存命中输入价</span><Input type="number" min={0} max={1_000_000} step="any" value={row.cacheHit} disabled={disabled} onChange={event => update(row.key, { cacheHit: event.target.value })} /></label>
        <label className="grid gap-1.5"><span className="text-[11px] font-medium">未命中输入价</span><Input type="number" min={0} max={1_000_000} step="any" value={row.cacheMiss} disabled={disabled} onChange={event => update(row.key, { cacheMiss: event.target.value })} /></label>
        <label className="grid gap-1.5"><span className="text-[11px] font-medium">缓存写入价（可选）</span><Input type="number" min={0} max={1_000_000} step="any" value={row.cacheWrite} disabled={disabled} placeholder="留空时跟随未命中价" onChange={event => update(row.key, { cacheWrite: event.target.value })} /></label>
        <label className="grid gap-1.5"><span className="text-[11px] font-medium">输出价</span><Input type="number" min={0} max={1_000_000} step="any" value={row.output} disabled={disabled} onChange={event => update(row.key, { output: event.target.value })} /></label>
      </div>
    </div>)}
    {rows.length === 0 && <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">当前没有自定义模型价格</p>}
    <ErrorMessage message={error} />
    <div className="flex flex-wrap justify-between gap-2"><Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={inherit}>恢复继承</Button><Button type="button" variant="outline" size="sm" disabled={disabled || rows.length >= 100} onClick={() => publish([...rows, blankRow()])}><Plus />添加模型</Button></div>
  </div>;
}

export function StructuredFields(props: StructuredFieldsProps) {
  return props.format === 'time-windows'
    ? <TimeWindowsEditor key={props.resetToken} {...props} />
    : <ModelPricesEditor key={props.resetToken} {...props} />;
}
