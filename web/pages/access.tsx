import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw, ShieldCheck, ShieldX } from 'lucide-react';
import { ApiError, asRecord, errorMessage } from '../lib/api.ts';
import type { PageProps } from '../lib/types.ts';
import { ConnectPrompt, Field, PageHeading, SaveBar, Section, StatusPill } from '../components/management.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Textarea } from '../components/ui/textarea.tsx';

interface AccessState {
  readonly revision: string;
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly owner: string | null;
}

interface AccessForm {
  readonly allow: string;
  readonly deny: string;
  readonly owner: string;
}

type SaveState = 'idle' | 'saved' | 'busy' | 'conflict' | 'unknown';

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !/^(?:group|private):[1-9][0-9]{0,19}$/.test(item))) return null;
  const result = value as string[];
  return new Set(result).size === result.length ? result : null;
}

function parseAccess(value: unknown): AccessState | null {
  const record = asRecord(value);
  const allow = stringList(record.allow);
  const deny = stringList(record.deny);
  if (typeof record.revision !== 'string' || !allow || !deny
    || record.owner !== null && (typeof record.owner !== 'string' || !/^[1-9][0-9]{0,19}$/.test(record.owner))
    || allow.some(entry => deny.includes(entry))) return null;
  return { revision: record.revision, allow, deny, owner: record.owner as string | null };
}

function toForm(access: AccessState): AccessForm {
  return { allow: access.allow.join('\n'), deny: access.deny.join('\n'), owner: access.owner ?? '' };
}

function parseEntries(value: string): { values?: string[]; error?: string } {
  const values = value.split(/[\n,]+/).map(item => item.trim()).filter(Boolean);
  if (values.some(item => !/^(?:group|private):[1-9][0-9]{0,19}$/.test(item))) return { error: '授权项必须是 group:群号 或 private:用户号，号码为 1–20 位正整数。' };
  if (values.length > 1_024) return { error: '单个名单最多包含 1024 个授权标识。' };
  if (new Set(values).size !== values.length) return { error: '同一名单中不能填写重复授权项。' };
  return { values };
}

function sameAccess(access: AccessState, form: AccessForm): boolean {
  const allow = parseEntries(form.allow).values;
  const deny = parseEntries(form.deny).values;
  if (!allow || !deny) return false;
  const owner = form.owner.trim() || null;
  return owner === access.owner && allow.length === access.allow.length && deny.length === access.deny.length
    && allow.every((value, index) => value === access.allow[index])
    && deny.every((value, index) => value === access.deny[index]);
}

function saveState(error: unknown): SaveState {
  if (error instanceof ApiError && error.code === 'chat_storage_busy') return 'busy';
  if (error instanceof ApiError && (error.status === 409 || /conflict|revision/.test(error.code))) return 'conflict';
  if (error instanceof ApiError && (error.status >= 500 || /unknown/.test(error.code))) return 'unknown';
  return 'idle';
}

function saveMessage(state: SaveState, dirty: boolean): string {
  if (state === 'saved') return '原生访问授权已保存。';
  if (state === 'busy') return '另一项保存正在进行，请稍后重新载入后再提交；不会自动重试。';
  if (state === 'conflict') return '授权目录已在其他窗口更新，请重新载入。';
  if (state === 'unknown') return '无法确认保存结果，请重新载入核对；不会自动重试。';
  return dirty ? '授权更改尚未保存。' : '当前授权与已保存目录一致。';
}

