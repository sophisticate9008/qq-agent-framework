import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, type Browser } from 'playwright';
import { startDemo } from '../src/demo.ts';
import { navigateConsolePage } from './browser-navigation-smoke.ts';

const directory = new URL('../runtime/ui-smoke/', import.meta.url);
await mkdir(directory, { recursive: true });
const token = randomBytes(32).toString('hex');
const application = await startDemo({ token, port: 0 });
const origin = `http://127.0.0.1:${application.address.port}`;
const sessionUrl = `${origin}/api/auth/session`;
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
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await page.locator('#token').waitFor();
  await page.locator('#token').fill(token);
  await page.locator('#connect').click();
  await page.getByRole('button', { name: '断开连接' }).waitFor();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: '工作台概览' }).waitFor();
  const sessionCookies = (await context.cookies(sessionUrl)).filter(cookie => cookie.httpOnly && cookie.path === '/api');
  assert.equal(sessionCookies.length, 1);
  const sessionCookie = sessionCookies[0]!;
  assert.equal(sessionCookie.sameSite, 'Strict');
  assert.notEqual(sessionCookie.value, token);
  assert(sessionCookie.expires > Date.now() / 1000);
  assert.equal(await page.evaluate(value => JSON.stringify(localStorage).includes(value)
    || JSON.stringify(sessionStorage).includes(value) || document.cookie.includes(value), token), false);
  assert.doesNotMatch(await page.locator('main').innerText(), /gateway-live|maxPending|messaging\.send|JSON/);
  const theme = page.getByRole('combobox', { name: '显示模式' });
  await theme.selectOption('light');
  await page.screenshot({ path: new URL('desktop-light.png', directory).pathname, fullPage: true, animations: 'disabled' });
  await theme.selectOption('dark');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.screenshot({ path: new URL('desktop-dark.png', directory).pathname, fullPage: true, animations: 'disabled' });
  await page.reload();
  await page.getByRole('heading', { name: '工作台概览' }).waitFor();
  await page.getByRole('button', { name: '断开连接' }).waitFor();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await page.evaluate(value => JSON.stringify(localStorage).includes(value)
    || JSON.stringify(sessionStorage).includes(value) || document.cookie.includes(value), token), false);

  let failSessionRequest = true;
  await page.route('**/api/auth/session', route => {
    if (failSessionRequest) {
      failSessionRequest = false;
      return route.abort('failed');
    }
    return route.continue();
  });
  await page.reload();
  await page.getByRole('button', { name: '重试现有访问会话' }).waitFor();
  assert.equal((await context.cookies(sessionUrl)).find(cookie => cookie.name === sessionCookie.name)?.value, sessionCookie.value);
  await page.unroute('**/api/auth/session');
  await page.getByRole('button', { name: '重试现有访问会话' }).click();
  await page.getByRole('button', { name: '断开连接' }).waitFor();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });

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
  await page.route('**/api/chat/personas', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ revision: 'a'.repeat(64), personas: [{ id: 'browser-persona', name: '浏览器测试', identity: '测试角色的身份定义', style: '自然简洁' }] })
  }));
  await navigateConsolePage(page, 'persona');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: '人设与形象', exact: true }).waitFor();
  await theme.selectOption('dark');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: new URL('mobile-dark.png', directory).pathname, fullPage: true, animations: 'disabled' });

  const persona = page.getByRole('textbox', { name: '身份定义' });
  await persona.fill('尚未保存的人设正文');
  await page.getByRole('button', { name: '断开连接', exact: true }).click();
  await page.getByRole('heading', { name: '退出工作台？' }).waitFor();
  assert.equal((await context.cookies(sessionUrl)).some(cookie => cookie.name === sessionCookie.name), true);
  await page.getByRole('button', { name: '继续编辑' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal((await context.cookies(sessionUrl)).some(cookie => cookie.name === sessionCookie.name), true);
  await page.getByRole('button', { name: '断开连接', exact: true }).click();
  await page.getByRole('button', { name: '退出并清除草稿' }).click();
  await page.getByRole('button', { name: '连接工作台', exact: true }).first().waitFor();
  assert.equal((await context.cookies(sessionUrl)).some(cookie => cookie.name === sessionCookie.name), false);

  await context.addCookies([{
    name: sessionCookie.name,
    value: 'invalid-browser-session-0123456789',
    domain: sessionCookie.domain,
    path: '/api',
    httpOnly: true,
    secure: sessionCookie.secure,
    sameSite: 'Strict',
    expires: Math.floor(Date.now() / 1000) + 3600
  }]);
  await page.reload();
  await page.locator('#token').waitFor();
  assert.equal(await page.getByRole('button', { name: '断开连接' }).count(), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  await writeFile(new URL('result.json', directory), JSON.stringify({ checkedAt: new Date().toISOString(),
    light: true, dark: true, systemThemeChanges: true, themePersisted: true, administratorTokenNotPersisted: true,
    httpOnlyStrictApiCookie: true, refreshSessionRestored: true, networkRetryPreservedSession: true,
    dirtyLogoutProtected: true, explicitLogoutRevokedSession: true, invalidSessionRejected: true,
    responsiveNavigation: true, noTechnicalDump: true, noHorizontalOverflow: true, pageErrors: 0, externalRequests: 0 }, null, 2) + '\n');
  console.log('Browser smoke passed: cookie session lifecycle, private login, themes, responsive navigation and readable overview.');
} finally { await browser?.close(); await application.stop(); }
