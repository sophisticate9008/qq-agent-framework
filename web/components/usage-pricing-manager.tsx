import { createDraftKey, retainDraft, retainedDraft } from '../lib/retained-drafts.ts';
import { useNativeCatalogOperation } from '../lib/use-native-catalog-operation.ts';
import { NativeCatalogRecovery } from './native-catalog-recovery.tsx';
import { readResource, writeResource } from '../lib/resource-reader.ts';
import { nativeFormMetadata } from '../lib/native-form-metadata.ts';
import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { ApiError, errorMessage } from '../lib/api.ts';
import { builtinPricingSchedule, parseUsagePricing, parseUsagePricingProviders, pricesFromDraft, usagePriceComponents, validUsagePriceRoutes, type UsagePriceDraft, type UsagePricing, type UsagePricingProvider } from '../lib/usage-pricing.ts';
import type { PageProps } from '../lib/types.ts';
import { Field, SaveBar, Section } from './management.tsx';
import { Input } from './ui/input.tsx';
import { Button } from './ui/button.tsx';
import { VirtualList, VirtualTableBody, type VirtualListHandle } from './virtual-list.tsx';

type WriteState = 'idle' | 'saved' | 'conflict' | 'unknown' | 'busy';
const pricingDraftKey = createDraftKey<{ readonly loaded: UsagePricing; readonly rows: readonly UsagePriceDraft[]; readonly baseline: string }>('usage-pricing');

