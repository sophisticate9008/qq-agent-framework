import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { CHAT_INPUT_PACKAGE_ID, type ChatInputConfiguration } from '../../src/contracts/chat-input-configuration.ts';
import { PACKAGE_CONFIGURATION_PATH, type PackageConfigurationSnapshot } from '../../src/contracts/package-configuration.ts';
import { errorMessage } from '../lib/api.ts';
import { chatInputConfiguration, chatInputForm, parseChatInputSnapshot, type ChatInputForm } from '../lib/chat-input-ui.ts';
import { nativeFormMetadata } from '../lib/native-form-metadata.ts';
import { createDraftKey, retainDraft, retainedDraft } from '../lib/retained-drafts.ts';
import { writeResource } from '../lib/resource-reader.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import { useNativeCatalogOperation } from '../lib/use-native-catalog-operation.ts';
import type { PageProps } from '../lib/types.ts';
import { Field, SaveBar, Section, StatusPill, ToggleField } from './management.tsx';
import { NativeCatalogRecovery } from './native-catalog-recovery.tsx';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { Textarea } from './ui/textarea.tsx';

type Snapshot = PackageConfigurationSnapshot<ChatInputConfiguration>;
const draftKey = createDraftKey<{ readonly saved: Snapshot; readonly form: ChatInputForm }>('chat-input');
export function ChatInputSettings({ api, connected, setDirty }: Pick<PageProps, 'api' | 'connected' | 'setDirty'>) {
  const retained = useMemo(() => retainedDraft(api, draftKey), [api]);
  const recovery = useNativeCatalogOperation(api, 'chat-input');
  const resource = useReadResource(api, `${PACKAGE_CONFIGURATION_PATH}?id=${CHAT_INPUT_PACKAGE_ID}`, connected, parseChatInputSnapshot);
  const [saved, setSaved] = useState<Snapshot | null>(retained?.saved ?? null);
  const [form, setForm] = useState<ChatInputForm | null>(retained?.form ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const request = useRef<AbortController | null>(null);
  const owner = useRef(api);
  const connection = useRef({ api, connected }); connection.current = { api, connected };
  const dirty = saved !== null && form !== null && JSON.stringify(chatInputForm(saved.configuration)) !== JSON.stringify(form);
  const live = useRef({ saved, form, dirty }); live.current = { saved, form, dirty };
  const dirtyCallback = useRef(setDirty); dirtyCallback.current = setDirty;
  useEffect(() => {
    const next = retainedDraft(api, draftKey); owner.current = api;
    setSaved(next?.saved ?? null); setForm(next?.form ?? null); setSaving(false); setError(''); setNotice('');
    return () => { request.current?.abort(); request.current = null; dirtyCallback.current(false, 'chat-input'); };
  }, [api, connected]);
  useEffect(() => {
    if (!resource.snapshot || !resource.updatedAt || resource.loading || resource.error || owner.current !== api || !connected) return;
    setSaved(resource.snapshot);
    if (!live.current.dirty) setForm(chatInputForm(resource.snapshot.configuration));
    recovery.review();
  }, [api, connected, resource.snapshot, resource.updatedAt, resource.loading, resource.error]);
  useEffect(() => {
    if (owner.current !== api) return;
    retainDraft(api, draftKey, connected && dirty && saved && form ? { saved, form } : null);
    setDirty(dirty, 'chat-input');
  }, [api, connected, dirty, saved, form, setDirty]);
  const disabled = saving || resource.loading || recovery.blocked || !saved;
  function update(patch: Partial<ChatInputForm>): void {
    if (disabled || request.current) return;
    setForm(current => current ? { ...current, ...patch } : current); setError(''); setNotice('');
  }
  async function save(): Promise<void> {
    if (!saved || !form || !dirty || disabled || request.current || connection.current.api !== api || !connection.current.connected) return;
    const configuration = chatInputConfiguration(form);
    if (!configuration) { setError('请检查昵称（最多16个、不重复）、续聊期限（0–300秒）和规范会话标识（每类最多256项）。'); return; }
    const controller = new AbortController(); const token = recovery.begin(saved.revision, controller.signal);
    if (!token) return; request.current = controller; setSaving(true); setError(''); setNotice('');
    const current = () => !controller.signal.aborted && request.current === controller && connection.current.api === api && connection.current.connected;
    try {
      const parsed = parseChatInputSnapshot(await writeResource(api, PACKAGE_CONFIGURATION_PATH, { id: CHAT_INPUT_PACKAGE_ID, revision: saved.revision, configuration }, controller.signal));
      if (!current()) return;
      if (!parsed || JSON.stringify(parsed.configuration) !== JSON.stringify(configuration)) throw new Error('chat_input_save_unknown');
      recovery.complete(token); setSaved(parsed); setForm(chatInputForm(parsed.configuration)); setNotice('触发配置已保存，后续消息按当前配置处理；已受理任务不会重放。');
    } catch (failure) { recovery.fail(token, failure); if (current()) setError(errorMessage(failure)); }
    finally { if (current()) setSaving(false); if (request.current === controller) request.current = null; }
  }
  if (!connected) return null;
  const metadata = nativeFormMetadata.triggers;
  return <Section id={metadata.id} title={metadata.title} description="设置正常呼叫、引用与短时续聊；参与规则仍受主人、白名单与权限检查约束。" scrollable
    actions={<Button size="sm" variant="outline" disabled={saving || resource.loading} onClick={resource.refresh}><RefreshCw className="size-3.5" />读取触发配置</Button>}
    footer={<SaveBar dirty={dirty} saving={saving} disabled={disabled} onSave={() => void save()} onReset={saved && !recovery.blocked ? () => { setForm(chatInputForm(saved.configuration)); setError(''); setNotice(''); } : undefined} label="保存触发配置" message={notice || (dirty ? '触发更改尚未保存。' : saved ? '后续消息使用已保存的触发配置。' : '尚未读取触发配置。')} />}>
    <NativeCatalogRecovery recovery={recovery} reading={saving || resource.loading} onRead={resource.refresh} onReleased={() => setError('')} />
    {(error || resource.error) && <p role="alert" className="mb-3 text-xs text-destructive">{error || '暂时无法读取触发配置；草稿保留，请重试。'}</p>}
    {!form ? <p role="status" className="text-xs text-muted-foreground">{resource.loading ? '正在读取触发配置…' : '当前服务尚未返回可编辑的触发配置。'}</p> : <div className="grid gap-4">
      <StatusPill>{saved?.configuration.enabled ? '已保存：触发已开启' : '已保存：触发已关闭'}</StatusPill>
      <ToggleField label={metadata.fields.enabled} checked={form.enabled} disabled={disabled} onChange={enabled => update({ enabled })} />
      <Field label={metadata.fields.nicknames} description="每行一个，最多16个；昵称不能忽略大小写重复。"><Textarea value={form.nicknames} disabled={disabled} className="h-24" onChange={event => update({ nicknames: event.target.value })} /></Field>
      <div className="grid gap-4 sm:grid-cols-2"><ToggleField label={metadata.fields.mention} checked={form.wakeOnMention} disabled={disabled} onChange={wakeOnMention => update({ wakeOnMention })} /><ToggleField label={metadata.fields.reply} checked={form.wakeOnReply} disabled={disabled} onChange={wakeOnReply => update({ wakeOnReply })} /></div>
      <Field label={metadata.fields.continuation} description="单位秒，0关闭短时续聊；最长300秒，转向他人时不继续抢答。"><Input type="number" min={0} max={300} step={0.001} value={form.continuationSeconds} disabled={disabled} onChange={event => update({ continuationSeconds: event.target.value })} /></Field>
      <div className="grid gap-4 sm:grid-cols-2"><ToggleField label={metadata.fields.group} checked={form.group} disabled={disabled} onChange={group => update({ group })} /><ToggleField label={metadata.fields.private} checked={form.private} disabled={disabled} onChange={value => update({ private: value })} /></div>
      <details><summary className="cursor-pointer text-xs">高级：限制参与会话</summary><div className="mt-3 grid gap-4 sm:grid-cols-2"><Field label={metadata.fields.include} description="可选，每行group:群号或private:用户号；留空采用所有已获准会话。"><Textarea value={form.include} disabled={disabled} className="h-24" onChange={event => update({ include: event.target.value })} /></Field><Field label={metadata.fields.exclude} description="排除优先于包含，不修改白名单或授权。"><Textarea value={form.exclude} disabled={disabled} className="h-24" onChange={event => update({ exclude: event.target.value })} /></Field></div></details>
    </div>}
  </Section>;
}
