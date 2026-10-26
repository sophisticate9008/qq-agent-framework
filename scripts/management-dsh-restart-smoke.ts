import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Page, Route } from 'playwright';
import { parseNativeDshRestartRequest, type NativeDshRestartOperation } from '../src/contracts/native-dsh-restart.ts';
import { NATIVE_CONFIGURATION_REVISION_KEYS, type NativeConfigurationRevisions } from '../src/contracts/native-revisions.ts';
import { isRecord } from '../src/core/values.ts';
import { navigateConsolePage } from './browser-navigation-smoke.ts';

const path = '/api/chat/dsh/restart';

export async function exerciseDshRestart(page: Page, requests: readonly { readonly method: string; readonly pathname: string }[]): Promise<void> {
  for (const scenario of ['running', 'stopped', 'lost-acknowledgement', 'not-received', 'blocked'] as const) {
    console.log('DSH restart regression: ' + scenario);
    const start = requests.length;
    const revisions = Object.fromEntries(NATIVE_CONFIGURATION_REVISION_KEYS.map(key =>
      [key, createHash('sha256').update(key).digest('hex')])) as NativeConfigurationRevisions;
    const wasRunning = scenario !== 'stopped';
    let operation: NativeDshRestartOperation | null = null;
    const currentOperation = (): NativeDshRestartOperation | null => operation;
    let complete = false;
    let restarted = 0;
    let reconciled = 0;
    const reads: string[] = [];
    const ids: string[] = [];
    const matches = (url: URL) => [path, path + '/reconcile', '/api/chat/runtime', '/api/chat/application'].includes(url.pathname);
    const response = () => ({ schema: 1, available: true, missingReasons: [], operation });
    const handler = async (route: Route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'POST') {
        if (url.pathname === path + '/reconcile') {
          if (scenario === 'not-received' && operation === null) {
            assert.deepEqual(request.postDataJSON(), { operationId: ids.at(-1) });
            reconciled++;
            return route.fulfill({ status: 409, json: { error: 'dsh_restart_not_received' } });
          }
          assert(operation && operation.state === 'unknown');
          assert.deepEqual(request.postDataJSON(), { operationId: operation.id });
          reconciled++;
          operation = { ...operation, state: 'running', phase: 'verify', phaseState: 'pending', reasons: [], updatedAt: operation.updatedAt + 1 };
          return route.fulfill({ json: response() });
        }
        assert.equal(url.pathname, path, 'Restart controls must not create an application or orchestrate legacy writes.');
        const body = parseNativeDshRestartRequest(request.postDataJSON());
        assert(body);
        assert.deepEqual(body.revisions, revisions);
        assert(operation === null || operation.state === 'blocked', 'An unsettled restart must retain its original identity.');
        assert(!ids.includes(body.operationId));
        ids.push(body.operationId); restarted++;
        if (scenario === 'not-received' && restarted === 1) {
          return route.fulfill({ status: 504, json: { error: 'dsh_restart_result_unknown' } });
        }
        const at = Date.now();
        operation = { schema: 1, id: body.operationId, revisions, state: 'running', phase: 'restart', phaseState: 'in-flight',
          wasRunning, restartExecutionVerified: scenario !== 'lost-acknowledgement', createdAt: at, updatedAt: at, reasons: [] };
        if (scenario === 'lost-acknowledgement') operation = { ...operation, state: 'unknown', reasons: ['DSH_RESTART_PHASE_UNKNOWN'] };
        if (scenario === 'blocked' && restarted === 1) operation = { ...operation, state: 'blocked', phase: 'stop', phaseState: 'pending', reasons: ['DSH_RESTART_NOT_QUIESCENT'] };
        return scenario === 'lost-acknowledgement'
          ? route.fulfill({ status: 504, json: { error: 'dsh_restart_result_unknown' } })
          : route.fulfill({ json: response() });
      }
      assert.equal(request.method(), 'GET');
      if (url.pathname === '/api/chat/application') return route.fulfill({ json: { schema: 1, operation: null } });
      if (url.pathname === '/api/chat/runtime') return route.fulfill({ json: { state: wasRunning && !operation || operation?.state === 'completed' && wasRunning ? 'running' : 'stopped',
        canStart: !wasRunning, canApplyDeployment: true, chatReady: wasRunning && !operation || operation?.state === 'completed' && wasRunning,
        revisions, activeRevisions: revisions, missingReasons: [], configurationIssues: [], lastError: null } });
      assert.equal(url.pathname, path);
      if (url.searchParams.has('id')) {
        if (!operation || url.searchParams.get('id') !== operation.id) return route.fulfill({ json: { ...response(), operation: null } });
        reads.push(url.searchParams.get('id') ?? '');
      }
      if (operation && complete) operation = { ...operation, state: 'completed', phase: 'restore', phaseState: 'confirmed', reasons: [], updatedAt: Date.now() + 2 };
      return route.fulfill({ json: response() });
    };
    await page.route(matches, handler);
    try {
      await page.reload();
      await navigateConsolePage(page, 'adapters');
      const control = page.locator('#dsh-deployment [data-dsh-restart]');
      const restart = control.getByRole('button', { name: '重启 DSH', exact: true });
      await restart.and(page.locator('button:enabled')).waitFor();
      const absenceRead = scenario === 'not-received' ? page.waitForResponse(value => new URL(value.url()).pathname === path
        && new URL(value.url()).searchParams.get('id') === ids[0] && value.request().method() === 'GET') : null;
      const post = page.waitForResponse(value => new URL(value.url()).pathname === path && value.request().method() === 'POST');
      await restart.click();
      assert.equal((await post).status(), scenario === 'lost-acknowledgement' || scenario === 'not-received' ? 504 : 200);
      assert.equal(restarted, 1);
      if (scenario === 'blocked') {
        await control.getByText('本次重启未继续，请刷新状态后处理条件。', { exact: true }).waitFor();
        await restart.and(page.locator('button:enabled')).waitFor();
        assert.equal(restarted, 1);
        await restart.click();
      }
      if (scenario === 'not-received') {
        assert(absenceRead);
        assert.equal((await (await absenceRead).json() as { operation: unknown }).operation, null);
        const restore = control.getByRole('button', { name: '恢复原重启', exact: true });
        await restore.and(page.locator('button:enabled')).waitFor();
        assert.equal(await restart.count(), 0, 'An ordinary null read cannot unlock an uncertain restart.');
        const checked = page.waitForResponse(value => new URL(value.url()).pathname === path + '/reconcile'
          && value.request().method() === 'POST');
        await restore.click();
        assert.equal((await checked).status(), 409);
        await restart.and(page.locator('button:enabled')).waitFor();
        assert.equal(restarted, 1);
        await restart.click();
      }
      if (scenario === 'lost-acknowledgement') {
        const original = currentOperation()?.id;
        const restore = control.getByRole('button', { name: '恢复原重启', exact: true });
        await restore.and(page.locator('button:enabled')).waitFor();
        const checked = page.waitForResponse(value => new URL(value.url()).pathname === path + '/reconcile' && value.request().method() === 'POST');
        await restore.click();
        assert.equal((await checked).status(), 200);
        assert.equal(currentOperation()?.id, original);
        assert.equal(restarted, 1);
        assert.equal(reconciled, 1);
      }
      await control.getByRole('button', { name: /正在重启 DSH|正在等待 DSH 就绪/ }).and(page.locator('button:disabled')).waitFor();
      const observed = page.waitForResponse(value => new URL(value.url()).pathname === path
        && new URL(value.url()).searchParams.get('id') === currentOperation()?.id && value.request().method() === 'GET');
      const read = control.getByRole('button', { name: '读取重启状态', exact: true });
      await read.click(); await observed;
      assert(reads.length > 0 && reads.every(id => ids.includes(id)));
      assert.equal(restarted, scenario === 'blocked' || scenario === 'not-received' ? 2 : 1);
      complete = true;
      await read.click();
      await control.getByText(scenario === 'lost-acknowledgement' ? 'DSH 可用，维护已完成；原重启回执未确认。'
        : 'DSH 已重启，维护已完成。', { exact: true }).waitFor();
      const runtime: unknown = await page.evaluate(async () => (await fetch('/api/chat/runtime')).json());
      assert(isRecord(runtime));
      assert.equal(runtime.state, wasRunning ? 'running' : 'stopped', 'Completed maintenance must reflect actual runtime state, not infer it from wasRunning.');
      assert.equal(await control.getByText(/聊天已恢复|聊天保持停止/).count(), 0);
      assert.equal(reconciled, scenario === 'lost-acknowledgement' || scenario === 'not-received' ? 1 : 0);
      assert(requests.slice(start).filter(request => request.method === 'POST').every(request =>
        request.pathname === path || request.pathname === path + '/reconcile'), 'Maintenance never saves drafts, reapplies configuration, or requests a model from the browser.');
    } finally {
      complete = true;
      await page.unroute(matches, handler);
      await page.reload();
    }
  }
}
