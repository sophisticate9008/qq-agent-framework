import { useEffect, useRef, useState } from 'react';
import { NATIVE_APPEARANCE_PATH, parseNativeAppearanceSnapshot, parseNativeAppearancePreview, isNativeAppearanceMediaType, type NativeAppearanceRequest } from '../../src/contracts/native-appearance.ts';
import { FRAMEWORK_MEDIA_IMAGE_BYTES, type FrameworkImageMediaType } from '../../src/contracts/framework-media.ts';
import { errorMessage, type ApiClient } from '../lib/api.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import { useNativeCatalogOperation } from '../lib/use-native-catalog-operation.ts';
import { createDraftKey, retainDraft, retainedDraft } from '../lib/retained-drafts.ts';
import { writeResource } from '../lib/resource-reader.ts';
import { Field, Section, StatusPill } from './management.tsx';
import { NativeCatalogRecovery } from './native-catalog-recovery.tsx';
import { Button } from './ui/button.tsx';

interface AppearanceUploadDraft { readonly name: string; readonly description: string; readonly file: { readonly name: string; readonly mediaType: FrameworkImageMediaType; readonly data: string } | null; readonly assetId: string | null }
const emptyDraft: AppearanceUploadDraft = { name: '', description: '', file: null, assetId: null };
const uploadKey = createDraftKey<AppearanceUploadDraft>('appearance');
function fileData(file: File): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('无法读取选择的图片')); reader.onload = () => {
    if (typeof reader.result !== 'string' || !reader.result.includes(',')) reject(new Error('无法读取选择的图片')); else resolve(reader.result.slice(reader.result.indexOf(',') + 1));
  }; reader.readAsDataURL(file); });
}

