import { useEffect, useMemo, useRef, useState } from 'react';
import { PACKAGE_CONFIGURATION_PATH, parsePackageConfigurationList, parsePackageConfigurationSnapshot, type PackageConfigurationField, type PackageConfigurationListEntry, type PackageConfigurationSnapshot, type PackageConfigurationValue } from '../../src/contracts/package-configuration.ts';
import { createDraftKey, retainDraft, retainedDraft, type DraftKey } from '../lib/retained-drafts.ts';
import { packageConfigurationChanges, packageConfigurationDraft, type PackageFieldDraft } from '../lib/package-configuration-ui.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import { useNativeCatalogOperation } from '../lib/use-native-catalog-operation.ts';
import { writeResource } from '../lib/resource-reader.ts';
import { errorMessage, type ApiClient } from '../lib/api.ts';
import { Section } from './management.tsx';
import { NativeCatalogRecovery } from './native-catalog-recovery.tsx';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { Textarea } from './ui/textarea.tsx';
import { Switch } from './ui/switch.tsx';
import { HelpTip } from './help-tip.tsx';
import { ReadOnlyDetails, TechnicalDetails } from './read-only-details.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog.tsx';
import type { PageProps } from '../lib/types.ts';

type PublicDraft = { readonly snapshot: PackageConfigurationSnapshot; readonly drafts: Readonly<Record<string, PackageFieldDraft>> };
const draftKeys = new Map<string, DraftKey<PublicDraft>>();
function draftKey(id: string): DraftKey<PublicDraft> { let value = draftKeys.get(id); if (!value) { value = createDraftKey<PublicDraft>(`package-configuration:${id}`); draftKeys.set(id, value); } return value; }

