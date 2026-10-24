import { useEffect, useRef, useState } from 'react';
import { Check, Eye, RefreshCw, Upload } from 'lucide-react';
import { asRecord, errorMessage, type ApiClient } from '../lib/api.ts';
import { chatRuntimeReason, parseChatRuntimeStatus } from '../lib/chat-runtime.ts';
import { Field, SaveBar, Section, ToggleField } from './management.tsx';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { Textarea } from './ui/textarea.tsx';

const efforts = ['off', 'low', 'medium', 'high', 'max'] as const;
const effortNames = { off: '关闭', low: '低', medium: '中', high: '高', max: '最高' } as const;
type Effort = typeof efforts[number];

interface DeploymentForm {
  readonly profilePath: string;
  readonly credentialsPath: string;
  readonly layerPaths: string;
  readonly namespace: string;
  readonly contextWindow: string;
  readonly maxTokens: string;
  readonly reasoning: boolean;
  readonly mapping: Readonly<Record<Effort, string>>;
}

interface DeploymentSnapshot { readonly revision: string; readonly form: DeploymentForm }
interface Preview { readonly revisions: Readonly<Record<string, string>>; readonly targetRevision: string | null; readonly ready: boolean; readonly reasons: readonly string[] }

function parseDeployment(value: unknown): DeploymentSnapshot | null {
  const root = asRecord(value);
  const deployment = asRecord(root.deployment);
  const target = asRecord(deployment.target);
  const settings = asRecord(deployment.modelSettings);
  const mapping = asRecord(settings.reasoningEfforts);
  if (typeof root.revision !== 'string' || !/^[a-f0-9]{64}$/.test(root.revision)
    || typeof deployment.namespace !== 'string'
    || deployment.target !== null && (typeof target.profilePath !== 'string' || typeof target.credentialsPath !== 'string'
      || target.layerPaths !== undefined && (!Array.isArray(target.layerPaths) || target.layerPaths.some(path => typeof path !== 'string')))
    || deployment.modelSettings !== null && (typeof settings.contextWindow !== 'number' || typeof settings.maxTokens !== 'number'
      || settings.reasoningEfforts !== false && !Object.entries(mapping).every(([key, wire]) => efforts.includes(key as Effort)
        && (typeof wire === 'string' || wire === null && key === 'off')))) return null;
  return { revision: root.revision, form: {
    profilePath: typeof target.profilePath === 'string' ? target.profilePath : '',
    credentialsPath: typeof target.credentialsPath === 'string' ? target.credentialsPath : '',
    layerPaths: Array.isArray(target.layerPaths) ? target.layerPaths.join('\n') : '', namespace: deployment.namespace,
    contextWindow: settings.contextWindow === undefined ? '' : String(settings.contextWindow),
    maxTokens: settings.maxTokens === undefined ? '' : String(settings.maxTokens),
    reasoning: settings.reasoningEfforts !== undefined && settings.reasoningEfforts !== false,
    mapping: Object.fromEntries(efforts.map(effort => [effort, typeof mapping[effort] === 'string' ? mapping[effort] : ''])) as Record<Effort, string>,
  } };
}

