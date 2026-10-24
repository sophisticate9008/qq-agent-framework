import { createSqliteStore } from '../../src/storage/sqlite.ts';
import { createNativeUsage, type NativeUsageTurn } from '../../src/host/native-usage.ts';
import { createNativeUsageProjection } from '../../src/host/native-usage-projection.ts';

export function createNativeUsagePageFixture() {
  let now = Date.UTC(2026, 9, 25, 12);
  let store = createSqliteStore({ filename: ':memory:' });
  let usage = createNativeUsage({ store, clock: () => now });
  let projection = createNativeUsageProjection({ usage, clock: () => now });
  let mode = 'normal';
  let writes = 0;
  let submittedRevisions: unknown[] = [];
  const basePrice = { provider: 'fixture-provider', model: 'fixture-model', currency: 'USD', inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1, cacheWritePerMillion: 0.5 };
  const baseTurn: NativeUsageTurn = { conversationId: 'private:123', sessionId: 'isolated-native-session', generation: 1, turnId: 'turn-0', stepId: 'step-0', coverage: 'complete',
    provider: basePrice.provider, model: basePrice.model, status: 'completed', tokens: { input: 100_000, output: 20_000, cacheRead: 40_000, cacheWrite: 10_000, total: 170_000 }, reportedCost: null };
  function seed(kind: string): void {
    store.close();
    store = createSqliteStore({ filename: ':memory:' });
    usage = createNativeUsage({ store, clock: () => now });
    projection = createNativeUsageProjection({ usage, clock: () => now });
    writes = 0;
    submittedRevisions = [];
    mode = 'normal';
    if (kind === 'empty') return;
    usage.setPricing([basePrice], null);
    for (let index = 0; index < 80; index++) usage.append({ ...baseTurn, turnId: `turn-${index}`, stepId: `step-${index}` });
    if (kind === 'partial' || kind === 'mixed') usage.append({ ...baseTurn, turnId: 'unknown-turn', stepId: 'unknown-step', coverage: 'unknown', tokens: { input: null, output: null, cacheRead: null, cacheWrite: null, total: null } });
    if (kind === 'mixed') usage.append({ ...baseTurn, turnId: 'reported-cny', stepId: 'reported-step', reportedCost: { amount: 3, currency: 'CNY' } });
  }
  seed('partial');
  function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
  return {
    close() { store.close(); },
    handle(method: string, path: string, body?: unknown): { readonly status: number; readonly body: unknown } {
      const url = new URL(path, 'http://fixture.invalid');
      const success = (value: unknown) => ({ status: 200, body: value });
      if (url.pathname === '/isolated-native-control' && method === 'POST') {
        const input = object(body);
        if (input.action === 'seed' && ['empty', 'complete', 'partial', 'mixed'].includes(String(input.kind))) seed(String(input.kind));
        else if (input.action === 'write-mode' && ['normal', 'conflict', 'unknown'].includes(String(input.mode))) mode = String(input.mode);
        else if (input.action === 'append') { now += 1000; usage.append({ ...baseTurn, turnId: `new-turn-${now}`, stepId: `new-step-${now}` }); }
        else if (input.action === 'large-prices') usage.setPricing(Array.from({ length: 256 }, (_, index) => ({ ...basePrice, model: index === 0 ? basePrice.model : `fixture-model-${index}` })), usage.pricing().revision);
        else return { status: 400, body: { error: 'invalid_fixture_control' } };
        return success({ ok: true });
      }
      if (url.pathname === '/isolated-native-state') {
        const records = usage.snapshot().items;
        return success({ writes, submittedRevisions, pricing: usage.pricing(),
          originalCost: records.find(item => item.turnId === 'turn-0')?.cost ?? null,
          newestCost: usage.recent({ limit: 1 }).items[0]?.cost ?? null });
      }
      if (method === 'GET') {
        if (url.pathname === '/api/chat/providers') return success({ revision: 'isolated-provider-catalog', providers: [{ id: basePrice.provider, name: '合成模型服务', enabled: true,
          models: Array.from({ length: 128 }, (_, index) => ({ id: index === 0 ? basePrice.model : `fixture-model-${index}`, name: index === 0 ? '合成聊天模型' : `合成模型 ${index}` })) }] });
        if (url.pathname === '/api/chat/usage') return success(projection.summary({ limit: Number(url.searchParams.get('limit') ?? 200) }));
        if (url.pathname === '/api/chat/usage/series') return success(projection.series(Number(url.searchParams.get('hours') ?? 24), Number(url.searchParams.get('buckets') ?? 48)));
        if (url.pathname === '/api/chat/usage/turns') return success(projection.conversation(url.searchParams.get('key') ?? 'private:123', { limit: Number(url.searchParams.get('limit') ?? 200) }));
        if (url.pathname === '/api/chat/usage/recent') return success(projection.recent({ limit: Number(url.searchParams.get('limit') ?? 40) }));
        if (url.pathname === '/api/chat/usage/pricing') return success(usage.pricing());
      }
      if (method === 'POST' && url.pathname === '/api/chat/usage/pricing') {
        writes++;
        const input = object(body);
        submittedRevisions.push(input.revision);
        if (mode === 'conflict') { usage.setPricing([{ ...basePrice, inputPerMillion: 9 }], usage.pricing().revision); mode = 'normal'; }
        try {
          const updated = usage.setPricing(input.prices, input.revision as number | null);
          if (mode === 'unknown') { mode = 'normal'; return { status: 500, body: { error: 'usage_pricing_operation_unknown' } }; }
          return success(updated);
        } catch (error) {
          return object(error).code === 'STORE_CONFLICT' ? { status: 409, body: { error: 'usage_pricing_revision_conflict' } } : { status: 400, body: { error: 'invalid_usage_pricing' } };
        }
      }
      return { status: 404, body: { error: 'isolated_fixture_route_missing' } };
    },
  };
}
