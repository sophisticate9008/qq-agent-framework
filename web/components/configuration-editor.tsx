import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, CircleOff, LoaderCircle } from 'lucide-react';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.tsx';
import { Switch } from './ui/switch.tsx';
import { Textarea } from './ui/textarea.tsx';
import { ConnectPrompt, EmptyState, Field, SaveBar, Section, StatusPill, ToggleField } from './management.tsx';
import { StructuredFields, type StructuredFieldFormat, type StructuredFieldState } from './structured-fields.tsx';
import { ApiError, asRecord, errorMessage, isRecord } from '../lib/api.ts';
import { resolveConfigurationVisibility } from '../lib/configuration-visibility.ts';
import type { PageProps } from '../lib/types.ts';

type ConfigurationCategory = 'persona' | 'features' | 'access' | 'model' | 'settings';
type ConfigurationSource = 'bridge' | 'gateway' | 'admin';
type ConfigurationFieldType = 'boolean' | 'number' | 'text' | 'textarea' | 'list' | 'select' | 'secret';
type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };
type DraftValue = boolean | string | null;

interface ConfigurationOption {
  readonly value: string;
  readonly label: string;
}

interface ConfigurationField {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly type: ConfigurationFieldType;
  readonly value: unknown;
  readonly configured?: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly unit?: string;
  readonly options?: readonly ConfigurationOption[];
  readonly editable?: boolean;
  readonly format?: StructuredFieldFormat;
}

interface ConfigurationGroup {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: ConfigurationCategory;
  readonly source: ConfigurationSource;
  readonly revision: string;
  readonly fields: readonly ConfigurationField[];
  readonly applyLabel?: string;
}

interface ConfigurationResponse {
  readonly groups: readonly ConfigurationGroup[];
  readonly capabilities: { readonly apply: boolean };
}

interface EditorState {
  readonly groups: readonly ConfigurationGroup[];
  readonly drafts: Readonly<Record<string, DraftValue>>;
  readonly dirtyKeys: ReadonlySet<string>;
}

interface OperationStatus {
  readonly text: string;
  readonly tone: 'success' | 'warning' | 'neutral';
}

const categories = new Set<ConfigurationCategory>(['persona', 'features', 'access', 'model', 'settings']);
const sources = new Set<ConfigurationSource>(['bridge', 'gateway', 'admin']);
const fieldTypes = new Set<ConfigurationFieldType>(['boolean', 'number', 'text', 'textarea', 'list', 'select', 'secret']);
const fieldFormats = new Set<StructuredFieldFormat>(['time-windows', 'model-prices']);

function fieldKey(groupId: string, fieldId: string): string {
  return `${groupId}\u0000${fieldId}`;
}

function parseOption(value: unknown): ConfigurationOption | null {
  if (!isRecord(value) || typeof value.value !== 'string' || typeof value.label !== 'string') return null;
  return { value: value.value, label: value.label };
}

function parseField(value: unknown): ConfigurationField | null {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.label !== 'string'
    || typeof value.description !== 'string'
    || typeof value.type !== 'string'
    || !fieldTypes.has(value.type as ConfigurationFieldType)) return null;
  const options = Array.isArray(value.options)
    ? value.options.map(parseOption).filter((option): option is ConfigurationOption => option !== null)
    : undefined;
  return {
    id: value.id,
    label: value.label,
    description: value.description,
    type: value.type as ConfigurationFieldType,
    value: value.value,
    ...(typeof value.configured === 'boolean' ? { configured: value.configured } : {}),
    ...(typeof value.min === 'number' ? { min: value.min } : {}),
    ...(typeof value.max === 'number' ? { max: value.max } : {}),
    ...(typeof value.step === 'number' ? { step: value.step } : {}),
    ...(typeof value.unit === 'string' ? { unit: value.unit } : {}),
    ...(options ? { options } : {}),
    ...(typeof value.editable === 'boolean' ? { editable: value.editable } : {}),
    ...(typeof value.format === 'string' && fieldFormats.has(value.format as StructuredFieldFormat) ? { format: value.format as StructuredFieldFormat } : {}),
  };
}

