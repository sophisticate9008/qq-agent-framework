import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, type Browser } from 'playwright';
import { createNativeUsagePageFixture } from '../test/fixtures/native-usage-page.ts';
import { asRecord } from '../web/lib/api.ts';

const nativeFixture = createNativeUsagePageFixture();
const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('../', import.meta.url)),
  resolve: { alias: { '@': fileURLToPath(new URL('../web/', import.meta.url)) } },
  cacheDir: fileURLToPath(new URL('../node_modules/.vite-virtual-perf/', import.meta.url)),
  optimizeDeps: { entries: ['test/fixtures/virtual-list.html', 'test/fixtures/virtualized-pages.html', 'test/fixtures/catalog-lifecycle.html', 'test/fixtures/native-usage.html', 'test/fixtures/session-pages.html'] },
  plugins: [react(), tailwindcss(), { name: 'isolated-native-usage-api', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (!request.url?.startsWith('/isolated-native')) { next(); return; }
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const raw = Buffer.concat(chunks).toString('utf8');
        const body: unknown = raw ? JSON.parse(raw) : undefined;
        const path = request.url?.replace(/^\/isolated-native-api/, '') ?? '';
        const result = nativeFixture.handle(request.method ?? 'GET', path, body);
        response.statusCode = result.status;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(result.body));
      })().catch(() => { response.statusCode = 500; response.end(JSON.stringify({ error: 'isolated_fixture_failed' })); });
    });
  } }],
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
let browser: Browser | undefined;
try {
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('fixture_address_missing');
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const started = performance.now();
  await page.goto(`http://127.0.0.1:${address.port}/test/fixtures/virtual-list.html`);
  await page.waitForSelector('[data-fixture-table-row]');
  const evidence = { rows: 50_000, maxTableRows: 0, maxListRows: 0, maxDomNodes: 0, mountMs: Math.round(performance.now() - started) };
  async function sample() {
    const counts = await page.evaluate(() => ({
      table: document.querySelectorAll('[data-fixture-table-row]').length,
      list: document.querySelectorAll('[data-fixture-list-row]').length,
      nodes: document.querySelectorAll('*').length,
    }));
    assert.ok(counts.table > 0 && counts.table < 50, JSON.stringify(counts));
    assert.ok(counts.list > 0 && counts.list < 50, JSON.stringify(counts));
    assert.ok(counts.nodes < 1500, JSON.stringify(counts));
    evidence.maxTableRows = Math.max(evidence.maxTableRows, counts.table);
    evidence.maxListRows = Math.max(evidence.maxListRows, counts.list);
    evidence.maxDomNodes = Math.max(evidence.maxDomNodes, counts.nodes);
  }
  await sample();
  assert.equal(await page.locator('[data-small-row]').count(), 40);
  assert.equal(await page.locator('#small-scroll [data-virtualized]').count(), 0);
  await page.locator('#fixture-secret').fill('synthetic-fixture-only');
  await page.locator('[data-draft="0"]').fill('未保存草稿');
  await page.locator('[data-draft="0"]').focus();
  const focusedBeforeScroll = await page.locator('[data-draft="0"]').evaluate(element => {
    element.dataset.retained = 'yes';
    return element.id;
  });
  assert.equal(focusedBeforeScroll, '');
  for (const fraction of [0.2, 0.5, 0.85, 1]) {
    await page.locator('#list-scroll').evaluate((element, fraction) => { element.scrollTop = (element.scrollHeight - element.clientHeight) * fraction; }, fraction);
    await page.waitForTimeout(80);
    await sample();
    assert.equal(await page.locator('[data-draft="0"]').inputValue(), '未保存草稿');
    assert.equal(await page.locator('[data-draft="0"]').getAttribute('data-retained'), 'yes');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-draft')), '0');
    await page.locator('#table-scroll').evaluate((element, fraction) => { element.scrollTop = (element.scrollHeight - element.clientHeight) * fraction; }, fraction);
    await page.waitForTimeout(80);
    await sample();
  }
  await page.locator('#table-end').click();
  await page.locator('#list-end').click();
  await page.waitForFunction(() => {
    for (const [viewportId, rowSelector] of [['table-scroll', '[data-fixture-table-row="49999"]'], ['list-scroll', '[data-fixture-list-row="49999"]']]) {
      const viewport = document.getElementById(viewportId);
      const row = document.querySelector(rowSelector);
      if (!viewport || !row) return false;
      const viewportBox = viewport.getBoundingClientRect();
      const box = row.getBoundingClientRect();
      if (box.top < viewportBox.top || box.bottom > viewportBox.bottom + 1) return false;
    }
    return true;
  });
  await sample();
  const headerDelta = await page.locator('#table-scroll').evaluate(viewport => {
    const header = viewport.querySelector('thead');
    if (!header) throw new Error('fixture_header_missing');
    return Math.abs(header.getBoundingClientRect().top - viewport.getBoundingClientRect().top - viewport.clientTop - Number.parseFloat(getComputedStyle(viewport).paddingTop));
  });
  assert.ok(headerDelta <= 1, `sticky header delta ${headerDelta}`);
  await page.locator('#expand').click();
  await page.locator('#table-end').click();
  await page.locator('#list-end').click();
  await page.waitForTimeout(150);
  await sample();
  await page.locator('#fixture-filter').fill('fixture-49999');
  await page.waitForFunction(() => document.querySelectorAll('[data-fixture-table-row]').length === 1);
  assert.equal(await page.locator('[data-fixture-table-row]').getAttribute('data-fixture-table-row'), '49999');
  await page.locator('#fixture-filter').fill('');
  await page.waitForTimeout(100);
  await sample();
  await page.locator('#list-scroll').evaluate(element => { element.scrollTop = 0; });
  await page.locator('[data-draft="0"]').waitFor();
  assert.equal(await page.locator('[data-draft="0"]').inputValue(), '未保存草稿');
  assert.equal(await page.locator('#fixture-secret').inputValue(), 'synthetic-fixture-only');
  await page.locator('[data-draft="0"]').focus();
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-draft')), '0');
  await page.locator('#table-scroll').evaluate(element => { element.scrollTop = 0; });
  await page.locator('[data-fixture-table-row="0"] button').focus();
  await page.keyboard.press('End');
  await page.waitForFunction(() => document.activeElement?.closest('[data-fixture-table-row]')?.getAttribute('data-fixture-table-row') === '49999');
  await page.keyboard.press('Home');
  await page.waitForFunction(() => document.activeElement?.closest('[data-fixture-table-row]')?.getAttribute('data-fixture-table-row') === '0');
  await page.evaluate(() => {
    const label = document.querySelector('[data-fixture-table-row="0"] td');
    if (!label) throw new Error('selection_label_missing');
    const range = document.createRange();
    range.selectNodeContents(label);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
  });
  await page.waitForTimeout(50);
  await page.locator('#table-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => document.getSelection()?.toString()), 'fixture-0');
  await sample();
  assert.deepEqual(errors, []);
  await page.goto(`http://127.0.0.1:${address.port}/test/fixtures/virtualized-pages.html`);
  await page.waitForSelector('[data-session-key]');
  const sessionsDom = await page.locator('[data-session-key]').count();
  assert.ok(sessionsDom < 35);
  await page.locator('#session-filter').fill('100255');
  await page.waitForFunction(() => document.querySelectorAll('[data-session-key]').length === 1);
  await page.locator('[data-session-key="group:100255"] button').click();
  assert.equal(await page.locator('[data-selected-session]').getAttribute('data-selected-session'), 'group:100255');
  await page.locator('[data-fixture-page="usage"]').click();
  await page.locator('[data-usage-conversations-panel] summary').click();
  await page.waitForSelector('[data-usage-key]');
  const usageDom = await page.locator('[data-usage-key]').count();
  assert.ok(usageDom < 35);
  await page.locator('[data-usage-conversations-scroll]').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.locator('[data-usage-key="group:100199"] button').click();
  await page.waitForSelector('[data-usage-turn]');
  assert.equal(await page.locator('#usage-key-select').inputValue(), 'group:100199');
  const turnsDom = await page.locator('[data-usage-turn]').count();
  assert.ok(turnsDom < 35);
  await page.locator('[data-usage-turns-scroll]').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.locator('[data-usage-turn="199"]').waitFor();
  await page.locator('[data-usage-recent-panel] summary').click();
  assert.equal(await page.locator('[data-usage-recent]').count(), 40);
  await page.locator('[data-usage-prices-panel] summary').click();
  await page.waitForSelector('[data-usage-prices-scroll] tbody tr[data-virtual-index]');
  const pricesDom = await page.locator('[data-usage-prices-scroll] tbody tr[data-virtual-index]').count();
  assert.ok(pricesDom < 35);
  await page.locator('[data-usage-prices-scroll]').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.locator('[data-usage-prices-scroll] tbody tr[data-virtual-index="255"]').waitFor();
  await page.waitForSelector('[data-chart-engine="recharts"] .recharts-surface');
  const progress = page.locator('[data-usage-key] [role="progressbar"]').first();
  assert.ok(Number(await progress.getAttribute('aria-valuenow')) > 0);
  await page.locator('#usage-refresh').click();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#usage-key-select').inputValue(), 'group:100199');
  assert.equal(await page.locator('[data-usage-turns-panel]').getAttribute('open'), '');
  await page.locator('[data-fixture-page="providers"]').click();
  await page.locator('#provider-name').waitFor();
  const directory = page.locator('[data-bounded-card]').first();
  const providersDom = await directory.locator('[role="listitem"]').count();
  assert.ok(providersDom < 35);
  await directory.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.getByRole('button', { name: /合成提供方 127/ }).click();
  assert.equal(await page.locator('#provider-name').inputValue(), '合成提供方 127');
  await page.locator('#provider-api-key').fill('isolated-fixture-only');
  await page.locator('#provider-model-id-0').fill('synthetic-edited-model');
  await page.locator('#provider-model-id-0').evaluate(element => { element.dataset.retained = 'yes'; });
  const modelViewport = page.getByRole('group', { name: '可用模型列表' });
  const modelsDom = await modelViewport.locator('[role="listitem"]').count();
  assert.ok(modelsDom < 25);
  await modelViewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.locator('#provider-model-id-127').waitFor();
  assert.equal(await page.locator('#provider-model-id-0').inputValue(), 'synthetic-edited-model');
  assert.equal(await page.locator('#provider-model-id-0').getAttribute('data-retained'), 'yes');
  assert.equal(await page.locator('#provider-api-key').inputValue(), 'isolated-fixture-only');
  assert.equal(await page.locator('[data-fixture-dirty]').getAttribute('data-fixture-dirty'), 'true');
  await page.setViewportSize({ width: 460, height: 900 });
  await modelViewport.evaluate(element => { element.scrollTop = 0; });
  await page.locator('#provider-model-id-1').fill('survives-earlier-removal');
  await page.locator('#provider-model-id-1').evaluate(element => { element.dataset.retained = 'survivor'; });
  await page.getByRole('button', { name: '删除模型 1', exact: true }).evaluate(element => { (element as HTMLButtonElement).click(); });
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>('#provider-model-id-0')?.value === 'survives-earlier-removal');
  assert.equal(await page.locator('#provider-model-id-0').getAttribute('data-retained'), 'survivor');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'provider-model-id-0');
  await page.getByRole('button', { name: '添加模型', exact: true }).click();
  await page.locator('#provider-model-id-127').waitFor();
  assert.equal(await page.locator('#provider-model-id-127').inputValue(), '');
  assert.equal(await page.locator('#provider-api-key').inputValue(), 'isolated-fixture-only');
  assert.deepEqual(errors, []);
  const catalogUrl = `http://127.0.0.1:${address.port}/test/fixtures/catalog-lifecycle.html`;
  async function openCatalog() {
    await page.goto(catalogUrl);
    await page.getByPlaceholder('日常伙伴').waitFor();
  }
  async function reconnectCatalog() {
    await page.locator('#fixture-disconnect').click();
    await page.locator('#fixture-reconnect').click();
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[placeholder="日常伙伴"]')?.value === '重连人设 1');
  }
  for (const method of ['get', 'post']) {
    for (const outcome of ['resolve', 'reject']) {
      await openCatalog();
      await page.locator(`#fixture-hold-${method}`).click();
      if (method === 'post') {
        await page.getByPlaceholder('日常伙伴').fill('旧生命周期提交');
        await page.getByRole('button', { name: '保存人设', exact: true }).click();
        assert.equal(await page.locator('#fixture-requests').getAttribute('data-persona-signal'), 'true');
      } else await page.getByRole('button', { name: '重新载入', exact: true }).first().click();
      await page.waitForFunction(() => document.getElementById('fixture-requests')?.dataset.pending === '1');
      await reconnectCatalog();
      await page.getByPlaceholder('日常伙伴').fill(`新草稿-${method}-${outcome}`);
      await page.locator(`#fixture-${outcome}`).click();
      await page.waitForTimeout(50);
      assert.equal(await page.getByPlaceholder('日常伙伴').inputValue(), `新草稿-${method}-${outcome}`);
      assert.equal(await page.getByRole('alert').count(), 0);
      assert.equal(await page.locator('[data-dirty-scope="personas"]').getAttribute('data-dirty'), 'true');
      assert.ok(Number(await page.locator('#fixture-requests').getAttribute('data-aborted')) > 0);
      assert.equal(await page.getByRole('button', { name: '保存人设', exact: true }).isEnabled(), true);
    }
  }
  await openCatalog();
  await page.getByPlaceholder('日常伙伴').fill('旧保存');
  await page.locator('#fixture-hold-post').click();
  await page.getByRole('button', { name: '保存人设', exact: true }).click();
  await reconnectCatalog();
  await page.getByPlaceholder('日常伙伴').fill('新保存');
  await page.locator('#fixture-hold-post').click();
  await page.getByRole('button', { name: '保存人设', exact: true }).click();
  await page.locator('#fixture-resolve').click();
  await page.waitForTimeout(50);
  assert.equal(await page.getByRole('button', { name: '正在保存', exact: true }).isDisabled(), true);
  assert.equal(await page.getByPlaceholder('日常伙伴').inputValue(), '新保存');
  await page.locator('#fixture-reject').click();
  await page.getByRole('button', { name: '保存人设', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '保存人设', exact: true }).isDisabled(), true);
  assert.equal(await page.getByPlaceholder('日常伙伴').isDisabled(), true);
  assert.equal(await page.locator('#fixture-requests').getAttribute('data-posts'), '2');
  await page.getByRole('alert').getByRole('button', { name: '重新载入', exact: true }).click();
  await page.getByPlaceholder('日常伙伴').waitFor();
  assert.equal(await page.locator('#fixture-requests').getAttribute('data-posts'), '2');
  await openCatalog();
  await page.getByPlaceholder('日常伙伴').fill('卸载前提交');
  await page.locator('#fixture-hold-post').click();
  await page.getByRole('button', { name: '保存人设', exact: true }).click();
  await page.locator('#fixture-unmount').click();
  await page.locator('#fixture-mount').click();
  await page.getByPlaceholder('日常伙伴').fill('重新挂载的草稿');
  await page.locator('#fixture-resolve').click();
  await page.waitForTimeout(50);
  assert.equal(await page.getByPlaceholder('日常伙伴').inputValue(), '重新挂载的草稿');
  await openCatalog();
  assert.equal(await page.getByPlaceholder('persona-default').inputValue(), 'persona:imported');
  assert.equal(await page.getByPlaceholder('persona-default').isDisabled(), true);
  await page.getByPlaceholder('日常伙伴').fill('合法冒号人设编辑');
  const gatewayIdentity = page.getByRole('textbox', { name: /^人格 ID/ });
  await gatewayIdentity.fill('outbound:separate');
  assert.equal(await page.locator('[data-dirty-scope="personas"]').getAttribute('data-dirty'), 'true');
  assert.equal(await page.locator('[data-dirty-scope="configuration:persona"]').getAttribute('data-dirty'), 'true');
  await page.getByRole('button', { name: '保存人设', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-dirty-scope="personas"]')?.getAttribute('data-dirty') === 'false');
  assert.equal(await page.locator('#fixture-requests').getAttribute('data-persona-id'), 'persona:imported');
  assert.equal(await gatewayIdentity.inputValue(), 'outbound:separate');
  assert.equal(await page.locator('[data-dirty-scope="configuration:persona"]').getAttribute('data-dirty'), 'true');
  await page.getByPlaceholder('日常伙伴').fill('独立保留的人设草稿');
  await page.getByRole('button', { name: '保存本组', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-dirty-scope="configuration:persona"]')?.getAttribute('data-dirty') === 'false');
  assert.equal(await page.locator('[data-dirty-scope="personas"]').getAttribute('data-dirty'), 'true');
  assert.equal(await page.getByPlaceholder('日常伙伴').inputValue(), '独立保留的人设草稿');
  await page.locator('#fixture-plan').click();
  await page.getByPlaceholder('daily-chat').waitFor();
  assert.equal(await page.getByPlaceholder('daily-chat').inputValue(), 'plan:imported');
  assert.equal(await page.getByPlaceholder('daily-chat').isDisabled(), true);
  await page.getByPlaceholder('日常聊天').fill('合法冒号方案编辑');
  await page.getByRole('button', { name: '保存聊天方案', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('fixture-requests')?.dataset.planId === 'plan:imported');
  assert.equal(await page.getByRole('alert').count(), 0);
  await openCatalog();
  await page.getByRole('button', { name: '新建人设', exact: true }).click();
  await page.getByPlaceholder('persona-default').fill('bad/id');
  await page.getByPlaceholder('日常伙伴').fill('非法 ID');
  await page.getByPlaceholder('描述这个角色是谁').fill('合成身份');
  await page.getByPlaceholder('描述这个角色如何表达').fill('合成风格');
  await page.getByRole('button', { name: '创建人设', exact: true }).click();
  assert.equal(await page.getByRole('alert').count(), 1);
  assert.equal(await page.locator('#fixture-requests').getAttribute('data-posts'), '0');
  assert.deepEqual(errors, []);
  async function openAccess() {
    await openCatalog();
    await page.locator('#fixture-access').click();
    await page.getByPlaceholder('654321', { exact: true }).waitFor();
  }
  async function reconnectAccess() {
    await page.locator('#fixture-disconnect').click();
    await page.locator('#fixture-reconnect').click();
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[placeholder="654321"]')?.value === '700001');
  }
  for (const method of ['get', 'post']) {
    for (const outcome of ['resolve', 'reject']) {
      await openAccess();
      await page.locator(`#fixture-hold-${method}`).click();
      if (method === 'post') {
        await page.getByPlaceholder('654321', { exact: true }).fill('800000');
        await page.getByRole('button', { name: '保存授权', exact: true }).click();
        assert.equal(await page.locator('#fixture-requests').getAttribute('data-access-signal'), 'true');
      } else await page.getByRole('button', { name: '重新载入', exact: true }).first().click();
      await page.waitForFunction(() => document.getElementById('fixture-requests')?.dataset.pending === '1');
      await reconnectAccess();
      await page.getByPlaceholder('654321', { exact: true }).fill('800001');
      await page.locator(`#fixture-${outcome}`).click();
      await page.waitForTimeout(50);
      assert.equal(await page.getByPlaceholder('654321', { exact: true }).inputValue(), '800001');
      assert.equal(await page.getByRole('alert').count(), 0);
      assert.equal(await page.locator('[data-dirty-scope="chat-access"]').getAttribute('data-dirty'), 'true');
      assert.equal(await page.getByRole('button', { name: '保存授权', exact: true }).isEnabled(), true);
    }
  }
  await openAccess();
  await page.getByPlaceholder('654321', { exact: true }).fill('800000');
  await page.locator('#fixture-hold-post').click();
  await page.getByRole('button', { name: '保存授权', exact: true }).click();
  await reconnectAccess();
  await page.getByPlaceholder('654321', { exact: true }).fill('800001');
  await page.locator('#fixture-hold-post').click();
  await page.getByRole('button', { name: '保存授权', exact: true }).click();
  await page.locator('#fixture-resolve').click();
  await page.waitForTimeout(50);
  assert.equal(await page.getByRole('button', { name: '正在保存', exact: true }).isDisabled(), true);
  assert.equal(await page.getByPlaceholder('654321', { exact: true }).inputValue(), '800001');
  await page.locator('#fixture-reject').click();
  await page.getByRole('button', { name: '保存授权', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '保存授权', exact: true }).isDisabled(), true);
  assert.equal(await page.locator('#fixture-requests').getAttribute('data-posts'), '2');
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.goto(`http://127.0.0.1:${address.port}/test/fixtures/native-usage.html`);
  await page.waitForSelector('[data-native-usage-coverage]');
  assert.equal(await page.locator('[data-usage-metric="total-tokens"] > strong').innerText(), '未知');
  assert.equal(await page.locator('[data-usage-metric="estimated-cost"] > strong').innerText(), '未知');
  assert.ok((await page.locator('[data-native-usage-coverage]').innerText()).includes('覆盖不完整'));
  await page.waitForSelector('[data-chart-engine="recharts"] .recharts-surface');
  assert.ok((await page.locator('[data-usage-chart-coverage]').innerText()).includes('未知值留空'));
  await page.locator('[data-usage-conversations-panel] summary').click();
  await page.locator('[data-usage-key="private:123"] button').click();
  await page.waitForSelector('[data-usage-turn]');
  assert.ok(await page.locator('[data-usage-turn]').count() < 35);
  assert.equal(await page.locator('#usage-reset-open').isDisabled(), true);
  await page.locator('[data-usage-recent-panel] summary').click();
  assert.equal(await page.locator('[data-usage-recent]').count(), 40);
  assert.ok((await page.locator('[data-usage-recent]').first().innerText()).includes('未知'));
  async function nativeControl(body: unknown) {
    const response = await page.request.post(`${origin}/isolated-native-control`, { data: body });
    assert.equal(response.ok(), true);
  }
  async function nativeState() {
    const response = await page.request.get(`${origin}/isolated-native-state`);
    const value: unknown = await response.json();
    return asRecord(value);
  }
  async function seedNative(kind: string) {
    const previous = Number(await page.locator('[data-native-fixture-version]').getAttribute('data-native-fixture-version'));
    await page.locator(`[data-native-seed="${kind}"]`).click();
    await page.waitForFunction(previous => Number(document.querySelector('[data-native-fixture-version]')?.getAttribute('data-native-fixture-version')) > previous, previous);
    await page.waitForFunction(() => document.querySelector('[data-native-usage-coverage]') !== null && document.querySelector('#usage-refresh')?.hasAttribute('disabled') === false);
    await page.locator('[data-usage-pricing-editor] summary').click();
  }
  await seedNative('empty');
  assert.equal(await page.locator('[data-usage-metric="total-tokens"] > strong').innerText(), '未知');
  await page.locator('#usage-price-add').click();
  await page.getByRole('button', { name: '保存后续单价', exact: true }).click();
  assert.equal((await nativeState()).writes, 0);
  await page.locator('#usage-price-provider-0').selectOption({ label: '合成模型服务' });
  await page.locator('#usage-price-model-0').selectOption({ label: '合成聊天模型' });
  await page.locator('#usage-price-currency-0').fill('USD');
  for (const [key, value] of [['inputPerMillion', '1'], ['outputPerMillion', '2'], ['cacheReadPerMillion', '0.1'], ['cacheWritePerMillion', '0.5']]) await page.locator(`#usage-price-${key}-0`).fill(value);
  await page.getByRole('button', { name: '保存后续单价', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-native-pricing-dirty]')?.getAttribute('data-native-pricing-dirty') === 'false');
  assert.deepEqual((await nativeState()).submittedRevisions, [null]);
  await seedNative('complete');
  await page.locator('#usage-price-inputPerMillion-0').fill('3');
  const costBefore = asRecord((await nativeState()).originalCost).amount;
  await page.getByRole('button', { name: '保存后续单价', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-native-pricing-dirty]')?.getAttribute('data-native-pricing-dirty') === 'false');
  assert.equal(asRecord((await nativeState()).originalCost).amount, costBefore);
  await nativeControl({ action: 'append' });
  const afterAppend = await nativeState();
  assert.equal(asRecord(afterAppend.originalCost).amount, costBefore);
  assert.ok(Number(asRecord(afterAppend.newestCost).amount) > Number(costBefore));
  await page.locator('#usage-price-inputPerMillion-0').fill('4');
  await nativeControl({ action: 'write-mode', mode: 'conflict' });
  await page.getByRole('button', { name: '保存后续单价', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-usage-pricing-editor] [role="alert"]')?.textContent?.includes('其他位置修改'));
  assert.equal(await page.getByRole('button', { name: '保存后续单价', exact: true }).isDisabled(), true);
  assert.equal((await nativeState()).writes, 2);
  await page.getByRole('button', { name: '重新读取单价', exact: true }).click();
  await page.getByRole('button', { name: '保留草稿', exact: true }).click();
  assert.equal(await page.locator('#usage-price-inputPerMillion-0').inputValue(), '4');
  await page.getByRole('button', { name: '重新读取单价', exact: true }).click();
  await page.getByRole('button', { name: '放弃草稿并重新读取', exact: true }).click();
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>('#usage-price-inputPerMillion-0')?.value === '9');
  await page.locator('#usage-price-inputPerMillion-0').fill('5');
  await nativeControl({ action: 'write-mode', mode: 'unknown' });
  await page.getByRole('button', { name: '保存后续单价', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-usage-pricing-editor] [role="alert"]')?.textContent?.includes('保存结果未知'));
  assert.equal((await nativeState()).writes, 3);
  assert.equal(await page.locator('#usage-price-inputPerMillion-0').isDisabled(), true);
  await page.getByRole('button', { name: '重新读取单价', exact: true }).click();
  await page.getByRole('button', { name: '放弃草稿并重新读取', exact: true }).click();
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>('#usage-price-inputPerMillion-0')?.value === '5' && document.querySelector<HTMLInputElement>('#usage-price-inputPerMillion-0')?.disabled === false);
  assert.equal((await nativeState()).writes, 3);
  assert.equal(asRecord((await nativeState()).originalCost).amount, costBefore);
  await seedNative('mixed');
  assert.equal(await page.locator('[data-usage-metric="estimated-cost"] > strong').innerText(), '未知');
  const nativeCosts = await page.locator('[data-native-usage-coverage] [data-usage-known-costs]').innerText();
  assert.ok(nativeCosts.includes('USD') && nativeCosts.includes('CNY') && nativeCosts.includes('不合并'));
  await nativeControl({ action: 'large-prices' });
  await page.getByRole('button', { name: '重新读取单价', exact: true }).click();
  await page.waitForSelector('#usage-price-model-0');
  const pricingRows = page.locator('[data-usage-price-row]');
  assert.ok(await pricingRows.count() < 30);
  await page.locator('#usage-price-model-0').focus();
  await page.getByRole('group', { name: '模型计价规则' }).evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.locator('#usage-price-model-255').waitFor();
  assert.equal(await page.locator('#usage-price-model-0').inputValue(), 'fixture-model');
  assert.equal(await page.locator('#usage-price-model-255').inputValue(), 'fixture-model-255');
  assert.ok((await page.locator('#usage-price-model-255 option:checked').innerText()).includes('保留现值'));
  await page.locator('#usage-price-inputPerMillion-255').fill('7');
  await page.getByRole('button', { name: '保存后续单价', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-native-pricing-dirty]')?.getAttribute('data-native-pricing-dirty') === 'false');
  const preservedPrices = asRecord((await nativeState()).pricing).prices;
  assert.ok(Array.isArray(preservedPrices));
  const preserved = preservedPrices.find((row: unknown) => asRecord(row).model === 'fixture-model-255');
  assert.equal(asRecord(preserved).inputPerMillion, 7);
  assert.equal(asRecord(preserved).provider, 'fixture-provider');
  assert.equal((await page.locator('[data-usage-pricing-editor]').innerText()).includes('revision'), false);
  assert.deepEqual(errors, []);
  const sessionsUrl = `http://127.0.0.1:${address.port}/test/fixtures/session-pages.html`;
  async function openSessions() {
    await page.goto(sessionsUrl);
    await page.waitForSelector('[data-session-key]');
  }
  await openSessions();
  assert.equal(await page.locator('#session-reset-open').isDisabled(), true);
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.locator('#session-filter').fill('100319');
  await page.waitForFunction(() => document.querySelectorAll('[data-session-key]').length === 0);
  assert.equal(await page.locator('[data-session-key]').count(), 0);
  for (let index = 0; index < 3; index++) await page.locator('#session-load-more').click();
  await page.locator('[data-session-key="group:100319"] button').click();
  assert.equal(await page.locator('[data-selected-session]').getAttribute('data-selected-session'), 'group:100319');
  assert.equal(await page.locator('#session-load-more').count(), 0);
  await page.locator('#session-filter').fill('');
  assert.ok(await page.locator('[data-session-key]').count() < 35);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.waitForSelector('[data-session-unconfirmed]');
  assert.equal(await page.locator('[data-selected-session]').getAttribute('data-selected-session'), 'group:100319');
  assert.equal(await page.locator('#session-reset-open').isDisabled(), true);
  for (const outcome of ['resolve', 'reject']) {
    await openSessions();
    await page.locator('#session-fixture-hold').click();
    await page.locator('#session-load-more').click();
    await page.locator('#session-load-cancel').click();
    await page.locator('#session-fixture-change').click();
    await page.locator('#session-load-more').click();
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes('发生变化') || [...document.querySelectorAll('[role="status"]')].some(element => element.textContent?.includes('发生变化')));
    await page.locator(`#session-fixture-${outcome}`).click();
    await page.waitForTimeout(50);
    assert.ok((await page.locator('[data-selected-session] code').textContent())?.includes('binding-changed-during-page'));
    assert.ok(Number(await page.locator('#session-fixture-state').getAttribute('data-aborted')) > 0);
    assert.equal(await page.locator('#session-fixture-state').getAttribute('data-posts'), '0');
  }
  await openSessions();
  await page.locator('#session-fixture-empty-first').click();
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-session-key]').length === 0);
  await page.locator('#session-load-more').click();
  await page.waitForSelector('[data-session-key]');
  await openSessions();
  await page.locator('#session-fixture-cycle').click();
  await page.locator('#session-load-more').click();
  await page.waitForFunction(() => document.getElementById('session-load-more')?.hasAttribute('disabled') === true);
  assert.ok((await page.locator('[data-page="sessions"]').innerText()).includes('分页游标未前进'));
  assert.ok((await page.locator('[data-page="sessions"]').innerText()).includes('部分结果'));
  await openSessions();
  await page.locator('#session-fixture-omit').click();
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#session-reset-open').isDisabled(), true);
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.locator('#session-fixture-writable').click();
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('session-reset-open')?.hasAttribute('disabled') === false);
  await page.locator('#session-reset-open').click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.locator('#session-fixture-state').getAttribute('data-posts'), '0');
  await page.locator('#session-fixture-conflict').click();
  await page.locator('#session-reset-open').click();
  await page.locator('#session-reset-confirm').fill('wrong-binding');
  assert.equal(await page.locator('#session-reset-submit').isDisabled(), true);
  await page.locator('#session-reset-confirm').fill('group:100000');
  await page.locator('#session-reset-submit').click();
  await page.getByRole('button', { name: '关闭并刷新', exact: true }).waitFor();
  assert.equal(await page.locator('#session-reset-submit').isDisabled(), true);
  assert.equal(await page.locator('#session-fixture-state').getAttribute('data-posts'), '1');
  await page.getByRole('button', { name: '关闭并刷新', exact: true }).click();
  await page.locator('#session-fixture-unknown').click();
  await page.locator('#session-reset-open').click();
  await page.locator('#session-reset-confirm').fill('group:100000');
  await page.locator('#session-reset-submit').click();
  await page.getByRole('button', { name: '关闭并刷新', exact: true }).waitFor();
  assert.equal(await page.locator('#session-reset-submit').isDisabled(), true);
  assert.equal(await page.locator('#session-fixture-state').getAttribute('data-posts'), '2');
  await openSessions();
  await page.locator('#session-fixture-writable').click();
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('session-reset-open')?.hasAttribute('disabled') === false);
  await page.locator('#session-reset-open').click();
  await page.locator('#session-reset-confirm').fill('group:100000');
  await page.locator('#session-reset-submit').click();
  await page.waitForFunction(() => document.querySelector('[data-selected-session]')?.getAttribute('data-selected-session') === 'group:100001');
  const resetBody = JSON.parse(await page.locator('#session-fixture-state').getAttribute('data-last-post') ?? 'null') as unknown;
  assert.equal(asRecord(resetBody).key, 'group:100000');
  assert.equal(asRecord(resetBody).sessionId, 'synthetic-session-0');
  assert.equal(asRecord(resetBody).revision, 'page-first-320-false');
  assert.equal(asRecord(resetBody).confirm, true);
  assert.equal(await page.locator('#session-fixture-state').getAttribute('data-posts'), '1');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ...evidence, scrollToEnd: true, stickyHeader: true, focusedDraftRetained: true, secretRetained: true, fullDataFilter: true, keyboardHomeEnd: true, textSelectionRetained: true,
    realPages: { sessions: { total: 256, mounted: sessionsDom }, conversations: { total: 200, mounted: usageDom }, turns: { total: 200, mounted: turnsDom }, recent: { total: 40, mounted: 40 }, prices: { total: 256, mounted: pricesDom }, providers: { total: 128, mounted: providersDom }, models: { total: 128, mounted: modelsDom }, recharts: true, progress: true, selectionAndFolding: true, dirtyDraftAndPassword: true, narrowScreen: true, stableModelIdentity: true, addedModelRevealed: true },
    catalog: { lateReadSuccessAndFailure: true, lateWriteSuccessAndFailure: true, oldFinallyCannotUnlockNewSave: true, abortOnUnmountAndReconnect: true, unknownNeverRetried: true, colonPersonaAndPlanEdits: true, invalidIdRejected: true, independentOutboundIdentityScope: true },
    access: { actualPage: true, lateReadSuccessAndFailure: true, lateWriteSuccessAndFailure: true, oldFinallyCannotUnlockNewSave: true, unknownLocksWrites: true },
    sessions: { reachableBeyondFirst100And256: true, localNoMatchCanLoadMore: true, dedupAndChangeNotice: true, cancelIgnoresLateSuccessAndFailure: true, emptyReadyPageCanContinue: true, cursorCycleStopsWithoutPretendingComplete: true, readonlyNoResetDialogOrPost: true, explicitResetCapabilityAndFrozenBinding: true, resetConflictAndUnknownNeverRetried: true },
    nativeUsage: { realLedgerProjection: true, unknownIsNotZero: true, partialAndMultiCurrency: true, rechartsAndTurnsPreserved: true, pricingNumericCas: true, nullRevisionCreation: true, priceConflictAndUnknownLocked: true, oldTurnsNeverRepriced: true, laterTurnsUseNewPrices: true, pricing256Virtualized: true }, errors }, null, 2));
} finally {
  await browser?.close();
  await server.close();
  nativeFixture.close();
}
