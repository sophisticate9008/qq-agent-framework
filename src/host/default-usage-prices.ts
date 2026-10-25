import { assert, snapshot } from '../core/values.ts'

export interface DefaultUsagePriceModel {
  readonly label: string
  readonly off: { readonly cacheMiss: number; readonly cacheHit: number; readonly cacheWrite: number; readonly output: number }
}

export interface DefaultUsagePriceTable {
  readonly version: string
  readonly source: 'migrated-reference'
  readonly referenceOnly: true
  readonly currency: 'CNY'
  readonly symbol: '¥'
  readonly unit: 1_000_000
  readonly pricingMode: 'time-of-use'
  readonly utcOffsetMinutes: 480
  readonly peakMultiplier: 2
  readonly peakWindows: readonly (readonly [number, number])[]
  readonly peakWeekdays: readonly number[]
  readonly holidays: readonly string[]
  readonly holidayCount: number
  readonly holidayYears: readonly number[]
  readonly referenceModel: string
  readonly fallbackModel?: string
  readonly cacheWritePricing: 'same-as-cache-miss-assumption'
  readonly models: Readonly<Record<string, DefaultUsagePriceModel>>
}

const referenceHolidays = [
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
] as const

export function createDefaultUsagePriceTable({ holidays = referenceHolidays, holidayYears = [2026] }:
  { readonly holidays?: readonly string[]; readonly holidayYears?: readonly number[] } = {}): DefaultUsagePriceTable {
  assert(Array.isArray(holidays) && holidays.length <= 3_660 && new Set(holidays).size === holidays.length
    && holidays.every(date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
      && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date)
    && Array.isArray(holidayYears) && holidayYears.length <= 100 && new Set(holidayYears).size === holidayYears.length
    && holidayYears.every(year => Number.isSafeInteger(year) && year >= 1970 && year <= 9999)
    && holidays.every(date => holidayYears.includes(Number(date.slice(0, 4)))),
  'USAGE_INVALID_PRICING', 'Explicit holiday dates and their covered years are required.')
  const flash = { label: 'DeepSeek Flash', off: { cacheMiss: 1, cacheHit: 0.02, cacheWrite: 1, output: 4 } }
  const pro = { label: 'DeepSeek Pro', off: { cacheMiss: 4.5, cacheHit: 0.15, cacheWrite: 4.5, output: 13.5 } }
  return snapshot<DefaultUsagePriceTable>({
    version: 'migrated-reference-v2', source: 'migrated-reference', referenceOnly: true,
    currency: 'CNY', symbol: '¥', unit: 1_000_000, pricingMode: 'time-of-use', utcOffsetMinutes: 480,
    peakMultiplier: 2, peakWindows: [[9, 12], [14, 18]], peakWeekdays: [1, 2, 3, 4, 5],
    holidays: [...holidays], holidayCount: holidays.length, holidayYears: [...holidayYears],
    referenceModel: 'deepseek-flash', fallbackModel: 'deepseek-flash', cacheWritePricing: 'same-as-cache-miss-assumption',
    models: {
      'deepseek-flash': flash,
      'deepseek-v4-flash': flash,
      'deepseek-v4-flash-vision-exp': flash,
      'deepseek-v4-pro': pro,
    },
  })
}

export const DEFAULT_USAGE_PRICE_TABLE = createDefaultUsagePriceTable()

export function defaultUsagePriceAt(model: string, at: number, table: DefaultUsagePriceTable = DEFAULT_USAGE_PRICE_TABLE) {
  if (typeof model !== 'string' || model.length === 0 || !Number.isSafeInteger(at) || at < 0) return null
  const referenceModel = Object.hasOwn(table.models, model) ? model : table.fallbackModel
  if (typeof referenceModel !== 'string' || !Object.hasOwn(table.models, referenceModel)) return null
  const entry = table.models[referenceModel]!
  const fallbackUsed = referenceModel !== model
  const date = new Date(at + table.utcOffsetMinutes * 60_000)
  if (!Number.isFinite(date.getTime())) return null
  const calendarKnown = table.holidayYears.includes(date.getUTCFullYear())
  const weekday = date.getUTCDay() || 7
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60
  const peakWindow = table.peakWeekdays.includes(weekday)
    && table.peakWindows.some(([start, end]) => hour >= start && hour < end)
  if (peakWindow && !calendarKnown) return null
  const peak = peakWindow && !table.holidays.includes(date.toISOString().slice(0, 10))
  const multiplier = peak ? table.peakMultiplier : 1
  return snapshot({ model, requestedModel: model, referenceModel, fallbackUsed,
    label: fallbackUsed ? '默认估价' : entry.label, tier: peak ? 'peak' as const : 'off' as const,
    tierLabel: peak ? '高峰时段' : '空闲时段', currency: table.currency, symbol: table.symbol, unit: table.unit,
    estimated: true, referenceOnly: true, source: table.source, version: table.version, calendarKnown,
    cacheMiss: entry.off.cacheMiss * multiplier, cacheHit: entry.off.cacheHit * multiplier,
    cacheWrite: entry.off.cacheWrite * multiplier, output: entry.off.output * multiplier,
    cacheWritePricing: table.cacheWritePricing })
}
