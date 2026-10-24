import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';

import { AdminRequestError, createAdminServer, type AdminRoute } from '../src/admin/server.ts';
import { createConfigurationRoutes } from '../src/admin/configuration.ts';
import { createSettingsRoutes } from '../src/admin/settings.ts';
import { isRecord } from '../src/core/values.ts';

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
const revisionKeys = ['plans', 'personas', 'access', 'adapters', 'providers', 'authorization', 'deployment'];

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
    deploymentBusy: false, deploymentCapabilityChecked: false, runningApplyBlocked: false, posts: []
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
    get('/api/chat/authorization', () => state.authorization),
    get('/api/chat/deployment', () => state.deployment),
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
        summary: { ready: true, missingReasons: [] }, preview: { providerCount: 1, presetCount: 2 } };
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
      return { verified: true, missingReasons: [], presets: [{ agentPreset: 'fixture-group' }, { agentPreset: 'fixture-private' }] };
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

async function navigate(page: Page, destination: 'access' | 'adapters'): Promise<void> {
  const label = destination === 'access' ? '访问范围' : '适配器';
  await page.getByRole('button', { name: label, exact: true }).first().click();
  await page.locator(`[data-page="${destination}"]`).waitFor();
}

async function enabled(locator: Locator, expected: boolean): Promise<void> {
  await locator.waitFor();
  await locator.and(locator.page().locator(expected ? 'button:enabled' : 'button:disabled')).waitFor({ timeout: 15_000 });
}

async function assertBounded(section: Locator, height: number): Promise<void> {
  const dimensions = await section.evaluate(element => {
    const card = element.querySelector('[data-bounded-card]');
    const footer = element.querySelector('.panel-footer');
    assertElement(card); assertElement(footer);
    function assertElement(candidate: Element | null): asserts candidate is HTMLElement {
      if (!(candidate instanceof HTMLElement)) throw new Error('bounded_card_or_footer_missing');
    }
    return { height: card.getBoundingClientRect().height, overflow: getComputedStyle(card).overflowY,
      footerAfter: footer.getBoundingClientRect().top >= card.getBoundingClientRect().bottom - 1 };
  });
  assert(Math.abs(dimensions.height - height) <= 2, JSON.stringify(dimensions));
  assert(['auto', 'scroll'].includes(dimensions.overflow));
  assert.equal(dimensions.footerAfter, true);
}

async function assertDirtyNavigation(page: Page, destination: 'access' | 'adapters', discard: boolean): Promise<void> {
  const label = destination === 'access' ? '访问范围' : '适配器';
  await page.getByRole('button', { name: label, exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '还有未保存的更改', exact: true });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: discard ? '舍弃并离开' : '继续编辑', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  if (discard) await page.locator(`[data-page="${destination}"]`).waitFor();
}

async function exerciseAuthorization(page: Page, state: FixtureState): Promise<void> {
  await navigate(page, 'access');
  const card = page.locator('#chat-authorization');
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
  await card.getByText(/授权已保存/).waitFor();
  assert.equal(state.authorization.grants.length, 2);
  assert.equal(state.authorization.grants[1]?.sendUses, 16);
  assert.equal(countPosts(state, '/api/chat/authorization'), 1);
  await assertBounded(card, 384);
  await input(card, '模型提交次数').first().fill('31');
  await assertDirtyNavigation(page, 'adapters', false);
  assert.equal(await input(card, '模型提交次数').first().inputValue(), '31');
  await assertDirtyNavigation(page, 'adapters', true);
  assert.equal(countPosts(state, '/api/chat/authorization'), 1);
  await navigate(page, 'access');
  for (const outcome of ['unknown', 'conflict'] as const) {
    state.authorizationOutcome = outcome;
    await input(card, '模型提交次数').first().fill('32');
    await card.getByRole('checkbox').check();
    const before = countPosts(state, '/api/chat/authorization');
    await save.click();
    await card.getByRole('alert').filter({ hasText: outcome === 'unknown' ? '无法确认' : '其他窗口更新' }).waitFor();
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
    await enabled(card.getByRole('button', { name: '添加会话授权', exact: true }), true);
    assert.equal(await input(card, '模型提交次数').first().inputValue(), '20');
  }
}

