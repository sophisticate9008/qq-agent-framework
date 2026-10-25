import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { createNativeAccounts } from '../src/host/native-accounts.ts';
import { createNativeAccountRoutes } from '../src/admin/native-accounts.ts';
import { createNativeAccountRuntimeBundle, createNativeAccountDispatchRoutes, type NativeAccountRuntimeBundle } from '../src/admin/native-account-runtime.ts';
import { parseNativeAccountsSnapshot } from '../src/contracts/native-accounts.ts';
import { navigateConsolePage } from './browser-navigation-smoke.ts';
export function accountsFixture(directory: string) {
  const bundles = new Map<string, NativeAccountRuntimeBundle>();
  const accounts = createNativeAccounts({ directory, protocols: [{ id: 'onebot', create(options) { const bundle = createNativeAccountRuntimeBundle(options); bundles.set(options.directory, bundle); return bundle; } }], legacy: { isStopped: () => true, async verifyIdentity(accountScope) { return { verified: true, accountScope, evidence: 'browser-explicit-legacy-identity-proof' }; } } });
  const routes = [...createNativeAccountRoutes(accounts), ...createNativeAccountDispatchRoutes({ accounts, async bundle(id) { const directory = await accounts.accountDirectory(id); await accounts.runtime(id); const bundle = bundles.get(directory); assert(bundle); return bundle; } })];
  return { accounts, routes };
}
async function json(page: Page, path: string, body?: unknown): Promise<unknown> { return page.evaluate(async ({ path, body }) => { const response = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const value: unknown = await response.json(); if (!response.ok) throw new Error(`fixture_http_${response.status}:${JSON.stringify(value)}`); return value; }, { path, body }); }
const dispatch = (id: string, path: string) => `/api/accounts/dispatch?${new URLSearchParams({ account: id, path })}`;
export async function exerciseAccountWorkspace(page: Page): Promise<void> {
  await navigateConsolePage(page, 'adapters'); const manager = page.locator('[data-account-management]');
  async function open(): Promise<void> { await manager.waitFor(); if (await manager.getAttribute('open') === null) await manager.locator('summary').click(); }
  await open();
  for (const [label, account] of [['Browser Account A', '777001'], ['Browser Account B', '777002']]) {
    await manager.getByRole('textbox', { name: '账号显示名称', exact: true }).fill(label ?? ''); await manager.getByRole('textbox', { name: '协议账号标识', exact: true }).fill(account ?? '');
    await manager.getByRole('checkbox', { name: '我已核对账号归属，明确进行本次管理操作', exact: true }).check(); await manager.getByRole('button', { name: '创建独立账号', exact: true }).click(); await manager.getByText('独立账号已创建，尚未启动；选择后可配置并明确应用。', { exact: true }).waitFor();
  }
  const snapshot = parseNativeAccountsSnapshot(await json(page, '/api/accounts')); assert(snapshot); const first = snapshot.accounts.find(item => item.accountScope.accountId === '777001'); const second = snapshot.accounts.find(item => item.accountScope.accountId === '777002'); assert(first && second);
  for (const [id, name] of [[first.id, 'Account A'], [second.id, 'Account B']]) {
    assert(id && name); const endpoint = dispatch(id, '/api/chat/personas'); const original = await json(page, endpoint); assert(original && typeof original === 'object' && 'revision' in original);
    await json(page, endpoint, { revision: original.revision, personas: [{ id: 'same-persona', name, identity: `${name} identity`, style: `${name} original` }] });
  }
  async function select(label: string): Promise<void> { await navigateConsolePage(page, 'adapters'); await open(); const row = manager.locator('div.rounded-lg.border').filter({ has: page.getByText(label, { exact: true }) }); await row.getByRole('button', { name: '管理此账号', exact: true }).click(); await page.locator('header').getByText(`连接 · ${label}`, { exact: true }).waitFor(); }
  const persona = page.locator('#native-persona-editor'); const style = () => persona.getByText('表达风格', { exact: true }).locator('xpath=ancestor::label[1]').locator('textarea');
  await select('Browser Account A'); await navigateConsolePage(page, 'persona'); await persona.getByRole('heading', { name: 'Account A', exact: true }).waitFor(); await style().fill('Account A retained draft');
  await select('Browser Account B'); await navigateConsolePage(page, 'persona'); await persona.getByRole('heading', { name: 'Account B', exact: true }).waitFor(); assert.equal(await style().inputValue(), 'Account B original'); await style().fill('Account B retained draft');
  await select('Browser Account A'); await navigateConsolePage(page, 'persona'); assert.equal(await style().inputValue(), 'Account A retained draft');
  let firstWrites = 0; let secondWrites = 0;
  await page.route('**/api/accounts/dispatch?*', async route => { const query = new URL(route.request().url()).searchParams; if (route.request().method() !== 'POST' || query.get('path') !== '/api/chat/personas') return route.continue(); if (query.get('account') === first.id) { firstWrites++; const response = await route.fetch(); assert.equal(response.status(), 200); return route.fulfill({ status: 504, json: { error: 'persona_operation_unknown' } }); } secondWrites++; return route.continue(); });
  await persona.getByRole('button', { name: '保存人设', exact: true }).click(); await page.getByText('上次写入结果待核对；草稿保留，不会自动重试。', { exact: true }).waitFor();
  await select('Browser Account B'); await navigateConsolePage(page, 'persona'); assert.equal(await style().inputValue(), 'Account B retained draft'); await persona.getByRole('button', { name: '保存人设', exact: true }).click(); await persona.getByText('人设库已保存。', { exact: true }).waitFor(); assert.equal(secondWrites, 1);
  await select('Browser Account A'); await navigateConsolePage(page, 'persona'); await page.getByText('上次写入结果待核对；草稿保留，不会自动重试。', { exact: true }).waitFor(); assert.equal(firstWrites, 1); assert.equal(secondWrites, 1);
  await page.getByRole('button', { name: '读取已保存内容', exact: true }).click(); await page.getByRole('button', { name: '已核对，允许新的保存', exact: true }).click(); assert.equal(await style().inputValue(), 'Account A retained draft');
  await page.unroute('**/api/accounts/dispatch?*'); await navigateConsolePage(page, 'adapters'); await open(); await manager.getByRole('button', { name: '切换到原单账号入口', exact: true }).click(); await open();
  await manager.getByRole('textbox', { name: '账号显示名称', exact: true }).fill('Explicit Legacy'); await manager.getByRole('textbox', { name: '协议账号标识', exact: true }).fill('777003'); await manager.getByRole('checkbox').check(); await manager.getByRole('button', { name: '预览采用原单账号', exact: true }).click(); await manager.getByText('原单账号配置与持久记录预览已核验；尚未迁入账号。', { exact: true }).waitFor();
  assert.equal((parseNativeAccountsSnapshot(await json(page, '/api/accounts')))?.legacy.adoptedBy, null);
  await manager.getByRole('checkbox').check(); await manager.getByRole('button', { name: '确认采用预览中的原单账号', exact: true }).click(); await page.locator('header').getByText('连接 · Explicit Legacy', { exact: true }).waitFor(); assert((parseNativeAccountsSnapshot(await json(page, '/api/accounts')))?.legacy.adoptedBy); await open(); assert.equal(await manager.getByRole('button', { name: '切换到原单账号入口', exact: true }).count(), 0);
}
