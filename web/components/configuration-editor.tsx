import { createDraftKey, retainDraft, retainedDraft } from '../lib/retained-drafts.ts';
import { readResource, writeResource } from '../lib/resource-reader.ts';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react';
import { AlertCircle, CheckCircle2, CircleOff, LoaderCircle } from 'lucide-react';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.tsx';
import { Switch } from './ui/switch.tsx';
import { Textarea } from './ui/textarea.tsx';
import { ConnectPrompt, EmptyState, Field, SaveBar, Section, StatusPill, ToggleField } from './management.tsx';
import { StructuredFields, type StructuredFieldFormat, type StructuredFieldState } from './structured-fields.tsx';
import { HelpTip } from './help-tip.tsx';
import { ApiError, asRecord, errorMessage, isRecord } from '../lib/api.ts';
import { resolveConfigurationVisibility } from '../lib/configuration-visibility.ts';
import { readConfigurationDraft } from '../lib/configuration-drafts.ts';
import { configurationApplyOutcome } from '../lib/configuration-operations.ts';
import { configurationOperationStore } from '../lib/configuration-operation-recovery.ts';
import type { PageProps } from '../lib/types.ts';

type ConfigurationCategory = 'persona' | 'features' | 'access' | 'model' | 'settings';
type ConfigurationSource = 'gateway' | 'admin';
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

const editorDraftKeys = {
  persona: createDraftKey<EditorState>('configuration:persona'), features: createDraftKey<EditorState>('configuration:features'),
  access: createDraftKey<EditorState>('configuration:access'), model: createDraftKey<EditorState>('configuration:model'), settings: createDraftKey<EditorState>('configuration:settings'),
};

/** Credentials remain only in the mounted field; public drafts keep their original CAS baseline. */
function publicEditorState(editor: EditorState): EditorState {
  const groups = editor.groups.map(group => ({ ...group, fields: group.fields.map(field => field.type === 'secret' ? { ...field, value: undefined } : field) }));
  const result = stateFromGroups(groups);
  const drafts = { ...result.drafts }; const dirtyKeys = new Set<string>();
  for (const group of groups) for (const field of group.fields) {
    const key = fieldKey(group.id, field.id);
    if (field.type !== 'secret' && editor.dirtyKeys.has(key)) { drafts[key] = editor.drafts[key] ?? null; dirtyKeys.add(key); }
  }
  return { groups, drafts, dirtyKeys };
}

interface OperationStatus {
  readonly text: string;
  readonly tone: 'success' | 'warning' | 'neutral';
}

const categories = new Set<ConfigurationCategory>(['persona', 'features', 'access', 'model', 'settings']);
const sources = new Set<ConfigurationSource>(['gateway', 'admin']);
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
      const draft = preserve ? readConfigurationDraft(current.drafts, key, initialDraft(field)) : initialDraft(field);
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
      <div className="flex items-center gap-0.5"><span className="field-label">{field.label}</span>{field.description && <HelpTip label={field.label}>{field.description}</HelpTip>}</div>
      <StructuredFields
        format={field.format}
        value={typeof draft === 'string' ? draft : null}
        originalValue={typeof field.value === 'string' ? field.value : null}
        disabled={disabled}
        resetToken={resetToken}
        onStateChange={onStructuredChange}
      />
    </div>;
  }

  if (field.type === 'boolean') {
    return <div className="flex min-h-[30px] flex-wrap items-center gap-2">
      <div className="min-w-0 flex-1"><ToggleField label={field.label} tip={description} checked={draft === true} disabled={disabled} onChange={onChange} /></div>
        {draft === null && field.editable !== false && <Button type="button" variant="ghost" size="xs" disabled={disabled} onClick={() => onChange(false)}>单独关闭</Button>}
        {inheritAction}
    </div>;
  }

  if (field.type === 'secret') {
    return <Field label={field.label} layout="stacked" tip={field.description}>
      <Input type="password" autoComplete="new-password" spellCheck={false} value={typeof draft === 'string' ? draft : ''} disabled={disabled} placeholder={field.configured === true ? '已配置，留空则保持不变' : '尚未配置，留空则不写入'} onChange={event => onChange(event.target.value)} />
      <span className="flex items-center gap-2 text-xs text-muted-foreground"><StatusPill tone={field.configured === true ? 'success' : 'neutral'}>{field.configured === true ? '已配置' : '未配置'}</StatusPill>密码不会在页面中回显</span>
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

  return <Field label={field.label} layout={field.type === 'textarea' || field.type === 'list' ? 'stacked' : 'inline'} tip={description}>
    {field.type === 'textarea' || field.type === 'list' ? control : <div className="flex min-w-0 items-center gap-1"><div className="min-w-0 flex-1">{control}</div>{inheritAction}</div>}
    {field.type === 'list' && <span className="text-xs text-muted-foreground">每行填写一项</span>}
    {(field.type === 'textarea' || field.type === 'list') && inheritAction && <span className="flex justify-end">{inheritAction}</span>}
  </Field>;
}

