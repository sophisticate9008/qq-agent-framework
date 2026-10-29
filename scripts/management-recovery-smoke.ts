import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { Page } from 'playwright';
import { createSqliteStore } from '../src/storage/sqlite.ts';
import { createNativeUsage } from '../src/host/native-usage.ts';
import { createNativeUsageMaintenance } from '../src/host/native-usage-maintenance.ts';
import { createNativeUsageMaintenanceRoutes } from '../src/admin/native-usage-maintenance.ts';
import { executionRecord } from '../test/fixtures/execution-records.ts';
import { navigateConsolePage } from './browser-navigation-smoke.ts';
export function usageMaintenanceFixture() {
  const at = Date.now() - 3600_000; const store = createSqliteStore({ filename: ':memory:', clock: () => at }); const usage = createNativeUsage({ store, clock: () => at });
  const base = { conversationId: 'group:456001', sessionId: 'browser-ledger', generation: 1, turnId: 'archive-one', provider: 'fixture', model: 'fixture-model', status: 'completed' as const, tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 }, reportedCost: { amount: 2, currency: 'USD' } };
  usage.append(base); usage.append({ ...base, conversationId: 'group:456002', turnId: 'clear-one' }); usage.append({ ...base, turnId: 'protected-unknown', status: 'unknown' });
  const service = createNativeUsageMaintenance({ store });
  return { store, usage, service, routes: createNativeUsageMaintenanceRoutes({ list: query => service.list(query), read: id => service.get(id), export: (scope, source) => service.export(scope, source), mutate: request => request.action === 'preview' ? service.preview(request) : service.confirm(request) }) };
}
export async function exerciseUsageMaintenance(page: Page, fixture: ReturnType<typeof usageMaintenanceFixture>): Promise<void> {
  await navigateConsolePage(page, 'usage'); const card = page.locator('#native-usage-maintenance');
  await card.getByRole('textbox', { name: '会话筛选', exact: true }).fill('group:456001');
  await card.getByRole('button', { name: '预览归档', exact: true }).click(); await card.getByText('归档预览：1 条；保护未知记录 1 条；已完成 0 条。', { exact: true }).waitFor();
  assert.equal(fixture.usage.summary().records, 3);
  await navigateConsolePage(page, 'overview'); await navigateConsolePage(page, 'usage');
  await card.getByText('归档预览：1 条；保护未知记录 1 条；已完成 0 条。', { exact: true }).waitFor();
  await card.getByRole('checkbox', { name: '我已核对本次预览，确认归档以上精确记录', exact: true }).check();
  await card.getByRole('button', { name: '确认本批归档', exact: true }).click(); await card.getByText('本批操作已持久完成。', { exact: true }).waitFor(); assert.equal(fixture.usage.summary().records, 2);
  const downloaded = page.waitForEvent('download'); await card.getByRole('button', { name: '导出归档 JSON', exact: true }).click(); const download = await downloaded; const path = await download.path(); assert(path);
  const data: unknown = JSON.parse(await readFile(path, 'utf8')); assert(data && typeof data === 'object' && 'records' in data && Array.isArray(data.records)); assert.equal(data.records.length, 1); assert.equal(data.records[0].cost.amount, 2);
  await card.getByRole('textbox', { name: '会话筛选', exact: true }).fill('group:456002'); await card.getByRole('button', { name: '预览清理', exact: true }).click(); await card.getByText('清理预览：1 条；保护未知记录 0 条；已完成 0 条。', { exact: true }).waitFor();
  let confirmations = 0;
  await page.route('**/api/chat/usage/maintenance', async route => {
    if (route.request().method() !== 'POST' || route.request().postDataJSON().action !== 'confirm') return route.continue();
    confirmations++; const response = await route.fetch(); assert.equal(response.status(), 200); return route.fulfill({ status: 504, json: { error: 'usage_maintenance_unknown' } });
  });
  await card.getByRole('checkbox', { name: '我已核对本次预览，确认永久清理以上精确记录', exact: true }).check(); await card.getByRole('button', { name: '确认本批清理', exact: true }).click();
  await card.getByText('结果未知。仅按原操作标识读取结果，不会重新提交。', { exact: true }).waitFor(); assert.equal(confirmations, 1); assert.equal(fixture.usage.summary().records, 1);
  await navigateConsolePage(page, 'overview'); await navigateConsolePage(page, 'usage');
  await card.getByText('结果未知。仅按原操作标识读取结果，不会重新提交。', { exact: true }).waitFor();
  await card.getByRole('button', { name: '读取原操作结果', exact: true }).click(); await card.getByText('已读取原操作的持久状态。', { exact: true }).waitFor(); assert.equal(confirmations, 1);
  assert.equal(fixture.usage.summary().records, 1); await page.unroute('**/api/chat/usage/maintenance');
  await page.reload(); await page.locator('[data-page="usage"]').waitFor(); const history = card.locator('[data-usage-operation-history]'); await history.locator('summary').click(); await history.getByRole('button', { name: '读取首批操作记录', exact: true }).click(); await history.getByText('2 项已读取', { exact: false }).waitFor(); const clear = history.locator('div.rounded.border').filter({ hasText: '清理 · completed' }); await clear.getByRole('button', { name: '读取此操作详情', exact: true }).click(); await card.getByText('已读取原操作的持久状态。', { exact: true }).waitFor(); assert.equal(confirmations, 1); assert.equal(fixture.usage.summary().records, 1);
}
export async function exerciseExecutionRecovery(page: Page): Promise<void> {
  const entry = executionRecord(999, { status: 'unknown', externalStatus: 'unknown', cancelStatus: 'unknown', isolated: true });
  const revision = 'd'.repeat(64); let view: unknown = null; let previews = 0; let commits = 0; let reconciles = 0;
  await page.route('**/api/chat/executions**', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.pathname === '/api/chat/executions/recovery') return route.fulfill({ json: { native: true, item: view, automaticReplayAvailable: false } });
    if (url.pathname.endsWith('/recovery/preview')) { previews++; view = { schema: 1, executionId: entry.id, revision, conversationId: entry.binding.conversationId, sourceSessionId: entry.binding.sessionId, sourceGeneration: 1, childSessionId: null, state: 'available', missingReasons: [], restartRequired: true, automaticReplayAvailable: false }; return route.fulfill({ json: view }); }
    if (url.pathname.endsWith('/recovery/commit')) { commits++; assert.equal(request.postDataJSON().revision, revision); view = { ...(view as object), state: commits === 1 ? 'unknown' : 'confirmed', childSessionId: commits === 1 ? null : 'browser-new-session' }; return route.fulfill(commits === 1 ? { status: 504, json: { error: 'execution_recovery_unknown' } } : { json: view }); }
    if (url.pathname.endsWith('/reconcile')) { reconciles++; return route.fulfill({ json: { state: 'blocked', execution: entry, evidence: null, missingReasons: ['execution_cancel_unknown'], automaticReplayAvailable: false, restartRequired: false } }); }
    return route.fulfill({ json: url.searchParams.has('id') ? { native: true, item: entry, manualCancelAvailable: false } : { native: true, items: [entry], next: null, manualCancelAvailable: false } });
  });
  await page.route('**/api/chat/diagnostics?*', route => route.fulfill({ json: { schema: 1, source: 'native-chat', conversationId: new URL(route.request().url()).searchParams.get('conversationId'), observedAt: Date.now(), state: 'blocked', checks: [{ code: 'execution_isolated', state: 'blocked', summary: '此会话执行证据未确认。', nextAction: '核对持久执行结果。', href: '#sessions' }], input: { mention: true, reply: true, nicknames: ['测试伙伴'], continuationMs: 15000 }, context: { source: 'active-session', limit: 196608, headroomTokens: null, modelWindow: null, maxOutput: null }, coverage: { history: 'partial', scannedPerNamespace: 256, live: true }, automaticReplayAvailable: false } }));
  await navigateConsolePage(page, 'sessions'); const journal = page.locator('#execution-journal'); await journal.locator('[data-execution-journal] > summary').click();
  const card = journal.locator('[data-execution-management]'); await card.getByRole('checkbox').check(); await card.getByRole('button', { name: '核对执行结果', exact: true }).click();
  await card.getByText('证据不足，保持隔离。', { exact: true }).waitFor(); assert.equal(reconciles, 1);
  await card.getByRole('checkbox').check(); await card.getByRole('button', { name: '预览保留上下文恢复', exact: true }).click(); await card.getByText('恢复状态：available · 第 1 代', { exact: true }).waitFor(); assert.equal(previews, 1); assert.equal(commits, 0);
  await card.getByRole('checkbox').check(); await card.getByRole('button', { name: '确认创建新的会话地址', exact: true }).click(); await card.getByText('管理操作结果未知，请按原执行标识读取；不会自动重试。', { exact: true }).waitFor(); assert.equal(commits, 1);
  await page.reload(); await page.locator('[data-page="sessions"]').waitFor(); await journal.locator('[data-execution-journal] > summary').click();
  await card.getByRole('button', { name: '核对原恢复请求', exact: true }).waitFor(); assert.equal(commits, 1); assert.equal(previews, 1);
  await card.getByRole('checkbox', { name: '核对原恢复请求；服务仅观察原 revision，禁止再次创建会话', exact: true }).check(); await card.getByRole('button', { name: '核对原恢复请求', exact: true }).click(); await card.getByText('恢复状态：confirmed · 第 1 代', { exact: true }).waitFor(); assert.equal(commits, 2);
  await card.getByText('原会话：isolated-session-999；新会话：browser-new-session', { exact: true }).waitFor();
  const diagnostics = page.locator('#conversation-diagnostics'); await diagnostics.getByRole('textbox', { name: '诊断会话', exact: true }).fill('group:100999'); await diagnostics.getByRole('button', { name: '检查会话', exact: true }).click();
  await diagnostics.getByText('此会话执行证据未确认。', { exact: false }).waitFor(); await diagnostics.getByText('历史不完整，未发现不能等同于没有阻碍。', { exact: false }).waitFor(); await diagnostics.getByText('上下文策略来源：当前运行会话', { exact: false }).waitFor();
  await page.unroute('**/api/chat/executions**'); await page.unroute('**/api/chat/diagnostics?*');
}
export async function exerciseCapacityRecommendations(page: Page): Promise<void> {
  await navigateConsolePage(page, 'model'); const editor = page.locator('#native-plan-editor');
  const group = editor.getByRole('spinbutton', { name: '群聊上下文', exact: false });
  const privateContext = editor.getByRole('spinbutton', { name: '私聊上下文', exact: false });
  await editor.getByRole('button', { name: '使用模型建议容量', exact: true }).waitFor();
  const originalGroup = await group.inputValue(); const originalPrivate = await privateContext.inputValue();
  assert.equal(originalGroup, '172000'); assert.equal(originalPrivate, '384000');
  await editor.getByRole('button', { name: '使用模型建议容量', exact: true }).click();
  assert.equal(await group.inputValue(), '196608'); assert.equal(await privateContext.inputValue(), '262144');
  await editor.getByRole('button', { name: '撤销更改', exact: true }).click(); assert.equal(await group.inputValue(), originalGroup); assert.equal(await privateContext.inputValue(), originalPrivate);
  await page.getByRole('button', { name: '新建方案', exact: true }).click(); await group.fill('12345');
  await editor.getByText('模型提供方', { exact: true }).locator('xpath=ancestor::label[1]').locator('select').selectOption('fixture-provider');
  await editor.locator('#chat-plan-model').selectOption('fixture-model');
  await page.waitForFunction(() => { const label = [...document.querySelectorAll('#native-plan-editor label')].find(item => item.querySelector('.field-label')?.textContent === '私聊上下文'); return label?.querySelector('input')?.value === '262144'; });
  assert.equal(await group.inputValue(), '12345');
  await navigateConsolePage(page, 'overview'); await navigateConsolePage(page, 'model'); assert.equal(await group.inputValue(), '12345'); assert.equal(await privateContext.inputValue(), '262144');
  await editor.getByRole('button', { name: '撤销更改', exact: true }).click();
}
export async function exerciseMediaAndInteractions(page: Page): Promise<void> {
  const now = Date.now(); let writes = 0; let later = false;
  await page.route('**/api/chat/media?*', route => {
    assert.equal(route.request().method(), 'GET'); const conversationId = new URL(route.request().url()).searchParams.get('conversationId');
    return route.fulfill({ json: { schema: 1, conversationId, observedAt: now, running: true, coverage: 'partial', capabilities: { image: true, audio: false, file: true, forward: true, quote: true }, quote: { messageId: 'browser-quote', at: now, status: 'rejected', code: 'QUOTED_CONTEXT_SCOPE_MISMATCH' }, items: [
      { kind: 'image', contentRead: true, bytesRead: true, readingAvailable: true, missingReasons: [], lastRead: { at: now, status: 'confirmed', code: null } },
      { kind: 'audio', contentRead: false, bytesRead: false, readingAvailable: false, missingReasons: ['native_media_transcriber_not_connected'], lastRead: { at: now, status: 'rejected', code: 'native_media_transcriber_not_connected' } },
      { kind: 'file', contentRead: false, bytesRead: false, readingAvailable: true, missingReasons: [], lastRead: { at: now, status: 'unknown', code: 'native_media_read_unknown' } },
      { kind: 'forward', contentRead: false, bytesRead: false, readingAvailable: true, missingReasons: [], lastRead: { at: now, status: 'rejected', code: 'forward_scope_mismatch' } },
    ].map((item, index) => ({ ...item, assetId: `media-${String(index + 1).repeat(64)}`, messageId: `browser-media-${index}`, registeredAt: now - 1000, expiresAt: now + 86400_000 })) } });
  });
  await page.route('**/api/chat/interactions', route => {
    if (route.request().method() !== 'GET') { writes++; return route.fulfill({ status: 400, json: { error: 'readonly_fixture' } }); }
    return route.fulfill({ json: { source: 'native-chat', retention: 'process', capacity: 100, state: 'running', available: true, unavailableReason: null, items: [
      { id: '11111111-1111-4111-8111-111111111111', revision: later ? 2 : 1, kind: 'question', status: later ? 'expired' : 'pending', sessionId: 'browser-interaction-session', conversationId: 'group:100999', generation: 1, createdAt: now, expiresAt: now + 60_000, summary: '模型请求主人澄清目标。', questions: [{ id: 'one', text: '选择当前任务范围', options: ['当前群', '取消操作'] }], toolName: null },
      { id: '22222222-2222-4222-8222-222222222222', revision: later ? 2 : 1, kind: 'approval', status: later ? 'unknown' : 'pending', sessionId: 'browser-interaction-session', conversationId: 'group:100999', generation: 1, createdAt: now, expiresAt: now + 60_000, summary: '尝试在当前会话发送文件，需要主人确认。', questions: [], toolName: 'qbf_work_start' }
    ] } });
  });
  await navigateConsolePage(page, 'overview'); await navigateConsolePage(page, 'sessions'); const diagnostics = page.locator('#conversation-diagnostics'); await diagnostics.getByRole('textbox', { name: '诊断会话', exact: true }).fill('group:100999'); await diagnostics.getByRole('button', { name: '检查会话', exact: true }).click();
  const media = page.locator('[data-conversation-media]'); await media.getByRole('button', { name: '读取接入状态', exact: true }).click(); await media.getByText('语音转写服务尚未接入', { exact: false }).first().waitFor(); await media.locator('[data-media-observation="file"]').getByText('读取结果未知：协议读取结果未知', { exact: false }).waitFor();
  await media.locator('[data-media-observation="forward"]').getByText('读取被拒绝：forward_scope_mismatch', { exact: false }).waitFor(); await media.getByText('图片字节读取不代表当前模型理解图片', { exact: false }).waitFor(); await media.getByText('引用归属与当前会话不匹配', { exact: false }).waitFor();
  const interactions = page.locator('#chat-interactions'); await interactions.getByText('尝试在当前会话发送文件，需要主人确认。', { exact: true }).waitFor(); await interactions.getByText('有效期至', { exact: false }).first().waitFor(); assert.equal(await interactions.locator('input,textarea,select').count(), 0); assert.equal(await interactions.getByRole('button').count(), 1);
  later = true; await interactions.getByRole('button', { name: '刷新互动记录', exact: true }).click(); await interactions.getByText('已过期', { exact: true }).waitFor(); await interactions.getByText('结果未确认', { exact: true }).waitFor(); assert.equal(writes, 0);
  await page.unroute('**/api/chat/media?*'); await page.unroute('**/api/chat/interactions');
}
