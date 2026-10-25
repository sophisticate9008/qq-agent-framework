import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, type Browser } from 'playwright';
import { verifyExecutionRuntimeUi, verifyExecutionThemes } from './execution-runtime-browser-smoke.ts';

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
  if (!address || typeof address === 'string') throw new Error('execution_fixture_address_missing');
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1100, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const capture = async (label: string) => {
    if (!evidenceDirectory) return;
    await mkdir(evidenceDirectory, { recursive: true });
    await page.screenshot({ path: join(evidenceDirectory, `${label}.png`), fullPage: true });
  };
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const evidence: Record<string, number | boolean> = {};
  const themesOnly = process.env.QQ_AGENT_UI_THEME_ONLY === '1';
  let runtimeEvidence: Readonly<Record<string, boolean | number>> = {};
  if (!themesOnly) {
  const start = async () => {
    await page.goto(`${origin}/test/fixtures/execution-journal.html`);
    await page.locator('[data-execution-journal] > summary').click();
    await page.waitForSelector('[data-execution-row]');
  };
  const readAgain = () => page.getByRole('button', { name: '重新读取日志', exact: true }).click();
  const more = () => page.getByRole('button', { name: '继续加载执行记录', exact: true }).click();
  const waitCount = (count: number) => page.waitForFunction(count => document.querySelector('#execution-journal')?.textContent?.includes(`已读取 ${count} 条`), count);
  const waitPending = (count: number) => page.waitForFunction(count => document.querySelector('#execution-fixture-state')?.getAttribute('data-pending') === String(count), count);
  const noWrites = async () => assert.equal(await page.locator('#execution-fixture-state').getAttribute('data-posts'), '0');
  await start();
  await waitCount(100);
  assert.match(await page.locator('[data-execution-detail]').innerText(), /已超时/);
  assert.match(await page.locator('[data-execution-detail]').innerText(), /协作停止仅已受理，尚未确认停止/);
  assert.match(await page.locator('[data-execution-detail]').innerText(), /提醒结果未知/);
  const visible = await page.locator('#execution-journal').innerText();
  assert.equal(visible.includes('合成提醒正文'), false);
  assert.equal(visible.includes('FIXTURE_PRIVATE_ERROR'), false);
  assert.equal(visible.includes('isolated-session-'), false);
  assert.equal(visible.includes('00000000000000000000000000000000'), false);
  assert.equal(await page.locator('#execution-journal button').filter({ hasText: /重放|重置|手动停止/ }).count(), 0);
  evidence.humanUnknownAndNoRawBodies = true;
  await page.locator('[data-execution-detail] details > summary').click();
  await page.getByRole('button', { name: '复制执行标识', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-execution-detail]')?.textContent?.includes('已复制执行标识'));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '0'.repeat(64));
  await page.locator('[data-execution-detail] details > summary').click();
  evidence.collapsedIdentifiersCopyOnlyOnRequest = true;
  await page.locator('#execution-journal-filter').fill('0'.repeat(64));
  await page.waitForFunction(() => document.querySelectorAll('[data-execution-row]').length === 1);
  assert.match(await page.locator('[data-execution-row]').innerText(), /100000/);
  await page.locator('#execution-journal-filter').fill('合成提醒正文');
  await page.waitForFunction(() => document.querySelectorAll('[data-execution-row]').length === 0);
  await page.locator('#execution-journal-filter').fill('');
  await page.getByRole('button', { name: '查看执行记录 6', exact: true }).waitFor();
  evidence.searchesAllLoadedMetadataWithoutIndexingBodies = true;
  await page.getByRole('button', { name: '查看执行记录 6', exact: true }).click();
  assert.match(await page.locator('[data-execution-detail]').innerText(), /迟到完成仅留档/);
  assert.equal(await page.locator('[data-execution-detail]').getByText('已完成', { exact: true }).count(), 0);
  evidence.lateFinalNotSuccessOrNextReply = true;
  await page.locator('#execution-journal-filter').fill('100319');
  await page.waitForFunction(() => document.querySelectorAll('[data-execution-row]').length === 0);
  for (const count of [200, 300, 320]) { await more(); await waitCount(count); }
  await page.waitForSelector('[data-execution-row]');
  assert.match(await page.locator('[data-execution-row]').innerText(), /100319/);
  await page.locator('[data-execution-row] button').click();
  assert.match(await page.locator('[data-execution-detail]').innerText(), /100319/);
  evidence.noLocalMatchStillLoadsBeyond100And256 = true;
  await page.locator('#execution-journal-filter').fill('');
  await page.waitForSelector('[data-virtualized]');
  const bounds = { maxRows: 0, maxDom: 0 };
  for (const fraction of [0, 0.25, 0.5, 1]) {
    await page.locator('[data-execution-journal-scroll]').evaluate((element, fraction) => { element.scrollTop = (element.scrollHeight - element.clientHeight) * fraction; }, fraction);
    await page.waitForTimeout(80);
    const counts = await page.evaluate(() => ({ rows: document.querySelectorAll('[data-execution-row]').length, nodes: document.querySelectorAll('*').length }));
    assert.ok(counts.rows > 0 && counts.rows < 40, JSON.stringify(counts));
    assert.ok(counts.nodes < 1800, JSON.stringify(counts));
    bounds.maxRows = Math.max(bounds.maxRows, counts.rows);
    bounds.maxDom = Math.max(bounds.maxDom, counts.nodes);
  }
  await page.getByRole('button', { name: '查看执行记录 320', exact: true }).waitFor();
  const heights = await page.locator('[data-execution-journal-scroll]').evaluate(element => ({ height: element.clientHeight, scroll: element.scrollHeight }));
  assert.equal(heights.height, 382);
  assert.ok(heights.scroll > heights.height * 10);
  const headerOffset = await page.locator('[data-execution-journal-scroll]').evaluate(element => (element.querySelector('thead')?.getBoundingClientRect().top ?? 0) - element.getBoundingClientRect().top);
  assert.ok(headerOffset >= 0 && headerOffset < 3);
  await page.locator('[data-execution-row] button').first().focus();
  await page.keyboard.press('Home');
  await page.getByRole('button', { name: '查看执行记录 1', exact: true }).waitFor();
  await page.keyboard.press('End');
  await page.getByRole('button', { name: '查看执行记录 320', exact: true }).waitFor();
  await page.setViewportSize({ width: 460, height: 850 });
  assert.ok(await page.locator('[data-execution-journal-scroll]').evaluate(element => element.scrollWidth > element.clientWidth));
  await page.locator('[data-execution-journal] > summary').click();
  assert.equal(await page.locator('[data-execution-journal-scroll]').isVisible(), false);
  await page.locator('[data-execution-journal] > summary').click();
  assert.match(await page.locator('[data-execution-detail]').innerText(), /100319/);
  evidence.rows = 320;
  evidence.maxMountedRows = bounds.maxRows;
  evidence.maxDomNodes = bounds.maxDom;
  evidence.endKeyboardStickyNarrowAndFoldSelection = true;
  await capture('execution-journal');
  await readAgain();
  await waitCount(100);
  await page.locator('[data-execution-selection-unconfirmed]').waitFor();
  assert.equal(await page.locator('[data-execution-detail]').count(), 0);
  for (const count of [200, 300, 320]) { await more(); await waitCount(count); }
  assert.match(await page.locator('[data-execution-detail]').innerText(), /100319/);
  evidence.refreshPreservesSelectionWithoutTreatingUnloadedAsGone = true;
  await noWrites();

  for (const completion of ['resolve', 'reject']) {
    await start();
    await page.locator('#execution-fixture-hold').click();
    await readAgain();
    await waitPending(1);
    await page.locator('#execution-fixture-disconnect').click();
    await page.locator('#execution-fixture-version').click();
    await page.locator('#execution-fixture-connect').click();
    await waitCount(100);
    assert.match(await page.locator('[data-execution-detail]').innerText(), /200000/);
    await page.locator(`#execution-fixture-${completion}`).click();
    await waitPending(0);
    await page.waitForTimeout(50);
    assert.match(await page.locator('[data-execution-detail]').innerText(), /200000/);
    assert.equal(await page.locator('#execution-journal [role="alert"]').count(), 0);
    assert.ok(Number(await page.locator('#execution-fixture-state').getAttribute('data-aborted')) > 0);
    await noWrites();
  }
  evidence.reconnectIgnoresOldSuccessAndFailure = true;

  for (const completion of ['resolve', 'reject']) {
    await start();
    await page.locator('#execution-fixture-hold').click();
    await readAgain();
    await waitPending(1);
    await page.locator('#execution-fixture-disconnect').click();
    await page.locator('#execution-fixture-version').click();
    await page.locator('#execution-fixture-hold').click();
    await page.locator('#execution-fixture-connect').click();
    await waitPending(2);
    await page.locator(`#execution-fixture-${completion}`).click();
    await waitPending(1);
    assert.equal(await page.getByRole('button', { name: '重新读取日志', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '取消读取', exact: true }).isVisible(), true);
    assert.equal(await page.locator('#execution-journal [role="alert"]').count(), 0);
    await page.locator('#execution-fixture-resolve').click();
    await waitPending(0);
    await waitCount(100);
    assert.match(await page.locator('[data-execution-detail]').innerText(), /200000/);
    await noWrites();
  }
  evidence.oldFinallyCannotUnlockNewRead = true;

  for (const completion of ['resolve', 'reject']) {
    await start();
    await page.locator('#execution-fixture-hold').click();
    await more();
    await waitPending(1);
    await page.getByRole('button', { name: '取消读取', exact: true }).click();
    await page.locator(`#execution-fixture-${completion}`).click();
    await waitPending(0);
    await waitCount(100);
    assert.equal(await page.locator('#execution-journal [role="alert"]').count(), 0);
    await more();
    await waitCount(200);
    await noWrites();
  }
  evidence.cancelIgnoresLatePageSuccessAndFailure = true;

  await start();
  await page.locator('#execution-fixture-hold').click();
  await readAgain();
  await waitPending(1);
  await page.locator('#execution-fixture-unmount').click();
  await page.locator('#execution-fixture-version').click();
  await page.locator('#execution-fixture-mount').click();
  await page.locator('[data-execution-journal] > summary').click();
  await waitCount(100);
  await page.locator('#execution-fixture-resolve').click();
  await waitPending(0);
  assert.match(await page.locator('[data-execution-detail]').innerText(), /200000/);
  evidence.unmountAbortsAndIgnoresOldRead = true;

  await start();
  await page.locator('#execution-fixture-empty').click();
  await page.locator('#execution-fixture-partial').click();
  await readAgain();
  await waitCount(0);
  assert.match(await page.locator('#execution-journal').innerText(), /服务仅提供部分记录/);
  await more();
  await waitCount(100);
  evidence.emptyAndPartialPageDoNotClaimSuccessOrFull = true;

  await start();
  await page.locator('#execution-fixture-change').click();
  await more();
  await waitCount(200);
  assert.match(await page.locator('#execution-journal').innerText(), /1 条已读记录发生变化/);
  evidence.deduplicatesAndExplainsChangedRows = true;
  await page.locator('#execution-fixture-cycle').click();
  await more();
  await waitCount(300);
  assert.match(await page.locator('#execution-journal').innerText(), /后续位置未前进/);
  assert.equal(await page.getByRole('button', { name: '继续加载执行记录', exact: true }).isDisabled(), true);
  evidence.cursorCycleStopsWithoutFalseFull = true;

  for (const failure of ['forbidden', 'unavailable']) {
    await start();
    await page.locator(`#execution-fixture-${failure}`).click();
    await readAgain();
    await page.locator('#execution-journal [role="alert"]').waitFor();
    assert.match(await page.locator('#execution-journal [role="alert"]').innerText(), failure === 'forbidden' ? /没有读取.*权限/ : /不可用不代表没有任务/);
    await waitCount(100);
    await noWrites();
  }
  evidence.permissionAndUnavailableRemainUnconfirmed = true;
  await page.goto(`${origin}/test/fixtures/execution-journal.html?mount=sessions`);
  await page.locator('[data-page="sessions"]').waitFor();
  await page.locator('[data-selected-session="group:100000"]').waitFor();
  await page.locator('#execution-journal > .panel-body [data-execution-journal] > summary').click();
  await waitCount(100);
  assert.match(await page.locator('[data-execution-detail]').innerText(), /协作停止仅已受理/);
  assert.equal(await page.locator('#session-reset-open').isDisabled(), true);
  await page.locator('#execution-journal-filter').fill('100319');
  await page.waitForFunction(() => document.querySelectorAll('[data-execution-row]').length === 0);
  for (const count of [200, 300, 320]) { await more(); await waitCount(count); }
  await page.locator('[data-execution-row] button').click();
  assert.match(await page.locator('[data-execution-detail]').innerText(), /100319/);
  assert.equal(await page.locator('[data-selected-session="group:100000"]').count(), 1);
  await noWrites();
  evidence.actualSessionsPageReachableWithoutResetOrSelectionLoss = true;
  await capture('sessions-integrated');
  runtimeEvidence = await verifyExecutionRuntimeUi(page, origin, capture);
  }
  const themeEvidence = await verifyExecutionThemes(page, origin, capture);
  assert.deepEqual(errors, []);
  const report = { mode: themesOnly ? 'themes-only' : 'full', executionJournal: evidence, executionRuntime: runtimeEvidence, themes: themeEvidence, errors };
  if (evidenceDirectory) await writeFile(join(evidenceDirectory, 'terminal.json'), `${JSON.stringify({ status: 'passed', ...report }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  if (evidenceDirectory) {
    await mkdir(evidenceDirectory, { recursive: true });
    const failedPage = browser?.contexts()[0]?.pages()[0];
    if (failedPage) await failedPage.screenshot({ path: join(evidenceDirectory, 'failure.png'), fullPage: true }).catch(() => {});
    await writeFile(join(evidenceDirectory, 'terminal.json'), `${JSON.stringify({ status: 'failed', error: error instanceof Error ? error.message : 'execution_ui_fixture_failed' }, null, 2)}\n`);
  }
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
