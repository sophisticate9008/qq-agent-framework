import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, type Browser } from 'playwright';
import { startDemo } from '../src/demo.ts';

const directory = new URL('../runtime/ui-smoke/', import.meta.url);
await mkdir(directory, { recursive: true });
const token = randomBytes(32).toString('hex');
const application = await startDemo({ token, port: 0 });
const origin = `http://127.0.0.1:${application.address.port}`;
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  const external: string[] = [];
  page.on('pageerror', () => errors.push('pageerror'));
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) { external.push('external'); return route.abort(); }
    return route.continue();
  });
  await page.goto(origin);
  await page.getByRole('heading', { name: '工作台概览' }).waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await page.getByRole('button', { name: '连接工作台', exact: true }).first().click();
  await page.locator('#token').fill(token);
  await page.locator('#connect').click();
  await page.getByRole('button', { name: '断开连接' }).waitFor();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.doesNotMatch(await page.locator('main').innerText(), /gateway-live|maxPending|messaging\.send|legacy-egress|JSON/);
  const theme = page.getByRole('combobox', { name: '显示模式' });
  await theme.selectOption('light');
  await page.screenshot({ path: new URL('desktop-light.png', directory).pathname, fullPage: true, animations: 'disabled' });
  await theme.selectOption('dark');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.screenshot({ path: new URL('desktop-dark.png', directory).pathname, fullPage: true, animations: 'disabled' });
  await page.reload();
  await page.getByRole('heading', { name: '工作台概览' }).waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await page.getByRole('button', { name: '断开连接' }).count(), 0);
  assert.equal(await page.evaluate(value => Object.values(localStorage).includes(value) || Object.values(sessionStorage).includes(value) || document.cookie.includes(value), token), false);
  await theme.selectOption('system');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.setViewportSize({ width: 390, height: 844 });
  await theme.selectOption('light');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: new URL('mobile-light.png', directory).pathname, fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '切换侧栏', exact: true }).first().click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: '人设与形象', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: '人设与形象', exact: true }).waitFor();
  await theme.selectOption('dark');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: new URL('mobile-dark.png', directory).pathname, fullPage: true, animations: 'disabled' });
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  await writeFile(new URL('result.json', directory), JSON.stringify({ checkedAt: new Date().toISOString(),
    light: true, dark: true, systemThemeChanges: true, themePersisted: true, tokenNotPersisted: true,
    responsiveNavigation: true, noTechnicalDump: true, noHorizontalOverflow: true, pageErrors: 0, externalRequests: 0 }, null, 2) + '\n');
  console.log('Browser smoke passed: light/dark/system themes, private login, responsive navigation and readable overview.');
} finally { await browser?.close(); await application.stop(); }