function parseGroup(value: unknown): ConfigurationGroup | null {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.title !== 'string'
    || typeof value.description !== 'string'
    || typeof value.category !== 'string'
    || !categories.has(value.category as ConfigurationCategory)
    || typeof value.source !== 'string'
    || !sources.has(value.source as ConfigurationSource)
    || typeof value.revision !== 'string'
    || !Array.isArray(value.fields)) return null;
  const fields = value.fields.map(parseField).filter((field): field is ConfigurationField => field !== null);
  return {
    id: value.id,
    title: value.title,
    description: value.description,
    category: value.category as ConfigurationCategory,
    source: value.source as ConfigurationSource,
    revision: value.revision,
    fields,
    ...(typeof value.applyLabel === 'string' ? { applyLabel: value.applyLabel } : {}),
  };
}

function parseConfiguration(value: unknown): ConfigurationResponse {
  const record = asRecord(value);
  const groups = Array.isArray(record.groups)
    ? record.groups.map(parseGroup).filter((group): group is ConfigurationGroup => group !== null)
    : [];
  return { groups, capabilities: { apply: asRecord(record.capabilities).apply === true } };
}

function initialDraft(field: ConfigurationField): DraftValue {
  if (field.type === 'secret') return '';
  if (field.value === null) return null;
  if (field.type === 'boolean') return typeof field.value === 'boolean' ? field.value : null;
  if (field.type === 'number') return typeof field.value === 'number' ? String(field.value) : null;
  if (field.type === 'list') {
    return Array.isArray(field.value) && field.value.every(item => typeof item === 'string')
      ? field.value.join('\n')
      : null;
  }
  return typeof field.value === 'string' ? field.value : null;
}

