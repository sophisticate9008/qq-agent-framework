import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';

import { createNativeRuntimeRoutes } from '../src/admin/runtime.ts';
import { createAdminServer } from '../src/admin/server.ts';

const outputDirectory = new URL('../runtime/management-smoke/', import.meta.url);
const administratorToken = 'management-smoke-administrator-token-1234567890';
const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const xssText = '<img src="/management-smoke-xss" onerror="globalThis.__managementSmokeXss=true">';
const fixtureAdapterCredential = 'fixture-only-adapter-value-1234567890';

interface RequestRecord {
  readonly method: string;
  readonly pathname: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertAdapterCredentialsRedacted(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertAdapterCredentialsRedacted(item);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    assert(!['secret', 'auth', 'token', 'hmac'].includes(key), `Adapter response exposed credential field ${key}.`);
    assertAdapterCredentialsRedacted(nested);
  }
}

async function writePrivateJson(filename: string, value: unknown): Promise<void> {
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function readJson(filename: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(filename, 'utf8'));
  assert(isRecord(value));
  return value;
}

async function listen(server: Server): Promise<AddressInfo> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const reject = (error: Error): void => rejectPromise(error);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolvePromise();
    });
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return address;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (server === undefined || !server.listening) return;
  server.closeAllConnections();
  await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
}

function section(page: Page, title: string): Locator {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).first();
}

function field(page: Page, label: string): Locator {
  return page.getByText(label, { exact: true }).locator('xpath=ancestor::label[1]').first();
}

async function navigate(page: Page, label: string, pageId: string, heading: string): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).first().click();
  await page.locator(`[data-page="${pageId}"]`).waitFor();
  await page.getByRole('heading', { name: heading, exact: true, level: 1 }).waitFor();
}

async function connect(page: Page): Promise<void> {
  await page.locator('#token').fill(administratorToken);
  await page.locator('#connect').click();
  await page.getByRole('button', { name: '断开连接', exact: true }).waitFor();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
}

async function apiJson(page: Page, pathname: string, init?: { readonly method: 'POST'; readonly body: unknown }): Promise<{
  readonly status: number;
  readonly value: unknown;
}> {
  return page.evaluate(async ({ target, request }) => {
    const response = await fetch(target, request === undefined ? undefined : {
      method: request.method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request.body),
    });
    return { status: response.status, value: await response.json() as unknown };
  }, { target: pathname, request: init });
}

async function screenshot(page: Page, name: string): Promise<void> {
  const filename = new URL(`${name}-${runId}.png`, outputDirectory).pathname;
  await page.screenshot({ path: filename, fullPage: true, animations: 'disabled' });
  await chmod(filename, 0o600);
}

async function assertBoundedLongText(sectionLocator: Locator, textarea: Locator, value: string): Promise<void> {
  const boundedCardSelector = '[data-bounded-card]';
  const card = sectionLocator.locator(boundedCardSelector).first();
  const footer = sectionLocator.locator('.panel-footer');
  await card.waitFor();
  const before = await sectionLocator.evaluate((sectionElement, selector) => {
    const cardElement = sectionElement.querySelector(selector);
    const footerElement = sectionElement.querySelector('.panel-footer');
    if (!(cardElement instanceof HTMLElement) || !(footerElement instanceof HTMLElement)) {
      throw new Error('Bounded management card or independent footer is missing.');
    }
    return {
      sectionHeight: sectionElement.getBoundingClientRect().height,
      cardHeight: cardElement.getBoundingClientRect().height,
    };
  }, boundedCardSelector);
  await textarea.fill(value);
  const textOverflow = await textarea.evaluate(element => {
    element.scrollTop = Math.min(96, element.scrollHeight - element.clientHeight);
    const style = getComputedStyle(element);
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
      overflowY: style.overflowY,
    };
  });
  assert(textOverflow.scrollHeight > textOverflow.clientHeight, `Long textarea did not overflow internally: ${JSON.stringify(textOverflow)}.`);
  assert(textOverflow.scrollTop > 0 && ['auto', 'scroll'].includes(textOverflow.overflowY),
    `Long textarea is not internally scrollable: ${JSON.stringify(textOverflow)}.`);
  const after = await sectionLocator.evaluate((sectionElement, selector) => {
    const cardElement = sectionElement.querySelector(selector);
    const footerElement = sectionElement.querySelector('.panel-footer');
    if (!(cardElement instanceof HTMLElement) || !(footerElement instanceof HTMLElement)) {
      throw new Error('Bounded management card or independent footer is missing.');
    }
    cardElement.scrollTop = Math.min(96, cardElement.scrollHeight - cardElement.clientHeight);
    const cardBounds = cardElement.getBoundingClientRect();
    const footerBounds = footerElement.getBoundingClientRect();
    return {
      sectionHeight: sectionElement.getBoundingClientRect().height,
      cardHeight: cardBounds.height,
      cardClientHeight: cardElement.clientHeight,
      cardScrollHeight: cardElement.scrollHeight,
      cardScrollTop: cardElement.scrollTop,
      overflowY: getComputedStyle(cardElement).overflowY,
      footerAfterCard: footerBounds.top >= cardBounds.bottom - 1,
      footerDisplay: getComputedStyle(footerElement).display,
    };
  }, boundedCardSelector);
  assert(Math.abs(after.sectionHeight - before.sectionHeight) <= 2,
    `Long input changed section height: ${JSON.stringify({ before, after })}.`);
  assert(Math.abs(after.cardHeight - before.cardHeight) <= 2,
    `Long input changed bounded card height: ${JSON.stringify({ before, after })}.`);
  assert(after.cardScrollHeight > after.cardClientHeight && after.cardScrollTop > 0
    && ['auto', 'scroll'].includes(after.overflowY), `Bounded card did not scroll internally: ${JSON.stringify(after)}.`);
  assert(after.footerAfterCard && after.footerDisplay !== 'none' && await footer.isVisible(),
    `Management footer is not independently visible: ${JSON.stringify(after)}.`);
}

