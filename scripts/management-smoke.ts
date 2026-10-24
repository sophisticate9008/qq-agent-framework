import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';

import { createAdminBootstrap } from '../src/admin/bootstrap.ts';
import { createConfigurationRoutes } from '../src/admin/configuration.ts';
import { createAdminServer } from '../src/admin/server.ts';
import { createSettingsRoutes } from '../src/admin/settings.ts';
import { createLegacyAdminRoutes, type LegacyAccess } from '../src/integrations/legacy-admin.ts';

const outputDirectory = new URL('../runtime/management-smoke/', import.meta.url);
const fixtureConsoleToken = 'fixture-console-token-1234567890';
const xssText = '<img src="/fixture-xss-probe" onerror="globalThis.__managementSmokeXss=true">';

interface LegacyModel {
  provider: string;
  model: string;
  reasoningEffort: string;
  options: string[];
  labels: Record<string, { name: string; description: string }>;
}

interface LegacyFixture {
  readonly server: Server;
  readonly root: string;
  readonly requests: Array<{ method: string; pathname: string }>;
  access: LegacyAccess;
  model: LegacyModel;
  roles: Map<string, string>;
  currentRole: string | null;
}

const results: Record<string, boolean> = {
  fixtureOnly: true,
  bootstrapAutoCreatedOnce: false,
  setupResponseSecretFree: false,
  localFileLogin: false,
  workspaceSearchUsed: false,
  settingsPageLoaded: false,
  budgetControlsReady: false,
  budgetSwitchChanged: false,
  budgetSwitchNowChecked: false,
  budgetInputEnabled: false,
  budgetFormChanged: false,
  budgetSaveSubmitted: false,
  budgetSaveConfirmed: false,
  budgetSavedToPrivateFixture: false,
  disabledBudgetRetainsValues: false,
  gatewayApplyExplicitlyApplied: false,
  savedSettingsApplyAfterNavigation: false,
  wildcardAdminReconnect: false,
  savedFeatureApplyAfterNavigation: false,
  personaSaved: false,
  personaNewFormOpened: false,
  personaCreateConfirmed: false,
  personaActivationConfirmed: false,
  personaCreatedAndActivated: false,
  unsavedPersonaSwitchProtected: false,
  unsavedNavigationProtected: false,
  unsavedBrowserBackProtected: false,
  unsavedBrandNavigationProtected: false,
  unsavedLogoutProtected: false,
  liveActivityCountsVisible: false,
  structuredPricesSaved: false,
  structuredPriceDuplicatesRejected: false,
  structuredTimeWindowsSaved: false,
  accessFormatRejectedWithoutWrite: false,
  accessSavedThroughRealRoute: false,
  modelEffortSavedThroughRealRoute: false,
  featureConfigurationSavedToFixture: false,
  adminReconnectAcceptedWithoutRestart: false,
  desktopLightScreenshot: false,
  desktopDarkScreenshot: false,
  mobileLightScreenshot: false,
  mobileDarkScreenshot: false,
  noHorizontalOverflow: false,
  xssTextInert: false,
  tokenNotStored: false,
  noPageErrors: false,
  noExternalRequests: false,
  completed: false
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function writePrivateJson(filename: string, value: unknown): Promise<void> {
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function readJson(filename: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(filename, 'utf8'));
  assert(isRecord(value));
  return value;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  if (chunks.length === 0) return null;
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert(isRecord(value));
  return value;
}

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  response.end(body);
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

async function createLegacyFixture(legacyRoot: string): Promise<LegacyFixture> {
  const requests: Array<{ method: string; pathname: string }> = [];
  const fixture: Omit<LegacyFixture, 'server' | 'root'> = {
    requests,
    access: {
      allow: { groups: [456001], private: [123001] },
      deny: { groups: [], private: [] },
      ownerQQ: 123001
    },
    model: {
      provider: xssText,
      model: 'fixture-chat-model',
      reasoningEffort: 'medium',
      options: ['low', 'medium', 'high'],
      labels: {
        low: { name: '较低', description: 'Fixture fast response.' },
        medium: { name: '均衡', description: 'Fixture balanced response.' },
        high: { name: '深入', description: 'Fixture thorough response.' }
      }
    },
    roles: new Map([
      ['测试伙伴', 'Fixture original persona.'],
      ['备用', 'Fixture alternate persona.']
    ]),
    currentRole: '测试伙伴'
  };

  const server = createServer(async (request, response) => {
    try {
      const requestBody = await readBody(request);
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      requests.push({ method: request.method ?? '', pathname: url.pathname });
      if (request.headers['x-console-token'] !== fixtureConsoleToken) {
        sendJson(response, { ok: false }, 401);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/status') {
        sendJson(response, {
          mode: 'reserved2',
          role: fixture.currentRole,
          dshReady: true,
          socialV2Paused: false,
          snowluma: {
            connected: true,
            accountOnline: true,
            good: true,
            lastPacketAgoMs: 5,
            silent: false,
            degraded: false
          }
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/mode') {
        sendJson(response, {
          mode: 'reserved2',
          revision: '8f2d047817f4eac59304a5a9f4b6a25fc53591d115991fcb6f83a90ba4cc4dd1'
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/sessions') {
        sendJson(response, { sessions: [] });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/whitelist') {
        sendJson(response, fixture.access);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/whitelist') {
        assert(requestBody);
        fixture.access = requestBody as unknown as LegacyAccess;
        sendJson(response, { ok: true });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/dsh/model') {
        sendJson(response, fixture.model);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/dsh/effort') {
        assert(requestBody && typeof requestBody.reasoningEffort === 'string');
        fixture.model.reasoningEffort = requestBody.reasoningEffort;
        sendJson(response, { ok: true, reasoningEffort: fixture.model.reasoningEffort });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/socialV2/activity') {
        sendJson(response, { ok: true, paused: requestBody?.paused === true });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/roles') {
        sendJson(response, { roles: [...fixture.roles.keys()], current: fixture.currentRole });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/roles/content') {
        const name = url.searchParams.get('name') ?? '';
        const content = fixture.roles.get(name);
        if (content === undefined) {
          sendJson(response, { ok: false }, 404);
          return;
        }
        sendJson(response, { ok: true, name, content });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/roles/update') {
        assert(requestBody && typeof requestBody.name === 'string' && typeof requestBody.content === 'string');
        fixture.roles.set(requestBody.name, requestBody.content);
        sendJson(response, { ok: true, role: requestBody.name });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/roles/create') {
        assert(requestBody && typeof requestBody.name === 'string' && typeof requestBody.content === 'string');
        if (fixture.roles.has(requestBody.name)) {
          sendJson(response, { ok: false }, 409);
          return;
        }
        fixture.roles.set(requestBody.name, requestBody.content);
        sendJson(response, { ok: true, role: requestBody.name });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/role') {
        assert(requestBody && (requestBody.role === null || typeof requestBody.role === 'string'));
        fixture.currentRole = requestBody.role;
        sendJson(response, { ok: true, role: fixture.currentRole });
        return;
      }
      sendJson(response, { ok: false }, 404);
    } catch {
      if (!response.headersSent) sendJson(response, { ok: false }, 500);
      else response.destroy();
    }
  });
  const address = await listen(server);
  await writePrivateJson(join(legacyRoot, 'config.json'), {
    consolePort: address.port,
    consoleToken: fixtureConsoleToken,
    dsh: { provider: 'fixture-provider', model: 'fixture-model' },
    pricing: {
      peakWindows: [[9, 18]],
      models: { 'fixture-model': { label: '测试模型', off: { cacheHit: 0.1, cacheMiss: 1, output: 4 } } }
    },
    socialV2: { proactive: { enabled: false }, tools: { slangQuery: false, slangSubmit: false } },
    slang: { enabled: false, autoResearch: false },
    privateFixtureMarker: true
  });
  return {
    server,
    root: legacyRoot,
    requests,
    get access() { return fixture.access; },
    set access(value) { fixture.access = value; },
    get model() { return fixture.model; },
    set model(value) { fixture.model = value; },
    get roles() { return fixture.roles; },
    set roles(value) { fixture.roles = value; },
    get currentRole() { return fixture.currentRole; },
    set currentRole(value) { fixture.currentRole = value; }
  };
}

function section(page: Page, title: string): Locator {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

async function navigate(page: Page, label: string, heading = label): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).first().click();
  await page.getByRole('heading', { name: heading, exact: true }).waitFor();
}

async function selectWorkspaceSearchResult(
  page: Page,
  query: string,
  title: string,
  pagePath: string
): Promise<void> {
  await page.getByRole('button', { name: '搜索工作台', exact: true }).click();
  const search = page.getByRole('combobox', { name: '搜索设置或功能', exact: true });
  await search.waitFor();
  assert.equal(await search.getAttribute('placeholder'), '搜索设置或功能…');
  await search.fill(query);
  const option = page.locator(`[role="option"][data-search-title=${JSON.stringify(title)}]`).filter({ hasText: pagePath });
  await option.first().waitFor();
  assert.equal(await option.count(), 1, `Workspace search returned an ambiguous result for ${title}.`);
  await option.click();
  await search.waitFor({ state: 'hidden' });
}

async function waitForTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme);
}

async function noHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}

async function capture(page: Page, name: string, theme: 'light' | 'dark'): Promise<boolean> {
  await page.getByRole('combobox', { name: '显示模式' }).selectOption(theme);
  await waitForTheme(page, theme);
  const fits = await noHorizontalOverflow(page);
  await page.screenshot({
    path: new URL(`fixture-${name}-${theme}.png`, outputDirectory).pathname,
    fullPage: true,
    animations: 'disabled'
  });
  return fits;
}

async function tokenIsAbsentFromStorage(page: Page, token: string): Promise<boolean> {
  return page.evaluate(async expected => {
    const storage = `${JSON.stringify(localStorage)}${JSON.stringify(sessionStorage)}${document.cookie}`;
    const databases = indexedDB.databases === undefined ? [] : await indexedDB.databases();
    const cacheNames = 'caches' in globalThis ? await caches.keys() : [];
    return !storage.includes(expected)
      && !JSON.stringify(databases).includes(expected)
      && !JSON.stringify(cacheNames).includes(expected);
  }, token);
}

async function run(): Promise<void> {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'management-smoke-fixture-'));
  const legacyRoot = join(fixtureDirectory, 'legacy');
  const stateDirectory = join(legacyRoot, 'state');
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const gatewayFile = join(fixtureDirectory, 'gateway.json');
  const adminFile = join(fixtureDirectory, 'admin.json');
  const tokenFile = join(fixtureDirectory, 'administrator.token');
  let legacy: LegacyFixture | undefined;
  let adminServer: Server | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;

  try {
    legacy = await createLegacyFixture(legacyRoot);
    await writePrivateJson(gatewayFile, {
      port: 3123,
      upstreamEndpoint: 'http://127.0.0.1:3100',
      tokenFile: 'fixture-gateway.token',
      upstreamTokenFile: 'fixture-upstream.token',
      storeFilename: 'fixture-gateway.sqlite',
      allowedConversations: ['group:456001', 'private:123001'],
      persona: { id: 'fixture-persona', version: '1.0.0' },
      budgetEnabled: false,
      maxSendUses: 4,
      grantTtlMs: 3_600_000,
      timeoutMs: 15_000,
      maxPending: 16,
      maxBodyBytes: 2 * 1024 * 1024,
      maxRecords: 10_000,
      authorizationVersion: 'fixture-initial'
    });
    await writePrivateJson(adminFile, {
      host: '127.0.0.1',
      port: 3210,
      tokenFile: 'fixture-admin.token',
      gatewayConfiguration: 'gateway.json'
    });

    const settingsApplyCalls: Array<'gateway' | 'admin'> = [];
    const configurationApplyCalls: string[] = [];
    let accessSyncCalls = 0;
    const settingsRoutes = createSettingsRoutes({
      gatewayConfigurationFilename: gatewayFile,
      adminConfigurationFilename: adminFile,
      async apply(target) {
        settingsApplyCalls.push(target);
        if (target === 'gateway') return { applied: true };
        const configuration = await readJson(adminFile);
        if (configuration.host === '0.0.0.0' || configuration.host === '::') return { accepted: true, reconnect: true, port: configuration.port };
        return { accepted: true, reconnectUrl: `http://${String(configuration.host)}:${String(configuration.port)}/` };
      }
    });
    const configurationRoutes = createConfigurationRoutes({
      legacyRoot,
      gatewayConfigurationFilename: gatewayFile,
      adminConfigurationFilename: adminFile,
      apply(source) {
        configurationApplyCalls.push(source);
        return { applied: true };
      }
    });
    const legacyRoutes = createLegacyAdminRoutes({
      legacyRoot,
      async beforeAccessSave(access) {
        accessSyncCalls += 1;
        const gateway = await readJson(gatewayFile);
        const deniedGroups = new Set(access.deny.groups);
        const deniedPrivate = new Set(access.deny.private);
        gateway.allowedConversations = [
          ...access.allow.groups.filter(value => !deniedGroups.has(value)).map(value => `group:${value}`),
          ...access.allow.private.filter(value => !deniedPrivate.has(value)).map(value => `private:${value}`)
        ];
        await writePrivateJson(gatewayFile, gateway);
      }
    });
    const bootstrap = createAdminBootstrap({ tokenFile });
    adminServer = createAdminServer({
      token: bootstrap.token,
      setup: { status: bootstrap.status, initialize: bootstrap.initialize },
      snapshot: () => ({
        mode: 'gateway-live',
        overview: { online: true, gatewayHealthy: true, metrics: { writes: 7, pending: 2, rejected: 1, unknown: 1, recoveredUnknown: 0 } },
        policy: { configuration: { budgetEnabled: false } },
        fixtureOnly: true
      }),
      routes: [...settingsRoutes, ...configurationRoutes, ...legacyRoutes],
      handlerTimeoutMs: 30_000
    });
    const address = await listen(adminServer);
    const origin = `http://127.0.0.1:${address.port}`;

    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROMIUM_EXECUTABLE === undefined
        ? {}
        : { executablePath: process.env.CHROMIUM_EXECUTABLE })
    });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    let externalRequests = 0;
    let xssProbeRequests = 0;
    let setupPosts = 0;
    const setupResponseBodies: Array<Promise<string>> = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname === '/api/setup' && request.method() === 'POST') setupPosts += 1;
      if (url.pathname === '/fixture-xss-probe') xssProbeRequests += 1;
    });
    page.on('response', response => {
      if (new URL(response.url()).pathname === '/api/setup') setupResponseBodies.push(response.text());
    });
    await context.route('**/*', route => {
      const requested = new URL(route.request().url());
      if ((requested.protocol === 'http:' || requested.protocol === 'https:') && requested.origin !== origin) {
        externalRequests += 1;
        return route.abort();
      }
      return route.continue();
    });

    await page.goto(origin);
    await page.getByTestId('token-path').waitFor();
    const token = (await readFile(tokenFile, 'utf8')).trim();
    assert(token.length >= 24);
    assert.equal(await page.getByTestId('token-path').textContent(), tokenFile);
    await page.reload();
    await page.getByTestId('token-path').waitFor();
    assert.equal(setupPosts, 1);
    results.bootstrapAutoCreatedOnce = true;
    const setupBodies = await Promise.all(setupResponseBodies);
    assert(setupBodies.length >= 3);
    assert(setupBodies.every(body => !body.includes(token)));
    results.setupResponseSecretFree = true;

    await page.locator('#token').fill(token);
    await page.locator('#connect').click();
    await page.getByRole('button', { name: '断开连接' }).waitFor();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    results.localFileLogin = true;
    await section(page, '最近动态').getByText('发送结果未确认', { exact: true }).waitFor();
    assert.equal(await page.getByText('一切安静，等待新的消息', { exact: true }).count(), 0);
    results.liveActivityCountsVisible = true;

    await navigate(page, '运行设置');
    await page.getByRole('heading', { name: '运营预算', exact: true }).waitFor();
    results.settingsPageLoaded = true;
    const budgetSection = section(page, '运营预算');
    const budgetSwitch = page.getByRole('switch', { name: '启用发送预算' });
    const sendLimit = budgetSection.locator('input[type="number"]').first();
    assert.equal(await budgetSwitch.getAttribute('data-checked'), null);
    results.budgetControlsReady = true;
    await budgetSwitch.press('Space');
    results.budgetSwitchChanged = true;
    results.budgetSwitchNowChecked = await budgetSwitch.getAttribute('data-checked') !== null;
    assert(results.budgetSwitchNowChecked);
    await page.waitForFunction(() => {
      const label = [...document.querySelectorAll('label')]
        .find(candidate => candidate.textContent?.includes('每次授权最多发送'));
      const input = label?.querySelector('input[type="number"]');
      return input instanceof HTMLInputElement && !input.disabled;
    }, undefined, { timeout: 1_000 }).catch(() => undefined);
    results.budgetInputEnabled = await page.evaluate(() => {
      const label = [...document.querySelectorAll('label')]
        .find(candidate => candidate.textContent?.includes('每次授权最多发送'));
      const input = label?.querySelector('input[type="number"]');
      return input instanceof HTMLInputElement && !input.disabled;
    });
    const technicalSection = section(page, '技术约束');
    let gatewayConfiguration: Record<string, unknown>;
    assert(results.budgetInputEnabled, 'Budget switch must enable the actual UI input.');
      await sendLimit.fill('9');
      results.budgetFormChanged = true;
      await technicalSection.getByRole('button', { name: '保存设置', exact: true }).click();
      results.budgetSaveSubmitted = true;
      await technicalSection.getByText('网关设置已保存，尚未应用', { exact: true }).waitFor();
      results.budgetSaveConfirmed = true;
      gatewayConfiguration = await readJson(gatewayFile);
      assert.equal(gatewayConfiguration.budgetEnabled, true);
      assert.equal(gatewayConfiguration.maxSendUses, 9);
      results.budgetSavedToPrivateFixture = true;
      await technicalSection.getByRole('button', { name: '应用到网关', exact: true }).click();
      await page.getByText('网关设置已应用。', { exact: true }).waitFor();
      assert.deepEqual(settingsApplyCalls, ['gateway']);
      results.gatewayApplyExplicitlyApplied = true;

      await budgetSwitch.click();
      assert.equal(await sendLimit.inputValue(), '9');
      await technicalSection.getByRole('button', { name: '保存设置', exact: true }).click();
      await technicalSection.getByText('网关设置已保存，尚未应用', { exact: true }).waitFor();
      gatewayConfiguration = await readJson(gatewayFile);
      assert.equal(gatewayConfiguration.budgetEnabled, false);
      assert.equal(gatewayConfiguration.maxSendUses, 9);
      results.disabledBudgetRetainsValues = true;

    await navigate(page, '概览', '工作台概览');
    await navigate(page, '运行设置');
    await technicalSection.getByRole('button', { name: '应用到网关', exact: true }).waitFor();
    const reapplied = page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings/apply');
    await technicalSection.getByRole('button', { name: '应用到网关', exact: true }).click();
    assert.equal((await reapplied).status(), 200);
    assert.deepEqual(settingsApplyCalls, ['gateway', 'gateway']);
    results.savedSettingsApplyAfterNavigation = true;

    const adminSection = section(page, '管理端监听');
    const adminInputs = adminSection.locator('input');
    await adminInputs.nth(0).fill('0.0.0.0');
    await adminInputs.nth(1).fill('43210');
    await adminSection.getByRole('button', { name: '保存设置', exact: true }).click();
    await adminSection.getByText('管理端设置已保存，尚未应用', { exact: true }).waitFor();
    const adminConfiguration = await readJson(adminFile);
    assert.equal(adminConfiguration.host, '0.0.0.0');
    assert.equal(adminConfiguration.port, 43210);
    await adminSection.getByRole('button', { name: '应用并重启', exact: true }).click();
    await adminSection.getByText('重启已受理', { exact: true }).waitFor();
    assert.deepEqual(settingsApplyCalls, ['gateway', 'gateway', 'admin']);
    assert.equal(await adminSection.getByRole('link').getAttribute('href'), 'http://127.0.0.1:43210/');
    results.wildcardAdminReconnect = true;
    assert.equal((await fetch(`${origin}/health`)).status, 200);
    results.adminReconnectAcceptedWithoutRestart = true;

    await navigate(page, '人设与形象');
    const initialPersonaSection = section(page, '测试伙伴');
    const personaBody = initialPersonaSection.locator('textarea').first();
    await personaBody.waitFor();
    const savedPersona = `Fixture saved persona. ${xssText}`;
    await personaBody.fill(savedPersona);
    await initialPersonaSection.getByRole('button', { name: '保存人设', exact: true }).click();
    await initialPersonaSection.getByText('人设已保存', { exact: true }).waitFor();
    assert.equal(legacy.roles.get('测试伙伴'), savedPersona);
    results.personaSaved = true;

    await personaBody.fill(`${savedPersona} unsaved`);
    await page.getByRole('button', { name: /^备用/ }).click();
    await page.getByRole('dialog').getByRole('heading', { name: '切换前还有未保存内容' }).waitFor();
    assert.equal(legacy.roles.get('测试伙伴'), savedPersona);
    await page.getByRole('dialog').getByRole('button', { name: '继续编辑' }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    results.unsavedPersonaSwitchProtected = true;
    const navigationChecks: Array<{ key: string; action(): Promise<unknown> }> = [
      { key: 'unsavedNavigationProtected', action: () => page.getByRole('button', { name: '模型与回复', exact: true }).first().click() },
      { key: 'unsavedBrandNavigationProtected', action: () => page.locator('a[href="#overview"]').click() },
      { key: 'unsavedBrowserBackProtected', action: () => page.evaluate(() => history.back()) },
      { key: 'unsavedLogoutProtected', action: () => page.getByRole('button', { name: '断开连接', exact: true }).click() },
    ];
    for (const check of navigationChecks) {
      await check.action();
      const guard = page.getByRole('dialog');
      await guard.getByRole('heading', { name: '还有未保存的更改', exact: true }).waitFor();
      await guard.getByRole('button', { name: '继续编辑', exact: true }).click();
      await guard.waitFor({ state: 'hidden' });
      assert.equal(await personaBody.inputValue(), `${savedPersona} unsaved`);
      assert.equal(legacy.roles.get('测试伙伴'), savedPersona);
      assert.equal(await page.getByRole('button', { name: '断开连接', exact: true }).count(), 1);
      results[check.key] = true;
    }
    await initialPersonaSection.getByRole('button', { name: '撤销更改', exact: true }).click();
    await page.getByRole('button', { name: '新建', exact: true }).click();
    const newPersonaSection = section(page, '新建人设');
    await newPersonaSection.waitFor();
    results.personaNewFormOpened = true;
    await newPersonaSection.locator('input').first().fill('Fixture新人设');
    await newPersonaSection.locator('textarea').first().fill('Fixture newly created persona.');
    await newPersonaSection.getByRole('button', { name: '创建人设', exact: true }).click();
    await page.getByText('人设已保存', { exact: true }).waitFor();
    results.personaCreateConfirmed = true;
    assert.equal(legacy.roles.get('Fixture新人设'), 'Fixture newly created persona.');
    await section(page, 'Fixture新人设').getByRole('button', { name: '启用这个人设', exact: true }).click();
    await section(page, 'Fixture新人设').getByText('当前人设状态已更新', { exact: true }).waitFor();
    results.personaActivationConfirmed = true;
    results.personaCreatedAndActivated = legacy.currentRole === 'Fixture新人设';

    await navigate(page, '访问范围');
    const allowSection = section(page, '允许访问');
    const denySection = section(page, '拒绝访问');
    const accessAdminSection = section(page, '管理员');
    const allowGroups = allowSection.locator('textarea').nth(0);
    await allowGroups.waitFor();
    const whitelistWritesBefore = legacy.requests.filter(request => request.method === 'POST'
      && request.pathname === '/api/whitelist').length;
    await allowGroups.fill('not-a-number');
    await accessAdminSection.getByRole('button', { name: '保存访问范围', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '允许群号只能包含正整数' }).waitFor();
    assert.equal(legacy.requests.filter(request => request.method === 'POST'
      && request.pathname === '/api/whitelist').length, whitelistWritesBefore);
    results.accessFormatRejectedWithoutWrite = true;
    await allowGroups.fill('456001\n456002');
    await allowSection.locator('textarea').nth(1).fill('123001');
    await denySection.locator('textarea').nth(0).fill('456001');
    await denySection.locator('textarea').nth(1).fill('');
    await accessAdminSection.locator('input').first().fill('123001');
    await accessAdminSection.getByRole('button', { name: '保存访问范围', exact: true }).click();
    await page.getByText('访问范围已同步到网关并保存。', { exact: true }).waitFor();
    assert.deepEqual(legacy.access, {
      allow: { groups: [456001, 456002], private: [123001] },
      deny: { groups: [456001], private: [] },
      ownerQQ: 123001
    });
    gatewayConfiguration = await readJson(gatewayFile);
    assert.deepEqual(gatewayConfiguration.allowedConversations, ['group:456002', 'private:123001']);
    assert.equal(accessSyncCalls, 1);
    results.accessSavedThroughRealRoute = true;

    await navigate(page, '模型与回复');
    await page.getByText(xssText, { exact: true }).waitFor();
    const modelSection = section(page, '回复设置');
    await modelSection.getByRole('combobox').click();
    await page.getByRole('option', { name: '深入', exact: true }).click();
    await modelSection.getByRole('button', { name: '保存强度', exact: true }).click();
    await modelSection.getByText('已保存，将从下一条消息开始生效', { exact: true }).waitFor();
    assert.equal(legacy.model.reasoningEffort, 'high');
    results.modelEffortSavedThroughRealRoute = true;

    await selectWorkspaceSearchResult(page, '模型 定价', '模型定价', '模型与回复');
    const pricingSection = section(page, '模型定价');
    await pricingSection.getByLabel('模型标识', { exact: true }).waitFor();
    assert.equal(await pricingSection.getByLabel('模型标识', { exact: true }).inputValue(), 'fixture-model');
    await pricingSection.getByLabel('输出价', { exact: true }).fill('6');
    await pricingSection.getByRole('button', { name: '保存本组', exact: true }).click();
    await pricingSection.getByText('已保存，等待应用', { exact: true }).first().waitFor();
    let pricing = (await readJson(join(legacyRoot, 'config.json'))).pricing;
    assert(isRecord(pricing) && isRecord(pricing.models));
    const savedModel = pricing.models['fixture-model'];
    assert(isRecord(savedModel) && isRecord(savedModel.off));
    assert.equal(savedModel.off.output, 6);
    assert.equal(savedModel.off.cacheWrite, undefined);
    results.structuredPricesSaved = true;

    await pricingSection.getByRole('button', { name: '添加模型', exact: true }).click();
    await pricingSection.getByLabel('模型标识', { exact: true }).nth(1).fill('fixture-model');
    await pricingSection.getByLabel('显示名', { exact: true }).nth(1).fill('重复模型');
    await pricingSection.getByLabel('缓存命中输入价', { exact: true }).nth(1).fill('1');
    await pricingSection.getByLabel('未命中输入价', { exact: true }).nth(1).fill('2');
    await pricingSection.getByLabel('输出价', { exact: true }).nth(1).fill('3');
    await pricingSection.getByRole('alert').filter({ hasText: /重复/ }).first().waitFor();
    assert.equal(await pricingSection.getByRole('button', { name: '保存本组', exact: true }).isDisabled(), true);
    pricing = (await readJson(join(legacyRoot, 'config.json'))).pricing;
    assert(isRecord(pricing) && isRecord(pricing.models));
    assert.equal(Object.keys(pricing.models).length, 1);
    results.structuredPriceDuplicatesRejected = true;
    await pricingSection.getByRole('button', { name: '移除第 2 个模型', exact: true }).click();

    await pricingSection.getByLabel('结束时间', { exact: true }).fill('19');
    await pricingSection.getByRole('button', { name: '保存本组', exact: true }).click();
    await pricingSection.getByText('已保存，等待应用', { exact: true }).first().waitFor();
    pricing = (await readJson(join(legacyRoot, 'config.json'))).pricing;
    assert(isRecord(pricing));
    assert.deepEqual(pricing.peakWindows, [[9, 19]]);
    assert.equal(await pricingSection.getByRole('group', { name: '模型价格', exact: true }).locator('textarea').count(), 0);
    assert.equal(await pricingSection.getByRole('group', { name: '高峰时间段', exact: true }).locator('textarea').count(), 0);
    results.structuredTimeWindowsSaved = true;

    await navigate(page, '功能与触发');
    await selectWorkspaceSearchResult(page, '启用 主动话题', '启用主动话题', '功能与触发');
    const proactiveSwitch = page.getByRole('switch', { name: '启用主动话题' });
    await proactiveSwitch.waitFor();
    assert.equal(await proactiveSwitch.getAttribute('data-checked'), null);
    await proactiveSwitch.click();
    const proactiveSection = section(page, '二代主动话题');
    await proactiveSection.getByRole('button', { name: '保存本组', exact: true }).click();
    await proactiveSection.getByText('已保存，等待应用', { exact: true }).first().waitFor();
    const bridgeConfiguration = await readJson(join(legacyRoot, 'config.json'));
    const socialV2 = bridgeConfiguration.socialV2;
    assert(isRecord(socialV2));
    assert(isRecord(socialV2.proactive));
    assert.equal(socialV2.proactive.enabled, true);
    assert.equal(configurationApplyCalls.length, 0);
    results.featureConfigurationSavedToFixture = true;
    await navigate(page, '概览', '工作台概览');
    await navigate(page, '功能与触发');
    await selectWorkspaceSearchResult(page, '启用主动话题', '启用主动话题', '功能与触发');
    await proactiveSection.getByRole('button', { name: '重新加载聊天服务', exact: true }).click();
    await proactiveSection.getByText('配置应用流程已完成', { exact: true }).first().waitFor();
    assert.deepEqual(configurationApplyCalls, ['bridge']);
    results.savedFeatureApplyAfterNavigation = true;
    results.workspaceSearchUsed = true;

    const xssExecuted = await page.evaluate(() => Boolean((globalThis as typeof globalThis & {
      __managementSmokeXss?: boolean;
    }).__managementSmokeXss));
    assert.equal(xssExecuted, false);
    assert.equal(xssProbeRequests, 0);
    results.xssTextInert = true;

    await page.getByRole('button', { name: '概览', exact: true }).first().click();
    await page.getByRole('heading', { name: '工作台概览', exact: true }).waitFor();
    const overflowChecks: boolean[] = [];
    overflowChecks.push(await capture(page, 'desktop', 'light'));
    results.desktopLightScreenshot = true;
    overflowChecks.push(await capture(page, 'desktop', 'dark'));
    results.desktopDarkScreenshot = true;
    await page.setViewportSize({ width: 390, height: 844 });
    overflowChecks.push(await capture(page, 'mobile', 'light'));
    results.mobileLightScreenshot = true;
    overflowChecks.push(await capture(page, 'mobile', 'dark'));
    results.mobileDarkScreenshot = true;
    assert(overflowChecks.every(Boolean));
    results.noHorizontalOverflow = true;

    assert(await tokenIsAbsentFromStorage(page, token));
    results.tokenNotStored = true;
    assert.deepEqual(pageErrors, []);
    results.noPageErrors = true;
    assert.equal(externalRequests, 0);
    results.noExternalRequests = true;
    results.completed = [
      'bootstrapAutoCreatedOnce',
      'setupResponseSecretFree',
      'localFileLogin',
      'workspaceSearchUsed',
      'budgetInputEnabled',
      'budgetFormChanged',
      'budgetSaveSubmitted',
      'budgetSaveConfirmed',
      'budgetSavedToPrivateFixture',
      'disabledBudgetRetainsValues',
      'gatewayApplyExplicitlyApplied',
      'savedSettingsApplyAfterNavigation',
      'wildcardAdminReconnect',
      'savedFeatureApplyAfterNavigation',
      'personaSaved',
      'personaCreatedAndActivated',
      'unsavedPersonaSwitchProtected',
      'unsavedNavigationProtected',
      'unsavedBrowserBackProtected',
      'unsavedBrandNavigationProtected',
      'unsavedLogoutProtected',
      'liveActivityCountsVisible',
      'structuredPricesSaved',
      'structuredPriceDuplicatesRejected',
      'structuredTimeWindowsSaved',
      'accessFormatRejectedWithoutWrite',
      'accessSavedThroughRealRoute',
      'modelEffortSavedThroughRealRoute',
      'featureConfigurationSavedToFixture',
      'adminReconnectAcceptedWithoutRestart',
      'desktopLightScreenshot',
      'desktopDarkScreenshot',
      'mobileLightScreenshot',
      'mobileDarkScreenshot',
      'noHorizontalOverflow',
      'xssTextInert',
      'tokenNotStored',
      'noPageErrors',
      'noExternalRequests'
    ].every(key => results[key] === true);
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await closeServer(adminServer);
    await closeServer(legacy?.server);
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
}

let failed = false;
try {
  await run();
} catch (error) {
  failed = true;
  const message = (error instanceof Error ? error.message : 'Unknown management smoke failure')
    .replace(/[a-f0-9]{48,}/gi, '[redacted]');
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(new URL('fixture-failure.txt', outputDirectory), `${message}\n`, { mode: 0o600 });
}
await mkdir(outputDirectory, { recursive: true });
await writeFile(new URL('fixture-result.json', outputDirectory), `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results));
if (failed || !results.completed) process.exitCode = 1;
