import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle, RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import { ConfigurationEditor } from '../components/configuration-editor.tsx';
import { ConnectPrompt, Field, PageHeading, SaveBar, Section, StatusPill } from '../components/management.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Textarea } from '../components/ui/textarea.tsx';
import { ApiError, asRecord, errorMessage } from '../lib/api.ts';
import type { PageProps } from '../lib/types.ts';

interface AccessValues {
  allow: { groups: number[]; private: number[] };
  deny: { groups: number[]; private: number[] };
  ownerQQ: number | null;
}

interface AccessState extends AccessValues {
  revision: string;
}

interface AccessForm {
  allowGroups: string;
  allowPrivate: string;
  denyGroups: string;
  denyPrivate: string;
  ownerQQ: string;
}

type AccessErrors = Partial<Record<keyof AccessForm, string>>;

function numberList(value: unknown): number[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'number'
    || !Number.isSafeInteger(item) || item <= 0)) throw new Error('invalid_access_response');
  return value as number[];
}

function parseAccess(value: unknown): AccessState {
  const root = asRecord(value);
  const allow = asRecord(root.allow);
  const deny = asRecord(root.deny);
  if (typeof root.revision !== 'string'
    || root.ownerQQ !== null && (typeof root.ownerQQ !== 'number'
      || !Number.isSafeInteger(root.ownerQQ) || root.ownerQQ <= 0)) {
    throw new Error('invalid_access_response');
  }
  return {
    revision: root.revision,
    allow: { groups: numberList(allow.groups), private: numberList(allow.private) },
    deny: { groups: numberList(deny.groups), private: numberList(deny.private) },
    ownerQQ: root.ownerQQ,
  };
}