async function exerciseDeployment(page: Page, state: FixtureState): Promise<void> {
  await navigate(page, 'adapters');
  const card = page.locator('#dsh-deployment');
  await input(card, 'DSH 配置文件').fill('/fixture/dsh/selected.patch.yml');
  await input(card, 'DSH 凭据文件').fill('/fixture/dsh/selected.credentials.yaml');
  await input(card, '模型上下文容量').fill('131072');
  await input(card, '模型最大输出').fill('4096');
  await card.getByRole('switch', { name: '模型支持推理档位', exact: true }).click();
  await input(card, '低档位的接口值').fill('low');
  await input(card, '高档位的接口值').fill('high');
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
  const apply = card.getByRole('button', { name: '备份并应用', exact: true });
  await enabled(apply, false);
  await card.getByRole('checkbox').check();
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
  await enabled(apply, false);
  await card.getByRole('checkbox').check();
  const approved = state.approvedTargetRevision;
  state.approvedTargetRevision = revision('another-tab-replaced-approved-preview');
  await apply.click();
  await card.getByRole('alert').waitFor();
  await enabled(card.getByRole('button', { name: '预览变更', exact: true }), false);
  assert.equal(state.appliedCount, 0);
  const rejectedApply = state.posts.filter(request => request.pathname === '/api/chat/deployment/apply').at(-1)?.body;
  assert(isRecord(rejectedApply));
  assert.equal(rejectedApply.targetRevision, approved);
  await card.getByRole('button', { name: '重新读取', exact: true }).click();
  await enabled(card.getByRole('button', { name: '预览变更', exact: true }), true);
  await card.getByRole('button', { name: '预览变更', exact: true }).click();
  await enabled(apply, false);
  await card.getByRole('checkbox').check();
  await apply.click();
  await card.getByRole('status').filter({ hasText: '配置已写入，等待 DSH 加载；不会擅自重启引擎。' }).waitFor();
  assert.equal(countPosts(state, '/api/chat/deployment/apply'), 2);
  assert.equal(state.appliedCount, 1);
  await card.getByRole('button', { name: '检查是否生效', exact: true }).click();
  await card.getByText('DSH 配置与托管凭据来源检查通过。', { exact: true }).waitFor();
  state.applyUnknown = true;
  await card.getByRole('button', { name: '预览变更', exact: true }).click();
  await enabled(apply, false);
  await card.getByRole('checkbox').check();
  await apply.click();
  await card.getByRole('alert').waitFor();
  await enabled(card.getByRole('button', { name: '预览变更', exact: true }), false);
  assert.equal(await input(card, 'DSH 配置文件').isDisabled(), true);
  await page.waitForTimeout(250);
  assert.equal(countPosts(state, '/api/chat/deployment/apply'), 3);
  assert.equal(state.appliedCount, 1);
  state.applyUnknown = false;
  await card.getByRole('button', { name: '重新读取', exact: true }).click();
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
    await card.getByRole('button', { name: '重新读取', exact: true }).click();
    await input(card, '模型最大输出').waitFor();
    await page.waitForFunction(() => !document.querySelector('#dsh-deployment [role="alert"]'));
    assert.equal(await input(card, '模型最大输出').inputValue(), '4096');
  }
}