function serializedDraft(field: ConfigurationField, draft: DraftValue): JsonValue | undefined {
  if (field.type === 'secret') return typeof draft === 'string' && draft.trim() !== '' ? draft : undefined;
  if (draft === null) return null;
  if (field.type === 'boolean') return typeof draft === 'boolean' ? draft : undefined;
  if (field.type === 'number') {
    if (typeof draft !== 'string' || draft.trim() === '') return null;
    const number = Number(draft);
    return Number.isFinite(number) ? number : undefined;
  }
  if (field.type === 'list') {
    if (typeof draft !== 'string') return undefined;
    return draft.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
  }
  return typeof draft === 'string' ? draft : undefined;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isDirty(field: ConfigurationField, draft: DraftValue): boolean {
  if (field.type === 'secret') return typeof draft === 'string' && draft.trim() !== '';
  const serialized = serializedDraft(field, draft);
  return serialized !== undefined && !sameValue(serialized, field.value);
}

function stateFromGroups(groups: readonly ConfigurationGroup[]): EditorState {
  const drafts: Record<string, DraftValue> = {};
  for (const group of groups) {
    for (const field of group.fields) drafts[fieldKey(group.id, field.id)] = initialDraft(field);
  }
  return { groups, drafts, dirtyKeys: new Set() };
}

function reconcileState(current: EditorState, groups: readonly ConfigurationGroup[], completedKeys: ReadonlySet<string>): EditorState {
  const drafts: Record<string, DraftValue> = {};
  const dirtyKeys = new Set<string>();
  for (const group of groups) {
    for (const field of group.fields) {
      const key = fieldKey(group.id, field.id);
      const preserve = current.dirtyKeys.has(key) && !completedKeys.has(key);
      const draft = preserve ? current.drafts[key] ?? initialDraft(field) : initialDraft(field);
      drafts[key] = draft;
      if (preserve && isDirty(field, draft)) dirtyKeys.add(key);
    }
  }
  return { groups, drafts, dirtyKeys };
}

function unavailableMessage(error: unknown): string | null {
  if (error instanceof ApiError && (error.status === 404 || error.status === 501)) {
    return '当前服务尚未提供配置接口，这些选项不会被假定为已经开通。';
  }
  return null;
}

function inheritedHint(field: ConfigurationField, draft: DraftValue): string | undefined {
  return field.type !== 'secret' && draft === null
    ? `${field.description}${field.description ? ' ' : ''}当前未单独设定，将继承服务默认值。`
    : undefined;
}

function FieldEditor({ field, draft, disabled, resetToken, onChange, onStructuredChange }: {
  field: ConfigurationField;
  draft: DraftValue;
  disabled: boolean;
  resetToken: string;
  onChange(value: DraftValue): void;
  onStructuredChange(state: StructuredFieldState): void;
}) {
  const description = inheritedHint(field, draft) ?? field.description;
  const inheritAction = field.type !== 'secret' && draft !== null && field.editable !== false
    ? <Button type="button" variant="ghost" size="xs" disabled={disabled} onClick={() => onChange(null)}>恢复继承</Button>
    : null;

  if (field.format) {
    return <div role="group" aria-label={field.label} className="grid content-start gap-2 md:col-span-2">
      <span className="field-label">{field.label}</span>
      <StructuredFields
        format={field.format}
        value={typeof draft === 'string' ? draft : null}
        originalValue={typeof field.value === 'string' ? field.value : null}
        disabled={disabled}
        resetToken={resetToken}
        onStateChange={onStructuredChange}
      />
      {field.description && <span className="field-hint">{field.description}</span>}
    </div>;
  }

  if (field.type === 'boolean') {
    return <div className="border-b pb-2 last:border-0">
      <ToggleField label={field.label} description={description} checked={draft === true} disabled={disabled} onChange={onChange} />
      <div className="flex min-h-7 items-center justify-end gap-2">
        {draft === null && field.editable !== false && <Button type="button" variant="ghost" size="xs" disabled={disabled} onClick={() => onChange(false)}>单独关闭</Button>}
        {inheritAction}
      </div>
    </div>;
  }

  if (field.type === 'secret') {
    return <Field label={field.label} description={field.description}>
      <Input type="password" autoComplete="new-password" spellCheck={false} value={typeof draft === 'string' ? draft : ''} disabled={disabled} placeholder={field.configured === true ? '已配置，留空则保持不变' : '尚未配置，留空则不写入'} onChange={event => onChange(event.target.value)} />
      <span className="flex items-center gap-2 text-[11px] text-muted-foreground"><StatusPill tone={field.configured === true ? 'success' : 'neutral'}>{field.configured === true ? '已配置' : '未配置'}</StatusPill>密码不会在页面中回显</span>
    </Field>;
  }

  let control;
  if (field.type === 'textarea' || field.type === 'list') {
    control = <Textarea value={typeof draft === 'string' ? draft : ''} disabled={disabled} rows={field.type === 'list' ? 5 : 6} placeholder={draft === null ? '继承默认设置' : undefined} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value)} />;
  } else if (field.type === 'select') {
    control = <Select value={typeof draft === 'string' ? draft : null} disabled={disabled} onValueChange={value => onChange(value)}>
      <SelectTrigger className="w-full"><SelectValue placeholder="继承默认设置">{typeof draft === 'string' ? field.options?.find(option => option.value === draft)?.label : undefined}</SelectValue></SelectTrigger>
      <SelectContent>{field.options?.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
    </Select>;
  } else {
    control = <div className="relative">
      <Input
        type={field.type === 'number' ? 'number' : 'text'}
        value={typeof draft === 'string' ? draft : ''}
        disabled={disabled}
        min={field.type === 'number' ? field.min : undefined}
        max={field.type === 'number' ? field.max : undefined}
        step={field.type === 'number' ? field.step : undefined}
        className={field.unit ? 'pr-20' : undefined}
        placeholder={draft === null ? '继承默认设置' : undefined}
        onChange={event => onChange(event.target.value)}
      />
      {field.unit && <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">{field.unit}</span>}
    </div>;
  }

  return <Field label={field.label} description={description}>
    {control}
    {field.type === 'list' && <span className="text-[11px] text-muted-foreground">每行填写一项</span>}
    {inheritAction && <span className="flex justify-end">{inheritAction}</span>}
  </Field>;
}

export function ConfigurationEditor({ connected, api, setDirty, category, connect, activeMode }: PageProps & { category: ConfigurationCategory; activeMode?: string | null }) {
  const dirtyScope = `configuration:${category}`;
  const [editor, setEditor] = useState<EditorState>(() => stateFromGroups([]));
  const [capabilities, setCapabilities] = useState({ apply: false });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [savingGroup, setSavingGroup] = useState<string | null>(null);
  const [applyingSource, setApplyingSource] = useState<ConfigurationSource | null>(null);
  const [pendingSources, setPendingSources] = useState<ReadonlySet<ConfigurationSource>>(new Set());
  const [groupStatuses, setGroupStatuses] = useState<Readonly<Record<string, OperationStatus>>>({});
  const [sourceStatuses, setSourceStatuses] = useState<Readonly<Partial<Record<ConfigurationSource, OperationStatus>>>>({});
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const [structuredEpoch, setStructuredEpoch] = useState(0);
  const [structuredVersions, setStructuredVersions] = useState<Readonly<Record<string, number>>>({});

  useEffect(() => {
    setDirty(editor.dirtyKeys.size > 0, dirtyScope);
  }, [dirtyScope, editor.dirtyKeys, setDirty]);

  useEffect(() => () => setDirty(false, dirtyScope), [dirtyScope, setDirty]);

  useEffect(() => {
    if (!connected) {
      setEditor(stateFromGroups([]));
      setFieldErrors({});
      setStructuredVersions({});
      setStructuredEpoch(current => current + 1);
      setLoadError('');
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    void api.get('/api/configuration', controller.signal).then(result => {
      const configuration = parseConfiguration(result);
      const groups = configuration.groups.filter(group => group.category === category);
      setEditor(stateFromGroups(groups));
      setFieldErrors({});
      setStructuredVersions({});
      setStructuredEpoch(current => current + 1);
      setCapabilities(configuration.capabilities);
      setExpanded(new Set(groups[0] ? [groups[0].id] : []));
    }).catch(error => {
      if (!controller.signal.aborted) setLoadError(unavailableMessage(error) ?? errorMessage(error));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [api, category, connected]);

  function updateField(group: ConfigurationGroup, field: ConfigurationField, value: DraftValue): void {
    const key = fieldKey(group.id, field.id);
    setEditor(current => {
      const drafts = { ...current.drafts, [key]: value };
      const dirtyKeys = new Set(current.dirtyKeys);
      if (isDirty(field, value)) dirtyKeys.add(key);
      else dirtyKeys.delete(key);
      return { ...current, drafts, dirtyKeys };
    });
    setGroupStatuses(current => {
      const next = { ...current };
      delete next[group.id];
      return next;
    });
    setSourceStatuses(current => {
      const next = { ...current };
      delete next[group.source];
      return next;
    });
  }

  function updateStructuredField(group: ConfigurationGroup, field: ConfigurationField, state: StructuredFieldState): void {
    const key = fieldKey(group.id, field.id);
    setEditor(current => {
      const drafts = state.value === undefined ? current.drafts : { ...current.drafts, [key]: state.value };
      const dirtyKeys = new Set(current.dirtyKeys);
      if (state.dirty) dirtyKeys.add(key);
      else dirtyKeys.delete(key);
      return { ...current, drafts, dirtyKeys };
    });
    setFieldErrors(current => {
      const next = { ...current };
      if (state.error) next[key] = state.error;
      else delete next[key];
      return next;
    });
    setGroupStatuses(current => {
      const next = { ...current };
      delete next[group.id];
      return next;
    });
    setSourceStatuses(current => {
      const next = { ...current };
      delete next[group.source];
      return next;
    });
  }

  function resetStructuredFields(keys: Iterable<string>): void {
    setStructuredVersions(current => {
      const next = { ...current };
      for (const key of keys) next[key] = (next[key] ?? 0) + 1;
      return next;
    });
  }

  function resetGroup(group: ConfigurationGroup): void {
    const keys = group.fields.map(field => fieldKey(group.id, field.id));
    setEditor(current => {
      const drafts = { ...current.drafts };
      const dirtyKeys = new Set(current.dirtyKeys);
      for (const field of group.fields) {
        const key = fieldKey(group.id, field.id);
        drafts[key] = initialDraft(field);
        dirtyKeys.delete(key);
      }
      return { ...current, drafts, dirtyKeys };
    });
    setFieldErrors(current => {
      const next = { ...current };
      for (const key of keys) delete next[key];
      return next;
    });
    resetStructuredFields(keys);
  }

  function optimisticGroups(group: ConfigurationGroup, changes: Readonly<Record<string, JsonValue>>, revision: string): readonly ConfigurationGroup[] {
    return editor.groups.map(current => {
      if (current.source !== group.source) return current;
      if (current.id !== group.id) return { ...current, revision };
      return {
        ...current,
        revision,
        fields: current.fields.map(field => Object.hasOwn(changes, field.id)
          ? { ...field, value: field.type === 'secret' ? field.value : changes[field.id], ...(field.type === 'secret' ? { configured: true } : {}) }
          : field),
      };
    });
  }

  async function saveGroup(group: ConfigurationGroup): Promise<void> {
    const changes: Record<string, JsonValue> = {};
    const completedKeys = new Set<string>();
    for (const field of group.fields) {
      const key = fieldKey(group.id, field.id);
      if (!editor.dirtyKeys.has(key)) continue;
      if (fieldErrors[key]) {
        setGroupStatuses(current => ({ ...current, [group.id]: { text: `请检查“${field.label}”：${fieldErrors[key]}`, tone: 'warning' } }));
        return;
      }
      const value = serializedDraft(field, editor.drafts[key] ?? initialDraft(field));
      if (value === undefined) {
        setGroupStatuses(current => ({ ...current, [group.id]: { text: `请检查“${field.label}”的填写内容。`, tone: 'warning' } }));
        return;
      }
      if (field.type === 'number' && typeof value === 'number' && ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max))) {
        setGroupStatuses(current => ({ ...current, [group.id]: { text: `“${field.label}”超出允许范围。`, tone: 'warning' } }));
        return;
      }
      changes[field.id] = value;
      completedKeys.add(key);
    }
    if (Object.keys(changes).length === 0) return;

    setSavingGroup(group.id);
    setGroupStatuses(current => ({ ...current, [group.id]: { text: '正在保存更改', tone: 'neutral' } }));
    setSourceStatuses(current => {
      const next = { ...current };
      delete next[group.source];
      return next;
    });
    try {
      const result = asRecord(await api.post('/api/configuration', { source: group.source, revision: group.revision, changes }));
      if (result.ok !== true || typeof result.revision !== 'string') throw new Error('save_result_unknown');
      const applyRequired = result.applyRequired === true || result.restartRequired === true;
      if (applyRequired) setPendingSources(current => new Set(current).add(group.source));
      try {
        const refreshed = parseConfiguration(await api.get('/api/configuration'));
        const groups = refreshed.groups.filter(item => item.category === category);
        setEditor(current => reconcileState(current, groups, completedKeys));
        setCapabilities(refreshed.capabilities);
        setGroupStatuses(current => ({ ...current, [group.id]: { text: applyRequired ? '已保存，等待应用' : '设置已保存', tone: applyRequired ? 'warning' : 'success' } }));
      } catch {
        const groups = optimisticGroups(group, changes, result.revision);
        setEditor(current => reconcileState(current, groups, completedKeys));
        setGroupStatuses(current => ({ ...current, [group.id]: { text: applyRequired ? '已保存，等待应用；最新状态暂时无法确认。' : '已保存，但最新状态暂时无法确认。', tone: 'warning' } }));
      }
      setFieldErrors(current => {
        const next = { ...current };
        for (const key of completedKeys) delete next[key];
        return next;
      });
      resetStructuredFields(completedKeys);
    } catch (error) {
      const unknown = error instanceof Error && error.message === 'save_result_unknown';
      setGroupStatuses(current => ({ ...current, [group.id]: { text: unknown ? '保存结果待确认，请刷新后查看。' : errorMessage(error), tone: 'warning' } }));
    } finally {
      setSavingGroup(null);
    }
  }

  async function applyGroup(group: ConfigurationGroup): Promise<void> {
    if (savingGroup !== null || applyingSource !== null || editor.groups.some(item => item.source === group.source
      && item.fields.some(field => editor.dirtyKeys.has(fieldKey(item.id, field.id))))) return;
    setApplyingSource(group.source);
    setGroupStatuses(current => {
      const next = { ...current };
      for (const item of editor.groups) if (item.source === group.source) delete next[item.id];
      return next;
    });
    setSourceStatuses(current => ({ ...current, [group.source]: { text: '正在应用更改', tone: 'neutral' } }));
    try {
      const result = asRecord(await api.post('/api/configuration/apply', { source: group.source, revision: group.revision }));
      const resultState = typeof result.status === 'string' ? result.status : result.result;
      const application = asRecord(result.application);
      if (resultState === 'unknown' || result.ok !== true) {
        setSourceStatuses(current => ({ ...current, [group.source]: { text: '应用结果待确认，请刷新状态后查看。', tone: 'warning' } }));
        return;
      }
      if (application.applied === true) {
        setPendingSources(current => {
          const next = new Set(current);
          next.delete(group.source);
          return next;
        });
        setSourceStatuses(current => ({ ...current, [group.source]: { text: '配置应用流程已完成', tone: 'success' } }));
        return;
      }
      if (application.accepted === true && typeof application.reconnectUrl === 'string') {
        setPendingSources(current => {
          const next = new Set(current);
          next.delete(group.source);
          return next;
        });
        setSourceStatuses(current => ({ ...current, [group.source]: { text: '重启请求已提交，等待服务重新连接', tone: 'neutral' } }));
        return;
      }
      setSourceStatuses(current => ({ ...current, [group.source]: { text: '应用结果待确认，请刷新状态后查看。', tone: 'warning' } }));
    } catch (error) {
      setSourceStatuses(current => ({ ...current, [group.source]: { text: errorMessage(error), tone: 'warning' } }));
    } finally {
      setApplyingSource(null);
    }
  }

  const visibilityValues = useMemo(() => {
    const values: Record<string, unknown> = {};
    for (const group of editor.groups) for (const field of group.fields) {
      const key = fieldKey(group.id, field.id);
      values[field.id] = Object.hasOwn(editor.drafts, key) ? editor.drafts[key] : field.value;
    }
    return values;
  }, [editor.drafts, editor.groups]);
  const dirtyFieldIds = useMemo(() => {
    const ids = new Set<string>();
    for (const group of editor.groups) for (const field of group.fields) {
      if (editor.dirtyKeys.has(fieldKey(group.id, field.id))) ids.add(field.id);
    }
    return ids;
  }, [editor.dirtyKeys, editor.groups]);
  const visibility = useMemo(() => resolveConfigurationVisibility(editor.groups, {
    activeMode,
    values: visibilityValues,
    dirtyFieldIds,
    showInactive
  }), [activeMode, dirtyFieldIds, editor.groups, showInactive, visibilityValues]);
  const matchingGroups = useMemo(() => {
    const matches = new Map<string, ReadonlySet<string> | null>();
    for (const group of editor.groups) {
      const groupVisibility = visibility.get(group.id);
      if (!groupVisibility?.visible) continue;
      matches.set(group.id, groupVisibility.fieldIds);
    }
    return matches;
  }, [editor.groups, visibility]);
  const featureSummary = useMemo(() => {
    let enabled = 0;
    let disabled = 0;
    for (const group of editor.groups) for (const field of group.fields) {
      if (!visibility.get(group.id)?.fieldIds.has(field.id)) continue;
      if (field.type !== 'boolean') continue;
      if (visibilityValues[field.id] === true) enabled += 1;
      if (visibilityValues[field.id] === false) disabled += 1;
    }
    return { enabled, disabled };
  }, [editor.groups, visibility, visibilityValues]);

  if (!connected) return <ConnectPrompt connect={connect} />;
  if (loading) return <div className="panel flex min-h-52 items-center justify-center gap-2 text-xs text-muted-foreground" role="status"><LoaderCircle className="size-4 animate-spin" />正在读取设置</div>;
  if (loadError) return <Section title="配置暂不可用"><EmptyState title="无法读取当前设置" description={loadError} action={<Button variant="outline" onClick={() => location.reload()}>重新加载页面</Button>} /></Section>;
  if (editor.groups.length === 0) return null;

  return <div className="grid gap-5">
    <div className="flex flex-wrap items-center gap-3">
      {category === 'features' && <label className="flex items-center gap-2 text-xs text-muted-foreground"><Switch size="sm" checked={showInactive} onCheckedChange={setShowInactive} aria-label="显示停用配置" /><span>显示停用配置</span></label>}
      {category === 'features' && (featureSummary.enabled > 0 || featureSummary.disabled > 0) && <div className="flex items-center gap-2" aria-label="功能状态摘要"><StatusPill tone="success">配置开启 {featureSummary.enabled} 项</StatusPill><StatusPill tone="neutral">配置关闭 {featureSummary.disabled} 项</StatusPill></div>}
    </div>
    {matchingGroups.size === 0 && <div className="panel"><EmptyState title="没有匹配的设置" description="换一个功能或设置名称试试。" /></div>}
    {editor.groups.map(group => {
      const groupVisible = matchingGroups.has(group.id);
      const visibleFieldIds = matchingGroups.get(group.id);
      const groupVisibility = visibility.get(group.id);
      const inactiveDirtyCount = groupVisibility?.inactiveDirtyFieldIds.size ?? 0;
      const dirtyCount = group.fields.filter(field => editor.dirtyKeys.has(fieldKey(group.id, field.id))).length;
      const groupDirty = dirtyCount > 0;
      const sourceDirty = editor.groups.some(item => item.source === group.source
        && item.fields.some(field => editor.dirtyKeys.has(fieldKey(item.id, field.id))));
      const groupInvalid = group.fields.some(field => Boolean(fieldErrors[fieldKey(group.id, field.id)]));
      const pending = pendingSources.has(group.source);
      const status = groupStatuses[group.id] ?? sourceStatuses[group.source];
      const busy = savingGroup !== null || applyingSource !== null;
      const visibleFieldCount = visibleFieldIds === null
        ? groupVisibility?.fieldIds.size ?? 0
        : visibleFieldIds?.size ?? 0;
      const open = inactiveDirtyCount > 0 || expanded.has(group.id);
      const message = status?.text ?? (groupDirty ? `${dirtyCount} 项更改尚未保存` : pending ? (capabilities.apply ? '已保存，等待应用' : '已保存，需要稍后重启服务') : '已读取保存的配置');
      return <Section key={group.id} className={groupVisible ? undefined : 'hidden'} title={group.title} description={group.description} actions={status && <StatusPill tone={status.tone}>{status.text}</StatusPill>} footer={<SaveBar dirty={groupDirty} disabled={busy || groupInvalid} saving={savingGroup === group.id} message={message} label="保存本组" onSave={() => void saveGroup(group)} onReset={() => resetGroup(group)}>{capabilities.apply && group.applyLabel && <Button variant="outline" disabled={busy || sourceDirty} onClick={() => void applyGroup(group)}>{applyingSource === group.source ? <LoaderCircle className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}{applyingSource === group.source ? '正在应用' : group.applyLabel ?? '应用更改'}</Button>}</SaveBar>}>
        <details open={open} onToggle={event => {
          const isOpen = event.currentTarget.open;
          setExpanded(current => {
            const next = new Set(current);
            if (isOpen) next.add(group.id);
            else next.delete(group.id);
            return next;
          });
        }}>
          <summary className="flex cursor-pointer list-none items-center justify-between rounded-lg px-1 py-2 text-xs font-medium text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"><span>{open ? '收起设置' : `展开 ${visibleFieldCount} 项设置`}</span><ChevronDown className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`} /></summary>
          {inactiveDirtyCount > 0 && <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground" role="status"><AlertCircle className="size-4 text-amber-600" />仍显示 {inactiveDirtyCount} 项受停用开关或运行模式隐藏的草稿；保存只写入草稿值，不会开启父功能或切换运行模式。</p>}
          <div className="grid gap-5 pt-5 md:grid-cols-2">{group.fields.map(field => {
            const key = fieldKey(group.id, field.id);
            const fieldVisible = groupVisibility?.fieldIds.has(field.id) === true && (visibleFieldIds === null || visibleFieldIds?.has(field.id) === true);
            return <div key={field.id} className={fieldVisible ? 'contents' : 'hidden'}><FieldEditor field={field} draft={editor.drafts[key] ?? initialDraft(field)} disabled={busy || field.editable === false} resetToken={`${structuredEpoch}:${structuredVersions[key] ?? 0}`} onChange={value => updateField(group, field, value)} onStructuredChange={state => updateStructuredField(group, field, state)} /></div>;
          })}</div>
          {group.fields.length === 0 && <div className="flex items-center gap-2 py-5 text-xs text-muted-foreground"><CircleOff className="size-4" />此分组没有可显示的设置</div>}
        </details>
      </Section>;
    })}
    {(Object.values(groupStatuses).some(status => status.tone === 'warning') || Object.values(sourceStatuses).some(status => status?.tone === 'warning')) && <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status"><AlertCircle className="size-4" />结果待确认时不会自动重试或重复写入。</p>}
  </div>;
}
