import { readBuiltBrowserApplication } from './browser-assets-smoke.ts';
import assert from 'node:assert/strict';
import { navigateConsolePage } from './browser-navigation-smoke.ts';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';

import { AdminRequestError, createAdminServer, type AdminRoute } from '../src/admin/server.ts';
import { createConfigurationRoutes } from '../src/admin/configuration.ts';
import { createSettingsRoutes } from '../src/admin/settings.ts';
import { isRecord } from '../src/core/values.ts';
import { validateNativeChatAuthorization } from '../src/host/native-chat-configuration.ts';
import { parseNativeApplicationRequest, type NativeApplicationSnapshot } from '../src/contracts/native-application.ts';
import { createNativeCapabilityRuntimeFixture } from '../test/fixtures/native-capability-runtime.ts';

type Outcome = 'success' | 'unknown' | 'conflict';
type RuntimeCondition = 'healthy' | 'budget-exhausted' | 'budget-expired' | 'follow' | 'configuration-changed' | 'protocol';
interface FixtureGrant {
  readonly conversationId: string;
  readonly submitUses: number;
  readonly sendUses: number;
  readonly expiresAt: number | null;
}
interface FixtureState {
  revisions: Record<string, string>;
  authorization: { revision: string; version: string; grants: FixtureGrant[] };
  deployment: { revision: string; deployment: Record<string, unknown> };
  authorizationOutcome: Outcome;
  deploymentOutcome: Outcome;
  startOutcome: Outcome;
  running: boolean;
  pendingReload: boolean;
  approvedTargetRevision: string | null;
  previewCount: number;
  appliedCount: number;
  applyUnknown: boolean;
  gatewayScopeEvidence: Record<string, unknown> | null;
  runtimeCondition: RuntimeCondition;
  readonly runtimeStatusCases: RuntimeCondition[];
  runtimeTransition: 'starting' | 'stopping' | null;
  deploymentBusy: boolean;
  deploymentCapabilityChecked: boolean;
  runningApplyBlocked: boolean;
  readonly posts: Array<{ readonly pathname: string; readonly body: unknown }>;
  application: NativeApplicationSnapshot | null;
  reconciliationVerified: boolean;
  deploymentReadGate?: Promise<void>;
}

interface FixtureFiles {
  readonly directory: string;
  readonly gateway: string;
  readonly admin: string;
  readonly nativeAccess: string;
  readonly gatewayToken: string;
  readonly adminToken: string;
}

const administratorToken = 'native-chat-ui-synthetic-administrator-1234567890';
const hostname = 'native-chat-ui.invalid';
const output = new URL('../runtime/native-chat-ui-smoke/', import.meta.url);
const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const revisionKeys = ['plans', 'personas', 'access', 'adapters', 'providers', 'authorization', 'deployment', 'execution'];

