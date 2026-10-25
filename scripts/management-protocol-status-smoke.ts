import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { NATIVE_CONFIGURATION_REVISION_KEYS } from '../src/contracts/native-revisions.ts';
import type { OneBotConnectionSnapshot } from '../web/lib/onebot-connection-presentation.ts';
import { navigateConsolePage } from './browser-navigation-smoke.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function exerciseProtocolConnectionDiagnostics(page: Page, requests: readonly { readonly method: string }[], base: unknown): Promise<void> {
  assert(isRecord(base) && isRecord(base.adapters) && isRecord(base.adapters.onebotWs));
  const adapters = base.adapters;
  const websocket = adapters.onebotWs;
  assert(isRecord(websocket));
  const revisions = Object.fromEntries(NATIVE_CONFIGURATION_REVISION_KEYS.map(key => [key, 'a'.repeat(64)]));
  let running = true;
  let connection: OneBotConnectionSnapshot = { state: 'connected', selfId: '410001', lastError: 'onebot_ws_callback_failed',
    received: 92, dropped: 5, chatReady: true };
  const postsBefore = requests.filter(request => request.method === 'POST').length;
  await page.route('**/api/chat/adapters', route => route.request().method() === 'GET' ? route.fulfill({ json: {
    ...base, adapters: { ...adapters, onebotWs: { ...websocket,
      enabled: true, endpoint: 'ws://127.0.0.1:3001', secretConfigured: true } },
    status: { assembled: true, running, applyAvailable: true }, connection,
  } }) : route.continue());
  await page.route('**/api/chat/runtime', route => route.request().method() === 'GET' ? route.fulfill({ json: {
    state: running ? 'running' : 'stopped', chatReady: running, protocolConnected: connection.state === 'connected',
    canStart: false, canApplyDeployment: false, missingReasons: running ? [] : ['runtime_not_started'], configurationIssues: [],
    revisions, activeRevisions: running ? revisions : null, lastError: null,
  } }) : route.continue());
  try {
    for (const sample of [
      { running: true, state: 'connected', error: 'onebot_ws_callback_failed', category: 'processing' },
      { running: true, state: 'connected', error: 'onebot_ws_connection_failed', category: 'transport' },
      { running: false, state: 'error', error: 'onebot_ws_auth_rejected', category: 'authentication' },
      { running: false, state: 'connected', error: null, category: null },
    ] as const) {
      running = sample.running;
      connection = { ...connection, state: sample.state, selfId: sample.state === 'connected' ? '410001' : null,
        chatReady: running, lastError: sample.error };
      await navigateConsolePage(page, 'overview');
      await navigateConsolePage(page, 'adapters');
      const panel = page.locator('#adapter-runtime');
      await panel.locator(`[data-protocol-connection-state="${sample.state}"]`).waitFor();
      await panel.getByText('接收计数 92；丢弃计数 5', { exact: true }).waitFor();
      const diagnostic = panel.locator('[data-protocol-diagnostic]');
      if (sample.category) {
        await panel.locator(`[data-protocol-diagnostic="${sample.category}"]`).waitFor();
        assert.equal(await diagnostic.locator('code').textContent(), sample.error);
      } else assert.equal(await diagnostic.count(), 0);
      if (sample.state === 'connected') {
        await panel.getByText('WebSocket 已连接', { exact: true }).waitFor();
        if (sample.category) assert.doesNotMatch(await diagnostic.innerText(), /协议连接失败|检查.*密钥|重新连接|重试连接/);
        await page.waitForFunction(expected => {
          const button = [...document.querySelectorAll<HTMLButtonElement>('#adapter-runtime button')]
            .find(element => element.textContent?.trim() === '重新连接 WebSocket');
          return button?.disabled === expected;
        }, running);
        assert.equal(await panel.getByRole('button', { name: '断开 WebSocket', exact: true }).isDisabled(), running);
      } else {
        await panel.getByText('WebSocket 连接异常', { exact: true }).waitFor();
        assert.match(await diagnostic.innerText(), /WebSocket 鉴权.*WebSocket 服务的专用密钥/);
      }
    }
    assert.equal(requests.filter(request => request.method === 'POST').length, postsBefore);
  } finally {
    await page.unroute('**/api/chat/adapters');
    await page.unroute('**/api/chat/runtime');
    await navigateConsolePage(page, 'overview');
  }
}