async function tokenIsAbsentFromStorage(page: Page): Promise<boolean> {
  return page.evaluate(async expected => {
    const storage = `${JSON.stringify(localStorage)}${JSON.stringify(sessionStorage)}${document.cookie}${location.href}`;
    const databases = indexedDB.databases === undefined ? [] : await indexedDB.databases();
    const cacheNames = 'caches' in globalThis ? await caches.keys() : [];
    return !storage.includes(expected)
      && !JSON.stringify(databases).includes(expected)
      && !JSON.stringify(cacheNames).includes(expected);
  }, administratorToken);
}

async function run(): Promise<void> {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await chmod(outputDirectory, 0o700);
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'management-smoke-'));
  const runtimeDirectory = join(fixtureDirectory, 'runtime');
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  await writePrivateJson(join(runtimeDirectory, 'chat-personas.json'), {
    schema: 1,
    personas: [{ id: 'fixture-persona', name: 'Fixture Persona', identity: xssText, style: 'Calm and precise.' }],
  });
  await writePrivateJson(join(runtimeDirectory, 'chat-plans.json'), {
    schema: 1,
    activePlanId: 'fixture-plan',
    plans: [{
      id: 'fixture-plan', name: 'Fixture Plan', description: 'Independent native plan.',
      instructions: 'Answer concisely.', personaId: 'fixture-persona', provider: 'fixture-provider',
      model: 'fixture-model', reasoningEffort: 'medium',
    }],
  });
  await writePrivateJson(join(runtimeDirectory, 'chat-access.json'), {
    schema: 1, allow: [], deny: [], owner: null,
  });

  const requests: RequestRecord[] = [];
  const pageErrors: string[] = [];
  const externalRequests: string[] = [];
  let xssRequests = 0;
  let server: Server | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;

  try {
    server = createAdminServer({
      token: administratorToken,
      snapshot: () => ({
        mode: 'gateway-live',
        integrations: { nativeRuntimeResources: true, nativeChatRuntime: false },
        overview: {
          online: true,
          gatewayHealthy: true,
          metrics: { writes: 0, pending: 0, rejected: 0, unknown: 0, recoveredUnknown: 0 },
        },
        fixtureOnly: true,
      }),
      routes: createNativeRuntimeRoutes({ directory: runtimeDirectory }),
      handlerTimeoutMs: 5_000,
    });
    const address = await listen(server);
    const origin = `http://127.0.0.1:${address.port}`;

    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROMIUM_EXECUTABLE === undefined ? {} : { executablePath: process.env.CHROMIUM_EXECUTABLE }),
    });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
    page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === origin) requests.push({ method: request.method(), pathname: url.pathname });
      if (url.pathname === '/management-smoke-xss') xssRequests += 1;
    });
    await context.route('**/*', route => {
      const requested = new URL(route.request().url());
      if ((requested.protocol === 'http:' || requested.protocol === 'https:') && requested.origin !== origin) {
        externalRequests.push(requested.href);
        return route.abort();
      }
      return route.continue();
    });

    await page.goto(origin);
    await connect(page);
    const cookies = await context.cookies(`${origin}/api/auth/session`);
    assert(cookies.some(cookie => cookie.httpOnly && cookie.sameSite === 'Strict' && cookie.path === '/api'));

    await navigate(page, '聊天方案', 'model', '聊天方案');
    await section(page, 'Fixture Plan').waitFor();
    await page.getByText('原生聊天宿主未接入，已保存方案当前不可用于真实聊天。', { exact: true }).waitFor();
    const planName = field(page, '方案名称').locator('input');
    await planName.fill('Fixture Plan Updated');
    await assertBoundedLongText(
      section(page, 'Fixture Plan Updated'),
      field(page, '方案指令').locator('textarea'),
      Array.from({ length: 120 }, (_, index) => `Plan instruction ${index + 1}: remain within the native plan boundary.`).join('\n'),
    );
    await page.getByRole('button', { name: '保存聊天方案', exact: true }).click();
    await page.getByText('聊天方案目录已保存。', { exact: true }).waitFor();

    const planResponse = await apiJson(page, '/api/chat/plans');
    assert.equal(planResponse.status, 200);
    assert(isRecord(planResponse.value) && typeof planResponse.value.revision === 'string');
    const modelBefore = await apiJson(page, '/api/chat/model');
    assert.equal(modelBefore.status, 200);
    assert(isRecord(modelBefore.value) && typeof modelBefore.value.revision === 'string');
    const modelSaved = await apiJson(page, '/api/chat/model', {
      method: 'POST',
      body: { revision: modelBefore.value.revision, provider: 'fixture-provider-v2', model: 'fixture-model-v2', reasoningEffort: 'high' },
    });
    assert.equal(modelSaved.status, 200);
    assert.deepEqual(isRecord(modelSaved.value) ? {
      activePlanId: modelSaved.value.activePlanId,
      provider: modelSaved.value.provider,
      model: modelSaved.value.model,
      reasoningEffort: modelSaved.value.reasoningEffort,
    } : null, {
      activePlanId: 'fixture-plan', provider: 'fixture-provider-v2', model: 'fixture-model-v2', reasoningEffort: 'high',
    });
    const staleModel = await apiJson(page, '/api/chat/model', {
      method: 'POST',
      body: { revision: modelBefore.value.revision, provider: 'stale-provider', model: 'stale-model', reasoningEffort: 'low' },
    });
    assert.equal(staleModel.status, 409);
    assert.deepEqual(staleModel.value, { error: 'chat_revision_conflict' });

    await navigate(page, '人设与形象', 'persona', '人设与形象');
    await page.getByText(xssText, { exact: true }).waitFor();
    const style = field(page, '表达风格').locator('textarea');
    const personaStyle = Array.from({ length: 120 }, (_, index) => `Style rule ${index + 1}: warm, direct, and bounded.`).join('\n');
    await assertBoundedLongText(section(page, 'Fixture Persona'), style, personaStyle);
    await page.getByRole('button', { name: '保存人设', exact: true }).click();
    await page.getByText('人设库已保存。', { exact: true }).waitFor();

    await navigate(page, '访问范围', 'access', '访问范围');
    await page.getByText('当前默认全部拒绝。', { exact: true }).waitFor();
    const allow = field(page, '允许名单').locator('textarea');
    const deny = field(page, '拒绝名单').locator('textarea');
    const owner = field(page, '所有者用户号').locator('input');
    await allow.fill('group:456001\nprivate:123001');
    await deny.fill('group:999001');
    await owner.fill('123001');
    const accessPostsBeforeInvalid = requests.filter(request => request.method === 'POST' && request.pathname === '/api/chat/access').length;
    await allow.fill('group:456001\ngroup:456001');
    await page.getByRole('button', { name: '保存授权', exact: true }).click();
    await page.getByRole('alert').getByText('同一名单中不能填写重复授权项。', { exact: true }).waitFor();
    assert.equal(requests.filter(request => request.method === 'POST' && request.pathname === '/api/chat/access').length, accessPostsBeforeInvalid);
    await allow.fill('group:456001\nprivate:123001');
    await page.getByRole('button', { name: '保存授权', exact: true }).click();
    await page.getByText('原生访问授权已保存。', { exact: true }).waitFor();

    const adaptersBefore = await apiJson(page, '/api/chat/adapters');
    assert.equal(adaptersBefore.status, 200);
    assert(isRecord(adaptersBefore.value) && typeof adaptersBefore.value.revision === 'string');
    assertAdapterCredentialsRedacted(adaptersBefore.value);
    const initialAdapterRevision = adaptersBefore.value.revision;
    const adapterEndpoint = 'http://127.0.0.1:3000';
    const adaptersSaved = await apiJson(page, '/api/chat/adapters', {
      method: 'POST',
      body: {
        revision: initialAdapterRevision,
        adapters: { onebotHttp: { enabled: true, endpoint: adapterEndpoint, secret: fixtureAdapterCredential } },
      },
    });
    assert.equal(adaptersSaved.status, 200);
    assert(isRecord(adaptersSaved.value) && typeof adaptersSaved.value.revision === 'string');
    assertAdapterCredentialsRedacted(adaptersSaved.value);
    const savedAdapters = adaptersSaved.value.adapters;
    assert(isRecord(savedAdapters) && isRecord(savedAdapters.onebotHttp));
    assert.deepEqual(savedAdapters.onebotHttp, {
      enabled: true,
      endpoint: adapterEndpoint,
      secretConfigured: true,
    });
    const adaptersAfterReplace = await readJson(join(runtimeDirectory, 'chat-adapters.json'));
    assert(isRecord(adaptersAfterReplace.adapters) && isRecord(adaptersAfterReplace.adapters.onebotHttp));
    assert(adaptersAfterReplace.adapters.onebotHttp.secret === fixtureAdapterCredential,
      'Replacing an adapter credential did not persist the submitted fixture value.');

    await navigate(page, '适配器', 'adapters', '适配器');
    await section(page, '运行状态').waitFor();
    await page.getByText('聊天收发尚未接通。', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-page="adapters"] [data-bounded-card]').count(), 3);
    assert.equal(await page.getByRole('heading', { name: '图片服务', exact: true }).count(), 0);
    assert.equal(await page.getByRole('switch', { name: '启用此连接', exact: true }).count(), 2);
    await page.getByText('协议端 API 密钥（可选）', { exact: true }).waitFor();
    await page.getByText('复制协议端 HTTP 服务设置中的 accessToken。不是本管理后台的管理员令牌或登录会话；协议端未启用认证时可不填。', { exact: true }).waitFor();
    assert.equal(await page.locator('#adapter-onebotHttp-credential-action').inputValue(), 'keep');
    assert.equal(await page.locator('#adapter-onebotHttp-credential-value').count(), 0);
    assert.equal((await page.locator('body').innerText()).includes(fixtureAdapterCredential), false);

    const adaptersKept = await apiJson(page, '/api/chat/adapters', {
      method: 'POST',
      body: {
        revision: adaptersSaved.value.revision,
        adapters: { onebotHttp: { enabled: true, endpoint: adapterEndpoint, secret: '' } },
      },
    });
    assert.equal(adaptersKept.status, 200);
    assert(isRecord(adaptersKept.value) && typeof adaptersKept.value.revision === 'string');
    assertAdapterCredentialsRedacted(adaptersKept.value);
    const adaptersAfterKeep = await readJson(join(runtimeDirectory, 'chat-adapters.json'));
    assert(isRecord(adaptersAfterKeep.adapters) && isRecord(adaptersAfterKeep.adapters.onebotHttp));
    assert(adaptersAfterKeep.adapters.onebotHttp.secret === fixtureAdapterCredential,
      'An empty adapter credential did not preserve the saved fixture value.');

    const adaptersCleared = await apiJson(page, '/api/chat/adapters', {
      method: 'POST',
      body: {
        revision: adaptersKept.value.revision,
        adapters: { onebotHttp: { enabled: true, endpoint: adapterEndpoint, clearSecret: true } },
      },
    });
    assert.equal(adaptersCleared.status, 200);
    assert(isRecord(adaptersCleared.value) && typeof adaptersCleared.value.revision === 'string');
    assertAdapterCredentialsRedacted(adaptersCleared.value);
    const clearedAdapters = adaptersCleared.value.adapters;
    assert(isRecord(clearedAdapters) && isRecord(clearedAdapters.onebotHttp));
    assert.equal(clearedAdapters.onebotHttp.secretConfigured, false);
    const adaptersAfterClear = await readJson(join(runtimeDirectory, 'chat-adapters.json'));
    assert(isRecord(adaptersAfterClear.adapters) && isRecord(adaptersAfterClear.adapters.onebotHttp));
    assert(adaptersAfterClear.adapters.onebotHttp.secret === '', 'Clearing an adapter credential did not remove it.');

    const staleAdapters = await apiJson(page, '/api/chat/adapters', {
      method: 'POST',
      body: {
        revision: initialAdapterRevision,
        adapters: { onebotHttp: { enabled: false, endpoint: adapterEndpoint } },
      },
    });
    assert.equal(staleAdapters.status, 409);
    assert.deepEqual(staleAdapters.value, { error: 'chat_revision_conflict' });
    await page.getByRole('button', { name: '重新读取', exact: true }).click();
    await page.getByText('尚未设置', { exact: true }).first().waitFor();
    assert.equal(await page.locator('#adapter-onebotHttp-credential-value').count(), 0);

    await navigate(page, '功能与触发', 'features', '功能与触发');
    await page.getByText('原生聊天宿主未接入。', { exact: true }).waitFor();
    await page.getByText('0 项已安装', { exact: true }).waitFor();
    const sessionsUnavailable = await apiJson(page, '/api/chat/sessions');
    const usageUnavailable = await apiJson(page, '/api/chat/usage');
    assert.deepEqual(sessionsUnavailable, { status: 503, value: { error: 'runtime_not_connected' } });
    assert.deepEqual(usageUnavailable, { status: 503, value: { error: 'runtime_not_connected' } });

    const plansDocument = await readJson(join(runtimeDirectory, 'chat-plans.json'));
    const personasDocument = await readJson(join(runtimeDirectory, 'chat-personas.json'));
    const accessDocument = await readJson(join(runtimeDirectory, 'chat-access.json'));
    assert.equal((plansDocument.plans as Array<Record<string, unknown>>)[0]?.name, 'Fixture Plan Updated');
    assert.equal((plansDocument.plans as Array<Record<string, unknown>>)[0]?.reasoningEffort, 'high');
    assert.equal((personasDocument.personas as Array<Record<string, unknown>>)[0]?.style, personaStyle);
    assert.deepEqual(accessDocument, {
      schema: 1, allow: ['group:456001', 'private:123001'], deny: ['group:999001'], owner: '123001',
    });
    assert.equal((await stat(runtimeDirectory)).mode & 0o777, 0o700);
    for (const filename of ['chat-plans.json', 'chat-personas.json', 'chat-access.json', 'chat-adapters.json']) {
      assert.equal((await stat(join(runtimeDirectory, filename))).mode & 0o777, 0o600);
    }

    await screenshot(page, 'desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot(page, 'mobile');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    assert.equal(await tokenIsAbsentFromStorage(page), true);
    assert.equal(await page.evaluate(() => globalThis.__managementSmokeXss === true), false);
    assert.equal(xssRequests, 0);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(externalRequests, []);

    await writePrivateJson(new URL(`result-${runId}.json`, outputDirectory).pathname, {
      checkedAt: new Date().toISOString(),
      nativeRuntimeRoutes: true,
      plansSaved: true,
      personasSaved: true,
      modelUpdatesActivePlan: true,
      staleModelWriteRejected: true,
      accessDefaultsToDeny: true,
      accessValidationPreventsWrite: true,
      accessSaved: true,
      adapterCredentialsRedacted: true,
      emptyAdapterCredentialPreserved: true,
      adapterCredentialCleared: true,
      staleAdapterWriteRejected: true,
      boundedLongTextCards: true,
      longTextScrollsInternally: true,
      independentFootersVisible: true,
      operationalRoutesUnavailableWithoutHost: true,
      privateRuntimePermissions: true,
      tokenStoredByBrowserScript: false,
      xssExecuted: false,
      pageErrors: 0,
      externalRequests: 0,
    });
    console.log(`Management smoke passed. Results: runtime/management-smoke/result-${runId}.json`);
  } catch (error: unknown) {
    if (page !== undefined && !page.isClosed()) await screenshot(page, 'failure').catch(() => undefined);
    await writePrivateJson(new URL(`failure-${runId}.json`, outputDirectory).pathname, {
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
      requests,
      pageErrors,
      externalRequests,
    });
    throw error;
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await closeServer(server);
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
}

declare global {
  var __managementSmokeXss: boolean | undefined;
}

await run();
