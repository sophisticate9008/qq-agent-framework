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
  cacheDir: fileURLToPath(new URL('../.cache/vite/virtual-list-perf/', import.meta.url)),
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
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
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
  await page.locator('[data-session-key="group:100255"]').getByRole('button', { name: '100255', exact: true }).click();
  assert.equal(await page.locator('[data-selected-session]').getAttribute('data-selected-session'), 'group:100255');
  await page.keyboard.press('Escape');
  await page.locator('[data-fixture-page="usage"]').click();
  await page.waitForSelector('[data-usage-key]');
  const usageDom = await page.locator('[data-usage-key]').count();
  assert.ok(usageDom > 0 && usageDom < 35);
  await page.locator('[data-usage-conversations-scroll]').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.locator('[data-usage-key="group:100199"] button').first().click();
  await page.waitForSelector('[data-usage-turn]');
  assert.equal(await page.locator('#usage-key-select').inputValue(), 'group:100199');
  const turnsDom = await page.locator('[data-usage-turn]').count();
  assert.ok(turnsDom > 0 && turnsDom < 35);
  await page.locator('[data-usage-turns-scroll]').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.locator('[data-usage-turn="199"]').waitFor();
  await page.getByRole('tab', { name: '调用记录', exact: true }).click();
  await page.waitForSelector('[data-usage-recent]');
  assert.equal(await page.locator('[data-usage-recent]').count(), 40);
  await page.locator('#usage-refresh').click();
  assert.equal(await page.locator('#usage-key-select').inputValue(), 'group:100199');
  await page.locator('[data-fixture-page="providers"]').click();
  await page.locator('#provider-name').waitFor();
  await page.getByRole('group', { name: '选择模型提供方', exact: true }).getByRole('button', { name: /合成提供方 127/ }).click();
  assert.equal(await page.locator('#provider-name').inputValue(), '合成提供方 127');
  await page.locator('#provider-api-key').fill('isolated-fixture-only');
  const modelTable = page.getByRole('group', { name: '可用模型列表', exact: true });
  assert.equal(await modelTable.locator('tbody tr').count(), 128);
  await page.getByRole('textbox', { name: '搜索模型目录', exact: true }).fill('fixture-model-127');
  assert.equal(await modelTable.locator('tbody tr').count(), 1);
  await modelTable.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('#provider-model-name').fill('保留的模型草稿');
  await page.getByRole('button', { name: '更新服务草稿', exact: true }).click();
  assert.equal(await page.locator('#provider-api-key').inputValue(), 'isolated-fixture-only');
  await modelTable.getByText('保留的模型草稿', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 1000 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.goto(`${origin}/test/fixtures/native-usage.html`);
  await page.locator('[data-usage-metric="total-tokens"] > strong').waitFor();
  assert.match(await page.locator('[data-usage-metric="total-tokens"] > strong').innerText(), /13\.6m/);
  assert.match(await page.locator('[data-usage-metric="total-tokens"]').innerText(), /已记录 Token/);
  assert.equal(await page.locator('[data-usage-metric="estimated-cost"] > strong').innerText(), 'USD 11.92');
  await page.getByRole('button', { name: '统计说明', exact: true }).click();
  await page.locator('[data-native-usage-coverage]').waitFor();
  assert.match(await page.locator('[data-native-usage-coverage]').innerText(), /1 轮计数不完整，1 条费用未知/);
  await page.keyboard.press('Escape');
  await page.locator('[data-usage-key="private:123"] button').first().click();
  await page.waitForSelector('[data-usage-turn]');
  assert.ok(await page.locator('[data-usage-turn]').count() < 35);
  await page.locator('#usage-reset-open').click();
  await page.getByRole('dialog', { name: '确认清空用量账本？', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.locator('[data-usage-metric="total-tokens"] > strong').innerText(), '13.6m');
  await page.getByRole('tab', { name: '调用记录', exact: true }).click();
  await page.waitForSelector('[data-usage-recent]');
  assert.equal(await page.locator('[data-usage-recent]').count(), 40);
  const sessionsUrl = `${origin}/test/fixtures/session-pages.html`;
  async function openSessions() {
    await page.goto(sessionsUrl);
    await page.waitForSelector('[data-session-key]');
  }
  await openSessions();
  await page.locator('#session-filter').fill('100319');
  await page.waitForFunction(() => document.querySelectorAll('[data-session-key]').length === 0);
  for (let index = 0; index < 3; index++) await page.locator('#session-load-more').click();
  await page.locator('[data-session-key="group:100319"]').getByRole('button', { name: '100319', exact: true }).click();
  assert.equal(await page.locator('[data-selected-session]').getAttribute('data-selected-session'), 'group:100319');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#session-load-more').count(), 0);
  await page.locator('#session-filter').fill('');
  assert.ok(await page.locator('[data-session-key]').count() < 35);
  for (const outcome of ['resolve', 'reject']) {
    await openSessions();
    await page.locator('#session-fixture-hold').click();
    await page.locator('#session-load-more').click();
    await page.locator('#session-load-cancel').click();
    await page.locator('#session-fixture-change').click();
    await page.locator('#session-load-more').click();
    await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(element => element.textContent?.includes('发生变化')));
    await page.locator(`#session-fixture-${outcome}`).click();
    assert.ok(Number(await page.locator('#session-fixture-state').getAttribute('data-aborted')) > 0);
    assert.equal(await page.locator('#session-fixture-state').getAttribute('data-posts'), '0');
  }
  await openSessions();
  await page.locator('#session-fixture-empty-first').click();
  await page.getByRole('button', { name: '刷新', exact: true }).first().click();
  await page.waitForFunction(() => document.querySelectorAll('[data-session-key]').length === 0);
  await page.locator('#session-load-more').click();
  await page.waitForSelector('[data-session-key]');
  await openSessions();
  await page.locator('#session-fixture-cycle').click();
  await page.locator('#session-load-more').click();
  await page.waitForFunction(() => document.getElementById('session-load-more')?.hasAttribute('disabled') === true);
  assert.ok((await page.locator('[data-page="sessions"]').innerText()).includes('分页游标未前进'));
  assert.ok((await page.locator('[data-page="sessions"]').innerText()).includes('不是全量结果'));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ...evidence, scrollToEnd: true, stickyHeader: true, focusedDraftRetained: true,
    secretRetained: true, fullDataFilter: true, keyboardHomeEnd: true, textSelectionRetained: true,
    sessions: { mounted: sessionsDom, reachableBeyond256: true, cancelledLateReadsIgnored: true, emptyPageContinues: true, cursorCycleStops: true },
    usage: { conversationsMounted: usageDom, turnsMounted: turnsDom, recent: 40, nativeUnknownIsNotZero: true },
    provider: { models: 128, filteredModelEditor: true, draftAndSecretRetained: true, narrowScreen: true }, errors }, null, 2));
} finally {
  await browser?.close();
  await server.close();
  nativeFixture.close();
}