function revision(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function fixtureState(): FixtureState {
  const revisions = Object.fromEntries(revisionKeys.map(key => [key, revision(key)]));
  return {
    revisions,
    authorization: { revision: revisions.authorization, version: 'fixture-authorization',
      grants: [{ conversationId: 'group:410001', submitUses: 20, sendUses: 20, expiresAt: null }] },
    deployment: { revision: revisions.deployment, deployment: {
      namespace: 'fixture-chat', target: { profilePath: '/fixture/dsh/initial.patch.yml',
        credentialsPath: '/fixture/dsh/initial.credentials.yaml', schemaVersion: '0.2.1-rc.2' },
      modelSettings: { contextWindow: 65536, maxTokens: 2048, reasoningEfforts: false }
    } },
    authorizationOutcome: 'success', deploymentOutcome: 'success', startOutcome: 'success',
    running: false, pendingReload: false, approvedTargetRevision: null,
    previewCount: 0, appliedCount: 0, applyUnknown: false, gatewayScopeEvidence: null,
    runtimeCondition: 'healthy', runtimeStatusCases: [], runtimeTransition: null,
    deploymentBusy: false, deploymentCapabilityChecked: false, runningApplyBlocked: false, posts: [], application: null,
    reconciliationVerified: true
  };
}

async function fixtureFiles(): Promise<FixtureFiles> {
  const directory = await mkdtemp(join(tmpdir(), 'native-chat-ui-config-'));
  const files = { directory, gateway: join(directory, 'gateway.json'), admin: join(directory, 'admin.json'),
    nativeAccess: join(directory, 'native-access.json'), gatewayToken: join(directory, 'gateway.token'),
    adminToken: join(directory, 'admin.token') };
  await writeFile(files.gatewayToken, 'synthetic-gateway-fixture-token-1234567890\n', { mode: 0o600 });
  await writeFile(files.adminToken, `${administratorToken}\n`, { mode: 0o600 });
  await writeFile(files.gateway, JSON.stringify({
    port: 3131, upstreamEndpoint: 'http://127.0.0.1:3000', tokenFile: files.gatewayToken,
    storeFilename: join(directory, 'unused-gateway.sqlite'), allowedConversations: ['group:430003'],
    persona: { id: 'fixture-persona', version: '1' }, authorizationVersion: 'fixture-gateway-authorization',
    budgetEnabled: false, timeoutMs: 60_000, maxPending: 16, maxBodyBytes: 2 * 1024 * 1024, maxRecords: 10_000
  }, null, 2) + '\n', { mode: 0o600 });
  await writeFile(files.admin, JSON.stringify({
    host: '127.0.0.1', port: 3210, tokenFile: files.adminToken, gatewayConfiguration: files.gateway,
    publicOrigin: '', trustedLoopbackProxy: false
  }, null, 2) + '\n', { mode: 0o600 });
  await writeFile(files.nativeAccess, JSON.stringify({ schema: 1,
    allow: ['group:410001', 'private:420002'], deny: [], owner: null
  }, null, 2) + '\n', { mode: 0o600 });
  return files;
}

function runtimeStatus(state: FixtureState): unknown {
  const reason = state.runtimeCondition === 'budget-exhausted' || state.runtimeCondition === 'budget-expired'
    ? 'authorization_budget_unavailable' : state.runtimeCondition === 'follow' ? 'agent_follow_unavailable'
      : state.runtimeCondition === 'configuration-changed' ? 'configuration_changed'
        : state.runtimeCondition === 'protocol' ? 'onebot_protocol_not_connected' : null;
  return {
    state: state.runtimeTransition ?? (state.running ? 'running' : 'stopped'),
    canStart: !state.running && state.runtimeTransition === null && !state.pendingReload,
    canApplyDeployment: !state.running && state.runtimeTransition === null && !state.deploymentBusy,
    chatReady: state.running && state.runtimeTransition === null && reason === null,
    protocolConnected: state.running && state.runtimeCondition !== 'protocol',
    revisions: { ...state.revisions },
    activeRevisions: state.running ? { ...state.revisions,
      ...(state.runtimeCondition === 'configuration-changed' ? { providers: revision('previous-provider-configuration') } : {}) } : null,
    lastError: null, modelExecutionVerified: false, readinessScope: 'fixture-protocol-dsh-and-host-only',
    configurationIssues: state.pendingReload ? ['pending_reload'] : [],
    missingReasons: state.pendingReload ? ['pending_reload', 'runtime_not_started']
      : state.running ? reason === null ? [] : [reason, 'runtime_not_started']
        : ['runtime_not_started', 'onebot_protocol_not_connected']
  };
}

function routes(state: FixtureState, files: FixtureFiles): readonly AdminRoute[] {
  const get = (pathname: string, handle: () => unknown): AdminRoute => ({ method: 'GET', pathname, handle });
  const post = (pathname: string, handle: (body: Record<string, unknown>) => unknown): AdminRoute => ({
    method: 'POST', pathname, handle: ({ body }) => {
      assert(isRecord(body));
      state.posts.push({ pathname, body: structuredClone(body) });
      return handle(body);
    }
  });
  const checkOutcome = (outcome: Outcome): void => {
    if (outcome === 'unknown') throw new AdminRequestError(504, 'operation_unknown');
    if (outcome === 'conflict') throw new AdminRequestError(409, 'chat_revision_conflict');
  };
  const checkRevisions = (body: Record<string, unknown>, withTarget = false): void => {
    assert.deepEqual(Object.keys(body).sort(), withTarget ? ['revisions', 'targetRevision'] : ['revisions']);
    if (JSON.stringify(body.revisions) !== JSON.stringify(state.revisions)) {
      throw new AdminRequestError(409, 'chat_revision_conflict');
    }
  };
  return [
    get('/api/chat/status', () => ({ runtimeConnected: state.running, protocolConnected: state.running })),
    get('/api/chat/access', async () => {
      const document: unknown = JSON.parse(await readFile(files.nativeAccess, 'utf8'));
      assert(isRecord(document));
      return { ...document, revision: state.revisions.access };
    }),
    get('/api/chat/adapters', () => ({
      revision: state.revisions.adapters,
      adapters: {
        onebotHttp: { enabled: true, endpoint: 'http://onebot.invalid', secretConfigured: false },
        onebotWs: { enabled: true, endpoint: 'ws://onebot.invalid', secretConfigured: false },
        dshAgent: { enabled: true, endpoint: 'http://dsh.invalid', authConfigured: true },
        onebotWebhook: { enabled: false, host: '127.0.0.1', port: 0, selfId: '', hmacConfigured: false }
      },
      status: { assembled: true, running: false, applyAvailable: false },
      connection: { state: 'disconnected', selfId: null, lastError: null, received: 0, dropped: 0, chatReady: false }
    })),
    get('/api/chat/runtime', () => runtimeStatus(state)),
    get('/api/chat/application', () => {
      if (state.application?.state === 'running') {
        state.running = true;
        state.pendingReload = false;
        state.application = { ...state.application, state: 'completed', phase: 'start', phaseState: 'confirmed', updatedAt: Date.now() };
      }
      return { schema: 1, operation: state.application };
    }),
    post('/api/chat/application', body => {
      const request = parseNativeApplicationRequest(body);
      assert(request, 'Application must carry a UUID, exact revisions and deploy choice.');
      assert.deepEqual(request.revisions, state.revisions);
      const now = Date.now();
      state.application = { schema: 1, id: request.operationId, state: 'running', phase: 'prepare', phaseState: 'in-flight',
        revisions: request.revisions, createdAt: now, updatedAt: now, reasons: [] };
      if (state.startOutcome === 'unknown') state.application = { ...state.application, state: 'unknown', phase: 'start',
        reasons: ['native_start_unknown'] };
      return { schema: 1, operation: state.application };
    }),
    post('/api/chat/application/reconcile', body => {
      assert.deepEqual(Object.keys(body), ['operationId']);
      assert.equal(body.operationId, state.application?.id);
      assert(state.application);
      state.application = { ...state.application, state: 'completed', phase: 'start', phaseState: 'confirmed',
        updatedAt: Date.now(), reasons: [] };
      state.running = true;
      return { schema: 1, operation: state.application };
    }),
    get('/api/chat/authorization', () => state.authorization),
    get('/api/chat/deployment', async () => {
      const gate = state.deploymentReadGate;
      delete state.deploymentReadGate;
      if (gate) await gate;
      return state.deployment;
    }),
    post('/api/chat/authorization', body => {
      assert.deepEqual(Object.keys(body).sort(), ['grants', 'revision', 'version']);
      if (body.revision !== state.authorization.revision) throw new AdminRequestError(409, 'chat_revision_conflict');
      checkOutcome(state.authorizationOutcome);
      assert.equal(typeof body.version, 'string');
      assert.match(String(body.version), /^[a-f0-9]{32}$/);
      assert(Array.isArray(body.grants));
      const grants: FixtureGrant[] = body.grants.map((entry: unknown) => {
        assert(isRecord(entry) && typeof entry.conversationId === 'string');
        assert(typeof entry.submitUses === 'number' && typeof entry.sendUses === 'number');
        assert(entry.expiresAt === null || typeof entry.expiresAt === 'number');
        return { conversationId: entry.conversationId, submitUses: entry.submitUses,
          sendUses: entry.sendUses, expiresAt: entry.expiresAt };
      });
      state.revisions.authorization = revision(body);
      state.authorization = { revision: state.revisions.authorization, version: String(body.version), grants };
      return state.authorization;
    }),
    post('/api/chat/deployment', body => {
      assert.deepEqual(Object.keys(body).sort(), ['deployment', 'revision']);
      if (body.revision !== state.deployment.revision) throw new AdminRequestError(409, 'chat_revision_conflict');
      checkOutcome(state.deploymentOutcome);
      assert(isRecord(body.deployment));
      state.revisions.deployment = revision(body);
      state.deployment = { revision: state.revisions.deployment, deployment: structuredClone(body.deployment) };
      return state.deployment;
    }),
    post('/api/chat/deployment/prepare', body => {
      checkRevisions(body);
      state.approvedTargetRevision = revision({ revisions: state.revisions, preview: ++state.previewCount });
      return { state: 'prepared', targetRevision: state.approvedTargetRevision,
        summary: { ready: true, missingReasons: [] }, preview: null };
    }),
    post('/api/chat/deployment/apply', body => {
      checkRevisions(body, true);
      assert.equal(state.running, false);
      assert.equal(state.runtimeTransition, null);
      assert.equal(state.deploymentBusy, false);
      assert.equal(typeof body.targetRevision, 'string');
      assert.match(String(body.targetRevision), /^[a-f0-9]{64}$/);
      if (body.targetRevision !== state.approvedTargetRevision) {
        return { state: 'conflict', missingReasons: ['deployment_target_changed'] };
      }
      if (state.applyUnknown) return { state: 'unknown', missingReasons: ['deployment_apply_unknown'] };
      state.appliedCount += 1;
      state.pendingReload = true;
      return { state: 'pending_reload', missingReasons: ['pending_reload'], backupId: 'fixture-backup' };
    }),
    post('/api/chat/deployment/reconcile', body => {
      checkRevisions(body);
      state.pendingReload = false;
      return { verified: state.reconciliationVerified, missingReasons: [],
        verificationScope: 'provider-preset-and-managed-file-provenance', credentialValueIdentityVerified: false,
        unverified: ['credential_loaded_value_identity'], presets: state.reconciliationVerified ? [{ agentPreset: 'fixture-group' }] : [] };
    }),
    post('/api/chat/runtime/start', body => {
      checkRevisions(body);
      checkOutcome(state.startOutcome);
      assert.equal(state.pendingReload, false);
      state.running = true;
      return runtimeStatus(state);
    }),
    post('/api/chat/runtime/stop', body => {
      assert.deepEqual(body, {});
      state.running = false;
      return runtimeStatus(state);
    })
  ];
}

function countPosts(state: FixtureState, pathname: string): number {
  return state.posts.filter(request => request.pathname === pathname).length;
}

function input(scope: Locator, label: string): Locator {
  return scope.getByText(label, { exact: true }).locator('xpath=ancestor::label[1]').locator('input');
}

async function navigate(page: Page, destination: 'access' | 'adapters' | 'model'): Promise<void> {
  await navigateConsolePage(page, destination);
  await page.locator(`[data-page="${destination}"]`).waitFor();
}

async function enabled(locator: Locator, expected: boolean): Promise<void> {
  await locator.waitFor();
  await locator.and(locator.page().locator(expected ? 'button:enabled' : 'button:disabled')).waitFor({ timeout: 15_000 });
}

async function assertBounded(section: Locator, height: number, options: { readonly footer?: 'required' | 'absent' } = {}): Promise<void> {
  const requiresFooter = options.footer !== 'absent';
  const dimensions = await section.evaluate((element, requiresFooter) => {
    const card = element.querySelector('[data-bounded-card]');
    const footer = element.querySelector('.panel-footer');
    assertElement(card);
    if (requiresFooter) assertElement(footer);
    function assertElement(candidate: Element | null): asserts candidate is HTMLElement {
      if (!(candidate instanceof HTMLElement)) throw new Error('bounded_card_or_footer_missing');
    }
    return { height: card.getBoundingClientRect().height, overflow: getComputedStyle(card).overflowY,
      footerPresent: footer !== null,
      footerAfter: footer instanceof HTMLElement ? footer.getBoundingClientRect().top >= card.getBoundingClientRect().bottom - 1 : null };
  }, requiresFooter);
  assert(Math.abs(dimensions.height - height) <= 2, JSON.stringify(dimensions));
  assert(['auto', 'scroll'].includes(dimensions.overflow));
  assert.equal(dimensions.footerPresent, requiresFooter);
  assert.equal(dimensions.footerAfter, requiresFooter ? true : null);
}

async function assertDirtyNavigation(page: Page, destination: 'access' | 'adapters', discard: boolean): Promise<void> {
  const label = destination === 'access' ? '安全' : '连接';
  await page.getByRole('button', { name: label, exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '还有未保存的更改', exact: true });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: discard ? '舍弃并离开' : '继续编辑', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  if (discard) await page.locator(`[data-page="${destination}"]`).waitFor();
}

async function showCountedAuthorization(page: Page): Promise<void> {
  const summary = page.getByText('高级：旧模式授权与次数', { exact: true });
  await summary.waitFor();
  if (!await summary.evaluate(element => element.closest('details')?.open === true)) await summary.click();
  await page.locator('#chat-authorization input').first().waitFor();
}

async function showAdvancedDeployment(page: Page): Promise<void> {
  const summary = page.locator('#dsh-deployment').getByText('手动部署/远程 DSH（高级）', { exact: true });
  await summary.waitFor();
  if (!await summary.evaluate(element => element.closest('details')?.open === true)) await summary.click();
}

async function rereadDeployment(page: Page, state: FixtureState): Promise<void> {
  const card = page.locator('#dsh-deployment');
  let release = () => {};
  state.deploymentReadGate = new Promise<void>(resolve => { release = resolve; });
  try {
    await card.getByRole('button', { name: '重新读取', exact: true }).click();
    const loading = card.getByText('正在读取应用设置', { exact: true });
    // Hold this GET until the old form has actually unmounted. Its details state
    // cannot stand in for the replacement form's state after the read completes.
    await loading.waitFor();
    release();
    await loading.waitFor({ state: 'hidden' });
    await showAdvancedDeployment(page);
  } finally {
    delete state.deploymentReadGate;
    release();
  }
}

async function acknowledgeDeploymentRecovery(page: Page, state: FixtureState): Promise<void> {
  const card = page.locator('#dsh-deployment');
  await enabled(card.getByRole('button', { name: '预览变更', exact: true }), false);
  const acknowledge = card.getByRole('button', { name: '我已核对，允许新的管理操作', exact: true });
  await enabled(acknowledge, false);
  state.reconciliationVerified = false;
  await card.getByRole('button', { name: '检查是否生效', exact: true }).click();
  await card.getByRole('alert').filter({ hasText: '缺少已核验的实际预设与配置来源证据' }).waitFor();
  await enabled(acknowledge, false);
  state.reconciliationVerified = true;
  await card.getByRole('button', { name: '检查是否生效', exact: true }).click();
  await enabled(acknowledge, true);
  await acknowledge.click();
}

async function exerciseAuthorization(page: Page, state: FixtureState): Promise<void> {
  await navigate(page, 'access');
  await showCountedAuthorization(page);
  const card = page.locator('#chat-authorization');
  const accessMode = page.getByRole('region', { name: '访问模式', exact: true });
  await input(card, '群号').waitFor();
  await assertBounded(card, 384);
  await card.getByRole('button', { name: '添加会话授权', exact: true }).click();
  await card.getByText('会话类型', { exact: true }).last().locator('xpath=ancestor::label[1]').locator('select').selectOption('private');
  await input(card, '用户号').fill('420002');
  await input(card, '模型提交次数').last().fill('15');
  await input(card, '回复发送次数').last().fill('15');
  const save = card.getByRole('button', { name: '保存新授权', exact: true });
  await enabled(save, false);
  await card.getByRole('checkbox').check();
  await enabled(save, true);
  await input(card, '回复发送次数').last().fill('16');
  assert.equal(await card.getByRole('checkbox').isChecked(), false);
  await enabled(save, false);
  await card.getByRole('checkbox').check();
  await save.click();
  await accessMode.getByText(/授权已保存/).waitFor();
  assert.equal(state.authorization.grants.length, 2);
  assert.equal(state.authorization.grants[1]?.sendUses, 16);
  assert.equal(countPosts(state, '/api/chat/authorization'), 1);
  await assertBounded(card, 384);
  await input(card, '模型提交次数').first().fill('31');
  await navigate(page, 'adapters');
  assert.equal(await page.getByRole('dialog', { name: '还有未保存的更改', exact: true }).count(), 0);
  assert.equal(countPosts(state, '/api/chat/authorization'), 1);
  await navigate(page, 'access');
  await showCountedAuthorization(page);
  assert.equal(await input(card, '模型提交次数').first().inputValue(), '31');
  await card.getByRole('button', { name: '撤销更改', exact: true }).click();
  for (const outcome of ['unknown', 'conflict'] as const) {
    state.authorizationOutcome = outcome;
    await input(card, '模型提交次数').first().fill('32');
    await card.getByRole('checkbox').check();
    const before = countPosts(state, '/api/chat/authorization');
    await save.click();
    await accessMode.getByRole('alert').filter({ hasText: outcome === 'unknown' ? '无法确认' : '其他窗口更新' }).waitFor();
    await enabled(save, false);
    assert.equal(await input(card, '模型提交次数').first().isDisabled(), true);
    await enabled(card.getByRole('button', { name: '添加会话授权', exact: true }), false);
    await page.waitForTimeout(250);
    assert.equal(countPosts(state, '/api/chat/authorization'), before + 1);
    state.authorizationOutcome = 'success';
    const reread = page.waitForResponse(response => response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/chat/authorization');
    await card.getByRole('button', { name: '重新读取', exact: true }).click();
    const response = await reread;
    assert.equal(response.status(), 200, `${outcome}: authorization reread failed`);
    assert.deepEqual(await response.json(), state.authorization, `${outcome}: authorization reread DTO differs`);
    await enabled(card.getByRole('button', { name: '添加会话授权', exact: true }), false);
    const recoveryPosts = countPosts(state, '/api/chat/authorization');
    const acknowledge = accessMode.getByRole('button', { name: '我已核对，允许新的管理操作', exact: true });
    await enabled(acknowledge, true);
    await acknowledge.click();
    assert.equal(countPosts(state, '/api/chat/authorization'), recoveryPosts);
    await enabled(card.getByRole('button', { name: '添加会话授权', exact: true }), true);
    assert.equal(await input(card, '模型提交次数').first().inputValue(), '32');
    await card.getByRole('button', { name: '撤销更改', exact: true }).click();
    assert.equal(await input(card, '模型提交次数').first().inputValue(), '20');
  }
}

async function exerciseDeployment(page: Page, state: FixtureState): Promise<void> {
  await navigate(page, 'adapters');
  const card = page.locator('#dsh-deployment');
  await showAdvancedDeployment(page);
  await input(card, 'DSH 配置文件').fill('/fixture/dsh/selected.patch.yml');
  await input(card, 'DSH 凭据文件').fill('/fixture/dsh/selected.credentials.yaml');
  await input(card, '模型上下文容量').fill('131072');
  await input(card, '模型最大输出').fill('4096');
  await card.getByRole('switch', { name: '模型支持推理档位', exact: true }).click();
  await input(card, 'low 接口值').fill('low');
  await input(card, 'high 接口值').fill('high');
  await assertBounded(card, 384);
  await enabled(card.getByRole('button', { name: '预览变更', exact: true }), false);
  await assertDirtyNavigation(page, 'access', false);
  assert.equal(await input(card, '模型上下文容量').inputValue(), '131072');
  await card.getByRole('button', { name: '保存应用设置', exact: true }).click();
  await card.getByText(/应用设置已保存/).waitFor();
  assert.equal(countPosts(state, '/api/chat/deployment/apply'), 0);
  assert.deepEqual(state.deployment.deployment, {
    target: { profilePath: '/fixture/dsh/selected.patch.yml', credentialsPath: '/fixture/dsh/selected.credentials.yaml', schemaVersion: '0.2.1-rc.2' },
    modelSettings: { contextWindow: 131072, maxTokens: 4096, reasoningEfforts: { off: null, low: 'low', high: 'high' } },
    namespace: 'fixture-chat'
  });
  await card.getByRole('button', { name: '预览变更', exact: true }).click();
  await card.getByText(/预览通过/).waitFor();
  const apply = card.getByRole('button', { name: '应用聊天设置', exact: true });
  await enabled(apply, true);
  const applyBeforeCapabilityCheck = countPosts(state, '/api/chat/deployment/apply');
  state.deploymentBusy = true;
  await apply.click();
  await card.getByRole('alert').filter({ hasText: '聊天处理尚未完全停止或另一项操作仍在进行' }).waitFor();
  assert.equal(countPosts(state, '/api/chat/deployment/apply'), applyBeforeCapabilityCheck);
  assert.equal(await input(card, 'DSH 配置文件').isDisabled(), false);
  await enabled(card.getByRole('button', { name: '预览变更', exact: true }), true);
  assert.equal(await card.getByRole('alert').filter({ hasText: /未知|无法确认|自动重试/ }).count(), 0);
  state.deploymentBusy = false;
  state.deploymentCapabilityChecked = true;
  state.revisions.providers = revision('changed-provider-before-apply');
  await apply.click();
  await card.getByRole('alert').filter({ hasText: '设置已变化' }).waitFor();
  assert.equal(countPosts(state, '/api/chat/deployment/apply'), 0);
  await card.getByRole('button', { name: '预览变更', exact: true }).click();
  await enabled(apply, true);
  const approved = state.approvedTargetRevision;
  state.approvedTargetRevision = revision('another-tab-replaced-approved-preview');
  await apply.click();
  await card.getByRole('alert').waitFor();
  await enabled(card.getByRole('button', { name: '预览变更', exact: true }), false);
  assert.equal(state.appliedCount, 0);
  const rejectedApply = state.posts.filter(request => request.pathname === '/api/chat/deployment/apply').at(-1)?.body;
  assert(isRecord(rejectedApply));
  assert.equal(rejectedApply.targetRevision, approved);
  await rereadDeployment(page, state);
  await acknowledgeDeploymentRecovery(page, state);
  await enabled(card.getByRole('button', { name: '预览变更', exact: true }), true);
  await card.getByRole('button', { name: '预览变更', exact: true }).click();
  await enabled(apply, true);
  await apply.click();
  await card.getByRole('status').filter({ hasText: '聊天设置已写入，等待 DSH 加载；不会自动重启。' }).waitFor();
  assert.equal(countPosts(state, '/api/chat/deployment/apply'), 2);
  assert.equal(state.appliedCount, 1);
  await card.getByRole('button', { name: '检查是否生效', exact: true }).click();
  await card.getByText('当前设置已通过生效检查；不代表模型调用成功。', { exact: true }).waitFor();
  state.applyUnknown = true;
  await card.getByRole('button', { name: '预览变更', exact: true }).click();
  await enabled(apply, true);
  await apply.click();
  await card.getByRole('alert').waitFor();
  await enabled(card.getByRole('button', { name: '预览变更', exact: true }), false);
  assert.equal(await input(card, 'DSH 配置文件').isDisabled(), true);
  await page.waitForTimeout(250);
  assert.equal(countPosts(state, '/api/chat/deployment/apply'), 3);
  assert.equal(state.appliedCount, 1);
  state.applyUnknown = false;
  await rereadDeployment(page, state);
  await acknowledgeDeploymentRecovery(page, state);
  await enabled(card.getByRole('button', { name: '预览变更', exact: true }), true);
  for (const outcome of ['unknown', 'conflict'] as const) {
    state.deploymentOutcome = outcome;
    await input(card, '模型最大输出').fill('4097');
    const before = countPosts(state, '/api/chat/deployment');
    await card.getByRole('button', { name: '保存应用设置', exact: true }).click();
    await card.getByRole('alert').filter({ hasText: outcome === 'unknown' ? '无法确认' : '其他窗口更新' }).waitFor();
    assert.equal(await input(card, 'DSH 配置文件').isDisabled(), true);
    await enabled(card.getByRole('button', { name: '保存应用设置', exact: true }), false);
    await enabled(card.getByRole('button', { name: '预览变更', exact: true }), false);
    await page.waitForTimeout(250);
    assert.equal(countPosts(state, '/api/chat/deployment'), before + 1);
    state.deploymentOutcome = 'success';
    await rereadDeployment(page, state);
    await acknowledgeDeploymentRecovery(page, state);
    await input(card, '模型最大输出').waitFor();
    await page.waitForFunction(() => !document.querySelector('#dsh-deployment [role="alert"]'));
    assert.equal(await input(card, '模型最大输出').inputValue(), '4096');
  }
}

async function exerciseRuntime(page: Page, state: FixtureState): Promise<void> {
  const card = page.locator('#chat-runtime');
  await card.getByRole('button', { name: '重新检查', exact: true }).click();
  const start = card.getByRole('button', { name: '启动聊天', exact: true });
  await enabled(start, true);
  assert.deepEqual((runtimeStatus(state) as Record<string, unknown>).missingReasons,
    ['runtime_not_started', 'onebot_protocol_not_connected']);
  await start.click();
  await card.getByText('聊天已启用', { exact: true }).waitFor();
  await card.getByText(/当前就绪检查不验证真实模型调用/).waitFor();
  assert.equal(countPosts(state, '/api/chat/application'), 1);
  assert.equal(countPosts(state, '/api/chat/runtime/start'), 0);
  const deployment = page.locator('#dsh-deployment');
  const appliesBeforeRunning = countPosts(state, '/api/chat/deployment/apply');
  await deployment.getByRole('button', { name: '预览变更', exact: true }).click();
  await enabled(deployment.getByRole('button', { name: '应用聊天设置', exact: true }), false);
  assert.equal(countPosts(state, '/api/chat/deployment/apply'), appliesBeforeRunning);
  state.runningApplyBlocked = true;
  const capture = async (condition: RuntimeCondition): Promise<void> => {
    const filename = new URL(`runtime-${condition}-${runId}.png`, output);
    await page.screenshot({ path: filename.pathname, fullPage: true, animations: 'disabled' });
    await chmod(filename, 0o600);
    state.runtimeStatusCases.push(condition);
  };
  await capture('healthy');
  const cases = [
    { condition: 'budget-exhausted', badge: '授权需要处理' },
    { condition: 'budget-expired', badge: '授权需要处理' },
    { condition: 'follow', badge: '引擎回复连接中断' },
    { condition: 'configuration-changed', badge: '设置等待应用' },
    { condition: 'protocol', badge: '协议连接中断' }
  ] as const;
  for (const scenario of cases) {
    state.runtimeCondition = scenario.condition;
    await card.getByRole('button', { name: '重新检查', exact: true }).click();
    await card.getByText(scenario.badge, { exact: true }).waitFor();
    assert.equal(await card.getByRole('button', { name: '启动聊天', exact: true }).count(), 0);
    assert.equal(await card.getByText('连接中断', { exact: true }).count(), 0);
    assert.equal(await card.getByText(/聊天尚未启动/).count(), 0);
    if (scenario.condition.startsWith('budget-')) {
      await card.getByText('消息授权已用完或过期，请到访问范围检查。', { exact: true }).waitFor();
      assert.equal(await card.getByText(/点击启动/).count(), 0);
      assert.equal(await card.getByText('协议连接中断', { exact: true }).count(), 0);
      await card.getByRole('button', { name: '去设置', exact: true }).click();
      await page.locator('[data-page="access"]').waitFor();
      await showCountedAuthorization(page);
      await navigate(page, 'adapters');
      await card.getByText(scenario.badge, { exact: true }).waitFor();
    } else if (scenario.condition === 'follow') {
      await card.getByText(/不会重放旧请求/).waitFor();
      assert.equal(await card.getByText('协议连接中断', { exact: true }).count(), 0);
    } else if (scenario.condition === 'configuration-changed') {
      await card.getByText('有新的已保存设置；停止后重新启动才会生效。', { exact: true }).waitFor();
    }
    await capture(scenario.condition);
  }
  state.runtimeCondition = 'healthy';
  await card.getByRole('button', { name: '重新检查', exact: true }).click();
  await card.getByText('聊天已启用', { exact: true }).waitFor();
  await card.getByRole('button', { name: '停止聊天', exact: true }).click();
  await enabled(start, true);
  assert.equal(countPosts(state, '/api/chat/runtime/stop'), 1);
  state.startOutcome = 'unknown';
  await start.click();
  await card.getByRole('alert').waitFor();
  await enabled(start, false);
  await page.waitForTimeout(250);
  assert.equal(countPosts(state, '/api/chat/application'), 2);
  assert.equal(countPosts(state, '/api/chat/runtime/start'), 0);
  state.startOutcome = 'success';
  await card.getByRole('button', { name: '重新检查', exact: true }).click();
  await enabled(start, false);
  await deployment.getByText('应用操作详情', { exact: true }).click();
  await deployment.getByRole('button', { name: '核对实际结果', exact: true }).click();
  await card.getByRole('button', { name: '重新检查', exact: true }).click();
  await card.getByRole('button', { name: '停止聊天', exact: true }).click();
  await enabled(start, true);
  await assertBounded(card, 512);
}

async function exercisePresentation(page: Page): Promise<void> {
  for (const title of ['聊天运行', '应用聊天设置到 DSH']) {
    await page.locator('[aria-label="本页目录"]:visible').first().getByRole('button', { name: title, exact: true }).waitFor();
  }
  await page.getByRole('button', { name: '搜索工作台', exact: true }).click();
  await page.getByRole('combobox', { name: '搜索设置或功能', exact: true }).fill('DSH 配置文件');
  await page.locator('[role="option"][data-search-title="DSH 配置文件"]').first().click();
  await page.getByRole('combobox', { name: '搜索设置或功能', exact: true }).waitFor({ state: 'hidden' });
  for (const theme of ['light', 'dark'] as const) {
    await page.getByRole('combobox', { name: '显示模式', exact: true }).selectOption(theme);
    await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme);
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      for (const destination of ['access', 'adapters'] as const) {
        await page.evaluate(target => { location.hash = `#${target}`; }, destination);
        await page.locator(`[data-page="${destination}"]`).waitFor();
        if (destination === 'access') await showCountedAuthorization(page);
        else await page.locator('#dsh-deployment').getByRole('button', { name: '应用并启动／更新聊天', exact: true }).waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        if (destination === 'access') await assertBounded(page.locator('#chat-authorization'), 384);
        else {
          await assertBounded(page.locator('#chat-runtime'), 512);
          await assertBounded(page.locator('#dsh-deployment'), 384);
        }
        if (viewport.width === 390) {
          await page.getByRole('button', { name: '展开本页目录', exact: true }).click();
          const title = destination === 'access' ? '消息处理授权' : '应用聊天设置到 DSH';
          await page.locator('[aria-label="本页目录"]:visible').first().getByRole('button', { name: title, exact: true }).click();
        }
        const filename = new URL(`${destination}-${theme}-${viewport.width}-${runId}.png`, output);
        await page.screenshot({ path: filename.pathname, fullPage: true, animations: 'disabled' });
        await chmod(filename, 0o600);
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await navigate(page, 'access');
  await showCountedAuthorization(page);
  await page.getByRole('button', { name: '搜索工作台', exact: true }).click();
  await page.getByRole('combobox', { name: '搜索设置或功能', exact: true }).fill('消息处理授权');
  await page.locator('[role="option"][data-search-title="消息处理授权"]').first().click();
  await page.getByRole('combobox', { name: '搜索设置或功能', exact: true }).waitFor({ state: 'hidden' });
}

async function exerciseApplication(page: Page, state: FixtureState): Promise<void> {
  await navigate(page, 'adapters');
  const legacy = ['/api/chat/runtime/start', '/api/chat/runtime/stop', '/api/chat/deployment/prepare', '/api/chat/deployment/apply'];
  const before = legacy.map(pathname => countPosts(state, pathname));
  const applicationsBefore = countPosts(state, '/api/chat/application');
  const card = page.locator('#dsh-deployment');
  await card.getByRole('button', { name: '应用并启动／更新聊天', exact: true }).click();
  await card.getByRole('status').filter({ hasText: '已应用已保存设置并启动／更新聊天' }).waitFor();
  assert.equal(countPosts(state, '/api/chat/application'), applicationsBefore + 1);
  assert.deepEqual(legacy.map(pathname => countPosts(state, pathname)), before,
    'The browser submits one durable application, without orchestrating legacy writes.');
  assert.equal(state.application?.state, 'completed');
  assert.equal(state.running, true);
  const runtime = page.locator('#chat-runtime');
  await runtime.getByRole('button', { name: '重新检查', exact: true }).click();
  await runtime.getByRole('button', { name: '停止聊天', exact: true }).click();
  await runtime.getByRole('button', { name: '启动聊天', exact: true }).waitFor();
}

type NativeCapabilityFixture = Awaited<ReturnType<typeof createNativeCapabilityRuntimeFixture>>;

function nativeRecords(value: unknown): Record<string, unknown>[] {
  assert(Array.isArray(value));
  return value.map(entry => { assert(isRecord(entry)); return entry; });
}

async function exerciseCapabilitySelection(page: Page, fixture: NativeCapabilityFixture): Promise<void> {
  await navigate(page, 'model');
  const before = await fixture.api('/api/chat/plans');
  const plans = nativeRecords(before.plans);
  const selected = plans.find(plan => plan.id === before.activePlanId);
  assert(selected && isRecord(selected.contextLimits));
  assert(typeof selected.contextLimits.group === 'number');
  const nextLimit = selected.contextLimits.group + 1;
  const card = page.locator('#native-plan-editor');
  await input(card, '群聊上下文').fill(String(nextLimit));
  await card.getByRole('button', { name: '保存聊天方案', exact: true }).click();
  await card.getByRole('status').filter({ hasText: /^已保存。$/ }).waitFor();
  const after = await fixture.api('/api/chat/plans');
  assert.equal(after.activePlanId, before.activePlanId);
  const saved = nativeRecords(after.plans);
  assert.deepEqual(saved, plans.map(plan => plan.id === before.activePlanId
    ? { ...plan, contextLimits: { ...selected.contextLimits as Record<string, unknown>, group: nextLimit } } : plan));
  assert.deepEqual(saved.find(plan => plan.id === 'work-alternative')?.capabilitySelection, selected.capabilitySelection);
  assert.equal(saved.find(plan => plan.id === 'text-alternative')?.capabilitySelection, null);
  const legacy = saved.find(plan => plan.id === 'legacy-alternative');
  assert(legacy && !Object.hasOwn(legacy, 'capabilitySelection'));
}

async function exerciseCapabilityApproval(page: Page, fixture: NativeCapabilityFixture, posts: readonly string[]): Promise<void> {
  await page.getByText('高级工具设置', { exact: true }).click();
  const card = page.locator('#native-chat-capabilities');
  const preview = card.getByRole('button', { name: '检查方案', exact: true });
  const approve = card.getByRole('button', { name: '确认使用', exact: true });
  const revoke = card.getByRole('button', { name: '取消确认', exact: true });
  const confirm = card.getByRole('checkbox', { name: '我确认使用这个工具组合', exact: true });
  await card.getByRole('heading', { name: '聊天工具', exact: true }).waitFor();
  const advanced = card.locator('details').filter({ has: card.page().getByText('高级设置', { exact: true }) });
  assert.equal(await advanced.getAttribute('open'), null);
  assert.equal(await card.getByText('外部工具授权未由桥核验', { exact: true }).isVisible(), false);
  await advanced.locator('summary').click();
  const authorization = await fixture.api('/api/chat/authorization');
  const profile = await readFile(fixture.profilePath);
  const credentials = await readFile(fixture.credentialsPath);
  assert.equal((await fixture.api('/api/chat/capabilities')).approval, null);
  await enabled(preview, true);
  const count = posts.length;
  await enabled(approve, false);
  assert.equal(posts.length, count);
  await preview.click();
  await card.getByText(/群聊设置/).waitFor();
  await card.getByText(/私聊设置/).waitFor();
  await enabled(approve, false);
  assert.equal(posts.filter(path => path === '/api/chat/capabilities/preview').length, 1);
  assert.deepEqual(await readFile(fixture.profilePath), profile);
  assert.deepEqual(await readFile(fixture.credentialsPath), credentials);
  await confirm.check();
  await approve.click();
  await card.getByRole('status').filter({ hasText: '已确认，请到“连接与安全”应用。' }).waitFor();
  const approved = await fixture.api('/api/chat/capabilities');
  assert(isRecord(approved.approval));
  assert.equal(approved.approval.authority, 'owner');
  assert.equal(approved.approval.externalTools, 'separate-runtime-authorization-required');
  assert(isRecord(approved.catalog));
  assert.equal(approved.catalog.externalToolAuthorizationVerified, false);
  assert.deepEqual(await fixture.api('/api/chat/authorization'), authorization);
  assert.deepEqual(await readFile(fixture.profilePath), profile);
  assert.deepEqual(await readFile(fixture.credentialsPath), credentials);
  await enabled(approve, false);
  assert.equal(await confirm.isChecked(), false);
  await preview.click();
  await card.getByText(/已确认方案与本次检查一致/).waitFor();
  await enabled(revoke, false);
  await confirm.check();
  await revoke.click();
  await card.getByRole('status').filter({ hasText: '已取消确认，正在运行的工具不受影响。' }).waitFor();
  assert.equal((await fixture.api('/api/chat/capabilities')).approval, null);
  assert.deepEqual(await fixture.api('/api/chat/authorization'), authorization);
  assert.deepEqual(await readFile(fixture.profilePath), profile);
  assert.deepEqual(await readFile(fixture.credentialsPath), credentials);
  assert.deepEqual(posts.filter(path => path.startsWith('/api/chat/capabilities/')), [
    '/api/chat/capabilities/preview', '/api/chat/capabilities/approval', '/api/chat/capabilities/preview', '/api/chat/capabilities/revoke'
  ]);
}

async function exerciseToolDelegation(page: Page, fixture: NativeCapabilityFixture): Promise<void> {
  const accessMode = page.getByRole('region', { name: '访问模式', exact: true });
  const original = await fixture.api('/api/chat/authorization');
  const legacy = { version: original.version, grants: nativeRecords(original.grants) };
  for (const grant of legacy.grants) {
    assert.equal(Object.hasOwn(grant, 'toolDelegationUses'), false);
    assert.equal(Object.hasOwn(grant, 'cancelUses'), false);
  }
  assert.equal(revision(validateNativeChatAuthorization(legacy)), revision(legacy));
  const rewritten = await fixture.api('/api/chat/authorization', { revision: original.revision, ...legacy });
  assert.equal(rewritten.revision, original.revision);
  const explicitZero = { ...legacy, grants: legacy.grants.map((grant, index) => index === 0 ? { ...grant, toolDelegationUses: 0 } : grant) };
  assert.notEqual(revision(validateNativeChatAuthorization(explicitZero)), revision(validateNativeChatAuthorization(legacy)));
  await navigate(page, 'access');
  await showCountedAuthorization(page);
  const card = page.locator('#chat-authorization');
  const toggle = card.getByRole('checkbox', { name: /^启用有限工具委派/ }).first();
  const confirm = card.getByRole('checkbox', { name: /^我确认这些数值/ });
  const save = card.getByRole('button', { name: '保存新授权', exact: true });
  await toggle.waitFor();
  assert.equal(await toggle.isChecked(), false);
  assert.equal(await card.getByText('工具委派尝试次数（按轮）', { exact: true }).count(), 0);
  const sendUses = legacy.grants[0]?.sendUses;
  assert(typeof sendUses === 'number');
  await input(card, '回复发送次数').first().fill(String(sendUses + 1));
  await enabled(save, false);
  await confirm.check();
  await save.click();
  await accessMode.getByRole('status').filter({ hasText: '授权已保存' }).waitFor();
  const unrelated = await fixture.api('/api/chat/authorization');
  const unrelatedGrants = nativeRecords(unrelated.grants);
  assert.notEqual(unrelated.version, original.version);
  assert.deepEqual(unrelatedGrants, legacy.grants.map((grant, index) => index === 0 ? { ...grant, sendUses: sendUses + 1 } : grant));
  await toggle.check();
  assert.equal(await input(card, '工具委派尝试次数（按轮）').inputValue(), '0');
  await input(card, '工具委派尝试次数（按轮）').fill('2');
  await enabled(save, false);
  await confirm.check();
  await save.click();
  await accessMode.getByRole('status').filter({ hasText: '授权已保存' }).waitFor();
  const delegated = await fixture.api('/api/chat/authorization');
  assert.notEqual(delegated.version, unrelated.version);
  assert.deepEqual(nativeRecords(delegated.grants), unrelatedGrants.map((grant, index) => index === 0 ? { ...grant, toolDelegationUses: 2 } : grant));
  await toggle.uncheck();
  await confirm.check();
  await save.click();
  await accessMode.getByRole('status').filter({ hasText: '授权已保存' }).waitFor();
  const disabled = await fixture.api('/api/chat/authorization');
  assert.notEqual(disabled.version, delegated.version);
  assert.deepEqual(disabled.grants, unrelated.grants);
  assert.equal((await fixture.api('/api/chat/capabilities')).approval, null);
}

async function exercisePlanDeletion(page: Page, fixture: NativeCapabilityFixture, posts: readonly string[]): Promise<Record<string, boolean>> {
  await navigate(page, 'model');
  const editor = page.locator('#native-plan-editor');
  const deletion = editor.getByText('删除此方案', { exact: true });
  await deletion.waitFor();
  if (await deletion.locator('xpath=ancestor::details[1]').getAttribute('open') === null) await deletion.click();
  const remove = editor.getByRole('button', { name: '确认删除此方案', exact: true });
  const confirm = editor.getByRole('checkbox', { name: /^我确认删除方案/ });
  await enabled(remove, false);
  await page.getByRole('button', { name: /^Work alternative/ }).click();
  await input(editor, '方案名称').waitFor();
  const before = await fixture.api('/api/chat/plans');
  const count = posts.length;
  await enabled(remove, false);
  await confirm.check();
  await confirm.uncheck();
  await enabled(remove, false);
  assert.equal(posts.length, count);
  assert.deepEqual(await fixture.api('/api/chat/plans'), before);
  await confirm.check();
  await enabled(remove, true);
  const staleDispatch = await page.evaluate(() => {
    const editor = document.querySelector('#native-plan-editor');
    const oldDelete = [...editor!.querySelectorAll('button')].find(button => button.textContent?.trim() === '确认删除此方案');
    const oldConfirm = [...editor!.querySelectorAll('label')].find(label => label.textContent?.includes('我确认删除方案'))?.control;
    const nextPlan = [...document.querySelectorAll('button')].find(button => button.textContent?.trim().startsWith('Text alternative'));
    if (!oldDelete || !(oldConfirm instanceof HTMLInputElement) || !nextPlan) throw new Error('plan_deletion_controls_missing');
    if (oldDelete.disabled || oldConfirm.disabled || nextPlan.disabled) throw new Error('plan_deletion_controls_not_enabled');
    nextPlan.click();
    const disabledAfterSelection = oldDelete.disabled;
    oldDelete.click();
    return { enabledAtEntry: true, disabledAfterSelection };
  });
  await page.waitForFunction(() => {
    const input = [...document.querySelectorAll('#native-plan-editor label')].find(label => label.querySelector('.field-label')?.textContent === '方案名称')?.querySelector('input');
    return input?.value === 'Text alternative';
  });
  await enabled(remove, false);
  assert.equal(await confirm.isChecked(), false);
  assert.equal(posts.length, count);
  assert.deepEqual(await fixture.api('/api/chat/plans'), before);
  await confirm.check();
  await remove.click();
  await editor.getByRole('status').filter({ hasText: /^已保存。$/ }).waitFor();
  const after = await fixture.api('/api/chat/plans');
  assert.equal(after.activePlanId, before.activePlanId);
  assert.deepEqual(after.plans, nativeRecords(before.plans).filter(plan => plan.id !== 'text-alternative'));
  assert.equal(posts.length, count + 1);
  assert.equal(posts.at(-1), '/api/chat/plans');
  return staleDispatch;
}

async function exerciseWhitelistDefaults(page: Page, fixture: NativeCapabilityFixture, posts: readonly string[]): Promise<void> {
  const legacy = await fixture.api('/api/chat/authorization');
  await fixture.save('authorization', { version: 'browser-whitelist-default', mode: 'whitelist', grants: [] });
  const saved = await fixture.api('/api/chat/authorization');
  assert.equal(saved.mode, 'whitelist');
  assert.equal(saved.taskDelegationAvailable, false);
  assert.deepEqual(saved.grants, []);
  assert.notEqual(saved.version, legacy.version);
  const capabilities = await fixture.api('/api/chat/capabilities');
  assert.equal(capabilities.compositionApprovalRequired, false);
  const beforePosts = posts.length;
  const beforePlans = await fixture.api('/api/chat/plans');
  const beforeAccess = await fixture.api('/api/chat/access');
  await navigate(page, 'access');
  const accessMode = page.getByRole('region', { name: '访问模式', exact: true });
  await accessMode.getByText(/已保存白名单模式/).waitFor();
  assert.equal(await accessMode.locator('input').count(), 0);
  assert.equal(await accessMode.getByText('高级：旧模式授权与次数', { exact: true }).count(), 0);
  await navigate(page, 'model');
  const card = page.locator('#native-chat-capabilities');
  await page.getByText('高级工具设置', { exact: true }).click();
  await card.getByText('工具组合', { exact: true }).locator('xpath=ancestor::label[1]').locator('select').waitFor();
  for (const title of ['检查方案', '确认使用', '取消确认']) {
    assert.equal(await card.getByRole('button', { name: title, exact: true }).count(), 0);
  }
  assert.equal(await card.getByRole('checkbox').count(), 0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['light', 'dark'] as const) {
      await page.getByRole('combobox', { name: '显示模式', exact: true }).selectOption(theme);
      await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await assertBounded(card, 384, { footer: 'absent' });
    }
  }
  assert.equal(posts.length, beforePosts);
  assert.deepEqual(await fixture.api('/api/chat/plans'), beforePlans);
  assert.deepEqual(await fixture.api('/api/chat/access'), beforeAccess);
  assert.deepEqual(await fixture.api('/api/chat/authorization'), saved);
}

async function exerciseNativeCapabilityManagement(browser: Browser): Promise<Record<string, unknown>> {
  const cleanups: Array<() => void | Promise<void>> = [];
  const posts: string[] = [];
  const errors: string[] = [];
  const external: string[] = [];
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let stage = 'native-fixture';
  try {
    const fixture = await createNativeCapabilityRuntimeFixture({ after: cleanup => { cleanups.push(cleanup); } });
    await fixture.login();
    await fixture.configure(true);
    const catalog = await fixture.api('/api/chat/plans');
    const plans = nativeRecords(catalog.plans);
    assert.equal(plans.length, 1);
    const active = plans[0]!;
    const { capabilitySelection, ...textPlan } = active;
    assert(isRecord(capabilitySelection));
    await fixture.save('plans', { activePlanId: catalog.activePlanId, plans: [active,
      { ...active, id: 'work-alternative', name: 'Work alternative' },
      { ...textPlan, id: 'text-alternative', name: 'Text alternative', capabilitySelection: null },
      { ...textPlan, id: 'legacy-alternative', name: 'Legacy alternative' }
    ] });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
    await context.route('**/*', route => {
      const target = new URL(route.request().url());
      if (['http:', 'https:', 'ws:', 'wss:'].includes(target.protocol) && target.origin !== fixture.origin) {
        external.push(target.origin); return route.abort();
      }
      return route.continue();
    });
    await context.routeWebSocket('**/*', route => { external.push('websocket'); route.close(); });
    page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on('pageerror', error => errors.push(error.name));
    page.on('request', request => { if (request.method() === 'POST') posts.push(new URL(request.url()).pathname); });
    await page.goto(fixture.origin);
    await page.locator('#token').fill(fixture.adminToken);
    await page.locator('#connect').click();
    await page.getByRole('button', { name: '断开连接', exact: true }).waitFor();
    stage = 'native-selection';
    await exerciseCapabilitySelection(page, fixture);
    stage = 'native-composition-approval';
    await exerciseCapabilityApproval(page, fixture, posts);
    stage = 'native-tool-delegation';
    await exerciseToolDelegation(page, fixture);
    stage = 'native-plan-deletion';
    const staleDeletionDispatch = await exercisePlanDeletion(page, fixture, posts);
    stage = 'whitelist-defaults';
    await exerciseWhitelistDefaults(page, fixture, posts);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    assert.deepEqual(fixture.errors, []);
    assert.equal(fixture.controls.creates, 0);
    assert.equal(fixture.sends.length, 0);
    assert.equal(fixture.calls.some(call => /prompt|submitRequest|session\/create|session\/selectModel|inspectScope/.test(call.method)), false);
    assert(posts.every(path => path === '/api/auth/login' || ['/api/chat/plans', '/api/chat/authorization',
      '/api/chat/capabilities/preview', '/api/chat/capabilities/approval', '/api/chat/capabilities/revoke'].includes(path)));
    return { realDefaultGateway: true, localSyntheticDsh: true, modelCalls: 0, sessionCreates: 0,
      selectionSiblingShapes: ['versioned', 'null', 'absent'], previewApprovalRevokeExplicit: true,
      approvalDoesNotGrant: true, legacyOmissionHashPreserved: true, explicitZeroHashDistinct: true,
      delegationExplicitNewVersion: true, whitelistNoLifetimeQuotaOrCompositionApproval: true,
      deletionCancelPosts: 0, staleDeletionPosts: 0, staleDeletionDispatch,
      browserPostPaths: posts, dshReadOnlyMethods: [...new Set(fixture.calls.map(call => call.method))] };
  } catch (error) {
    if (page && !page.isClosed()) {
      const filename = new URL(`native-management-failure-${runId}.png`, output);
      await page.screenshot({ path: filename.pathname, fullPage: true, animations: 'disabled' }).catch(() => undefined);
      await chmod(filename, 0o600).catch(() => undefined);
    }
    await writeFile(new URL(`native-management-failure-${runId}.json`, output), JSON.stringify({
      stage, error: error instanceof Error ? error.name : 'unknown', pageErrors: errors, externalRequests: external, browserPostPaths: posts
    }, null, 2) + '\n', { mode: 0o600 });
    throw error;
  } finally {
    try { await context?.close(); }
    finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
  }
}

const state = fixtureState();
const errors: string[] = [];
const externalRequests: string[] = [];
const browserPostPaths: string[] = [];
let server: Server | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;
let files: FixtureFiles | undefined;
let stage = 'startup';
try {
  const bundle = await readBuiltBrowserApplication();
  for (const pathname of ['/api/chat/authorization', '/api/chat/deployment', '/api/chat/runtime', '/api/chat/capabilities', 'capabilitySelection', 'toolDelegationUses']) {
    assert(bundle.includes(pathname), '请先在隔离副本构建当前管理页面；本测试不会自动构建。');
  }
  await mkdir(output, { recursive: true, mode: 0o700 });
  files = await fixtureFiles();
  const configurationRoutes = [
    ...createConfigurationRoutes({ gatewayConfigurationFilename: files.gateway, adminConfigurationFilename: files.admin }),
    ...createSettingsRoutes({ gatewayConfigurationFilename: files.gateway, adminConfigurationFilename: files.admin })
  ].map(route => route.method !== 'POST' ? route : { ...route, handle: (request: Parameters<AdminRoute['handle']>[0]) => {
    state.posts.push({ pathname: route.pathname, body: structuredClone(request.body) });
    return route.handle(request);
  } });
  server = createAdminServer({ token: administratorToken, routes: [...routes(state, files), ...configurationRoutes], snapshot: () => ({
    mode: 'framework', integrations: { nativeRuntimeResources: true, nativeChatRuntime: true },
    overview: { online: true, gatewayHealthy: true }, fixtureOnly: true
  }) });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server!.once('error', rejectPromise);
    server!.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://${hostname}:${address.port}`;
  browser = await chromium.launch({ headless: true,
    args: [`--host-resolver-rules=MAP ${hostname} 127.0.0.1`, '--no-proxy-server'],
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
  await context.route('**/*', route => {
    const requested = new URL(route.request().url());
    if (['http:', 'https:', 'ws:', 'wss:'].includes(requested.protocol) && requested.origin !== origin) {
      externalRequests.push(requested.origin);
      return route.abort();
    }
    return route.continue();
  });
  await context.routeWebSocket('**/*', route => { externalRequests.push('websocket'); route.close(); });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.name));
  page.on('request', request => {
    if (request.method() === 'POST') browserPostPaths.push(new URL(request.url()).pathname);
  });
  await page.goto(origin);
  assert.deepEqual(await page.evaluate(() => ({ secure: isSecureContext, randomUUID: typeof crypto.randomUUID })),
    { secure: false, randomUUID: 'undefined' });
  await page.locator('#token').fill(administratorToken);
  await page.locator('#connect').click();
  await page.getByRole('button', { name: '断开连接', exact: true }).waitFor();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  stage = 'authorization';
  await exerciseAuthorization(page, state);
  stage = 'deployment';
  await exerciseDeployment(page, state);
  stage = 'runtime';
  await exerciseRuntime(page, state);
  stage = 'durable-application';
  await exerciseApplication(page, state);
  stage = 'presentation';
  await exercisePresentation(page);
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  assert.equal(state.running, false);
  assert(state.posts.every(request => !/reset|restart|connect/.test(request.pathname)));
  for (const pathname of ['/api/chat/access', '/api/configuration/apply', '/api/settings/apply']) {
    assert.equal(browserPostPaths.includes(pathname), false);
  }
  stage = 'native-capability-management';
  await context.close();
  context = undefined;
  const nativeCapabilityManagement = await exerciseNativeCapabilityManagement(browser);
  const report = { fixtureOnly: true, insecureContext: true, randomUUIDFallback: true, pageErrors: errors,
    externalRequests, browserPostPaths, postCounts: Object.fromEntries([...new Set(state.posts.map(request => request.pathname))]
      .map(pathname => [pathname, countPosts(state, pathname)])), gatewayScope: state.gatewayScopeEvidence,
    runtimeStatusCases: state.runtimeStatusCases, deploymentCapabilityChecked: state.deploymentCapabilityChecked,
    runningApplyBlocked: state.runningApplyBlocked, screenshots: 10 + state.runtimeStatusCases.length, nativeCapabilityManagement };
  await writeFile(new URL(`report-${runId}.json`, output), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log('原生聊天 UI 测试通过：授权、应用确认、未知结果、布局，以及真实默认入口的能力选择、组合批准、有限委派和方案删除保护。');
} catch (error: unknown) {
  if (page && !page.isClosed()) {
    const filename = new URL(`failure-${runId}.png`, output);
    await page.screenshot({ path: filename.pathname, fullPage: true, animations: 'disabled' }).catch(() => undefined);
    await chmod(filename, 0o600).catch(() => undefined);
  }
  await writeFile(new URL(`failure-${runId}.json`, output), JSON.stringify({
    stage, pageErrors: errors, externalRequests,
    error: error instanceof Error ? error.name : 'unknown',
    postCounts: Object.fromEntries([...new Set(state.posts.map(request => request.pathname))]
      .map(pathname => [pathname, countPosts(state, pathname)]))
  }, null, 2) + '\n', { mode: 0o600 }).catch(() => undefined);
  throw error;
} finally {
  await context?.close();
  await browser?.close();
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise<void>(resolvePromise => server!.close(() => resolvePromise()));
  }
  if (files) await rm(files.directory, { recursive: true, force: true });
}