export function ConfigurationEditor({ connected, api, setDirty, category, connect }: PageProps & { category: ConfigurationCategory }) {
  const dirtyScope = `configuration:${category}`;
  const operationStore = useMemo(() => configurationOperationStore(api), [api]);
  const sourceBlocks = useSyncExternalStore(operationStore.subscribe, operationStore.getSnapshot, operationStore.getSnapshot);
  const [editor, setEditor] = useState<EditorState>(() => stateFromGroups([]));
  const [capabilities, setCapabilities] = useState({ apply: false });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [savingGroup, setSavingGroup] = useState<string | null>(null);
  const [applyingSource, setApplyingSource] = useState<ConfigurationSource | null>(null);
  const [checkingSource, setCheckingSource] = useState<ConfigurationSource | null>(null);
  const [pendingSources, setPendingSources] = useState<ReadonlySet<ConfigurationSource>>(new Set());
  const [groupStatuses, setGroupStatuses] = useState<Readonly<Record<string, OperationStatus>>>({});
  const [sourceStatuses, setSourceStatuses] = useState<Readonly<Partial<Record<ConfigurationSource, OperationStatus>>>>({});
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const [structuredEpoch, setStructuredEpoch] = useState(0);
  const [structuredVersions, setStructuredVersions] = useState<Readonly<Record<string, number>>>({});
  const epoch = useRef(0);
  const writeController = useRef<AbortController | null>(null);
  const readController = useRef<AbortController | null>(null);
  const activeWrite = useRef<{ store: typeof operationStore; source: ConfigurationSource; token: object } | null>(null);
  const editorOwner = useRef<{ api: PageProps['api']; category: ConfigurationCategory; epoch: number } | null>(null);
  const connection = useRef({ api, connected, category });
  connection.current = { api, connected, category };
  const dirtyCallback = useRef(setDirty);
  dirtyCallback.current = setDirty;

  function hasCurrentEditor(): boolean {
    return connection.current.connected && connection.current.api === api && connection.current.category === category
      && editorOwner.current?.api === api && editorOwner.current.category === category && editorOwner.current.epoch === epoch.current;
  }

  function detachWrite(): void {
    const active = activeWrite.current;
    if (active && active.store.getSnapshot()[active.source]?.phase === 'pending') active.store.block(active.source, active.token, 'unknown');
    activeWrite.current = null;
  }

  useEffect(() => {
    if (hasCurrentEditor()) {
      const publicState = publicEditorState(editor);
      retainDraft(api, editorDraftKeys[category], publicState.dirtyKeys.size > 0 ? publicState : null);
    }
    setDirty(editor.dirtyKeys.size > 0, dirtyScope);
  }, [api, category, dirtyScope, editor, setDirty]);

  useEffect(() => () => { epoch.current++; writeController.current?.abort(); dirtyCallback.current(false, dirtyScope); }, [dirtyScope]);

  useEffect(() => {
    const generation = ++epoch.current;
    const controller = new AbortController();
    detachWrite();
    if (editorOwner.current) operationStore.invalidateReviews(editorOwner.current);
    readController.current?.abort(); readController.current = null;
    writeController.current?.abort(); writeController.current = null;
    editorOwner.current = null;
    const current = () => !controller.signal.aborted && generation === epoch.current
      && connection.current.api === api && connection.current.category === category && connection.current.connected;
    const retained = connected ? retainedDraft(api, editorDraftKeys[category]) : undefined;
    setEditor(retained ?? stateFromGroups([]));
    setFieldErrors({});
    setStructuredVersions({});
    setStructuredEpoch(value => value + 1);
    setCapabilities({ apply: false });
    setSavingGroup(null); setApplyingSource(null); setCheckingSource(null); setPendingSources(new Set());
    setGroupStatuses({}); setSourceStatuses({}); setLoadError(''); setLoading(connected);
    if (!connected) {
      return () => { controller.abort(); epoch.current++; };
    }
    void readResource(api, '/api/configuration', controller.signal).then(result => {
      if (!current()) return;
      const configuration = parseConfiguration(result);
      const groups = configuration.groups.filter(group => group.category === category && (category !== 'settings' || group.source === 'admin'));
      editorOwner.current = { api, category, epoch: generation };
      setEditor(retained && retained.groups.every(group => category !== 'settings' || group.source === 'admin') ? retained : stateFromGroups(groups));
      setFieldErrors({});
      setStructuredVersions({});
      setStructuredEpoch(current => current + 1);
      setCapabilities(configuration.capabilities);
    }).catch(error => {
      if (current()) setLoadError(unavailableMessage(error) ?? errorMessage(error));
    }).finally(() => {
      if (current()) setLoading(false);
    });
    return () => { controller.abort(); epoch.current++; writeController.current?.abort(); readController.current?.abort(); detachWrite(); if (editorOwner.current) operationStore.invalidateReviews(editorOwner.current); };
  }, [api, category, connected, operationStore]);

  function updateField(group: ConfigurationGroup, field: ConfigurationField, value: DraftValue): void {
    if (!hasCurrentEditor()) return;
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
    if (!hasCurrentEditor()) return;
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
    if (!hasCurrentEditor() || writeController.current) return;
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
    if (!hasCurrentEditor() || writeController.current || readController.current || operationStore.getSnapshot()[group.source] || loading) return;
    const changes: Record<string, JsonValue> = {};
    const completedKeys = new Set<string>();
    for (const field of group.fields) {
      const key = fieldKey(group.id, field.id);
      if (!editor.dirtyKeys.has(key)) continue;
      if (fieldErrors[key]) {
        setGroupStatuses(current => ({ ...current, [group.id]: { text: `请检查“${field.label}”：${fieldErrors[key]}`, tone: 'warning' } }));
        return;
      }
      const value = serializedDraft(field, readConfigurationDraft(editor.drafts, key, initialDraft(field)));
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

    const token = operationStore.begin(group.source, group.revision, 'save');
    if (!token) return;
    activeWrite.current = { store: operationStore, source: group.source, token };
    const controller = new AbortController();
    const generation = epoch.current;
    writeController.current = controller;
    const current = () => !controller.signal.aborted && writeController.current === controller
      && generation === epoch.current && hasCurrentEditor();

    setSavingGroup(group.id);
    setGroupStatuses(current => ({ ...current, [group.id]: { text: '正在保存更改', tone: 'neutral' } }));
    setSourceStatuses(current => {
      const next = { ...current };
      delete next[group.source];
      return next;
    });
    try {
      const result = asRecord(await writeResource(api, '/api/configuration', { source: group.source, revision: group.revision, changes }, controller.signal));
      if (!current() || operationStore.getSnapshot()[group.source]?.token !== token
        || operationStore.getSnapshot()[group.source]?.phase !== 'pending') return;
      if (result.ok !== true || typeof result.revision !== 'string') throw new Error('save_result_unknown');
      operationStore.complete(group.source, token);
      const applyRequired = result.applyRequired === true || result.restartRequired === true;
      if (applyRequired) setPendingSources(current => new Set(current).add(group.source));
      try {
        const refreshed = parseConfiguration(await readResource(api, '/api/configuration', controller.signal));
        if (!current()) return;
        const groups = refreshed.groups.filter(item => item.category === category && (category !== 'settings' || item.source === 'admin'));
        setEditor(current => reconcileState(current, groups, completedKeys));
        setCapabilities(refreshed.capabilities);
        setGroupStatuses(current => ({ ...current, [group.id]: { text: applyRequired ? '已保存，等待应用' : '设置已保存', tone: applyRequired ? 'warning' : 'success' } }));
      } catch {
        if (!current()) return;
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
      if (!current()) return;
      const unknown = error instanceof Error && error.message === 'save_result_unknown';
      if (unknown || !(error instanceof ApiError) || error.status === 409 || error.status >= 500 || /unknown/.test(error.code)) {
        operationStore.block(group.source, token, error instanceof ApiError && error.status === 409 ? 'conflict' : 'unknown');
      } else operationStore.complete(group.source, token);
      setGroupStatuses(current => ({ ...current, [group.id]: { text: unknown ? '保存结果待确认，请刷新后查看。' : errorMessage(error), tone: 'warning' } }));
    } finally {
      if (operationStore.getSnapshot()[group.source]?.phase === 'pending') operationStore.block(group.source, token, 'unknown');
      if (activeWrite.current?.token === token) activeWrite.current = null;
      if (current()) setSavingGroup(null);
      if (writeController.current === controller) writeController.current = null;
    }
  }

  async function applyGroup(group: ConfigurationGroup): Promise<void> {
    if (!hasCurrentEditor() || writeController.current || readController.current || loading || savingGroup !== null || applyingSource !== null || editor.groups.some(item => item.source === group.source
      && item.fields.some(field => editor.dirtyKeys.has(fieldKey(item.id, field.id))))) return;
    const token = operationStore.begin(group.source, group.revision);
    if (!token) return;
    activeWrite.current = { store: operationStore, source: group.source, token };
    const controller = new AbortController();
    const generation = epoch.current;
    writeController.current = controller;
    const current = () => !controller.signal.aborted && writeController.current === controller
      && generation === epoch.current && hasCurrentEditor();
    setApplyingSource(group.source);
    setGroupStatuses(current => {
      const next = { ...current };
      for (const item of editor.groups) if (item.source === group.source) delete next[item.id];
      return next;
    });
    setSourceStatuses(current => ({ ...current, [group.source]: { text: '正在应用更改', tone: 'neutral' } }));
    try {
      const result = await writeResource(api, '/api/configuration/apply', { source: group.source, revision: group.revision }, controller.signal);
      if (!current()) return;
      const outcome = configurationApplyOutcome(result, group.source, group.revision);
      if (outcome === 'applied') {
        operationStore.complete(group.source, token);
        setPendingSources(current => {
          const next = new Set(current);
          next.delete(group.source);
          return next;
        });
        setSourceStatuses(current => ({ ...current, [group.source]: { text: '配置应用流程已完成', tone: 'success' } }));
        return;
      }
      if (outcome === 'accepted') {
        operationStore.block(group.source, token, 'accepted');
        setSourceStatuses(current => ({ ...current, [group.source]: { text: '重启请求已提交，仍需核对实际服务。', tone: 'warning' } }));
        return;
      }
      operationStore.block(group.source, token, 'unknown');
      setSourceStatuses(current => ({ ...current, [group.source]: { text: '应用结果待确认，保存和应用已冻结。', tone: 'warning' } }));
    } catch (error) {
      if (!current()) return;
      operationStore.block(group.source, token, error instanceof ApiError && error.status === 409 ? 'conflict' : 'unknown');
      setSourceStatuses(current => ({ ...current, [group.source]: { text: errorMessage(error), tone: 'warning' } }));
    } finally {
      if (operationStore.getSnapshot()[group.source]?.phase === 'pending') operationStore.block(group.source, token, 'unknown');
      if (activeWrite.current?.token === token) activeWrite.current = null;
      if (current()) setApplyingSource(null);
      if (writeController.current === controller) writeController.current = null;
    }
  }

  async function rereadSource(source: ConfigurationSource, token: object): Promise<void> {
    const block = operationStore.getSnapshot()[source];
    const owner = editorOwner.current;
    if (!hasCurrentEditor() || !owner || !block || block.token !== token || block.phase !== 'blocked' || writeController.current || readController.current) return;
    operationStore.review(source, block.token, null);
    const controller = new AbortController();
    readController.current = controller;
    const generation = epoch.current;
    const ownsRead = () => !controller.signal.aborted && readController.current === controller
      && generation === epoch.current && editorOwner.current === owner && hasCurrentEditor();
    const current = () => ownsRead() && operationStore.getSnapshot()[source]?.token === token
      && operationStore.getSnapshot()[source]?.phase === 'blocked';
    setCheckingSource(source);
    try {
      const refreshed = parseConfiguration(await readResource(api, '/api/configuration', controller.signal));
      if (!current()) return;
      const groups = refreshed.groups.filter(group => group.source === source && group.category === category && (category !== 'settings' || group.source === 'admin'));
      const expected = editor.groups.filter(group => group.source === source);
      if (new Set(groups.map(group => group.id)).size !== groups.length
        || groups.some(group => new Set(group.fields.map(field => field.id)).size !== group.fields.length)
        || !expected.every(group => groups.some(candidate => candidate.id === group.id && /^[a-f0-9]{64}$/.test(candidate.revision)
        && group.fields.every(field => candidate.fields.some(item => item.id === field.id))))) throw new Error('configuration_read_unverified');
      setEditor(current => reconcileState(current, current.groups.map(group => group.source === source
        ? groups.find(candidate => candidate.id === group.id) ?? group : group), new Set()));
      setCapabilities(refreshed.capabilities);
      operationStore.review(source, block.token, owner);
      setSourceStatuses(current => ({ ...current, [source]: { text: '已重新读取配置并保留草稿；这不能证明服务应用或重启已完成。', tone: 'warning' } }));
    } catch {
      if (current()) setSourceStatuses(current => ({ ...current, [source]: { text: '重新读取失败，仍保持冻结并保留草稿。', tone: 'warning' } }));
    } finally {
      if (ownsRead()) setCheckingSource(null);
      if (readController.current === controller) readController.current = null;
    }
  }

  function acknowledgeSource(source: ConfigurationSource, token: object, owner: object | null): void {
    const block = operationStore.getSnapshot()[source];
    if (!hasCurrentEditor() || !owner || editorOwner.current !== owner || !block || block.token !== token || writeController.current || readController.current) return;
    if (operationStore.release(source, block.token, owner)) {
      setSourceStatuses(current => ({ ...current, [source]: { text: '已记录人工核对；如需保存或应用，请明确发起新的操作。', tone: 'neutral' } }));
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
    values: visibilityValues,
    dirtyFieldIds,
    showInactive
  }), [dirtyFieldIds, editor.groups, showInactive, visibilityValues]);
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
  if (loading || !loadError && !hasCurrentEditor()) return <div className="panel flex min-h-32 items-center justify-center gap-2 text-xs text-muted-foreground" role="status"><LoaderCircle className="size-4 animate-spin" />正在读取设置</div>;
  if (loadError) return <Section title="配置暂不可用"><EmptyState title="无法读取当前设置" description={loadError} action={<Button variant="outline" onClick={() => location.reload()}>重新加载页面</Button>} /></Section>;
  if (editor.groups.length === 0) return null;

  return <div className="grid gap-3">
    {category === 'features' && <div className="flex flex-wrap items-center gap-3">
      {category === 'features' && <label className="flex items-center gap-2 text-xs text-muted-foreground"><Switch size="sm" checked={showInactive} onCheckedChange={setShowInactive} aria-label="显示停用配置" /><span>显示停用配置</span></label>}
      {category === 'features' && (featureSummary.enabled > 0 || featureSummary.disabled > 0) && <div className="flex items-center gap-2" aria-label="功能状态摘要"><StatusPill tone="success">配置开启 {featureSummary.enabled} 项</StatusPill><StatusPill tone="neutral">配置关闭 {featureSummary.disabled} 项</StatusPill></div>}
    </div>}
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
      const block = sourceBlocks[group.source];
      const recoveryOwner = editorOwner.current;
      const status = groupStatuses[group.id] ?? sourceStatuses[group.source];
      const busy = savingGroup !== null || applyingSource !== null;
      const message = block?.phase === 'blocked' ? '此配置来源的保存和应用已冻结，请先核对实际服务。'
        : status?.text ?? (groupDirty ? `${dirtyCount} 项更改尚未保存` : pending ? (capabilities.apply ? '已保存，等待应用' : '已保存，需要稍后重启服务') : '已读取保存的配置');
      return <Section scrollable key={group.id} className={groupVisible ? undefined : 'hidden'} title={group.title} actions={<>{group.description && <HelpTip label={group.title}>{group.description}</HelpTip>}{status && <StatusPill tone={status.tone}>{status.text}</StatusPill>}</>} footer={<SaveBar dirty={groupDirty} disabled={busy || groupInvalid || Boolean(block) || checkingSource !== null} saving={savingGroup === group.id} message={message} label="保存本组" onSave={() => void saveGroup(group)} onReset={() => resetGroup(group)}>{capabilities.apply && group.applyLabel && <Button variant="outline" disabled={busy || sourceDirty || Boolean(block) || checkingSource !== null} onClick={() => void applyGroup(group)}>{applyingSource === group.source ? <LoaderCircle className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}{applyingSource === group.source ? '正在应用' : group.applyLabel ?? '应用更改'}</Button>}</SaveBar>}>
        {block?.phase === 'blocked' && editor.groups.find(item => item.source === group.source && matchingGroups.has(item.id))?.id === group.id && <div className="mb-3 grid max-h-48 gap-2 overflow-y-auto rounded-md border border-amber-500/30 p-3 text-xs" role="status">
          <p>{block.reason === 'conflict' ? '配置存在冲突。' : block.reason === 'accepted' ? '重启请求已被接受，完成情况仍待核对。' : '旧操作结果无法确认。'}请先核对实际服务和旧操作是否已结束；配置读取相同不代表应用或重启已完成。</p>
          {sourceStatuses[group.source] && <p>{sourceStatuses[group.source]?.text}</p>}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={busy || checkingSource !== null} onClick={() => void rereadSource(group.source, block.token)}>{checkingSource === group.source ? '正在重新读取' : '重新读取并核对'}</Button>
            <Button variant="outline" size="sm" disabled={busy || checkingSource !== null || block.reviewedBy !== recoveryOwner} onClick={() => acknowledgeSource(group.source, block.token, recoveryOwner)}>确认旧操作已结束，允许新操作</Button>
          </div>
          <p>重新读取保留草稿；确认仅允许新的操作，不会自动保存、应用或重试。</p>
        </div>}
          {inactiveDirtyCount > 0 && <p className="mb-3 flex items-center gap-2 text-xs text-muted-foreground" role="status"><AlertCircle className="size-4 text-amber-600" />仍显示 {inactiveDirtyCount} 项受停用开关隐藏的草稿；保存只写入草稿值，不会开启父功能。</p>}
          <div className="grid gap-3 md:grid-cols-2">{group.fields.map(field => {
            const key = fieldKey(group.id, field.id);
            const fieldVisible = groupVisibility?.fieldIds.has(field.id) === true && (visibleFieldIds === null || visibleFieldIds?.has(field.id) === true);
            return <div key={field.id} className={fieldVisible ? 'contents' : 'hidden'}><FieldEditor field={field} draft={readConfigurationDraft(editor.drafts, key, initialDraft(field))} disabled={busy || field.editable === false} resetToken={`${structuredEpoch}:${structuredVersions[key] ?? 0}`} onChange={value => updateField(group, field, value)} onStructuredChange={state => updateStructuredField(group, field, state)} /></div>;
          })}</div>
          {group.fields.length === 0 && <div className="flex items-center gap-2 py-5 text-xs text-muted-foreground"><CircleOff className="size-4" />此分组没有可显示的设置</div>}
      </Section>;
    })}
    {(Object.values(groupStatuses).some(status => status.tone === 'warning') || Object.values(sourceStatuses).some(status => status?.tone === 'warning')) && <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status"><AlertCircle className="size-4" />结果待确认时不会自动重试或重复写入。</p>}
  </div>;
}

/** Package contributions expose only these controlled public fields; validators stay in the host. */
export function PackageConfigurationFieldEditor({ field, value, disabled, onChange }: {
  readonly field: import('../../src/contracts/package-configuration.ts').PackageConfigurationField;
  readonly value: boolean | string; readonly disabled: boolean; readonly onChange: (value: boolean | string) => void;
}) {
  if (field.kind === 'boolean') return <ToggleField label={field.label} description={field.description} checked={value === true} disabled={disabled} onChange={onChange} />;
  if (field.kind === 'integer') return <Field label={field.label} description={`${field.description}${field.unit ? `（${field.unit}）` : ''}`}><Input aria-label={field.label} type="number" min={field.minimum} max={field.maximum} step={1} disabled={disabled} value={typeof value === 'string' ? value : ''} onChange={event => onChange(event.target.value)} /></Field>;
  return <Field label={field.label} layout="stacked" description={`${field.description} 每行一项，最多 ${field.maximumEntries} 项，每项 ${field.maximumLength} 字符。`}><Textarea aria-label={field.label} disabled={disabled} value={typeof value === 'string' ? value : ''} onChange={event => onChange(event.target.value)} /></Field>;
}