export function UsagePricingManager({ api, connected, setDirty, navigate, onSaved }: PageProps & { readonly onSaved: () => void }) {
  const recovery = useNativeCatalogOperation(api, 'pricing');
  const draftApi = useRef<PageProps['api'] | null>(null);
  const [loaded, setLoaded] = useState<UsagePricing | null>(null);
  const [rows, setRows] = useState<readonly UsagePriceDraft[]>([]);
  const [baseline, setBaseline] = useState('[]');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [readError, setReadError] = useState('');
  const [writeError, setWriteError] = useState('');
  const [state, setState] = useState<WriteState>('idle');
  const [reload, setReload] = useState(0);
  const [confirmReload, setConfirmReload] = useState(false);
  const [providers, setProviders] = useState<readonly UsagePricingProvider[]>([]);
  const [providersAvailable, setProvidersAvailable] = useState(false);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providerError, setProviderError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const nextKey = useRef(0);
  const list = useRef<VirtualListHandle>(null);
  const revealLast = useRef(false);
  const connection = useRef({ api, connected });
  connection.current = { api, connected };
  const dirtyCallback = useRef(setDirty);
  dirtyCallback.current = setDirty;
  const dirty = loaded !== null && JSON.stringify(rows) !== baseline;
  const blocked = recovery.blocked || state === 'conflict' || state === 'unknown' || state === 'busy';
  const locked = loading || saving || blocked;
  const view = useRef({ loaded, locked });
  view.current = { loaded, locked };

  function accept(value: UsagePricing): void {
    const drafts = value.prices.map(price => ({ key: nextKey.current++, provider: price.provider, model: price.model, currency: price.currency,
      inputPerMillion: String(price.inputPerMillion), outputPerMillion: String(price.outputPerMillion), cacheReadPerMillion: String(price.cacheReadPerMillion), cacheWritePerMillion: String(price.cacheWritePerMillion) }));
    setLoaded(value);
    setRows(drafts);
    setBaseline(JSON.stringify(drafts));
  }

  useEffect(() => {
    if (draftApi.current === api) retainDraft(api, pricingDraftKey, dirty && loaded ? { loaded, rows, baseline } : null);
    setDirty(dirty, 'usage-pricing');
  }, [api, dirty, loaded, rows, baseline, setDirty]);
  useEffect(() => () => { dirtyCallback.current(false, 'usage-pricing'); }, []);
  useEffect(() => {
    const request = ++epoch.current;
    const read = new AbortController();
    controller.current?.abort();
    controller.current = read;
    const current = () => !read.signal.aborted && epoch.current === request && connection.current.api === api && connection.current.connected;
    setLoading(connected);
    setSaving(false);
    const retained = connected ? retainedDraft(api, pricingDraftKey) : undefined;
    draftApi.current = api;
    setLoaded(retained?.loaded ?? null);
    setRows(retained?.rows ?? []);
    setBaseline(retained?.baseline ?? '[]');
    if (retained) nextKey.current = Math.max(0, ...retained.rows.map(row => row.key)) + 1;
    setReadError('');
    setWriteError('');
    setState('idle');
    setProviders([]);
    setProvidersAvailable(false);
    setProvidersLoading(connected);
    setProviderError('');
    if (connected) void readResource(api, '/api/chat/providers', read.signal).then(value => {
      if (!current()) return;
      const parsed = parseUsagePricingProviders(value);
      if (!parsed) throw new Error('invalid_usage_pricing_providers');
      setProviders(parsed);
      setProvidersAvailable(true);
    }).catch(() => { if (current()) setProviderError('暂时无法读取模型提供方目录，不能新增或更换路由；已保存规则的金额仍可编辑。'); })
      .finally(() => { if (current()) setProvidersLoading(false); });
    if (connected) void readResource(api, '/api/chat/usage/pricing', read.signal).then(value => {
      if (!current()) return;
      const parsed = parseUsagePricing(value);
      if (!parsed) throw new Error('invalid_usage_pricing');
      if (!retained) accept(parsed);
      recovery.review();
    }).catch(error => { if (current()) setReadError(errorMessage(error)); })
      .finally(() => { if (current()) { setLoading(false); controller.current = null; } });
    return () => { epoch.current += 1; read.abort(); controller.current?.abort(); };
  }, [api, connected, reload]);
  useEffect(() => {
    if (!revealLast.current) return;
    revealLast.current = false;
    list.current?.scrollToIndex(rows.length - 1);
  }, [rows]);

  function update(index: number, key: Exclude<keyof UsagePriceDraft, 'key'>, value: string): void {
    if (locked) return;
    setRows(current => current.map((row, rowIndex) => rowIndex === index ? { ...row, [key]: value } : row));
    setState('idle');
    setWriteError('');
  }
  function readAgain(): void {
    if (loading || saving) return;
    if (dirty) setConfirmReload(true);
    else setReload(value => value + 1);
  }
  async function save(): Promise<void> {
    if (!loaded || !dirty || locked || controller.current) return;
    const prices = pricesFromDraft(rows);
    if (!prices) { setWriteError('请填写唯一的提供方与模型、三位币种，以及 0–1,000,000 的四项每百万 Token 单价；空值不是零。'); return; }
    if (!validUsagePriceRoutes(prices, loaded.prices, providers)) { setWriteError('新增或更换计价对象前，请在模型提供方登记并启用服务与模型，再从目录中选择。原有未登记规则可以保留并编辑金额。'); return; }
    const write = new AbortController();
    const request = epoch.current;
    controller.current = write;
    const current = () => !write.signal.aborted && epoch.current === request && controller.current === write && connection.current.api === api && connection.current.connected;
    const token = recovery.begin(String(loaded.revision), write.signal);
    if (!token) { controller.current = null; return; }
    setSaving(true);
    setWriteError('');
    try {
      const value = await writeResource(api, '/api/chat/usage/pricing', { revision: loaded.revision, prices }, write.signal);
      if (!current()) return;
      const parsed = parseUsagePricing(value);
      if (!parsed) throw new ApiError('usage_pricing_operation_unknown', 504);
      recovery.complete(token);
      accept(parsed);
      setState('saved');
      onSaved();
    } catch (error) {
      if (!current()) return;
      const next = recovery.fail(token, error);
      setState(next);
      setWriteError(next === 'conflict' ? '单价已在其他位置修改，保存版本已变化。请保留草稿或重新读取核对，不会自动覆盖。'
        : next === 'unknown' ? '保存结果未知。不要再次提交；请重新载入核对当前单价，不会自动重试。' : errorMessage(error));
    } finally { if (current()) { controller.current = null; setSaving(false); } }
  }

  const builtin = loaded?.builtin;
  const builtinModels = builtin ? Object.entries(builtin.models).map(([name, model]) => ({ name, ...model })) : [];
  const priceLabel = (value: number) => value.toLocaleString('zh-CN', { maximumSignificantDigits: 12 });

  return <Section id={nativeFormMetadata.pricing.id} title={nativeFormMetadata.pricing.title} description="内置参考价目与可选人工覆盖；仅影响后续估算，不追溯重算历史。" actions={<Button size="sm" variant="outline" onClick={readAgain} disabled={loading || saving}><RefreshCw className="size-3.5" />重新读取单价</Button>}>
    <NativeCatalogRecovery recovery={recovery} reading={loading || saving} onRead={() => setReload(value => value + 1)} onReleased={() => { setState('idle'); setWriteError(''); }} />
    {builtin ? <details open className="mb-4 min-w-0 rounded-lg border p-4">
      <summary className="cursor-pointer text-sm font-medium">内置参考价目表</summary>
      <div className="mt-3 grid min-w-0 gap-3 text-xs leading-6">
        <p className="text-muted-foreground">{builtin.currency}（{builtin.symbol}）/ 百万 Token，以下为空闲时段单价。参考表不保证与服务商实时账单一致。</p>
        <div className="h-96 min-w-0 overflow-auto overscroll-contain rounded-lg border" role="region" aria-label="内置参考价目表">
          <table className="w-full min-w-[32rem] text-left text-xs" aria-rowcount={builtinModels.length + 1}>
            <thead className="sticky top-0 z-10 border-b bg-muted"><tr><th className="px-3 py-2.5 font-medium">模型</th><th className="px-3 py-2.5 font-medium">缓存命中</th><th className="px-3 py-2.5 font-medium">未命中输入</th><th className="px-3 py-2.5 font-medium">输出</th></tr></thead>
            <VirtualTableBody items={builtinModels} getItemKey={model => model.name} columns={4} estimateSize={68}>{model => <tr className="border-b"><td className="px-3 py-3"><strong className="font-medium">{model.label}</strong><span className="block break-all text-[11px] text-muted-foreground">{model.name}</span></td><td className="px-3 py-3 tabular-nums">{priceLabel(model.off.cacheHit)}</td><td className="px-3 py-3 tabular-nums">{priceLabel(model.off.cacheMiss)}</td><td className="px-3 py-3 tabular-nums">{priceLabel(model.off.output)}</td></tr>}</VirtualTableBody>
          </table>
        </div>
        <p className="text-muted-foreground">{builtinPricingSchedule(builtin)}</p>
        <p className="text-muted-foreground">缓存写入按未命中输入价推算，并非服务商单独公布的第四项价格。</p>
        <p className="text-muted-foreground">人工单价优先；{builtin.fallbackModel ? `未登记型号按默认参考价（${builtin.models[builtin.fallbackModel]?.label ?? builtin.fallbackModel}）估算，可人工覆盖；非该型号官方报价。` : '当前后端未声明默认参考价，未登记型号不自动套价。'}必要用量计数缺失时费用仍未知；历史金额和币种保持原样。</p>
      </div>
    </details> : <p className="mb-4 text-xs leading-6 text-muted-foreground" role="status">{loading ? '正在读取内置参考价目表…' : readError || '当前服务尚未提供内置参考价目表。'}</p>}
    <details data-usage-pricing-editor>
      <summary className="cursor-pointer text-xs font-medium">高级：人工单价覆盖</summary>
      <div className="mt-3 grid gap-3">
        <p className="text-xs leading-5 text-muted-foreground">四项单价单位均为对应币种 / 百万 Token；输入为未命中部分，缓存读取、缓存写入独立计价。推理不重复计费。必要用量计数缺失时费用仍未知；不同币种不相加。选择模型只设置计价对象，不连接模型或扩大调用授权。</p>
        <div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" onClick={() => navigate('providers')}>管理模型提供方</Button>{providersLoading && <span className="text-xs text-muted-foreground">正在读取模型目录</span>}{providerError && <span className="text-xs text-muted-foreground">{providerError}</span>}</div>
        {loading ? <p className="flex items-center gap-2 text-xs" role="status"><LoaderCircle className="size-3.5 animate-spin" />正在读取单价</p>
          : !loaded ? <p className="text-xs leading-5 text-muted-foreground">{readError || '当前数据源尚未提供可编辑的原生账本单价。'}已有统计仍可独立查看；可点击“重新读取单价”重试。</p>
            : <><div className="flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-muted-foreground">{rows.length}/256 条人工覆盖 · {loaded.revision === null ? '未保存人工单价' : '已读取人工单价'}</span><div className="flex flex-wrap gap-2">{builtin && <Button size="sm" variant="outline" disabled={locked || rows.length === 0} onClick={() => {
              if (view.current.locked || view.current.loaded !== loaded || controller.current || connection.current.api !== api || !connection.current.connected) return;
              setRows([]); setState('idle'); setWriteError('');
            }}>恢复内置参考价（待保存）</Button>}<Button id="usage-price-add" size="sm" variant="outline" disabled={locked || rows.length >= 256 || !providersAvailable || !providers.some(provider => provider.enabled && provider.models.length > 0)} onClick={() => { revealLast.current = true; setRows(current => [...current, { key: nextKey.current++, provider: '', model: '', currency: '', inputPerMillion: '', outputPerMillion: '', cacheReadPerMillion: '', cacheWritePerMillion: '' }]); }}><Plus className="size-3.5" />添加单价</Button></div></div>
              <div className="h-96 overflow-auto overscroll-contain rounded-lg border p-3" role="group" aria-label="模型计价规则">
                <VirtualList items={rows} getItemKey={row => row.key} estimateSize={270} listRef={list} itemClassName="pb-3">{(row, index) => {
                  const provider = providers.find(item => item.id === row.provider);
                  const model = provider?.models.find(item => item.id === row.model);
                  return <div className="grid gap-3 rounded-lg border p-3" data-usage-price-row={index}>
                  <div className="flex items-center justify-between"><span className="text-xs font-medium">计价规则 {index + 1}</span><Button size="icon-xs" variant="ghost" aria-label={`删除单价 ${index + 1}`} disabled={locked} onClick={() => setRows(current => current.filter(item => item.key !== row.key))}><Trash2 className="size-3.5" /></Button></div>
                  <div className="grid gap-3 sm:grid-cols-3"><Field label={nativeFormMetadata.pricing.fields.provider}><select id={`usage-price-provider-${index}`} className="h-8 w-full rounded-lg border bg-background px-2 text-xs" value={row.provider} disabled={locked || !providersAvailable} onChange={event => { const providerId = event.target.value; if (providers.some(item => item.enabled && item.id === providerId)) { update(index, 'provider', providerId); update(index, 'model', ''); } }}><option value="" disabled>选择已登记的提供方</option>{row.provider && !provider && <option value={row.provider}>未登记的提供方（保留现值）</option>}{providers.filter(item => item.enabled || item.id === row.provider).map(item => <option key={item.id} value={item.id} disabled={!item.enabled}>{item.name}{item.enabled ? '' : '（已停用，保留现值）'}</option>)}</select></Field><Field label={nativeFormMetadata.pricing.fields.model}><select id={`usage-price-model-${index}`} className="h-8 w-full rounded-lg border bg-background px-2 text-xs" value={row.model} disabled={locked || !provider?.enabled} onChange={event => { if (provider?.models.some(item => item.id === event.target.value)) update(index, 'model', event.target.value); }}><option value="" disabled>选择已登记的模型</option>{row.model && !model && <option value={row.model}>未登记的模型（保留现值）</option>}{provider?.models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label={nativeFormMetadata.pricing.fields.currency}><Input id={`usage-price-currency-${index}`} value={row.currency} maxLength={3} placeholder="例如 CNY 或 USD" disabled={locked} onChange={event => update(index, 'currency', event.target.value)} /></Field></div>
                  {row.provider && (!provider || !model) && <p className="text-[11px] leading-5 text-muted-foreground">当前计价对象未在目录中登记，原值保持不变；可继续编辑金额，或主动选择已登记的模型。不会自动替换现有对象。</p>}
                  <div className="grid gap-3 sm:grid-cols-2">{usagePriceComponents.map(component => <Field key={component.key} label={component.label} description="每百万 Token"><Input id={`usage-price-${component.key}-${index}`} type="number" min={0} max={1_000_000} step="any" value={row[component.key]} disabled={locked} onChange={event => update(index, component.key, event.target.value)} /></Field>)}</div>
                </div>; }}</VirtualList>
                {rows.length === 0 && <p className="text-xs text-muted-foreground">{builtin ? builtin.fallbackModel ? '没有人工覆盖；已登记型号使用内置参考价，未登记型号按默认参考价估算。' : '没有人工覆盖；本服务未声明默认参考价，未登记型号不自动套价。' : '尚无人工计价规则；没有适用单价不代表费用为零。'}</p>}
              </div>
              {builtin && rows.length === 0 && loaded.prices.length > 0 && <p className="text-xs leading-6 text-muted-foreground">保存后将清除人工覆盖，后续恢复内置参考计价；历史不会重算。</p>}
              {writeError && <p className="text-xs leading-5 text-destructive" role="alert">{writeError}</p>}
              <div className="flex flex-wrap items-center gap-2"><SaveBar dirty={dirty} saving={saving} disabled={locked} onSave={() => void save()} onReset={blocked ? undefined : () => { if (loaded) { accept(loaded); setState('idle'); setWriteError(''); } }} label="保存后续单价" message={state === 'saved' ? '单价已保存；旧轮次未重算。' : blocked ? '结果待核对，保存已锁定。' : dirty ? '单价草稿未保存；保存前会核对读取时的版本。' : '单价只用于后续入账，不会回填旧轮次。'} /></div>
            </>}
        {confirmReload && <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-xs" role="alert"><span>重新读取将丢弃未保存的单价草稿，且不会重新提交保存。</span><Button size="sm" variant="outline" onClick={() => setConfirmReload(false)}>保留草稿</Button><Button size="sm" variant="destructive" onClick={() => { retainDraft(api, pricingDraftKey, null); setConfirmReload(false); setReload(value => value + 1); }}>放弃草稿并重新读取</Button></div>}
      </div>
    </details>
  </Section>;
}
