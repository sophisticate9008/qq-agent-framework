import { useEffect, useRef, useState } from 'react';
import { errorMessage, type ApiClient } from '../lib/api.ts';
import { authorizationMode, forwardAuthorizationRequest } from '../lib/chat-authorization-mode.ts';
import { newChatConfigurationId, parseChatAuthorization, type ChatAuthorization } from '../lib/chat-runtime.ts';
import { createDraftKey, retainDraft, retainedDraft } from '../lib/retained-drafts.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import { useNativeCatalogOperation } from '../lib/use-native-catalog-operation.ts';
import { writeResource } from '../lib/resource-reader.ts';
import { Field, Section } from './management.tsx';
import { NativeCatalogRecovery } from './native-catalog-recovery.tsx';
import { Button } from './ui/button.tsx';
import type { PageProps } from '../lib/types.ts';

const draftKey = createDraftKey<{ readonly saved: ChatAuthorization; readonly text: string }>('forward-authorization');
export function ForwardAuthorizationManager({ api, connected, setDirty, navigate }: { readonly api: ApiClient; readonly connected: boolean; readonly setDirty: PageProps['setDirty']; readonly navigate: PageProps['navigate'] }) {
  const resource = useReadResource(api, '/api/chat/authorization', connected, parseChatAuthorization);
  const recovery = useNativeCatalogOperation(api, 'authorization');
  const [saved, setSaved] = useState<ChatAuthorization | null>(() => retainedDraft(api, draftKey)?.saved ?? null);
  const [text, setText] = useState(() => retainedDraft(api, draftKey)?.text ?? '');
  const [identity, setIdentity] = useState(api);
  const [confirmed, setConfirmed] = useState(false); const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(''); const request = useRef<AbortController | null>(null);
  const mode = saved ? authorizationMode(saved) : 'unconfirmed';
  const changed = mode === 'whitelist' && text !== (saved?.forwardAllow ?? []).join('\n');
  useEffect(() => {
    const draft = retainedDraft(api, draftKey); setIdentity(api); setSaved(draft?.saved ?? null); setText(draft?.text ?? ''); setConfirmed(false); setBusy(false); setMessage('');
    return () => { request.current?.abort(); request.current = null; };
  }, [api, connected]);
  useEffect(() => {
    if (!resource.loading && !resource.error && resource.snapshot) {
      recovery.review();
      if (identity === api && (!saved || !changed && !request.current)) { setSaved(resource.snapshot); setText((resource.snapshot.forwardAllow ?? []).join('\n')); }
    }
  }, [api, identity, saved, changed, resource.loading, resource.error, resource.snapshot, resource.updatedAt]);
  useEffect(() => {
    if (identity === api) retainDraft(api, draftKey, connected && changed && saved ? { saved, text } : null);
    setDirty(identity === api && changed, 'forward-authorization'); setConfirmed(false);
  }, [api, identity, connected, changed, saved, text, setDirty]);
  useEffect(() => () => setDirty(false, 'forward-authorization'), [setDirty]);
  const locked = busy || resource.loading || resource.error !== null || recovery.blocked || mode !== 'whitelist';
  async function save(): Promise<void> {
    if (!saved || locked || !changed || !confirmed || request.current) return;
    const forwardAllow = text.split('\n').map(line => line.trim()).filter(Boolean);
    const version = newChatConfigurationId();
    const body = forwardAuthorizationRequest(saved, version, forwardAllow);
    if (!body) { setMessage('请输入不重复的 group:群号 或 private:账号，每行一个，最多 1024 个。'); return; }
    const controller = new AbortController(); const token = recovery.begin(saved.revision, controller.signal); if (!token) return;
    request.current = controller; setBusy(true); setConfirmed(false); setMessage('');
    try {
      const next = parseChatAuthorization(await writeResource(api, '/api/chat/authorization', body, controller.signal));
      if (!next || next.version !== version || next.mode !== 'whitelist') throw new Error('invalid_forward_authorization_response');
      if (controller.signal.aborted) return;
      recovery.complete(token); setSaved(next); setText((next.forwardAllow ?? []).join('\n'));
      setMessage('合并转发权限已保存为新授权版本；请到连接页明确应用。输出开关不会代替这项授权。'); resource.refresh();
    } catch (failure) { recovery.fail(token, failure); if (!controller.signal.aborted) setMessage(errorMessage(failure)); }
    finally { if (request.current === controller) { request.current = null; if (!controller.signal.aborted) setBusy(false); } }
  }
  if (!connected) return null;
  return <Section id="forward-authorization" title="合并转发权限" description="输出形式与发送权限分别配置。合并转发需要独立授权，同时仍受普通回复发送权限和会话白名单约束。">
    <div className="grid gap-3 text-xs leading-6">
      <NativeCatalogRecovery recovery={recovery} reading={busy || resource.loading} onRead={resource.refresh} onReleased={() => { if (resource.snapshot) setSaved(resource.snapshot); setMessage('已核对保存版本，草稿保留；不会重放旧请求。'); }} />
      {mode === 'whitelist' ? <><Field label="允许合并转发的会话" description="每行 group:群号 或 private:账号，留空表示不授予合并转发；还需要该会话在访问白名单内。"><textarea aria-label="允许合并转发的会话" className="min-h-24 w-full rounded border bg-background p-3" disabled={locked} value={text} onChange={event => setText(event.target.value)} /></Field>
        <label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={locked || !changed} onChange={event => setConfirmed(event.target.checked)} />确认以新授权版本保存合并转发会话范围</label><Button size="sm" className="justify-self-start" disabled={locked || !changed || !confirmed} onClick={() => void save()}>保存合并转发权限</Button>
      </> : <p>{mode === 'counted' ? '当前采用有限次数授权，请在安全页每个会话的“合并转发次数”中明确设置；0 表示未授权。' : '访问模式尚未核实，合并转发权限保持只读。'}</p>}
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy || resource.loading} onClick={resource.refresh}>读取合并转发权限</Button>{changed && <Button size="sm" variant="ghost" disabled={busy || recovery.blocked} onClick={() => { const current = resource.snapshot ?? saved; if (current) { setSaved(current); setText((current.forwardAllow ?? []).join('\n')); } }}>撤销转发权限草稿</Button>}<Button size="sm" variant="outline" onClick={() => navigate('security', { kind: 'section', title: '访问控制', sectionId: 'security-access' })}>查看访问控制</Button></div>
      {message && <p role="status">{message}</p>}
    </div>
  </Section>;
}