function payload(form: DeploymentForm): { readonly deployment?: Record<string, unknown>; readonly error?: string } {
  const profilePath = form.profilePath.trim();
  const credentialsPath = form.credentialsPath.trim();
  const layerPaths = form.layerPaths.split('\n').map(path => path.trim()).filter(Boolean);
  if ((profilePath !== '' || credentialsPath !== '') && (!profilePath.startsWith('/') || !credentialsPath.startsWith('/'))
    || layerPaths.some(path => !path.startsWith('/')) || layerPaths.length > 16
    || new Set(layerPaths).size !== layerPaths.length) return { error: '配置与凭据都需要明确填写服务器绝对路径；基础配置每行一个路径，最多 16 个且不能重复。' };
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(form.namespace.trim())) return { error: '配置名前缀需要 1–64 个英文、数字、短横线或下划线，以英文或数字开头。' };
  const capacity = Number(form.contextWindow);
  const output = Number(form.maxTokens);
  if ((form.contextWindow !== '' || form.maxTokens !== '')
    && (!/^\d+$/.test(form.contextWindow) || !/^\d+$/.test(form.maxTokens)
      || !Number.isSafeInteger(capacity) || capacity <= 0 || capacity > 16_777_216
      || !Number.isSafeInteger(output) || output <= 0 || output >= capacity)) return { error: '模型容量和最大输出必须是正整数，最大输出小于容量；不要超过模型实际支持的范围。' };
  const reasoningEfforts = form.reasoning ? Object.fromEntries(efforts.filter(effort => effort === 'off'
    || form.mapping[effort].trim() !== '').map(effort => [effort, form.mapping[effort].trim() || null])) : false;
  if (form.reasoning && !efforts.some(effort => effort !== 'off' && form.mapping[effort].trim() !== '')) {
    return { error: '请至少填写一个实际支持的推理档位；不支持推理档位的模型请关闭此选项。' };
  }
  return { deployment: {
    target: profilePath === '' ? null : { profilePath, credentialsPath, schemaVersion: '0.2.1-rc.2', ...(layerPaths.length ? { layerPaths } : {}) },
    modelSettings: form.contextWindow === '' ? null : { contextWindow: capacity, maxTokens: output, reasoningEfforts },
    namespace: form.namespace.trim(),
  } };
}