export function AccessPage({ api, connected, connect, setDirty }: PageProps) {
  const [access, setAccess] = useState<AccessState | null>(null);
  const [form, setForm] = useState<AccessForm | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [writeError, setWriteError] = useState('');
  const [validationError, setValidationError] = useState('');
  const [result, setResult] = useState<SaveState>('idle');
  const [reloadVersion, setReloadVersion] = useState(0);
  const reportedDirty = useRef(false);
  const setDirtyRef = useRef(setDirty);
  const dirty = access !== null && form !== null && !sameAccess(access, form);

  useEffect(() => { setDirtyRef.current = setDirty; }, [setDirty]);
  useEffect(() => {
    if (reportedDirty.current === dirty) return;
    reportedDirty.current = dirty;
    setDirty(dirty, 'chat-access');
  }, [dirty, setDirty]);
  useEffect(() => () => {
    reportedDirty.current = false;
    setDirtyRef.current(false, 'chat-access');
  }, []);

  useEffect(() => {
    if (!connected) {
      setAccess(null);
      setForm(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    setWriteError('');
    setResult('idle');
    void api.get('/api/chat/access', controller.signal).then(value => {
      const next = parseAccess(value);
      if (!next) throw new Error('invalid_access_response');
      setAccess(next);
      setForm(toForm(next));
    }).catch(error => {
      if (!controller.signal.aborted) {
        setAccess(null);
        setForm(null);
        setLoadError(errorMessage(error));
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [api, connected, reloadVersion]);

  function update(key: keyof AccessForm, value: string): void {
    setForm(current => current ? { ...current, [key]: value } : current);
    setValidationError('');
    setWriteError('');
    setResult('idle');
  }

  function reset(): void {
    if (access) setForm(toForm(access));
    setValidationError('');
    setWriteError('');
    setResult('idle');
  }

  async function save(): Promise<void> {
    if (!access || !form || !dirty || saving) return;
    const allow = parseEntries(form.allow);
    const deny = parseEntries(form.deny);
    if (!allow.values || !deny.values) {
      setValidationError(allow.error ?? deny.error ?? '请检查授权项。');
      return;
    }
    if (allow.values.some(entry => deny.values!.includes(entry))) {
      setValidationError('同一主体不能同时出现在允许和拒绝名单中。');
      return;
    }
    const owner = form.owner.trim() || null;
    if (owner !== null && !/^[1-9][0-9]{0,19}$/.test(owner)) {
      setValidationError('所有者必须是 1–20 位十进制用户号，不包含 private: 前缀。');
      return;
    }
    setSaving(true);
    setWriteError('');
    setResult('idle');
    try {
      const next = parseAccess(await api.post('/api/chat/access', {
        revision: access.revision,
        allow: allow.values,
        deny: deny.values,
        owner,
      }));
      if (!next) throw new Error('invalid_access_response');
      setAccess(next);
      setForm(toForm(next));
      setResult('saved');
    } catch (error) {
      setResult(saveState(error));
      setWriteError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  if (!connected) return <div className="page-stack" data-page="access"><PageHeading title="访问范围" description="管理聊天入口的独立授权目录。" /><ConnectPrompt connect={connect} /></div>;

  return <div className="page-stack" data-page="access">
    <PageHeading title="访问范围" description="访问授权只决定谁可以进入原生聊天链路，不会创建人设、能力、偏好或模型权限。" actions={<Button variant="outline" onClick={() => setReloadVersion(version => version + 1)} disabled={loading || saving || dirty}><RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />重新载入</Button>} />
    {loading && !access ? <Section title="原生访问授权"><div className="flex min-h-44 items-center justify-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在读取授权目录</div></Section>
      : !access || !form ? <Section title="原生访问授权不可用" description={loadError || '服务没有返回可识别的授权目录。'}><div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs leading-6">暂时无法读取访问授权，请稍后重试。</div></Section>
        : <>
          {parseEntries(form.allow).values?.length === 0 && <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs leading-5"><ShieldX className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" /><p><strong>当前默认全部拒绝。</strong><span className="mt-1 block text-muted-foreground">允许名单为空时，没有会话主体可以进入原生聊天链路，也不会从其他系统继承名单。</span></p></div>}
          <Section title="授权目录" description="每行填写一个群聊或私聊；拒绝名单用于明确覆盖允许结果。" actions={<StatusPill tone={parseEntries(form.allow).values?.length ? 'success' : 'warning'}>{parseEntries(form.allow).values?.length ?? 0} 个允许主体</StatusPill>} footer={<SaveBar dirty={dirty} saving={saving} message={saveMessage(result, dirty)} onSave={() => void save()} onReset={reset} label="保存授权" />}>
            <div className="h-96 min-h-0 overflow-auto overscroll-contain pr-1"><div className="grid gap-5 sm:grid-cols-2">
              <Field label="允许名单" description="支持换行或逗号分隔，只接受 group:群号 和 private:用户号。"><Textarea value={form.allow} onChange={event => update('allow', event.target.value)} disabled={saving} className="h-72 resize-none font-mono text-xs leading-6" placeholder={'group:123456\nprivate:654321'} /></Field>
              <Field label="拒绝名单" description="显式拒绝项独立保存，格式与允许名单相同。"><Textarea value={form.deny} onChange={event => update('deny', event.target.value)} disabled={saving} className="h-72 resize-none font-mono text-xs leading-6" placeholder="group:999999" /></Field>
            </div>
            <div className="mt-5 grid gap-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"><Field label="所有者用户号" description="可留空；这里只填写十进制用户号，所有者身份本身不等于无限能力授权。"><Input value={form.owner} onChange={event => update('owner', event.target.value)} disabled={saving} inputMode="numeric" maxLength={20} placeholder="654321" /></Field><div className="flex h-9 items-center gap-2 text-xs text-muted-foreground"><ShieldCheck className="size-4" />独立授权层</div></div>
            {validationError && <p className="mt-4 text-xs text-destructive" role="alert">{validationError}</p>}
            {writeError && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive" role="alert"><span>{writeError}</span>{(result === 'busy' || result === 'conflict' || result === 'unknown') && <Button size="sm" variant="outline" onClick={() => setReloadVersion(version => version + 1)}>重新载入</Button>}</div>}
            </div>
          </Section>
        </>}
  </div>;
}