async function exerciseGatewayScope(page: Page, state: FixtureState, files: FixtureFiles): Promise<void> {
  const preserved = [files.admin, files.nativeAccess, files.gatewayToken, files.adminToken];
  const before = new Map(await Promise.all(preserved.map(async filename => [filename, await readFile(filename, 'utf8')] as const)));
  const filenamesBefore = (await readdir(files.directory)).sort();
  const gatewayBeforeContent = await readFile(files.gateway, 'utf8');
  const gatewayBefore: unknown = JSON.parse(gatewayBeforeContent);
  assert(isRecord(gatewayBefore));
  const authorizationBefore = JSON.stringify(state.authorization);
  await navigate(page, 'adapters');
  await page.getByRole('button', { name: '搜索工作台', exact: true }).click();
  await page.getByRole('combobox', { name: '搜索设置或功能', exact: true }).fill('允许发送的会话');
  await page.locator('[role="option"][data-search-title="允许发送的会话"]').first().click();
  await page.locator('[data-page="access"]').waitFor();
  const card = page.locator('section').filter({ has: page.getByRole('heading', { name: '消息发送范围', exact: true }) }).first();
  await card.waitFor();
  await page.locator('[aria-label="本页目录"]:visible').first().getByRole('button', { name: '消息发送范围', exact: true }).click();
  const targets = card.getByText('允许发送的会话', { exact: true }).locator('xpath=ancestor::label[1]').locator('textarea');
  assert.equal(await targets.inputValue(), 'group:430003');
  await targets.fill('group:430004\nprivate:440005');
  await card.getByRole('button', { name: '保存本组', exact: true }).click();
  await card.getByRole('status').filter({ hasText: '已保存，等待应用' }).waitFor();
  await enabled(card.getByRole('button', { name: '保存本组', exact: true }), false);
  const gatewayAfterContent = await readFile(files.gateway, 'utf8');
  const gatewayAfter: unknown = JSON.parse(gatewayAfterContent);
  assert(isRecord(gatewayAfter));
  assert.deepEqual(gatewayAfter.allowedConversations, ['group:430004', 'private:440005']);
  assert.equal(typeof gatewayAfter.authorizationVersion, 'string');
  assert.notEqual(gatewayAfter.authorizationVersion, gatewayBefore.authorizationVersion);
  assert.deepEqual({ ...gatewayAfter, allowedConversations: gatewayBefore.allowedConversations,
    authorizationVersion: gatewayBefore.authorizationVersion }, gatewayBefore);
  for (const [filename, content] of before) assert.equal(await readFile(filename, 'utf8'), content);
  assert.deepEqual((await readdir(files.directory)).sort(), filenamesBefore);
  assert.equal(JSON.stringify(state.authorization), authorizationBefore);
  const saved = state.posts.filter(request => request.pathname === '/api/configuration');
  assert.equal(saved.length, 1);
  assert(isRecord(saved[0]?.body));
  assert.equal(saved[0].body.source, 'gateway');
  assert.deepEqual(saved[0].body.changes, { allowedConversations: ['group:430004', 'private:440005'] });
  assert.equal(countPosts(state, '/api/chat/access'), 0);
  assert.equal(await page.getByText('允许名单', { exact: true }).locator('xpath=ancestor::label[1]')
    .locator('textarea').inputValue(), 'group:410001\nprivate:420002');
  assert.equal(await card.getByRole('button', { name: '应用消息网关设置', exact: true }).count(), 0);
  const scopeScreenshot = new URL(`gateway-scope-${runId}.png`, output);
  await page.screenshot({ path: scopeScreenshot.pathname, fullPage: true, animations: 'disabled' });
  await chmod(scopeScreenshot, 0o600);
  await page.getByRole('button', { name: '搜索工作台', exact: true }).click();
  await page.getByRole('combobox', { name: '搜索设置或功能', exact: true }).fill('HTTPS 反向代理');
  await page.locator('[role="option"][data-search-title="HTTPS 反向代理"]').first().click();
  await page.locator('[data-page="settings"]').waitFor();
  const proxy = page.locator('section').filter({ has: page.getByRole('heading', { name: 'HTTPS 反向代理', exact: true }) }).first();
  await proxy.waitFor();
  await input(proxy, '管理页公开 HTTPS 来源').waitFor();
  assert.equal(await input(proxy, '管理页公开 HTTPS 来源').inputValue(), '');
  assert.equal(await proxy.getByRole('switch', { name: '信任本机 TLS 代理', exact: true }).getAttribute('aria-checked'), 'false');
  await enabled(proxy.getByRole('button', { name: '保存本组', exact: true }), false);
  assert.equal(countPosts(state, '/api/configuration/apply'), 0);
  assert.equal(countPosts(state, '/api/settings/apply'), 0);
  assert.equal(await readFile(files.admin, 'utf8'), before.get(files.admin));
  const proxyScreenshot = new URL(`proxy-schema-readonly-${runId}.png`, output);
  await page.screenshot({ path: proxyScreenshot.pathname, fullPage: true, animations: 'disabled' });
  await chmod(proxyScreenshot, 0o600);
  state.gatewayScopeEvidence = {
    allowedConversations: gatewayAfter.allowedConversations, authorizationVersionChanged: true,
    nativeAccessUnchanged: true, adminUnchanged: true, credentialsUnchanged: true,
    nativeAuthorizationUnchanged: true, proxySchemaReadOnly: true, applied: false,
    gatewayHashBefore: createHash('sha256').update(gatewayBeforeContent).digest('hex'),
    gatewayHashAfter: createHash('sha256').update(gatewayAfterContent).digest('hex'),
    nativeAccessHash: createHash('sha256').update(before.get(files.nativeAccess)!).digest('hex'),
    adminHash: createHash('sha256').update(before.get(files.admin)!).digest('hex')
  };
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
  assert.equal(countPosts(state, '/api/chat/runtime/start'), 1);
  const deployment = page.locator('#dsh-deployment');
  const appliesBeforeRunning = countPosts(state, '/api/chat/deployment/apply');
  await deployment.getByRole('button', { name: '预览变更', exact: true }).click();
  assert.equal(await deployment.getByRole('checkbox').isDisabled(), true);
  await enabled(deployment.getByRole('button', { name: '备份并应用', exact: true }), false);
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
      await page.locator('#chat-authorization input').first().waitFor();
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
  await card.getByRole('alert').filter({ hasText: '不会自动重复操作' }).waitFor();
  await enabled(start, false);
  await page.waitForTimeout(250);
  assert.equal(countPosts(state, '/api/chat/runtime/start'), 2);
  state.startOutcome = 'success';
  await card.getByRole('button', { name: '重新检查', exact: true }).click();
  await enabled(start, true);
  await assertBounded(card, 256);
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
        await page.locator(destination === 'access' ? '#chat-authorization input' : '#dsh-deployment input').first().waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        if (destination === 'access') await assertBounded(page.locator('#chat-authorization'), 384);
        else {
          await assertBounded(page.locator('#chat-runtime'), 256);
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
  await page.locator('#chat-authorization input').first().waitFor();
  await page.getByRole('button', { name: '搜索工作台', exact: true }).click();
  await page.getByRole('combobox', { name: '搜索设置或功能', exact: true }).fill('消息处理授权');
  await page.locator('[role="option"][data-search-title="消息处理授权"]').first().click();
  await page.getByRole('combobox', { name: '搜索设置或功能', exact: true }).waitFor({ state: 'hidden' });
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
  const bundle = await readFile(new URL('../dist/admin-web/app.js', import.meta.url), 'utf8');
  for (const pathname of ['/api/chat/authorization', '/api/chat/deployment', '/api/chat/runtime']) {
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
  stage = 'gateway-scope';
  await exerciseGatewayScope(page, state, files);
  stage = 'deployment';
  await exerciseDeployment(page, state);
  stage = 'runtime';
  await exerciseRuntime(page, state);
  stage = 'presentation';
  await exercisePresentation(page);
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  assert.equal(state.running, false);
  assert(state.posts.every(request => !/reset|restart|connect/.test(request.pathname)));
  for (const pathname of ['/api/chat/access', '/api/configuration/apply', '/api/settings/apply']) {
    assert.equal(browserPostPaths.includes(pathname), false);
  }
  const report = { fixtureOnly: true, insecureContext: true, randomUUIDFallback: true, pageErrors: errors,
    externalRequests, browserPostPaths, postCounts: Object.fromEntries([...new Set(state.posts.map(request => request.pathname))]
      .map(pathname => [pathname, countPosts(state, pathname)])), gatewayScope: state.gatewayScopeEvidence,
    runtimeStatusCases: state.runtimeStatusCases, deploymentCapabilityChecked: state.deploymentCapabilityChecked,
    runningApplyBlocked: state.runningApplyBlocked, screenshots: 10 + state.runtimeStatusCases.length };
  await writeFile(new URL(`report-${runId}.json`, output), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log('原生聊天 UI 测试通过：授权、应用确认、未知结果、冲突、布局与非安全上下文。');
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
