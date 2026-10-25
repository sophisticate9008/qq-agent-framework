import assert from 'node:assert/strict';
import test from 'node:test';
import { presentOneBotConnection, type OneBotConnectionSnapshot } from '../web/lib/onebot-connection-presentation.ts';

const connected: OneBotConnectionSnapshot = { state: 'connected', selfId: '12345', lastError: null,
  received: 92, dropped: 5, chatReady: true };

test('connected WebSocket with a failed inbound callback keeps its connection status and processing evidence', () => {
  const input = { ...connected, lastError: 'onebot_ws_callback_failed' };
  const view = presentOneBotConnection(input);
  assert.equal(view.statusLabel, 'WebSocket 已连接');
  assert.equal(view.statusTone, 'success');
  assert.equal(view.diagnostic?.category, 'processing');
  assert.equal(view.diagnostic?.tone, 'warning');
  assert.equal(view.diagnostic?.code, 'onebot_ws_callback_failed');
  assert.match(view.diagnostic?.message ?? '', /保持连接.*入站事件处理失败/);
  assert.match(view.diagnostic?.message ?? '', /目标会话诊断与执行记录/);
  assert.doesNotMatch(view.diagnostic?.message ?? '', /重新连接|重连|密钥|连接失败|连接中断/);
  assert.deepEqual(input, { ...connected, lastError: 'onebot_ws_callback_failed' });
});

test('a past transport or authentication error cannot override a currently connected WebSocket', () => {
  for (const lastError of ['onebot_ws_connection_failed', 'onebot_ws_pong_timeout', 'onebot_ws_auth_rejected']) {
    const view = presentOneBotConnection({ ...connected, lastError });
    assert.equal(view.statusTone, 'success');
    assert.equal(view.statusLabel, 'WebSocket 已连接');
    assert.equal(view.diagnostic?.title, '历史连接诊断');
    assert.equal(view.diagnostic?.tone, 'neutral');
    assert.equal(view.diagnostic?.code, lastError);
    assert.doesNotMatch(view.diagnostic?.message ?? '', /重连|重新连接|密钥|鉴权.*拒绝|连接失败/);
  }
});

test('a current authentication rejection identifies the WebSocket credential without diagnosing HTTP or model failures', () => {
  const view = presentOneBotConnection({ ...connected, state: 'error', selfId: null,
    chatReady: false, lastError: 'onebot_ws_auth_rejected' });
  assert.equal(view.statusLabel, 'WebSocket 连接异常');
  assert.equal(view.statusTone, 'warning');
  assert.equal(view.diagnostic?.category, 'authentication');
  assert.equal(view.diagnostic?.tone, 'error');
  assert.match(view.diagnostic?.message ?? '', /WebSocket 鉴权.*WebSocket 服务的专用密钥/);
  assert.doesNotMatch(view.diagnostic?.message ?? '', /HTTP|管理员令牌|模型/);
});

test('inbound timeouts remain processing diagnostics while the actual transport state is shown independently', () => {
  for (const state of ['connected', 'reconnecting', 'error'] as const) {
    const view = presentOneBotConnection({ ...connected, state, chatReady: false, lastError: 'onebot_ws_callback_timeout' });
    assert.equal(view.diagnostic?.category, 'processing');
    assert.match(view.diagnostic?.message ?? '', /入站事件处理超时/);
    assert.doesNotMatch(view.diagnostic?.message ?? '', /密钥|地址|重连/);
    assert.equal(view.statusTone === 'success', state === 'connected');
  }
});

test('unknown diagnostics retain a bounded machine code and never expose arbitrary upstream text', () => {
  const future = presentOneBotConnection({ ...connected, lastError: 'onebot_ws_future_error' });
  assert.equal(future.diagnostic?.category, 'unknown');
  assert.equal(future.diagnostic?.code, 'onebot_ws_future_error');
  const untrusted = presentOneBotConnection({ ...connected, lastError: 'Authorization: Bearer private-fixture-value' });
  assert.equal(untrusted.diagnostic?.code, null);
  assert.doesNotMatch(JSON.stringify(untrusted), /private-fixture-value|Authorization/);
  assert.equal(presentOneBotConnection(connected).diagnostic, null);
});
