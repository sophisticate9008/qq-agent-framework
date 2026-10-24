import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { startDemo } from '../src/demo.ts';
import { chromium, type Browser } from 'playwright';

const directory = new URL('../runtime/iterations/001/', import.meta.url);
await mkdir(directory, { recursive: true });
const token = randomBytes(32).toString('hex');
const demo = await startDemo({ token, port: 0 });
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors: string[] = [];
  const external: string[] = [];
  page.on('pageerror', () => errors.push('pageerror'));
  const origin = `http://127.0.0.1:${demo.address.port}`;
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) {
      external.push('external-request');
      return route.abort();
    }
    return route.continue();
  });
  await page.goto(origin);
  assert.equal(await page.locator('#dispatch').isDisabled(), true);
  await page.locator('#token').fill(token);
  await page.locator('#connect').click();
  await page.waitForFunction(() => document.querySelector('#connection-status')?.textContent?.startsWith('已连接'));
  assert.equal(await page.locator('#token').inputValue(), '');
  assert.equal(await page.locator('#conversation-id').inputValue(), 'demo:room');
  for (const type of ['message.received', 'trigger.fired']) {
    await page.locator('#event-type').selectOption(type);
    await page.locator('#event-text').fill(`browser-${type} <img src=x onerror=alert(1)>`);
    const response = page.waitForResponse(result => result.url().endsWith('/api/demo/events') && result.request().method() === 'POST');
    await page.locator('#dispatch').click();
    const result = await response;
    assert.equal(result.status(), 200);
    assert.equal((await result.json()).outcomes[0].status, 'completed');
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#dispatch')?.disabled);
  }
  assert.equal(await page.locator('#outbox-content img').count(), 0);
  assert.match(await page.locator('#outbox-content').innerText(), /browser-message.received/);
  assert.match(await page.locator('#outbox-content').innerText(), /browser-trigger.fired/);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  await page.screenshot({ path: new URL('ui-desktop.png', directory).pathname, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: new URL('ui-mobile.png', directory).pathname, fullPage: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  const evidence = { at: new Date().toISOString(), browser: await browser.version(),
    connected: true, demoEvents: 2, pageErrors: errors.length, externalRequests: external.length,
    tokenFieldCleared: true, browserStorageEmpty: true, dynamicMarkupInert: true, mobileNoHorizontalOverflow: true };
  await writeFile(new URL('browser.json', directory), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log('Browser smoke passed: authenticated UI, two demo features, inert markup, desktop and mobile.');
} finally {
  if (browser) await browser.close();
  await demo.stop();
}
