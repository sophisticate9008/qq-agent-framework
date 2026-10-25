import { useEffect, useMemo, useRef, useState } from 'react';
import { PACKAGE_CONFIGURATION_PATH, parsePackageConfigurationList, parsePackageConfigurationSnapshot, type PackageConfigurationListEntry, type PackageConfigurationSnapshot, type PackageConfigurationValue } from '../../src/contracts/package-configuration.ts';
import { createDraftKey, retainDraft, retainedDraft, type DraftKey } from '../lib/retained-drafts.ts';
import { packageConfigurationChanges, packageConfigurationDraft, type PackageFieldDraft } from '../lib/package-configuration-ui.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import { useNativeCatalogOperation } from '../lib/use-native-catalog-operation.ts';
import { writeResource } from '../lib/resource-reader.ts';
import { errorMessage, type ApiClient } from '../lib/api.ts';
import { Section, StatusPill } from './management.tsx';
import { NativeCatalogRecovery } from './native-catalog-recovery.tsx';
import { PackageConfigurationFieldEditor } from './configuration-editor.tsx';
import { Button } from './ui/button.tsx';
import type { PageProps } from '../lib/types.ts';

type PublicDraft = { readonly snapshot: PackageConfigurationSnapshot; readonly drafts: Readonly<Record<string, PackageFieldDraft>> };
const draftKeys = new Map<string, DraftKey<PublicDraft>>();
function draftKey(id: string): DraftKey<PublicDraft> { let value = draftKeys.get(id); if (!value) { value = createDraftKey<PublicDraft>(`package-configuration:${id}`); draftKeys.set(id, value); } return value; }