export function AppearanceManager({ api, connected, personaId, personaDirty, setDirty }: {
  readonly api: ApiClient; readonly connected: boolean; readonly personaId: string | null; readonly personaDirty: boolean;
  readonly setDirty: (value: boolean, scope?: string) => void;
}) {
  const recovery = useNativeCatalogOperation(api, 'appearance');
  const resource = useReadResource(api, NATIVE_APPEARANCE_PATH, connected, parseNativeAppearanceSnapshot);
  const [draft, setDraft] = useState<AppearanceUploadDraft>(() => retainedDraft(api, uploadKey) ?? emptyDraft);
  const [selection, setSelection] = useState('');
  const [confirmedUpload, setConfirmedUpload] = useState(false);
  const [confirmedBind, setConfirmedBind] = useState(false);
  const [confirmedUnbind, setConfirmedUnbind] = useState(false);
  const [confirmedDelete, setConfirmedDelete] = useState(false);
  const [busy, setBusy] = useState(false); const [readingFile, setReadingFile] = useState(false);
  const [imageError, setImageError] = useState('');
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const input = useRef<HTMLInputElement>(null); const request = useRef<AbortController | null>(null);
  const fileEpoch = useRef(0); const owner = useRef(api); const [draftIdentity, setDraftIdentity] = useState(api);
  const choices = resource.snapshot?.assets.flatMap(asset => [...asset.versions].reverse().map(version => ({ asset, version, key: `${asset.id}:${version.version}` }))) ?? [];
  const selected = choices.find(choice => choice.key === selection);
  const binding = resource.snapshot?.bindings.find(binding => binding.personaId === personaId && binding.assetId !== null);
  const boundChoice = choices.find(choice => choice.asset.id === binding?.assetId && choice.version.version === binding?.version);
  const previewPath = selected ? `${NATIVE_APPEARANCE_PATH}?${new URLSearchParams({ assetId: selected.asset.id, version: String(selected.version.version), preview: '1' })}` : NATIVE_APPEARANCE_PATH;
  const preview = useReadResource(api, previewPath, connected && selected !== undefined, parseNativeAppearancePreview);
  const image = preview.snapshot?.assetId === selected?.asset.id && preview.snapshot?.version === selected?.version.version ? preview.snapshot?.image : null;
  const dirty = draft.file !== null || draft.name !== '' || draft.description !== '';
  const locked = busy || readingFile || resource.loading || resource.error !== null || recovery.blocked || !resource.snapshot;
  const inUse = selected !== undefined && resource.snapshot?.bindings.some(binding => binding.assetId === selected.asset.id);
  useEffect(() => {
    owner.current = api; setDraftIdentity(api); fileEpoch.current++; setDraft(retainedDraft(api, uploadKey) ?? emptyDraft); setSelection(''); setBusy(false); setReadingFile(false); setError(''); setNotice('');
    return () => { fileEpoch.current++; request.current?.abort(); request.current = null; };
  }, [api, connected]);
  useEffect(() => { if (draftIdentity === api) retainDraft(api, uploadKey, connected && dirty ? draft : null); setDirty(draftIdentity === api && dirty, 'appearance'); }, [api, connected, draftIdentity, dirty, draft, setDirty]);
  useEffect(() => () => setDirty(false, 'appearance'), [setDirty]);
  useEffect(() => { setSelection(''); }, [personaId]);
  useEffect(() => { setConfirmedBind(false); setConfirmedUnbind(false); setConfirmedDelete(false); }, [personaId, selection, resource.snapshot?.revision]);
  useEffect(() => { setConfirmedUpload(false); }, [draft]);
  useEffect(() => { if (resource.updatedAt > 0 && !resource.error && !resource.loading) recovery.review(); }, [resource.updatedAt, resource.error, resource.loading]);
  useEffect(() => { if (!selection && boundChoice) setSelection(boundChoice.key); }, [selection, boundChoice?.key]);

  async function chooseFile(file: File | undefined): Promise<void> {
    if (!file || locked) return;
    const generation = ++fileEpoch.current; setReadingFile(true); setError('');
    try {
      if (!isNativeAppearanceMediaType(file.type) || file.size < 1 || file.size > FRAMEWORK_MEDIA_IMAGE_BYTES) throw new Error(`请选择 PNG、JPEG、WebP 或 GIF 图片，大小不超过 ${FRAMEWORK_MEDIA_IMAGE_BYTES.toLocaleString('zh-CN')} 字节。`);
      const data = await fileData(file); if (generation !== fileEpoch.current) return;
      setDraft(current => ({ ...current, name: current.name || file.name.slice(0, 128), file: { name: file.name, mediaType: file.type as FrameworkImageMediaType, data } }));
    } catch (failure) { if (generation === fileEpoch.current) setError(errorMessage(failure)); }
    finally { if (generation === fileEpoch.current) setReadingFile(false); }
  }
  async function perform(action: 'upload' | 'bind' | 'unbind' | 'remove'): Promise<void> {
    if (!resource.snapshot || locked || request.current) return;
    if (action === 'upload' && (!confirmedUpload || !draft.file || !draft.name.trim()) || action === 'bind' && (!confirmedBind || !selected || !personaId || personaDirty)
      || action === 'unbind' && (!confirmedUnbind || !binding || !personaId || personaDirty) || action === 'remove' && (!confirmedDelete || !selected || inUse)) return;
    const revision = resource.snapshot.revision;
    const body: NativeAppearanceRequest | null = action === 'upload' && draft.file ? { action, revision, name: draft.name.trim(), description: draft.description, mediaType: draft.file.mediaType, data: draft.file.data, ...(draft.assetId ? { assetId: draft.assetId } : {}) }
      : action === 'bind' && selected && personaId ? { action, revision, personaId, assetId: selected.asset.id, version: selected.version.version }
        : action === 'unbind' && personaId ? { action, revision, personaId } : action === 'remove' && selected ? { action, revision, assetId: selected.asset.id } : null;
    if (!body) return;
    const controller = new AbortController(); request.current = controller; const token = recovery.begin(revision, controller.signal);
    if (!token) { request.current = null; return; }
    setBusy(true); setError(''); setNotice(''); setConfirmedUpload(false); setConfirmedBind(false); setConfirmedUnbind(false); setConfirmedDelete(false);
    try {
      const next = parseNativeAppearanceSnapshot(await writeResource(api, NATIVE_APPEARANCE_PATH, body, controller.signal));
      if (!next) throw new Error('invalid_appearance_response'); if (controller.signal.aborted || owner.current !== api) return;
      recovery.complete(token);
      if (action === 'upload') {
        const uploaded = draft.assetId ? next.assets.find(asset => asset.id === draft.assetId) : next.assets.find(asset => !resource.snapshot?.assets.some(previous => previous.id === asset.id));
        if (uploaded) setSelection(`${uploaded.id}:${uploaded.versions.at(-1)?.version}`);
        setDraft(emptyDraft); if (input.current) input.current.value = '';
      }
      if (action === 'remove') setSelection('');
      setNotice(action === 'upload' ? '参考图版本已保存；人设绑定保持原样。' : action === 'bind' ? '当前人设已绑定这版参考图。模型需要实际读取图像后才能使用其内容。' : action === 'unbind' ? '人设参考图绑定已解除。' : '未被引用的素材及版本已删除。'); resource.refresh();
    } catch (failure) { recovery.fail(token, failure); if (!controller.signal.aborted && owner.current === api) setError(errorMessage(failure)); }
    finally { if (request.current === controller) { request.current = null; if (!controller.signal.aborted) setBusy(false); } }
  }
  if (!connected) return null;
  return <Section id="native-appearance" title="角色参考图" description="手工保存图片版本并为已保存的人设选择一份参考图。图像说明与人设身份、表达分别保存。" scrollable height="lg">
    <div className="grid gap-4 text-xs leading-6">
      <NativeCatalogRecovery recovery={recovery} reading={resource.loading || busy} onRead={resource.refresh} onReleased={() => setError('')} />
      <div className="flex flex-wrap items-center justify-between gap-2"><StatusPill>{boundChoice ? `当前绑定：${boundChoice.version.name} · 版本 ${boundChoice.version.version}` : '当前人设尚未绑定参考图'}</StatusPill><Button size="sm" variant="outline" disabled={busy || resource.loading} onClick={resource.refresh}>重新读取形象素材</Button></div>
      {resource.error && <p role="status">素材目录暂未读到；不推断绑定已解除，也不会自动保存。</p>}
      {!personaId && <p>先保存人设，再为它明确绑定图片；可以先维护参考素材库。</p>}
      {personaDirty && <p>当前人设仍有草稿；绑定操作使用已保存的人设，请先保存或撤销人设更改。</p>}
      <Field label="参考素材与版本"><select aria-label="参考素材与版本" className="h-9 w-full min-w-0 rounded border bg-background px-3" disabled={busy || resource.loading} value={selection} onChange={event => setSelection(event.target.value)}><option value="">选择素材与版本</option>{choices.map(choice => <option key={choice.key} value={choice.key}>{choice.version.name} · 版本 {choice.version.version}</option>)}</select></Field>
      {selected && <><p>来源：手工上传 · {new Date(selected.version.createdAt).toLocaleString('zh-CN')} · {selected.version.mediaType} · {selected.version.width}×{selected.version.height} · {selected.version.bytes} 字节</p><p className="whitespace-pre-wrap break-words">{selected.version.description || '未填写图像说明。'}</p>
        {image ? <img onError={() => setImageError(selection)} onLoad={() => setImageError('')} className="max-h-64 w-full rounded border bg-muted object-contain" src={`data:${image.mediaType};base64,${image.data}`} alt={`角色参考图预览：${selected.version.name}，版本 ${selected.version.version}`} /> : <p role="status">{preview.loading ? '正在读取实际图片预览…' : '图片预览尚未读到；不会以说明代替图像内容。'}</p>}
        <label className="flex gap-2"><input type="checkbox" checked={confirmedBind} disabled={locked || !personaId || personaDirty} onChange={event => setConfirmedBind(event.target.checked)} />确认将这版参考图用于当前人设</label><Button size="sm" className="justify-self-start" disabled={locked || !confirmedBind || !personaId || personaDirty} onClick={() => void perform('bind')}>绑定当前人设</Button>
      </>}
      {imageError === selection && imageError !== '' && <p role="status">这版图像尚未成功显示，请重新核验实际图片；说明不能替代图像内容。</p>}
      {binding && <details key="unbind"><summary className="cursor-pointer">解除当前人设参考图</summary><div className="mt-2 grid gap-2"><label className="flex gap-2"><input type="checkbox" checked={confirmedUnbind} disabled={locked || personaDirty} onChange={event => setConfirmedUnbind(event.target.checked)} />确认解除当前人设参考图绑定</label><Button size="sm" variant="outline" className="justify-self-start" disabled={locked || !confirmedUnbind || personaDirty} onClick={() => void perform('unbind')}>解除参考图绑定</Button></div></details>}
      <details key="upload"><summary className="cursor-pointer">上传参考图或新版本</summary><div className="mt-3 grid gap-3">
        <Field label="参考图名称"><input aria-label="参考图名称" className="h-9 w-full rounded border bg-background px-3" maxLength={128} disabled={locked} value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} /></Field>
        <Field label="参考图说明"><textarea aria-label="参考图说明" className="min-h-20 w-full rounded border bg-background p-3" maxLength={2000} disabled={locked} value={draft.description} onChange={event => setDraft(current => ({ ...current, description: event.target.value }))} /></Field>
        <Field label="参考图片文件" description={`PNG / JPEG / WebP / GIF，最多 ${FRAMEWORK_MEDIA_IMAGE_BYTES.toLocaleString('zh-CN')} 字节；服务会核验实际图像格式与尺寸。`}><input aria-label="参考图片文件" ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={locked} onChange={event => void chooseFile(event.target.files?.[0])} /></Field>
        {draft.file && <p>已选择：{draft.file.name}</p>}
        <label className="flex gap-2"><input type="checkbox" disabled={locked || !selected} checked={draft.assetId !== null} onChange={event => setDraft(current => ({ ...current, assetId: event.target.checked ? selected?.asset.id ?? null : null }))} />保存为选中素材的新版本</label>
        <p>{draft.assetId ? '新增版本后，已有的人设绑定仍停留在原版本，需另行明确更换。' : '保存为独立参考素材，不会自动绑定任何人设。'}</p>
        <label className="flex gap-2"><input type="checkbox" disabled={locked || !draft.file} checked={confirmedUpload} onChange={event => setConfirmedUpload(event.target.checked)} />确认保存参考图，不更改人设绑定</label>
        <div className="flex gap-2"><Button size="sm" disabled={locked || !confirmedUpload || !draft.file || !draft.name.trim()} onClick={() => void perform('upload')}>保存参考图版本</Button><Button size="sm" variant="ghost" disabled={busy || !dirty} onClick={() => { fileEpoch.current++; setReadingFile(false); setDraft(emptyDraft); if (input.current) input.current.value = ''; }}>撤销参考图草稿</Button></div>
      </div></details>
      {selected && <details key="remove"><summary className="cursor-pointer">删除参考素材</summary><div className="mt-2 grid gap-2"><p>{inUse ? '素材仍被人设引用，需要先明确解除或更换绑定。' : '删除此素材及全部版本，不改变人设正文。'}</p><label className="flex gap-2"><input type="checkbox" checked={confirmedDelete} disabled={locked || inUse} onChange={event => setConfirmedDelete(event.target.checked)} />确认删除未被人设使用的素材及全部版本</label><Button size="sm" variant="destructive" className="justify-self-start" disabled={locked || inUse || !confirmedDelete} onClick={() => void perform('remove')}>删除参考素材及版本</Button></div></details>}
      {(error || notice) && <p role="status" className={error ? 'text-destructive' : ''}>{error || notice}</p>}
    </div>
  </Section>;
}
