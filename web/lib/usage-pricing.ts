export interface UsagePrice {
  readonly provider: string;
  readonly model: string;
  readonly currency: string;
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
  readonly cacheReadPerMillion: number;
  readonly cacheWritePerMillion: number;
}

export interface UsagePricing {
  readonly revision: number | null;
  readonly prices: readonly UsagePrice[];
  readonly builtin?: BuiltinUsagePricing;
}

export interface BuiltinUsagePricing {
  readonly version: string;
  readonly source: 'migrated-reference';
  readonly referenceOnly: true;
  readonly currency: string;
  readonly symbol: string;
  readonly unit: number;
  readonly pricingMode: 'time-of-use';
  readonly utcOffsetMinutes: number;
  readonly peakMultiplier: number;
  readonly peakWindows: readonly (readonly [number, number])[];
  readonly peakWeekdays: readonly number[];
  readonly holidays: readonly string[];
  readonly holidayCount: number;
  readonly holidayYears: readonly number[];
  readonly referenceModel: string;
  readonly fallbackModel?: string;
  readonly cacheWritePricing: 'same-as-cache-miss-assumption';
  readonly models: Readonly<Record<string, { readonly label: string; readonly off: {
    readonly cacheMiss: number; readonly cacheHit: number; readonly cacheWrite: number; readonly output: number;
  } }>>;
}

export interface UsagePricingProvider {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly models: readonly { readonly id: string; readonly name: string }[];
}

export function parseUsagePricingProviders(value: unknown): readonly UsagePricingProvider[] | null {
  if (!isRecord(value) || !Array.isArray(value.providers) || value.providers.length > 128) return null;
  const providers: UsagePricingProvider[] = [];
  for (const item of value.providers) {
    if (!isRecord(item) || !reference(item.id) || !reference(item.name) || typeof item.enabled !== 'boolean' || !Array.isArray(item.models) || item.models.length > 128) return null;
    const models: { id: string; name: string }[] = [];
    for (const candidate of item.models) {
      if (!isRecord(candidate) || !reference(candidate.id) || !reference(candidate.name)) return null;
      models.push({ id: candidate.id, name: candidate.name });
    }
    if (new Set(models.map(model => model.id)).size !== models.length) return null;
    providers.push({ id: item.id, name: item.name, enabled: item.enabled, models });
  }
  return new Set(providers.map(provider => provider.id)).size === providers.length ? providers : null;
}

export function validUsagePriceRoutes(prices: readonly UsagePrice[], saved: readonly UsagePrice[], providers: readonly UsagePricingProvider[]): boolean {
  return prices.every(price => saved.some(prior => prior.provider === price.provider && prior.model === price.model)
    || providers.some(provider => provider.enabled && provider.id === price.provider && provider.models.some(model => model.id === price.model)));
}

export const usagePriceComponents = [
  { key: 'inputPerMillion', label: '未命中输入单价' },
  { key: 'outputPerMillion', label: '输出单价' },
  { key: 'cacheReadPerMillion', label: '缓存读取单价' },
  { key: 'cacheWritePerMillion', label: '缓存写入单价' },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function reference(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value); }

export function parseBuiltinPricing(value: unknown): BuiltinUsagePricing | null {
  if (!isRecord(value) || !reference(value.version) || value.source !== 'migrated-reference' || value.referenceOnly !== true
    || typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency) || !reference(value.symbol)
    || value.unit !== 1_000_000 || value.pricingMode !== 'time-of-use'
    || typeof value.utcOffsetMinutes !== 'number' || !Number.isSafeInteger(value.utcOffsetMinutes) || Math.abs(value.utcOffsetMinutes) > 1440
    || typeof value.peakMultiplier !== 'number' || !Number.isFinite(value.peakMultiplier) || value.peakMultiplier < 1 || value.peakMultiplier > 1000
    || !Array.isArray(value.peakWindows) || value.peakWindows.length > 24
    || !Array.isArray(value.peakWeekdays) || value.peakWeekdays.length > 7
    || !value.peakWeekdays.every(day => typeof day === 'number' && Number.isInteger(day) && day >= 1 && day <= 7)
    || new Set(value.peakWeekdays).size !== value.peakWeekdays.length
    || !Array.isArray(value.holidayYears) || value.holidayYears.length > 100
    || !value.holidayYears.every(year => typeof year === 'number' && Number.isSafeInteger(year) && year >= 1970 && year <= 9999)
    || new Set(value.holidayYears).size !== value.holidayYears.length
    || !Array.isArray(value.holidays) || value.holidays.length > 3660
    || !value.holidays.every(day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)
      && Number.isFinite(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day)
    || new Set(value.holidays).size !== value.holidays.length
    || value.holidayCount !== value.holidays.length || !reference(value.referenceModel)
    || value.cacheWritePricing !== 'same-as-cache-miss-assumption'
    || !isRecord(value.models) || Object.keys(value.models).length < 1 || Object.keys(value.models).length > 256) return null;
  const holidayYears = value.holidayYears as number[];
  if (!value.holidays.every(day => holidayYears.includes(Number(String(day).slice(0, 4))))) return null;
  const peakWindows: [number, number][] = [];
  for (const window of value.peakWindows) {
    if (!Array.isArray(window) || window.length !== 2 || window.some(hour => typeof hour !== 'number' || !Number.isFinite(hour) || hour < 0 || hour > 24)
      || window[0] >= window[1]) return null;
    peakWindows.push([window[0] as number, window[1] as number]);
  }
  const models: Record<string, BuiltinUsagePricing['models'][string]> = {};
  for (const [name, model] of Object.entries(value.models)) {
    if (!reference(name) || !isRecord(model) || !reference(model.label)) return null;
    const off = model.off;
    if (!isRecord(off) || ['cacheMiss', 'cacheHit', 'cacheWrite', 'output'].some(key => typeof off[key] !== 'number'
      || !Number.isFinite(off[key]) || Number(off[key]) < 0 || Number(off[key]) > 1_000_000)) return null;
    models[name] = { label: model.label, off: { cacheMiss: Number(off.cacheMiss), cacheHit: Number(off.cacheHit),
      cacheWrite: Number(off.cacheWrite), output: Number(off.output) } };
  }
  if (!Object.hasOwn(models, value.referenceModel)) return null;
  const fallbackModel = Object.hasOwn(value, 'fallbackModel') ? value.fallbackModel : undefined;
  if (fallbackModel !== undefined && (!reference(fallbackModel) || !Object.hasOwn(value.models, fallbackModel)
    || !Object.hasOwn(models, fallbackModel))) return null;
  return { version: value.version, source: 'migrated-reference', referenceOnly: true, currency: value.currency, symbol: value.symbol,
    unit: 1_000_000, pricingMode: 'time-of-use', utcOffsetMinutes: value.utcOffsetMinutes,
    peakMultiplier: value.peakMultiplier, peakWindows, peakWeekdays: value.peakWeekdays as number[],
    holidays: value.holidays as string[], holidayCount: value.holidays.length, holidayYears,
    referenceModel: value.referenceModel, ...(typeof fallbackModel === 'string' ? { fallbackModel } : {}),
    cacheWritePricing: 'same-as-cache-miss-assumption', models };
}