function ConfigurationField({ owner, field, value, disabled, onChange, compact = false }: { readonly compact?: boolean; readonly owner: string; readonly field: PackageConfigurationField; readonly value: PackageFieldDraft; readonly disabled: boolean; readonly onChange: (value: PackageFieldDraft) => void }) {
  const id = `package-field-${owner}-${field.id}`;
  const hint = field.kind === 'string-list' ? `${field.description} 每行一项，最多 ${field.maximumEntries} 项，每项 ${field.maximumLength} 字符。` : field.description;
  const label = <div className="flex min-w-0 items-center gap-1"><label htmlFor={id} className="text-sm font-medium">{field.label}</label>{hint && <HelpTip label={field.label}>{hint}</HelpTip>}</div>;
  if (compact && field.kind === 'boolean') return <div className="inline-flex items-center gap-1"><label htmlFor={id}><input id={id} type="checkbox" checked={value === true} disabled={disabled} onChange={event => onChange(event.target.checked)} />{field.label}</label>{hint && <HelpTip label={field.label}>{hint}</HelpTip>}</div>;
  if (field.kind === 'choice') return <div className="inline-flex flex-wrap items-center gap-2"><div className="inline-flex items-center gap-1"><label htmlFor={id} className={compact ? 'text-xs' : 'text-sm font-medium'}>{field.label}</label><HelpTip label={field.label}>{hint}</HelpTip></div><select id={id} className="h-[27px] max-w-full rounded border bg-background px-2 text-xs" value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={event => onChange(event.target.value)}>{field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>;
  if (field.kind === 'string-list') return <div className="grid gap-1.5 sm:col-span-2 xl:col-span-3">{label}<Textarea id={id} className="min-h-32 resize-y" value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={event => onChange(event.target.value)} /></div>;
  return <div className="flex min-h-[30px] max-w-xl flex-wrap items-center justify-between gap-x-3 gap-y-1.5">{label}{field.kind === 'boolean' ? <Switch id={id} checked={value === true} disabled={disabled} onCheckedChange={onChange} /> : <div className="flex items-center gap-2"><Input id={id} className="w-24" type="number" min={field.minimum} max={field.maximum} step={1} disabled={disabled} value={typeof value === 'string' ? value : ''} onChange={event => onChange(event.target.value)} />{field.unit && <span className="text-xs text-muted-foreground">{field.unit}</span>}</div>}</div>;
}

function PackageConfigurationCard({ api, connected, entry, setDirty, refreshCatalog, catalogUpdatedAt, embedded = false }: { readonly embedded?: boolean; readonly catalogUpdatedAt: number; readonly api: ApiClient; readonly connected: boolean; readonly entry: PackageConfigurationListEntry; readonly setDirty: PageProps['setDirty']; readonly refreshCatalog: () => void }) {
  const { descriptor } = entry;
  const replySettings = descriptor.id === 'chat-output';
  const simpleSettings = replySettings || descriptor.id === 'media';
  const key = useMemo(() => draftKey(descriptor.id), [descriptor.id]);
  const resource = useReadResource(api, `${PACKAGE_CONFIGURATION_PATH}?${new URLSearchParams({ id: descriptor.id })}`, connected, parsePackageConfigurationSnapshot);
  const recovery = useNativeCatalogOperation(api, 'package-configuration');
  const [local, setLocal] = useState<{ readonly api: ApiClient; readonly value: PublicDraft | null }>(() => ({ api, value: retainedDraft(api, key) ?? null }));
  const current = local.api === api ? local.value : null;
  const baseline = current ? packageConfigurationDraft(descriptor, current.snapshot.configuration) : null;
  const dirty = current !== null && JSON.stringify(current.drafts) !== JSON.stringify(baseline);
  const [confirmed, setConfirmed] = useState(false); const [migrationConfirmed, setMigrationConfirmed] = useState(false);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
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
    if (!revision || request.current || busy || recovery.blocked || migrate && !migrationConfirmed || !migrate && (locked || !current || !dirty || !simpleSettings && !confirmed)) return;
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
      setMessage(migrate ? '配置已迁移，请核对后继续。' : value.application === 'live' ? '设置已保存，后续处理生效。' : '设置已保存，重启对应宿主后生效。'); resource.refresh(); refreshCatalog();
    } catch (failure) { recovery.fail(token, failure); if (!controller.signal.aborted) setMessage(errorMessage(failure)); }
    finally { if (request.current === controller) { request.current = null; if (!controller.signal.aborted) setBusy(false); } }
  }
  const advancedFields = descriptor.id === 'chat-output' ? descriptor.fields.filter(field => field.id === 'long-threshold') : [];
  const fields = descriptor.fields.filter(field => !advancedFields.includes(field));
  const fieldEditor = (field: PackageConfigurationField) => current && <ConfigurationField compact={embedded} key={field.id} owner={descriptor.id} field={field} value={current.drafts[field.id] ?? ''} disabled={locked} onChange={value => setLocal({ api, value: { ...current, drafts: { ...current.drafts, [field.id]: value } } })} />;
  return <Section className={embedded ? 'reply-settings-embedded' : undefined} id={`package-configuration-${descriptor.id}`} title={descriptor.title} actions={<>{descriptor.description && <HelpTip label={descriptor.title}>{descriptor.description}</HelpTip>}<ReadOnlyDetails title={`${descriptor.title}详情`} description="配置来源、保存版本与读取结果。"><TechnicalDetails fields={[{ label: '配置标识', value: descriptor.id }, { label: '所属扩展', value: descriptor.owner }, { label: '字段版本', value: descriptor.schemaVersion }, { label: '保存版本', value: current?.snapshot.revision ?? entry.revision }, { label: '来源', value: entry.source }, { label: '读取错误', value: resource.error ? errorMessage(resource.error) : entry.errorCode }]} /></ReadOnlyDetails></>}>
    <div className="grid gap-2 text-sm leading-[1.45]">
      {ownBlock && <NativeCatalogRecovery recovery={recovery} reading={resource.loading || busy} onRead={() => { resource.refresh(); refreshCatalog(); }} onReleased={() => setMessage('已核对保存内容；草稿保留，不会重试原请求。')} />}
      {recovery.blocked && !ownBlock && <p role="status">另一项功能配置仍有待核对的写入，请先处理对应配置。</p>}
      {entry.state === 'unavailable' && <><p role="status" className="text-xs text-destructive">当前设置不可编辑，请查看详情核对原因。</p>{entry.errorCode === 'PACKAGE_CONFIGURATION_MIGRATION_REQUIRED' && entry.revision && <><label className="flex gap-2"><input type="checkbox" checked={migrationConfirmed} disabled={busy || recovery.blocked} onChange={event => setMigrationConfirmed(event.target.checked)} />确认迁移已保存的配置到当前字段版本</label><Button size="sm" variant="outline" className="justify-self-start" disabled={busy || recovery.blocked || !migrationConfirmed} onClick={() => void perform(true)}>迁移此功能配置</Button></>}</>}
      {resource.error && <p role="alert" className="text-xs text-destructive">设置读取失败，草稿已保留。请重新读取或查看详情。</p>}
      {current && schemaMatches ? <div className={embedded ? "reply-settings-checks" : "grid gap-x-3.5 gap-y-1.5 sm:grid-cols-2 xl:grid-cols-3"}>{fields.map(fieldEditor)}</div> : <p className="text-xs text-muted-foreground">{resource.loading ? '正在读取设置…' : '设置尚未核对，暂时不可编辑。'}</p>}
      {advancedFields.length > 0 && <Dialog open={advancedOpen} onOpenChange={setAdvancedOpen}><DialogContent><DialogHeader><DialogTitle>长文设置</DialogTitle><DialogDescription>调整后返回回复方式卡片保存。</DialogDescription></DialogHeader><div className="grid gap-3">{current && schemaMatches && advancedFields.map(fieldEditor)}</div><DialogFooter><Button variant="outline" onClick={() => setAdvancedOpen(false)}>完成</Button></DialogFooter></DialogContent></Dialog>}
      <div className="flex flex-wrap items-center gap-2">{dirty && !simpleSettings && <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={confirmed} disabled={locked} onChange={event => setConfirmed(event.target.checked)} />确认保存</label>}<span className="mr-auto text-xs text-muted-foreground">{dirty ? '有未保存的更改' : descriptor.application === 'live' ? descriptor.id === 'media' ? '保存后立即生效' : '保存后对后续回复生效' : '保存后重启对应宿主生效'}</span>{advancedFields.length > 0 && <Button size="sm" variant="outline" disabled={!current || !schemaMatches} onClick={() => setAdvancedOpen(true)}>长文设置</Button>}<Button size="sm" variant="outline" disabled={resource.loading || busy} onClick={resource.refresh}>重新读取</Button>{dirty && <Button size="sm" variant="ghost" disabled={busy || recovery.blocked} onClick={() => { const snapshot = resource.snapshot ?? current?.snapshot; if (snapshot) { const drafts = packageConfigurationDraft(descriptor, snapshot.configuration); if (drafts) setLocal({ api, value: { snapshot, drafts } }); } }}>撤销更改</Button>}<Button size="sm" disabled={locked || !dirty || !simpleSettings && !confirmed} onClick={() => void perform()}>{replySettings ? '保存回复设置' : '保存设置'}</Button></div>
      {message && <p role="status" className="rounded-md bg-muted/50 px-3 py-1.5 text-xs">{message}</p>}
    </div>
  </Section>;
}
export function PackageConfigurationManager({ api, connected, setDirty, onlyIds, excludeIds = [], embedded = false }: Pick<PageProps, 'api' | 'connected' | 'setDirty'> & { readonly onlyIds?: readonly string[]; readonly excludeIds?: readonly string[]; readonly embedded?: boolean }) {
  const resource = useReadResource(api, PACKAGE_CONFIGURATION_PATH, connected, parsePackageConfigurationList);
  if (!connected) return null;
  const entries = resource.snapshot?.packages.filter(entry => (!onlyIds || onlyIds.includes(entry.descriptor.id)) && !excludeIds.includes(entry.descriptor.id)) ?? [];
  return <div className={embedded ? "embedded-settings-directory" : "grid gap-2"} data-package-configuration-directory>
    {resource.error && <div className="flex flex-wrap items-center gap-2 text-xs"><p role="alert" className="text-destructive">设置列表读取失败，已保留上次结果。</p><Button size="sm" variant="outline" onClick={resource.refresh}>重新读取</Button><ReadOnlyDetails title="设置列表读取详情"><TechnicalDetails fields={[{ label: '错误', value: errorMessage(resource.error) }]} /></ReadOnlyDetails></div>}
    {!resource.error && entries.length === 0 && onlyIds && <p role="status" className="text-sm text-muted-foreground">{resource.loading ? '正在读取回复设置…' : '当前服务未提供回复设置。'}</p>}
    {entries.map(entry => <PackageConfigurationCard embedded={embedded} key={entry.descriptor.id} api={api} connected={connected} entry={entry} setDirty={setDirty} refreshCatalog={resource.refresh} catalogUpdatedAt={resource.updatedAt} />)}
  </div>;
}
