import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Page, Route } from 'playwright';
import { validateChatPlanCatalog } from '../src/contracts/chat-plans.ts';
import { parseNativeApplicationRequest, type NativeApplicationSnapshot } from '../src/contracts/native-application.ts';
import type { NativeConfigurationRevisions } from '../src/contracts/native-revisions.ts';
import { isRecord } from '../web/lib/api.ts';
import { navigateConsolePage } from './browser-navigation-smoke.ts';

const revision = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const applicationPath = '/api/chat/application';
const reconciliationPath = `${applicationPath}/reconcile`;
const interceptedPaths = new Set(['/api/chat/plans', '/api/chat/personas', '/api/chat/providers', '/api/chat/model-capabilities',
  '/api/chat/runtime', '/api/chat/deployment', applicationPath, reconciliationPath]);

export async function exercisePlanUpdate(page: Page, requests: readonly { readonly method: string; readonly pathname: string }[]): Promise<void> {
  for (const scenario of ['draft', 'lost-acknowledgement', 'continue-verified-apply', 'continue-pending-reload', 'rejected', 'save-conflict'] as const) {
    console.log(`Plan update regression: ${scenario}`);
    const continuation = scenario.startsWith('continue-');
    const requestStart = requests.length;
    const assertScopedWrites = () => {
      assert(requests.slice(requestStart).filter(request => request.method === 'POST')
        .every(request => request.pathname === '/api/chat/plans' || request.pathname === applicationPath || request.pathname === reconciliationPath),
      'Updating one plan cannot save another settings domain or directly stop/apply/start the runtime.');
    };
    let catalog = { revision: revision(['plans', scenario]), ...validateChatPlanCatalog({ activePlanId: 'update-active', plans: [
      { id: 'update-active', name: 'Update Active', description: '', instructions: 'Original active instructions.',
        personaId: 'update-persona', provider: 'update-provider', model: 'update-model', reasoningEffort: 'high', contextLimits: { group: 128000, private: 128000 } },
      { id: 'update-alternate', name: 'Update Alternate', description: '', instructions: 'Original alternate instructions.',
        personaId: 'update-persona', provider: 'update-provider', model: 'update-model', reasoningEffort: 'high', contextLimits: { group: 128000, private: 128000 } },
    ] }) };
    let revisions: NativeConfigurationRevisions = { plans: catalog.revision, personas: revision('personas'), access: revision('access'),
      adapters: revision('adapters'), providers: revision('providers'), authorization: revision('authorization'),
      deployment: revision('deployment'), execution: revision('execution') };
    let activeRevisions = { ...revisions };
    let operation: NativeApplicationSnapshot | null = null;
    const currentOperation = (): NativeApplicationSnapshot | null => operation;
    let complete = false;
    let acceptedCount = 0;
    let deploymentAdvanced = false;
    let rejectApplication = scenario === 'rejected';
    const writes: { readonly path: string; readonly body: unknown }[] = [];
    const operationReads: string[] = [];
    const matches = (url: URL) => interceptedPaths.has(url.pathname);
    const handler = async (route: Route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      if (request.method() === 'POST') {
        const body: unknown = request.postDataJSON();
        writes.push({ path, body });
        if (path === '/api/chat/plans') {
          assert(isRecord(body));
          assert.equal(body.revision, catalog.revision);
          if (scenario === 'save-conflict') return route.fulfill({ status: 409, json: { error: 'chat_revision_conflict' } });
          const next = validateChatPlanCatalog({ activePlanId: body.activePlanId, plans: body.plans });
          catalog = { revision: revision(body), ...next };
          revisions = { ...revisions, plans: catalog.revision };
          return route.fulfill({ json: catalog });
        }
        if (path === reconciliationPath) {
          assert(operation && (operation.state === 'unknown' || operation.state === 'blocked') && operation.phase === 'apply');
          assert.deepEqual(body, { operationId: operation.id });
          operation = { ...operation, state: 'running', phase: 'migrate', phaseState: 'pending', reasons: [], updatedAt: Date.now() };
          return route.fulfill({ json: { schema: 1, operation } });
        }
        assert.equal(path, applicationPath, 'An update must not orchestrate legacy stop/apply/start writes in the browser.');
        const parsed = parseNativeApplicationRequest(body);
        assert(parsed);
        assert.deepEqual(parsed.revisions, revisions, 'The application must carry the actual saved revision, including this click\'s draft.');
        assert.equal(parsed.deploy, true);
        if (rejectApplication) return route.fulfill({ status: 409, json: { error: 'native_chat_busy' } });
        assert(operation === null || operation.state === 'completed', 'A new application cannot overlap an accepted operation.');
        acceptedCount += 1;
        complete = false;
        const now = Date.now();
        operation = { schema: 1, id: parsed.operationId, state: 'running', phase: 'apply', phaseState: 'in-flight',
          revisions: { ...revisions }, createdAt: now, updatedAt: now, reasons: [] };
        if (scenario === 'continue-verified-apply' && acceptedCount === 1) operation = { ...operation, state: 'unknown', reasons: ['deployment_result_unknown'] };
        if (scenario === 'continue-pending-reload') operation = { ...operation, state: 'blocked', phaseState: 'confirmed', reasons: ['pending_reload'] };
        return scenario === 'lost-acknowledgement'
          ? route.fulfill({ status: 504, json: { error: 'operation_unknown' } })
          : route.fulfill({ json: { schema: 1, operation } });
      }
      assert.equal(request.method(), 'GET');
      if (path === '/api/chat/plans') return route.fulfill({ json: catalog });
      if (path === '/api/chat/personas') return route.fulfill({ json: { revision: revisions.personas,
        personas: [{ id: 'update-persona', name: 'Update Persona', identity: 'Synthetic update persona.', style: 'Brief.' }] } });
      if (path === '/api/chat/providers') return route.fulfill({ json: { revision: revisions.providers, providers: [{ id: 'update-provider',
        name: 'Update Provider', type: 'openai', baseUrl: 'https://update.invalid/v1', enabled: true, apiKeyConfigured: false,
        models: [{ id: 'update-model', name: 'Update Model' }] }] } });
      if (path === '/api/chat/model-capabilities') return route.fulfill({ json: { provider: 'update-provider', model: 'update-model',
        state: 'available', reasoningEfforts: ['off', 'high'], missingReasons: [] } });
      if (path === '/api/chat/deployment') return route.fulfill({ json: { revision: revisions.deployment, deployment: {
        namespace: 'update-fixture', target: null, modelSettings: null } } });
      if (path === '/api/chat/runtime') return route.fulfill({ json: { state: !operation || operation.state === 'completed' ? 'running' : 'stopped',
        canStart: operation !== null && operation.state !== 'completed', canApplyDeployment: operation !== null && operation.state !== 'completed',
        chatReady: !operation || operation.state === 'completed', protocolConnected: true, configurationIssues: [], missingReasons: [], lastError: null,
        revisions, activeRevisions, sessionMigration: { eligible: true, availability: 'requires-preview', requiresPreview: true, missingReasons: [] } } });
      assert.equal(path, applicationPath);
      if (url.searchParams.has('id')) {
        const id = url.searchParams.get('id');
        if (!operation || id !== operation.id) return route.fulfill({ json: { schema: 1, operation: null } });
        operationReads.push(operation.id);
        if (scenario === 'continue-verified-apply' && !deploymentAdvanced) {
          // autoPrepare changed the saved deployment after the original acknowledgement.
          revisions = { ...revisions, deployment: revision('auto-prepared-deployment') };
          operation = { ...operation, revisions: { ...revisions } };
          deploymentAdvanced = true;
        }
      }
      if (operation && complete) {
        operation = { ...operation, state: 'completed', phase: 'start', phaseState: 'confirmed', updatedAt: Date.now() };
        activeRevisions = { ...revisions };
      }
      return route.fulfill({ json: { schema: 1, operation } });
    };
    await page.route(matches, handler);
    try {
      await page.reload();
      await navigateConsolePage(page, 'model');
      const editor = page.locator('#native-plan-editor');
      const update = page.locator('#native-plan-update');
      await editor.getByRole('textbox', { name: '方案名称', exact: true }).waitFor();
      if (scenario === 'draft' || scenario === 'save-conflict') {
        const catalogList = page.locator('[data-page="model"] section').filter({
          has: page.getByRole('heading', { name: '聊天方案', exact: true }),
        }).getByRole('list');
        await catalogList.getByRole('button', { name: /^Update Alternate/ }).click();
        await editor.getByRole('textbox', { name: '方案名称', exact: true }).fill('Update Draft In One Click');
        await editor.getByText('方案指令', { exact: true }).locator('xpath=ancestor::label[1]').locator('textarea').fill('Preserve this exact draft through one update.');
      }
      await editor.getByText('当前模型支持：off、high。', { exact: true }).waitFor();
      if (scenario === 'save-conflict') {
        const failedSave = page.waitForResponse(response => new URL(response.url()).pathname === '/api/chat/plans'
          && response.request().method() === 'POST');
        await update.click();
        assert.equal((await failedSave).status(), 409);
        await page.getByRole('alert').filter({ hasText: /其他窗口更新/ }).waitFor();
        assert.equal(writes.filter(write => write.path === applicationPath).length, 0);
        assert.equal(await editor.getByRole('textbox', { name: '方案名称', exact: true }).inputValue(), 'Update Draft In One Click');
        assertScopedWrites();
        continue;
      }
      const created = page.waitForResponse(response => new URL(response.url()).pathname === applicationPath
        && response.request().method() === 'POST');
      const observeResponse = () => page.waitForResponse(response => new URL(response.url()).pathname === applicationPath
        && new URL(response.url()).searchParams.get('id') === currentOperation()?.id && response.request().method() === 'GET');
      let observed = scenario === 'rejected' ? null : observeResponse();
      await update.click();
      assert.equal((await created).status(), scenario === 'rejected' ? 409 : scenario === 'lost-acknowledgement' ? 504 : 200);
      if (scenario === 'rejected') {
        // A definite refusal created no operation. The next click is new, explicit intent.
        await update.and(page.locator('button:enabled')).waitFor();
        assert.equal(await page.getByText('应用结果待核对', { exact: true }).count(), 0);
        assert.equal(writes.length, 1);
        rejectApplication = false;
        observed = observeResponse();
        await update.click();
      }
      assert(observed);
      await observed;
      if (continuation) {
        await update.filter({ hasText: '核对并继续更新' }).and(page.locator('button:enabled')).waitFor();
        assert.equal(await update.innerText(), '核对并继续更新');
        const continued = page.waitForResponse(response => new URL(response.url()).pathname === reconciliationPath
          && response.request().method() === 'POST');
        await update.click();
        assert.equal((await continued).status(), 200);
        assert.equal(currentOperation()?.phase, 'migrate');
        assert.equal(writes.filter(write => write.path === reconciliationPath).length, 1);
      }
      await update.and(page.locator('button:disabled')).waitFor();
      const secondObservation = observeResponse();
      await update.evaluate(element => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await secondObservation;
      const accepted = currentOperation();
      assert(accepted);
      assert(operationReads.length >= 2);
      assert(operationReads.every(id => id === accepted.id));
      assert.equal(writes.filter(write => write.path === applicationPath).length, scenario === 'rejected' ? 2 : 1);
      assert.equal(writes.filter(write => write.path === '/api/chat/plans').length, scenario === 'draft' ? 1 : 0);
      if (scenario === 'draft') {
        assert.equal(catalog.activePlanId, 'update-alternate');
        assert.equal(catalog.plans.find(plan => plan.id === catalog.activePlanId)?.instructions, 'Preserve this exact draft through one update.');
      }
      const refreshedDeployment = scenario === 'continue-verified-apply'
        ? page.waitForResponse(async response => new URL(response.url()).pathname === '/api/chat/deployment'
          && response.request().method() === 'GET' && (await response.json() as { revision?: string }).revision === revisions.deployment)
        : null;
      complete = true;
      if (refreshedDeployment) await refreshedDeployment;
      await update.and(page.locator('button:enabled')).waitFor();
      assert.equal(currentOperation()?.state, 'completed');
      assert.equal(writes.filter(write => write.path === reconciliationPath).length, continuation ? 1 : 0);
      if (scenario === 'continue-verified-apply') {
        const firstId = accepted.id;
        const nextCreated = page.waitForResponse(response => new URL(response.url()).pathname === applicationPath
          && response.request().method() === 'POST');
        const nextObserved = observeResponse();
        await update.click();
        assert.equal((await nextCreated).status(), 200);
        await nextObserved;
        assert.notEqual(currentOperation()?.id, firstId);
        assert.equal(writes.filter(write => write.path === applicationPath).length, 2);
        assert.equal(writes.filter(write => write.path === reconciliationPath).length, 1);
        assert.equal(writes.filter(write => write.path === '/api/chat/plans').length, 0);
        complete = true;
        await update.and(page.locator('button:enabled')).waitFor();
        assert.equal(currentOperation()?.state, 'completed');
      }
      assertScopedWrites();
    } finally {
      complete = true;
      await page.unroute(matches, handler);
      await page.reload();
    }
  }
}
