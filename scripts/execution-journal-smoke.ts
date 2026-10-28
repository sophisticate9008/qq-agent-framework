import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, type Browser } from 'playwright';

const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('../', import.meta.url)),
  resolve: { alias: { '@': fileURLToPath(new URL('../web/', import.meta.url)) } },
  cacheDir: fileURLToPath(new URL('../runtime/testing/.vite-execution-journal/', import.meta.url)),
  optimizeDeps: { entries: ['test/fixtures/execution-journal.html', 'test/fixtures/execution-runtime.html'] },
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
let browser: Browser | undefined;
const evidenceDirectory = process.env.QQ_AGENT_UI_EVIDENCE_DIR;
if (evidenceDirectory && !isAbsolute(evidenceDirectory)) throw new Error('execution_evidence_directory_must_be_absolute');
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const start = async () => {
    await page.goto(`${origin}/test/fixtures/execution-journal.html`);
    await page.locator('[data-execution-row]').first().waitFor();
  };
  const count = (value: number) => page.waitForFunction(value => document.querySelector('#execution-journal')?.textContent?.includes(`/ ${value} 条`), value);
  const refresh = () => page.locator('#execution-journal').getByRole('button', { name: '刷新', exact: true }).click();
  const pending = (value: number) => page.waitForFunction(value => document.querySelector('#execution-fixture-state')?.getAttribute('data-pending') === String(value), value);
  await start(); await count(100);
  await page.locator('#execution-journal-filter').fill('100000');
  await page.waitForFunction(() => document.querySelectorAll('[data-execution-row]').length === 1);
  await page.getByRole('button', { name: '查看执行记录 1', exact: true }).click();
  const details = page.locator('[data-execution-detail]');
  assert.match(await details.innerText(), /已超时|超时/);
  assert.doesNotMatch(await details.innerText(), /FIXTURE_PRIVATE_ERROR|isolated-session-/);
  await page.keyboard.press('Escape');
  await page.locator('#execution-journal-filter').fill('');
  for (const value of [200, 300, 320]) {
    await page.getByRole('button', { name: '加载更早记录', exact: true }).click();
    await count(value);
  }
  assert(await page.locator('[data-execution-row]').count() < 60);
  await page.locator('#execution-journal-filter').fill('100319');
  await page.waitForFunction(() => document.querySelectorAll('[data-execution-row]').length === 1);
  await page.locator('[data-execution-row] button').click();
  assert.match(await details.innerText(), /100319/);
  assert.doesNotMatch(await details.innerText(), /FIXTURE_PRIVATE_ERROR|合成提醒正文/);
  await page.keyboard.press('Escape');
  await page.locator('#execution-journal-filter').fill('');
  await count(320);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert(await page.locator('[data-execution-journal-scroll]').evaluate(element => element.scrollHeight > element.clientHeight));
    if (evidenceDirectory) {
      await mkdir(evidenceDirectory, { recursive: true });
      await page.screenshot({ path: join(evidenceDirectory, `execution-journal-${width}.png`), fullPage: true });
    }
  }
  for (const completion of ['resolve', 'reject']) {
    await start();
    await page.locator('#execution-fixture-hold').click(); await refresh(); await pending(1);
    await page.locator('#execution-fixture-disconnect').click();
    await page.locator('#execution-fixture-version').click();
    await page.locator('#execution-fixture-connect').click();
    await count(100);
    await page.waitForFunction(() => document.querySelector('[data-execution-row]')?.textContent?.includes('200099'));
    await page.locator(`#execution-fixture-${completion}`).click(); await pending(0);
    assert.match(await page.locator('[data-execution-row]').first().innerText(), /200099/);
    assert.equal(await page.locator('#execution-journal [role="alert"]').count(), 0);
    assert(Number(await page.locator('#execution-fixture-state').getAttribute('data-aborted')) > 0);
  }
  await start();
  await page.locator('#execution-fixture-partial').click(); await refresh();
  await page.getByText('服务仅提供部分记录；缺失状态保持未知，不以成功或空日志代替。', { exact: true }).waitFor();
  await page.locator('#execution-fixture-forbidden').click(); await refresh();
  await page.locator('#execution-journal [role="alert"]').waitFor();
  assert.equal(await page.locator('#execution-fixture-state').getAttribute('data-posts'), '0');
  assert.deepEqual(errors, []);
  if (evidenceDirectory) await writeFile(join(evidenceDirectory, 'result.json'), JSON.stringify({ passed: true,
    rows: 320, virtualized: true, detailsDialog: true, reconnectIgnoresStaleReads: true, readOnly: true }, null, 2));
  console.log('执行日志浏览器验证通过：分页、虚拟列表、详情窗口、窄屏、读取错误与断线重连隔离。');
} finally {
  await browser?.close();
  await server.close();
}
