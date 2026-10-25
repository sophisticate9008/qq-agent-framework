import assert from 'node:assert/strict';
import test from 'node:test';
import { createSqliteStore } from '../src/storage/sqlite.ts';
import { createNativeUsage, NATIVE_USAGE_TURNS_NAMESPACE, NATIVE_USAGE_ARCHIVE_NAMESPACE, NATIVE_USAGE_RETIRED_NAMESPACE, type NativeUsageTurn } from '../src/host/native-usage.ts';
import { createNativeUsageMaintenance } from '../src/host/native-usage-maintenance.ts';
import { parseNativeUsageMaintenanceOperation, parseNativeUsageExport } from '../src/contracts/native-usage-maintenance.ts';

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const turn: NativeUsageTurn = { conversationId: 'group:123', sessionId: 'session-one', generation: 1, turnId: 'turn-one', provider: 'fixture', model: 'fixture-model', status: 'completed', tokens: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, total: 5 }, reportedCost: { amount: 1, currency: 'USD' } };
const scope = { since: 0, until: 10_000 };

test('ledger archive is atomic, exact-preview scoped and preserves historical values and deduplication', context => {
  let now = 1000; const store = createSqliteStore({ filename: ':memory:', clock: () => now }); context.after(() => store.close());
  const usage = createNativeUsage({ store, clock: () => now }); const original = usage.append(turn); assert(!('retired' in original));
  usage.append({ ...turn, turnId: 'other-conversation', conversationId: 'group:456' });
  const evidence = store.write('host.executions', 'unsettled', { state: 'unknown', proof: 'keep' });
  const maintenance = createNativeUsageMaintenance({ store, clock: () => now });
  const preview = maintenance.preview({ action: 'preview', operationId: id(1), kind: 'archive', scope: { ...scope, conversationId: 'group:123' } });
  assert(parseNativeUsageMaintenanceOperation(preview)); assert.equal(preview.rows.length, 1); assert.equal(usage.summary().records, 2);
  assert.deepEqual(maintenance.preview({ action: 'preview', operationId: id(1), kind: 'archive', scope: { ...scope, conversationId: 'group:123' } }), preview);
  now++;
  const completed = maintenance.confirm({ action: 'confirm', operationId: preview.id, revision: preview.revision, confirm: true });
  assert.equal(completed.state, 'completed'); assert.equal(completed.affected, 1); assert.equal(usage.summary().records, 1);
  assert.equal(store.list(NATIVE_USAGE_ARCHIVE_NAMESPACE).length, 1); assert.deepEqual(usage.append(turn), original); assert.equal(usage.summary().records, 1);
  assert.deepEqual(maintenance.confirm({ action: 'confirm', operationId: preview.id, revision: preview.revision, confirm: true }), completed);
  const exported = maintenance.export(scope, 'archive'); assert(parseNativeUsageExport(exported)); assert.equal(exported.records, 1); assert(exported.data.includes('reported')); assert(exported.data.includes('pricingRevision')); assert.equal(JSON.parse(exported.data).records[0].cost.amount, 1);
  assert.deepEqual(store.read('host.executions', evidence.key), evidence);
});

test('ledger clear retains only deduplication receipts, protects unknown rows and never recreates cleared statistics', context => {
  const store = createSqliteStore({ filename: ':memory:', clock: () => 1000 }); context.after(() => store.close());
  const usage = createNativeUsage({ store, clock: () => 1000 }); const original = usage.append(turn); assert(!('retired' in original));
  usage.append({ ...turn, turnId: 'unknown', status: 'unknown' });
  const maintenance = createNativeUsageMaintenance({ store, clock: () => 1000 });
  const preview = maintenance.preview({ action: 'preview', operationId: id(2), kind: 'clear', scope }); assert.equal(preview.protectedUnknown, 1); assert.equal(preview.rows.length, 1);
  const completed = maintenance.confirm({ action: 'confirm', operationId: preview.id, revision: preview.revision, confirm: true }); assert.equal(completed.state, 'completed');
  assert.equal(usage.summary().records, 1); const receipt = store.list(NATIVE_USAGE_RETIRED_NAMESPACE)[0]; assert(receipt);
  assert.deepEqual(Object.keys(receipt.value as object).sort(), ['fingerprint', 'operationId', 'retiredAt', 'schema']);
  assert.deepEqual(usage.append(turn), { retired: true, cursor: original.cursor, fingerprint: (receipt.value as Record<string, unknown>).fingerprint });
  assert.equal(usage.summary().records, 1);
  assert.throws(() => usage.append({ ...turn, reportedCost: { amount: 2, currency: 'USD' } }), { code: 'USAGE_TURN_CONFLICT' });
  assert.equal(maintenance.get(preview.id)?.state, 'completed');
});

test('concurrent changes invalidate the complete ledger preview without partial deletion', context => {
  const store = createSqliteStore({ filename: ':memory:', clock: () => 1000 }); context.after(() => store.close());
  const usage = createNativeUsage({ store, clock: () => 1000 }); usage.append(turn); usage.append({ ...turn, turnId: 'second' });
  const maintenance = createNativeUsageMaintenance({ store, clock: () => 1000 }); const preview = maintenance.preview({ action: 'preview', operationId: id(3), kind: 'clear', scope });
  const changed = store.list(NATIVE_USAGE_TURNS_NAMESPACE)[0]; assert(changed); store.write(changed.namespace, changed.key, changed.value, { expectedRevision: changed.revision });
  const result = maintenance.confirm({ action: 'confirm', operationId: preview.id, revision: preview.revision, confirm: true });
  assert.equal(result.state, 'blocked'); assert.deepEqual(result.missingReasons, ['usage_preview_changed']);
  assert.equal(store.list(NATIVE_USAGE_TURNS_NAMESPACE).length, 2); assert.equal(store.list(NATIVE_USAGE_RETIRED_NAMESPACE).length, 0);
});

