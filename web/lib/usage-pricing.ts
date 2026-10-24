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

export function parseUsagePricing(value: unknown): UsagePricing | null {
  if (!isRecord(value) || value.revision !== null && (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 1)
    || !Array.isArray(value.prices) || value.prices.length > 256) return null;
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
  return { revision: value.revision, prices };
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
