import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAdminServer } from '../src/admin/server.ts';
import { startDemo } from '../src/demo.ts';
import { chromium, type Browser } from 'playwright';

interface RunningLiveAdmin {
  readonly origin: string;
  readonly snapshotReads: () => number;
  readonly stop: () => Promise<void>;
}

const iteration = process.env.FRAMEWORK_ITERATION ?? '001';
assert(/^\d{3}$/.test(iteration), 'FRAMEWORK_ITERATION must contain three digits.');
const directory = new URL(`../runtime/iterations/${iteration}/`, import.meta.url);
await mkdir(directory, { recursive: true });

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeIdleConnections();
  });
}

async function startLiveAdmin(token: string): Promise<RunningLiveAdmin> {
  let reads = 0;
  const server = createAdminServer({
    token,
    snapshot: () => {
      reads += 1;
      return {
        mode: 'gateway-live',
        overview: {
          name: 'Gateway <img src=x onerror=alert(1)>',
          status: `online-${reads}`,
          connection: '正式接入',
          outbound: 'HTTP出站兼容',
          legacyDsh: '保留'
        },
        features: [{
          id: 'legacy-http-outbound <img src=x onerror=alert(1)>',
          version: 'current',
          status: 'active',
          capabilities: ['messaging.send']
        }],
        context: {
          persona: { id: 'gateway-operator' },
          configuration: { transport: 'http-compatible' },
          preferences: {},
          provenance: { source: 'gateway-runtime' }
        },
        policy: {
          paused: false,
          source: 'gateway-configuration',
          configuration: { maxSendUses: 250, grantTtlMs: null },
          grants: []
        },
        outbox: [{ status: 'confirmed', target: '<img src=x onerror=alert(1)>' }],
        audit: [{ action: 'snapshot.read', result: 'allowed' }]
      };
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    origin: `http://127.0.0.1:${(address as AddressInfo).port}`,
    snapshotReads: () => reads,
    stop: () => closeServer(server)
  };
}

const token = randomBytes(32).toString('hex');
const demo = await startDemo({ token, port: 0 });
let liveAdmin: RunningLiveAdmin | undefined;
let browser: Browser | undefined;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {})
  });

  const demoContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await demoContext.newPage();
  const errors: string[] = [];
  const external: string[] = [];
  page.on('pageerror', () => errors.push('pageerror'));
  const origin = `http://127.0.0.1:${demo.address.port}`;
  await demoContext.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) {
      external.push('external-request');
      return route.abort();
    }
    return route.continue();
  });
  await page.goto(origin);
  assert.equal(await page.title(), 'QQ Agent Framework · 管理台');
  assert.equal(await page.locator('#demo').isHidden(), true);
  assert.equal(await page.locator('#dispatch').isDisabled(), true);
  await page.locator('#token').fill(token);
  await page.locator('#connect').click();
  await page.waitForFunction(() => document.querySelector('#connection-status')?.textContent?.startsWith('已连接'));
  assert.equal(await page.locator('#token').inputValue(), '');
  assert.equal(await page.locator('#demo').isVisible(), true);
  assert.equal(await page.locator('#conversation-id').inputValue(), 'demo:room');
  for (const type of ['message.received', 'trigger.fired']) {
    await page.locator('#event-type').selectOption(type);
    await page.locator('#event-text').fill(`browser-${type} <img src=x onerror=alert(1)>`);
    const response = page.waitForResponse(result => result.url().endsWith('/api/demo/events')
      && result.request().method() === 'POST');
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
  await demoContext.close();

  const liveToken = randomBytes(32).toString('hex');
  liveAdmin = await startLiveAdmin(liveToken);
  const liveContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const livePage = await liveContext.newPage();
  const liveErrors: string[] = [];
  const liveExternal: string[] = [];
  const liveWrites: string[] = [];
  livePage.on('pageerror', () => liveErrors.push('pageerror'));
  livePage.on('request', request => {
    if (request.method() !== 'GET') liveWrites.push(request.method());
  });
  await liveContext.route('**/*', route => {
    if (new URL(route.request().url()).origin !== liveAdmin?.origin) {
      liveExternal.push('external-request');
      return route.abort();
    }
    return route.continue();
  });

  await livePage.goto(liveAdmin.origin);
  const initialText = await livePage.locator('body').innerText();
  assert.equal(await livePage.title(), 'QQ Agent Framework · 管理台');
  assert.doesNotMatch(initialText, /正式接入|旧DSH保留/);
  assert.match(initialText, /尚未认证；这不表示后台已经开放/);
  assert.match(await livePage.locator('.connection-help').textContent() ?? '', /docs\/GATEWAY_ADMIN\.md/);
  assert.equal(await livePage.locator('#demo').isHidden(), true);
  assert.equal(await livePage.locator('#dispatch').isDisabled(), true);

  await livePage.locator('#token').fill(liveToken);
  await livePage.locator('#connect').click();
  await livePage.waitForFunction(() => document.querySelector('#connection-status')?.textContent
    ?.includes('正式接入 / HTTP出站兼容，旧DSH保留'));
  assert.equal(await livePage.locator('#token').inputValue(), '');
  assert.match(await livePage.title(), /正式接入 \/ HTTP出站兼容，旧DSH保留/);
  assert.equal(await livePage.locator('#demo').isHidden(), true);
  assert.equal(await livePage.locator('#demo-nav').isHidden(), true);
  assert.equal(await livePage.locator('#dispatch').isDisabled(), true);
  assert.equal(await livePage.locator('#features-content .feature-card').count(), 1);
  assert.match(await livePage.locator('#features-content').innerText(), /legacy-http-outbound/);
  assert.match(await livePage.locator('#policy-content').innerText(), /maxSendUses[\s\S]*250/);
  assert.doesNotMatch(await livePage.locator('#outbox-content').innerText(), /暂无演示消息/);
  assert.doesNotMatch(await livePage.locator('body').innerText(), /完整newhost/);
  assert.equal(await livePage.locator('img').count(), 0);
  assert.match(await livePage.locator('#overview-content').innerText(), /<img src=x onerror=alert\(1\)>/);
  assert.equal(liveAdmin.snapshotReads(), 1);

  const refreshed = livePage.waitForResponse(response => response.url().endsWith('/api/snapshot')
    && response.request().method() === 'GET');
  await livePage.locator('#refresh').click();
  assert.equal((await refreshed).status(), 200);
  await livePage.waitForFunction(() => document.querySelector('#connection-status')?.textContent
    ?.startsWith('已连接'));
  assert.equal(liveAdmin.snapshotReads(), 2);
  assert.match(await livePage.locator('#overview-content').innerText(), /online-2/);
  assert.deepEqual(liveWrites, []);
  assert.equal(await livePage.evaluate(() => localStorage.length + sessionStorage.length), 0);
  await livePage.setViewportSize({ width: 390, height: 844 });
  assert(await livePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

  await livePage.reload();
  await livePage.waitForFunction(() => document.querySelector('#connection-status')?.textContent
    ?.startsWith('尚未认证'));
  assert.equal(liveAdmin.snapshotReads(), 2);
  assert.equal(await livePage.title(), 'QQ Agent Framework · 管理台');
  assert.doesNotMatch(await livePage.locator('body').innerText(), /正式接入|旧DSH保留/);
  assert.equal(await livePage.locator('#token').inputValue(), '');
  assert.equal(await livePage.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.deepEqual(liveErrors, []);
  assert.deepEqual(liveExternal, []);
  await liveContext.close();

  const evidence = {
    at: new Date().toISOString(),
    browser: await browser.version(),
    connected: true,
    demoEvents: 2,
    pageErrors: errors.length + liveErrors.length,
    externalRequests: external.length + liveExternal.length,
    tokenFieldCleared: true,
    browserStorageEmpty: true,
    dynamicMarkupInert: true,
    mobileNoHorizontalOverflow: true,
    gatewayLive: {
      readOnly: liveWrites.length === 0,
      snapshotReads: liveAdmin.snapshotReads(),
      demoControlsHidden: true,
      reloadRequiresToken: true
    }
  };
  await writeFile(new URL('browser.json', directory), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log('Browser smoke passed: demo controls, gateway-live read-only mode, inert markup, refresh and mobile.');
} finally {
  if (browser) await browser.close();
  if (liveAdmin) await liveAdmin.stop();
  await demo.stop();
}