test('ledger scans remain bounded and exports preserve unknown coverage without message content', context => {
  const store = createSqliteStore({ filename: ':memory:', clock: () => 1000 }); context.after(() => store.close());
  const usage = createNativeUsage({ store, clock: () => 1000 });
  for (let index = 0; index < 70; index++) usage.append({ ...turn, turnId: `turn-${index}`, coverage: index === 0 ? 'partial' : 'complete' });
  const maintenance = createNativeUsageMaintenance({ store, clock: () => 1000 }); const preview = maintenance.preview({ action: 'preview', operationId: id(4), kind: 'archive', scope });
  assert.equal(preview.rows.length, 60); assert.equal(preview.partial, true); assert(preview.next);
  const exported = maintenance.export(scope); assert(parseNativeUsageExport(exported)); assert.equal(exported.records, 60); assert.equal(exported.partial, true);
  assert.equal(exported.data.includes('requestId'), false); assert.equal(exported.data.includes('prompt'), false); assert.equal(exported.data.includes('coverage'), true);
  assert.equal(maintenance.export({ ...scope, after: exported.next ?? undefined }).records, 10);
});

test('ledger HTTP ports preserve receipt identity and strictly scope export and confirmation', async context => {
  const { createNativeUsageMaintenanceRoutes } = await import('../src/admin/native-usage-maintenance.ts');
  const { createAdminServer } = await import('../src/admin/server.ts');
  const store = createSqliteStore({ filename: ':memory:', clock: () => 1000 }); context.after(() => store.close());
  const usage = createNativeUsage({ store, clock: () => 1000 }); usage.append(turn);
  const service = createNativeUsageMaintenance({ store, clock: () => 1000 }); let writes = 0;
  const server = createAdminServer({ token: 'ledger-http-fixture-token-1234567890', snapshot: () => ({}), routes: createNativeUsageMaintenanceRoutes({
    list: query => service.list(query), read: id => service.get(id), export: (scope, source) => service.export(scope, source), mutate: input => { writes++; return input.action === 'preview' ? service.preview(input) : service.confirm(input); }
  }) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); context.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert(address && typeof address !== 'string'); const origin = `http://127.0.0.1:${address.port}`;
  const headers = { origin, authorization: 'Bearer ledger-http-fixture-token-1234567890', 'content-type': 'application/json' };
  const post = (value: unknown) => fetch(`${origin}/api/chat/usage/maintenance`, { headers, method: 'POST', body: JSON.stringify(value) });
  const preview = await (await post({ action: 'preview', operationId: id(5), kind: 'clear', scope })).json(); assert(parseNativeUsageMaintenanceOperation(preview.operation));
  const listed = await fetch(`${origin}/api/chat/usage/maintenance?action=list&limit=20`, { headers }); assert.equal(listed.status, 200); const discovery = await listed.json(); assert.equal(discovery.operations[0]?.id, id(5)); assert.equal(JSON.stringify(discovery).includes('rows'), false);
  assert.equal((await fetch(`${origin}/api/chat/usage/maintenance?action=list&limit=21`, { headers })).status, 400);
  assert.equal((await fetch(`${origin}/api/chat/usage/maintenance?id=${id(5)}`, { headers })).status, 200); assert.equal(writes, 1); assert.equal(usage.summary().records, 1);
  assert.equal((await post({ action: 'confirm', operationId: id(5), revision: preview.operation.revision, confirm: false })).status, 400);
  const exported = await fetch(`${origin}/api/chat/usage/maintenance?action=export&source=active&since=0&until=10000`, { headers }); assert.equal(exported.status, 200); assert(parseNativeUsageExport(await exported.json())); assert.equal(writes, 1);
  assert.equal((await fetch(`${origin}/api/chat/usage/maintenance?action=export&since=0&until=10000&since=1`, { headers })).status, 400);
  const completed = await (await post({ action: 'confirm', operationId: id(5), revision: preview.operation.revision, confirm: true })).json(); assert.equal(completed.operation.state, 'completed'); assert.equal(usage.summary().records, 0);
});
test('persisted ledger operation discovery is bounded, read only and carries no record payloads', context => {
  const store = createSqliteStore({ filename: ':memory:', clock: () => 1000 }); context.after(() => store.close()); const maintenance = createNativeUsageMaintenance({ store, clock: () => 1000 });
  for (let number = 10; number < 35; number++) maintenance.preview({ action: 'preview', operationId: id(number), kind: 'archive', scope });
  const records = store.list('native-usage.maintenance'); const first = maintenance.list(); assert.equal(first.operations.length, 20); assert.equal(first.partial, true); assert(first.next); assert.deepEqual(store.list('native-usage.maintenance'), records);
  assert.deepEqual(Object.keys(first.operations[0] ?? {}).sort(), ['createdAt', 'expiresAt', 'id', 'kind', 'scope', 'state']); assert.equal(JSON.stringify(first).includes('references'), false); assert.equal(JSON.stringify(first).includes('rows'), false);
  const next = maintenance.list({ after: first.next }); assert.equal(next.operations.length, 5); assert.equal(next.partial, false); assert.deepEqual(store.list('native-usage.maintenance'), records);
  assert.throws(() => maintenance.list({ limit: 21 }), { code: 'USAGE_MAINTENANCE_INVALID' });
});