export function DshDeploymentManager({ api, connected, setDirty, running = false }: {
  readonly api: ApiClient; readonly connected: boolean; readonly running?: boolean; setDirty(value: boolean, scope?: string): void;
}) {
  const [saved, setSaved] = useState<DeploymentSnapshot | null>(null);
  const [form, setForm] = useState<DeploymentForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [reload, setReload] = useState(0);
  const request = useRef<AbortController | null>(null);
  const dirtyCallback = useRef(setDirty);
  const dirty = saved !== null && form !== null && JSON.stringify(saved.form) !== JSON.stringify(form);
  useEffect(() => { dirtyCallback.current = setDirty; }, [setDirty]);
  useEffect(() => { setDirty(dirty, 'dsh-deployment'); }, [dirty, setDirty]);
  useEffect(() => () => { request.current?.abort(); dirtyCallback.current(false, 'dsh-deployment'); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setSaved(null); setForm(null); setPreview(null); setConfirmed(false); setError(''); setBlocked(false); setBusy(connected);
    if (!connected) return () => controller.abort();
    void api.get('/api/chat/deployment', controller.signal).then(value => {
      const next = parseDeployment(value);
      if (!next) throw new Error('invalid_deployment');
      if (!controller.signal.aborted) { setSaved(next); setForm(next.form); }
    }).catch(failure => { if (!controller.signal.aborted) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => { controller.abort(); request.current?.abort(); };
  }, [api, connected, reload]);

  function update(patch: Partial<DeploymentForm>): void {
    setForm(current => current ? { ...current, ...patch } : current);
    setPreview(null); setConfirmed(false); setError(''); setNotice('');
  }

  async function perform(operation: 'save' | 'prepare' | 'reconcile' | 'apply'): Promise<void> {
    if (!saved || !form || busy || blocked || request.current || operation !== 'save' && dirty
      || operation === 'apply' && (!preview?.ready || !confirmed)) return;
    if (operation === 'apply' && running) { setError('请先停止聊天，再应用引擎配置。'); return; }
    const input = payload(form);
    if (input.error) { setError(input.error); return; }
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(''); setNotice('');
    try {
      if (operation === 'save') {
        const next = parseDeployment(await api.post('/api/chat/deployment', { revision: saved.revision, ...input }, controller.signal));
        if (!next) throw new Error('invalid_deployment');
        if (!controller.signal.aborted) { setSaved(next); setForm(next.form); setPreview(null); setNotice('应用设置已保存，尚未修改 DSH。下一步预览变更。'); }
      } else {
        const runtime = parseChatRuntimeStatus(await api.get('/api/chat/runtime', controller.signal));
        if (!runtime || runtime.revisions.deployment !== saved.revision) throw new Error('deployment_revision_changed');
        if (operation === 'apply' && !runtime.canApplyDeployment) {
          setError('聊天处理尚未完全停止或另一项操作仍在进行，请先停止并重新检查状态。');
          return;
        }
        if (operation === 'apply' && Object.keys(runtime.revisions).some(key => preview?.revisions[key] !== runtime.revisions[key])) {
          setPreview(null); setConfirmed(false); setError('设置已变化，请重新预览后再应用。'); return;
        }
        const response = asRecord(await api.post(`/api/chat/deployment/${operation}`, {
          revisions: operation === 'apply' ? preview?.revisions : runtime.revisions,
          ...(operation === 'apply' ? { targetRevision: preview?.targetRevision } : {}),
        }, controller.signal));
        if (controller.signal.aborted) return;
        const summary = asRecord(response.summary ?? response);
        const reasons = Array.isArray(summary.missingReasons) ? summary.missingReasons.filter((reason): reason is string => typeof reason === 'string') : [];
        if (operation === 'prepare') {
          const targetRevision = typeof response.targetRevision === 'string' && /^[a-f0-9]{64}$/.test(response.targetRevision) ? response.targetRevision : null;
          if (summary.ready === true && targetRevision === null) throw new Error('invalid_deployment_preview');
          setPreview({ revisions: runtime.revisions, targetRevision, ready: summary.ready === true && targetRevision !== null, reasons });
          setConfirmed(false);
          setNotice(summary.ready === true ? '预览通过：将为群聊和私聊写入独立的模型路由与聊天预设，并保留私有备份。' : '预览未通过，请核对下方提示。');
        } else {
          setPreview(null); setConfirmed(false);
          setNotice(response.state === 'verified' || response.status === 'verified' || response.verified === true ? 'DSH 配置与托管凭据来源检查通过。'
            : response.state === 'pending_reload' || response.status === 'pending_reload' || reasons.includes('pending_reload') ? '配置已写入，等待 DSH 加载；不会擅自重启引擎。'
              : '检查完成；只有引擎实际加载并通过校验，聊天才能启动。');
          if (reasons.length > 0) setError([...new Set(reasons.map(reason => chatRuntimeReason(reason).text))].join(' '));
          if (response.state === 'unknown' || response.state === 'conflict') setBlocked(true);
        }
      }
    } catch (failure) {
      if (!controller.signal.aborted) { setError(`${errorMessage(failure)} 请重新读取核对，不会自动重试。`); setBlocked(true); setPreview(null); setConfirmed(false); }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (request.current === controller) request.current = null;
    }
  }

  if (!connected) return null;
  return <Section id="dsh-deployment" title="应用聊天设置到 DSH" description="网页里的方案、人设和模型目录需应用到引擎才能生效。这里只管理明确指定的配置文件，不自动搜索其他项目。" scrollable
    actions={<Button variant="outline" size="sm" disabled={busy || dirty && !blocked} onClick={() => setReload(value => value + 1)}><RefreshCw className="size-3.5" />重新读取</Button>}
    footer={<SaveBar dirty={dirty} saving={busy} disabled={blocked} onSave={() => void perform('save')} onReset={saved ? () => { setForm(saved.form); setPreview(null); setConfirmed(false); } : undefined} label="保存应用设置" message={notice || (dirty ? '更改尚未保存；保存本身不会修改引擎文件。' : '应用前会备份并校验文件版本。')} />}>
    {error && <p className="mb-4 text-xs leading-6 text-destructive" role="alert">{error}</p>}
    {!form ? <p role="status" className="text-xs text-muted-foreground">{busy ? '正在读取应用设置' : '暂时无法读取应用设置，请重试。'}</p> : <div className="grid gap-5">
      <p className="text-xs leading-5 text-muted-foreground">检查会核对配置、凭据引用及文件来源，不验证引擎内的实际密钥值、模型可用性或余额；使用结果以实际消息为准。</p>
      <div className="grid gap-4 sm:grid-cols-2"><Field label="DSH 配置文件" description="DSH 服务器上的 cordis.patch.yml 绝对路径。"><Input value={form.profilePath} disabled={busy || blocked} onChange={event => update({ profilePath: event.target.value })} placeholder="/srv/dsh/profiles/chat/cordis.patch.yml" /></Field><Field label="DSH 凭据文件" description="服务器上 .credentials.yaml 的绝对路径；只保存路径，不显示密钥内容。"><Input value={form.credentialsPath} disabled={busy || blocked} onChange={event => update({ credentialsPath: event.target.value })} placeholder="/srv/dsh/.credentials.yaml" /></Field></div>
      <div className="grid gap-4 sm:grid-cols-2"><Field label="模型上下文容量" description="填写模型实际支持的总容量；群聊、私聊设置不能超过它。"><Input type="number" min={1} max={16_777_216} value={form.contextWindow} disabled={busy || blocked} onChange={event => update({ contextWindow: event.target.value })} /></Field><Field label="模型最大输出" description="填写实际支持的最大输出 Token 数，小于群聊、私聊上下文。"><Input type="number" min={1} max={16_777_215} value={form.maxTokens} disabled={busy || blocked} onChange={event => update({ maxTokens: event.target.value })} /></Field></div>
      <ToggleField label="模型支持推理档位" description="关闭时只允许方案选择关闭推理；开启后按提供方文档填写对应值，不自动猜测。" checked={form.reasoning} disabled={busy || blocked} onChange={reasoning => update({ reasoning })} />
      {form.reasoning && <div className="grid gap-3 sm:grid-cols-2">{efforts.map(effort => <Field key={effort} label={`${effortNames[effort]}档位的接口值`} description={effort === 'off' ? '留空表示不传推理参数。' : '不支持此档位则留空。'}><Input value={form.mapping[effort]} maxLength={128} disabled={busy || blocked} onChange={event => update({ mapping: { ...form.mapping, [effort]: event.target.value } })} /></Field>)}</div>}
      <details><summary className="cursor-pointer text-xs text-muted-foreground">高级：基础配置与命名前缀</summary><div className="mt-4 grid gap-4"><Field label="基础配置文件（可选）" description="有继承配置时按加载顺序每行填写一个绝对路径；不包括上方目标文件。"><Textarea className="h-28 resize-none font-mono text-xs" value={form.layerPaths} disabled={busy || blocked} onChange={event => update({ layerPaths: event.target.value })} /></Field><Field label="生成配置名前缀" description="避免与其他 DSH 配置重名；不改变聊天人设。"><Input value={form.namespace} disabled={busy || blocked} onChange={event => update({ namespace: event.target.value })} /></Field></div></details>
      <div className="flex flex-wrap gap-2 border-t pt-4"><Button variant="outline" disabled={busy || blocked || dirty} onClick={() => void perform('prepare')}><Eye className="size-3.5" />预览变更</Button><Button variant="outline" disabled={busy || blocked || dirty} onClick={() => void perform('reconcile')}><Check className="size-3.5" />检查是否生效</Button></div>
      {preview && <div className="grid gap-3 rounded-lg border p-3 text-xs leading-6">{preview.reasons.length > 0 && <ul>{[...new Set(preview.reasons.map(reason => chatRuntimeReason(reason).text))].map(reason => <li key={reason}>{reason}</li>)}</ul>}{preview.ready && <><label className="flex items-start gap-2"><input type="checkbox" className="mt-1.5" checked={confirmed} disabled={busy || blocked || running} onChange={event => setConfirmed(event.target.checked)} /><span>确认应用当前方案、人设与模型设置到指定的 DSH 配置，并写入对应的提供方凭据。不会重置已有会话或重启 DSH。</span></label>{running && <p className="text-muted-foreground">请先停止聊天，再应用引擎配置。</p>}<Button disabled={!confirmed || busy || blocked || dirty || running} onClick={() => void perform('apply')}><Upload className="size-3.5" />备份并应用</Button></>}</div>}
    </div>}
  </Section>;
}