function PackageConfigurationCard({ api, connected, entry, setDirty, refreshCatalog, catalogUpdatedAt }: { readonly catalogUpdatedAt: number; readonly api: ApiClient; readonly connected: boolean; readonly entry: PackageConfigurationListEntry; readonly setDirty: PageProps['setDirty']; readonly refreshCatalog: () => void }) {
  const { descriptor } = entry;
  const key = useMemo(() => draftKey(descriptor.id), [descriptor.id]);
  const resource = useReadResource(api, `${PACKAGE_CONFIGURATION_PATH}?${new URLSearchParams({ id: descriptor.id })}`, connected, parsePackageConfigurationSnapshot);
  const recovery = useNativeCatalogOperation(api, 'package-configuration');
  const [local, setLocal] = useState<{ readonly api: ApiClient; readonly value: PublicDraft | null }>(() => ({ api, value: retainedDraft(api, key) ?? null }));
  const current = local.api === api ? local.value : null;
  const baseline = current ? packageConfigurationDraft(descriptor, current.snapshot.configuration) : null;
  const dirty = current !== null && JSON.stringify(current.drafts) !== JSON.stringify(baseline);
  const [confirmed, setConfirmed] = useState(false); const [migrationConfirmed, setMigrationConfirmed] = useState(false);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  const request = useRef<AbortController | null>(null);
  const ownBlock = recovery.block?.revision.startsWith(`${descriptor.id}:`) === true;
  useEffect(() => { setLocal({ api, value: connected ? retainedDraft(api, key) ?? null : null }); setConfirmed(false); setMigrationConfirmed(false); setBusy(false); setMessage(''); return () => { request.current?.abort(); request.current = null; }; }, [api, connected, key]);
  useEffect(() => {
    if (resource.updatedAt === 0 || resource.loading || resource.error || !resource.snapshot || resource.snapshot.id !== descriptor.id || resource.snapshot.schemaVersion !== descriptor.schemaVersion || resource.snapshot.application !== descriptor.application) return;
    if (ownBlock) recovery.review();
    if (!dirty) { const drafts = packageConfigurationDraft(descriptor, resource.snapshot.configuration); if (drafts) setLocal({ api, value: { snapshot: resource.snapshot, drafts } }); }
  }, [api, descriptor, dirty, ownBlock, resource.loading, resource.error, resource.snapshot, resource.updatedAt]);
  useEffect(() => { if (ownBlock && catalogUpdatedAt > 0 && entry.state === 'unavailable' && entry.revision && entry.errorCode === 'PACKAGE_CONFIGURATION_MIGRATION_REQUIRED') recovery.review(); }, [ownBlock, catalogUpdatedAt, entry]);
  useEffect(() => { if (local.api === api) retainDraft(api, key, connected && dirty ? current : null); setDirty(dirty, key.label); setConfirmed(false); }, [api, connected, key, local, current, dirty, setDirty]);
  useEffect(() => () => setDirty(false, key.label), [key, setDirty]);
  const schemaMatches = current?.snapshot.id === descriptor.id && current.snapshot.schemaVersion === descriptor.schemaVersion && current.snapshot.application === descriptor.application && baseline !== null;
  const locked = busy || resource.loading || resource.error !== null || recovery.blocked || !schemaMatches || entry.state !== 'ready';
  async function perform(migrate = false): Promise<void> {
    const revision = migrate ? entry.revision : current?.snapshot.revision;
    if (!revision || request.current || busy || recovery.blocked || migrate && !migrationConfirmed || !migrate && (locked || !current || !dirty || !confirmed)) return;
    let configuration: PackageConfigurationValue | null;
    try { configuration = !migrate && current ? packageConfigurationChanges(descriptor, current.snapshot.configuration, current.drafts) : null; } catch (failure) { setMessage(errorMessage(failure)); return; }
    const controller = new AbortController(); const token = recovery.begin(`${descriptor.id}:${revision}`, controller.signal); if (!token) return;
    request.current = controller; setBusy(true); setConfirmed(false); setMigrationConfirmed(false); setMessage('');
    try {
      const value = parsePackageConfigurationSnapshot(await writeResource(api, migrate ? `${PACKAGE_CONFIGURATION_PATH}/migrate` : PACKAGE_CONFIGURATION_PATH,
        migrate ? { id: descriptor.id, revision, confirm: true } : { id: descriptor.id, revision, configuration }, controller.signal));
      if (!value || value.id !== descriptor.id || value.schemaVersion !== descriptor.schemaVersion || value.application !== descriptor.application) throw new Error('invalid_package_configuration_response');
      const drafts = packageConfigurationDraft(descriptor, value.configuration); if (!drafts) throw new Error('invalid_package_configuration_fields');
      if (controller.signal.aborted) return; recovery.complete(token); setLocal({ api, value: { snapshot: value, drafts } });
      setMessage(migrate ? '配置迁移已保存；没有自动重启或重新执行任务。' : value.application === 'live' ? '功能配置已保存，后续处理按已保存值读取；不会创建授权。' : '功能配置已保存，需要明确重启对应宿主后生效。'); resource.refresh(); refreshCatalog();
    } catch (failure) { recovery.fail(token, failure); if (!controller.signal.aborted) setMessage(errorMessage(failure)); }
    finally { if (request.current === controller) { request.current = null; if (!controller.signal.aborted) setBusy(false); } }
  }
  return <Section id={`package-configuration-${descriptor.id}`} title={descriptor.title} description={descriptor.description} scrollable height="lg" actions={<StatusPill>{descriptor.application === 'live' ? '后续处理读取配置' : '重启对应宿主后生效'}</StatusPill>}>
    <div className="grid gap-3 text-xs leading-6">
      {ownBlock && <NativeCatalogRecovery recovery={recovery} reading={resource.loading || busy} onRead={() => { resource.refresh(); refreshCatalog(); }} onReleased={() => setMessage('已核对保存内容；草稿保留，不会重试原请求。')} />}
      {recovery.blocked && !ownBlock && <p role="status">另一项功能配置仍有待核对的写入，请先处理对应配置。</p>}
      {entry.state === 'unavailable' && <><p role="status">当前配置尚不可编辑；不会把旧 schema 或读取失败当作默认值保存。</p>{entry.errorCode === 'PACKAGE_CONFIGURATION_MIGRATION_REQUIRED' && entry.revision && <><label className="flex gap-2"><input type="checkbox" checked={migrationConfirmed} disabled={busy || recovery.blocked} onChange={event => setMigrationConfirmed(event.target.checked)} />确认迁移已保存的配置到当前字段版本</label><Button size="sm" variant="outline" className="justify-self-start" disabled={busy || recovery.blocked || !migrationConfirmed} onClick={() => void perform(true)}>迁移此功能配置</Button></>}</>}
      {resource.error && <p role="status">未取得可用配置；草稿和保存版本保持，不能推断配置已应用。</p>}
      {current && schemaMatches ? descriptor.fields.map(field => <PackageConfigurationFieldEditor key={field.id} field={field} value={current.drafts[field.id] ?? ''} disabled={locked} onChange={value => setLocal({ api, value: { ...current, drafts: { ...current.drafts, [field.id]: value } } })} />) : <p>{resource.loading ? '正在读取功能配置…' : '字段或 schema 尚未核验。'}</p>}
      {descriptor.id === 'chat-output' && <p>分条回复依赖普通发送权限；长文合并转发还需要下方独立转发授权及当前协议支持。媒体发送只消费已登记资源与实际协议回执，开关不会创建图片、音频或文件。</p>}
      {dirty && <label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={locked} onChange={event => setConfirmed(event.target.checked)} />确认保存这项功能配置，不增加访问权限</label>}
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={locked || !dirty || !confirmed} onClick={() => void perform()}>保存功能配置</Button><Button size="sm" variant="outline" disabled={resource.loading || busy} onClick={resource.refresh}>读取此功能配置</Button>{dirty && <Button size="sm" variant="ghost" disabled={busy || recovery.blocked} onClick={() => { const snapshot = resource.snapshot ?? current?.snapshot; if (snapshot) { const drafts = packageConfigurationDraft(descriptor, snapshot.configuration); if (drafts) setLocal({ api, value: { snapshot, drafts } }); } }}>撤销功能草稿</Button>}</div>
      <details><summary className="cursor-pointer">配置来源与版本</summary><p>功能：{descriptor.id} · 所属包：{descriptor.owner} · schema {descriptor.schemaVersion}</p><p>来源：{entry.source === 'stored' ? '手工保存' : entry.source === 'default' ? '包内默认值' : '尚未核验'}</p>{entry.errorCode && <p>状态标识：{entry.errorCode}</p>}</details>
      {message && <p role="status">{message}</p>}
    </div>
  </Section>;
}
export function PackageConfigurationManager({ api, connected, setDirty, onlyIds, excludeIds = [] }: Pick<PageProps, 'api' | 'connected' | 'setDirty'> & { readonly onlyIds?: readonly string[]; readonly excludeIds?: readonly string[] }) {
  const resource = useReadResource(api, PACKAGE_CONFIGURATION_PATH, connected, parsePackageConfigurationList);
  if (!connected) return null;
  const entries = resource.snapshot?.packages.filter(entry => (!onlyIds || onlyIds.includes(entry.descriptor.id)) && !excludeIds.includes(entry.descriptor.id)) ?? [];
  return <div className="grid gap-4" data-package-configuration-directory>
    {resource.error && <p role="status" className="text-xs leading-6">功能配置目录尚未读到；已保存配置保持，不会以空目录覆盖。</p>}
    {entries.map(entry => <PackageConfigurationCard key={entry.descriptor.id} api={api} connected={connected} entry={entry} setDirty={setDirty} refreshCatalog={resource.refresh} catalogUpdatedAt={resource.updatedAt} />)}
  </div>;
}