function accessForm(values: AccessValues): AccessForm {
  return {
    allowGroups: values.allow.groups.join('\n'),
    allowPrivate: values.allow.private.join('\n'),
    denyGroups: values.deny.groups.join('\n'),
    denyPrivate: values.deny.private.join('\n'),
    ownerQQ: values.ownerQQ === null ? '' : String(values.ownerQQ),
  };
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameAccess(left: AccessValues, right: AccessValues): boolean {
  return sameNumbers(left.allow.groups, right.allow.groups)
    && sameNumbers(left.allow.private, right.allow.private)
    && sameNumbers(left.deny.groups, right.deny.groups)
    && sameNumbers(left.deny.private, right.deny.private)
    && left.ownerQQ === right.ownerQQ;
}

function parseIdentifiers(value: string, label: string): { values?: number[]; error?: string } {
  const normalized = value.trim();
  if (normalized === '') return { values: [] };
  const tokens = normalized.split(/[\s,]+/);
  const identifiers: number[] = [];
  for (const token of tokens) {
    if (!/^[1-9]\d*$/.test(token)) return { error: `${label}只能包含正整数，可用逗号、空格或换行分隔。` };
    const identifier = Number(token);
    if (!Number.isSafeInteger(identifier)) return { error: `${label}中有超出安全范围的号码。` };
    if (identifiers.includes(identifier)) return { error: `${label}中不能填写重复号码。` };
    identifiers.push(identifier);
  }
  if (identifiers.length > 1_000) return { error: `${label}最多填写 1000 个号码。` };
  return { values: identifiers };
}

function parseForm(form: AccessForm): { values?: AccessValues; errors: AccessErrors } {
  const fields = {
    allowGroups: parseIdentifiers(form.allowGroups, '允许群号'),
    allowPrivate: parseIdentifiers(form.allowPrivate, '允许私聊 QQ 号'),
    denyGroups: parseIdentifiers(form.denyGroups, '拒绝群号'),
    denyPrivate: parseIdentifiers(form.denyPrivate, '拒绝私聊 QQ 号'),
    ownerQQ: parseIdentifiers(form.ownerQQ, '管理员 QQ 号'),
  };
  const errors = Object.fromEntries(Object.entries(fields)
    .filter(([, result]) => result.error !== undefined)
    .map(([key, result]) => [key, result.error])) as AccessErrors;
  if (!errors.ownerQQ && (fields.ownerQQ.values?.length ?? 0) > 1) {
    errors.ownerQQ = '管理员只能填写一个 QQ 号。';
  }
  if (Object.keys(errors).length > 0) return { errors };
  return {
    errors,
    values: {
      allow: { groups: fields.allowGroups.values!, private: fields.allowPrivate.values! },
      deny: { groups: fields.denyGroups.values!, private: fields.denyPrivate.values! },
      ownerQQ: fields.ownerQQ.values![0] ?? null,
    },
  };
}

function accessError(error: unknown): string {
  if (error instanceof ApiError && error.code === 'access_sync_failed') {
    return '访问范围未能同步到网关，旧设置没有保存。';
  }
  if (error instanceof ApiError && error.code === 'access_sync_required') {
    return '当前未启用网关同步，不能保存访问范围。';
  }
  return errorMessage(error);
}

export function AccessPage(props: PageProps) {
  const { api, connected, connect, setDirty } = props;
  const chatManagement = asRecord(props.snapshot.integrations).chatManagement !== false;
  const [access, setAccess] = useState<AccessState | null>(null);
  const [form, setForm] = useState<AccessForm | null>(null);
  const [errors, setErrors] = useState<AccessErrors>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [configurationDirty, setConfigurationDirty] = useState(false);

  const loadAccess = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const next = parseAccess(await api.get('/api/legacy/access', signal));
    setAccess(next);
    setForm(accessForm(next));
    setErrors({});
    setLoadError('');
  }, [api]);

  useEffect(() => {
    if (!connected || !chatManagement) {
      setAccess(null);
      setForm(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    void loadAccess(controller.signal).catch(error => {
      if (!controller.signal.aborted) setLoadError(accessError(error));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [chatManagement, connected, loadAccess]);

  const parsedForm = form === null ? null : parseForm(form);
  const dirty = access !== null && form !== null
    && (parsedForm?.values === undefined || !sameAccess(parsedForm.values, access));
  useEffect(() => setDirty(dirty || configurationDirty), [configurationDirty, dirty, setDirty]);
  useEffect(() => () => setDirty(false), [setDirty]);

  function update<Key extends keyof AccessForm>(key: Key, value: AccessForm[Key]): void {
    setForm(current => current ? { ...current, [key]: value } : current);
    setErrors(current => ({ ...current, [key]: undefined }));
  }

  function reset(): void {
    if (!access) return;
    setForm(accessForm(access));
    setErrors({});
  }

  async function save(): Promise<void> {
    if (!access || !form || !dirty || saving) return;
    const parsed = parsedForm ?? parseForm(form);
    setErrors(parsed.errors);
    if (!parsed.values) {
      toast.error('请先修正访问范围中的号码。');
      return;
    }
    setSaving(true);
    try {
      const next = parseAccess(await api.post('/api/legacy/access', {
        revision: access.revision,
        ...parsed.values,
      }));
      setAccess(next);
      setForm(accessForm(next));
      toast.success('访问范围已同步到网关并保存。');
    } catch (error) {
      toast.error(accessError(error));
    } finally {
      setSaving(false);
    }
  }

  let content;
  if (!connected) {
    content = <ConnectPrompt connect={connect} />;
  } else if (!chatManagement) {
    content = <Section title="消息网关访问范围" description="当前未接入聊天宿主。以下允许范围只约束网关出站，不创建聊天入站或管理员 QQ 身份。" />;
  } else if (loading && !access) {
    content = <Section title="正在读取访问范围"><div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在连接聊天服务</div></Section>;
  } else if (loadError || !access || !form) {
    content = <Section title="暂时无法读取访问范围" description={loadError || '服务返回了无法识别的内容。'}><Button variant="outline" onClick={() => { setLoading(true); void loadAccess().catch(error => setLoadError(accessError(error))).finally(() => setLoading(false)); }}><RotateCw className="size-4" />重新读取</Button></Section>;
  } else {
    const allowEmpty = parsedForm?.values !== undefined
      && parsedForm.values.allow.groups.length === 0 && parsedForm.values.allow.private.length === 0;
    content = <>
      {allowEmpty && <div className="flex items-start gap-3 rounded-lg border p-4"><StatusPill tone="warning">全部拒绝</StatusPill><p className="text-xs leading-6 text-muted-foreground">允许名单为空，所有群聊和私聊都会被拒绝。</p></div>}
      <Section title="允许访问" description="只有允许名单中的群聊和私聊可以与机器人对话；两个名单都为空时全部拒绝。">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="允许的群号" description="可用逗号、空格或换行分隔；只接受正整数。" error={errors.allowGroups}><Textarea rows={6} value={form.allowGroups} disabled={saving} onChange={event => update('allowGroups', event.target.value)} placeholder={'123456789\n987654321'} /></Field>
          <Field label="允许私聊的 QQ 号" description="可用逗号、空格或换行分隔；只接受正整数。" error={errors.allowPrivate}><Textarea rows={6} value={form.allowPrivate} disabled={saving} onChange={event => update('allowPrivate', event.target.value)} placeholder={'123456789\n987654321'} /></Field>
        </div>
      </Section>
      <Section title="拒绝访问" description="拒绝名单用于排除特定群聊或私聊，命中时不允许访问。">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="拒绝的群号" description="可用逗号、空格或换行分隔；只接受正整数。" error={errors.denyGroups}><Textarea rows={6} value={form.denyGroups} disabled={saving} onChange={event => update('denyGroups', event.target.value)} placeholder="留空表示不额外拒绝群聊" /></Field>
          <Field label="拒绝私聊的 QQ 号" description="可用逗号、空格或换行分隔；只接受正整数。" error={errors.denyPrivate}><Textarea rows={6} value={form.denyPrivate} disabled={saving} onChange={event => update('denyPrivate', event.target.value)} placeholder="留空表示不额外拒绝私聊" /></Field>
        </div>
      </Section>
      <Section title="管理员" description="管理员 QQ 号拥有管理权限；显示昵称、群名片或备注不会获得授权。" footer={<SaveBar dirty={dirty} saving={saving} message="修改允许范围后会更新发送授权；已开启的发送额度将重新计数。" onSave={() => void save()} onReset={reset} label="保存访问范围" />}>
        <Field label="管理员 QQ 号" description="仅可填写一个正整数 QQ 号；留空表示不指定管理员。" error={errors.ownerQQ} className="max-w-md"><Input inputMode="numeric" value={form.ownerQQ} disabled={saving} onChange={event => update('ownerQQ', event.target.value)} placeholder="留空表示不指定" /></Field>
      </Section>
    </>;
  }

  return <div className="page-stack" data-page="access">
    <PageHeading title="访问范围" description="设置可对话的群聊、私聊与管理员账号。保存时会先同步网关，再更新已接入的聊天服务。" />
    {content}
    {connected && <ConfigurationEditor category="access" {...props} setDirty={setConfigurationDirty} />}
  </div>;
}