export function builtinPricingSchedule(pricing: BuiltinUsagePricing): string {
  const time = (hour: number) => `${String(Math.floor(hour)).padStart(2, '0')}:${String(Math.round(hour * 60) % 60).padStart(2, '0')}`;
  const windows = pricing.peakWindows.map(([start, end]) => `${time(start)}–${time(end)}`).join('、');
  const weekdays = pricing.peakWeekdays.join(',') === '1,2,3,4,5' ? '周一至周五'
    : pricing.peakWeekdays.map(day => ['周一', '周二', '周三', '周四', '周五', '周六', '周日'][day - 1]).join('、');
  const timezone = pricing.utcOffsetMinutes === 480 ? '北京时间' : `UTC${pricing.utcOffsetMinutes >= 0 ? '+' : ''}${pricing.utcOffsetMinutes / 60}`;
  return `${timezone}${weekdays} ${windows} 为峰时，单价为表中空闲价的 ${pricing.peakMultiplier} 倍；其他时段按空闲价。节假日资料覆盖 ${pricing.holidayYears.join('、') || '未提供'} 年，共 ${pricing.holidayCount} 天不加价；未覆盖年份的潜在峰时不估价。`;
}

export function parseUsagePricing(value: unknown): UsagePricing | null {
  if (!isRecord(value) || value.revision !== null && (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 1)
    || !Array.isArray(value.prices) || value.prices.length > 256) return null;
  const builtin = value.builtin === undefined ? undefined : parseBuiltinPricing(value.builtin);
  if (builtin === null) return null;
  const prices: UsagePrice[] = [];
  const routes = new Set<string>();
  for (const item of value.prices) {
    if (!isRecord(item) || Object.keys(item).length !== 7 || !reference(item.provider) || !reference(item.model)
      || typeof item.currency !== 'string' || !/^[A-Z]{3}$/.test(item.currency)
      || usagePriceComponents.some(({ key }) => typeof item[key] !== 'number' || !Number.isFinite(item[key]) || item[key] < 0 || item[key] > 1_000_000)) return null;
    const route = JSON.stringify([item.provider, item.model]);
    if (routes.has(route)) return null;
    routes.add(route);
    prices.push({ provider: item.provider, model: item.model, currency: item.currency,
      inputPerMillion: Number(item.inputPerMillion), outputPerMillion: Number(item.outputPerMillion), cacheReadPerMillion: Number(item.cacheReadPerMillion), cacheWritePerMillion: Number(item.cacheWritePerMillion) });
  }
  return { revision: value.revision, prices, ...(builtin === undefined ? {} : { builtin }) };
}

export interface UsagePriceDraft {
  readonly key: number;
  readonly provider: string;
  readonly model: string;
  readonly currency: string;
  readonly inputPerMillion: string;
  readonly outputPerMillion: string;
  readonly cacheReadPerMillion: string;
  readonly cacheWritePerMillion: string;
}

export function pricesFromDraft(rows: readonly UsagePriceDraft[]): readonly UsagePrice[] | null {
  if (rows.some(row => usagePriceComponents.some(({ key }) => !row[key].trim() || !/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(row[key].trim())))) return null;
  return parseUsagePricing({ revision: null, prices: rows.map(row => ({ provider: row.provider.trim(), model: row.model.trim(), currency: row.currency.trim().toUpperCase(),
    inputPerMillion: Number(row.inputPerMillion), outputPerMillion: Number(row.outputPerMillion), cacheReadPerMillion: Number(row.cacheReadPerMillion), cacheWritePerMillion: Number(row.cacheWritePerMillion) })) })?.prices ?? null;
}
