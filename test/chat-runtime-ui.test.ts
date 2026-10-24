import assert from 'node:assert/strict';
import test from 'node:test';
import { chatRuntimeBadge, chatRuntimeReason, chatRuntimeVisibleReasons, newChatConfigurationId, parseChatAuthorization, parseChatRuntimeStatus } from '../web/lib/chat-runtime.ts';

const revisions = Object.fromEntries(['plans', 'personas', 'access', 'adapters', 'providers', 'authorization', 'deployment'].map(key => [key, '0'.repeat(64)]));
const status = { state: 'stopped', canStart: true, configurationIssues: [], chatReady: false, protocolConnected: false,
  missingReasons: ['runtime_not_started', 'onebot_protocol_not_connected'], revisions, activeRevisions: null, lastError: null };

test('runtime UI separates startup prerequisites from expected stopped diagnostics', () => {
  const parsed = parseChatRuntimeStatus(status);
  assert(parsed?.canStart);
  assert.deepEqual(parsed.blockingReasons, []);
  assert.deepEqual(parsed.missingReasons, status.missingReasons);
  assert.equal(parseChatRuntimeStatus({ ...status, chatReady: true }), null);
  assert.equal(parseChatRuntimeStatus({ ...status, revisions: {} }), null);
  assert.equal(parseChatRuntimeStatus({ ...status, canStart: 'true' }), null);
  assert.equal(parseChatRuntimeStatus({ ...status, activeRevisions: { ...revisions, access: '1'.repeat(64) } })?.configurationChanged, true);
  assert.equal(chatRuntimeReason('explicit_authorization_missing').page, 'access');
  assert.equal(chatRuntimeReason('unknown_private_path_or_key').text.includes('unknown_private_path_or_key'), false);
  assert.match(chatRuntimeReason('dsh_credential_file_source_unverified').text, /环境变量/);
  assert.match(chatRuntimeReason('dsh_credential_target_unverified').text, /位置/);
  assert.equal(parseChatRuntimeStatus({ ...status, canApplyDeployment: true })?.canApplyDeployment, true);
  assert.equal(parsed.canApplyDeployment, false);
});

test('authorization UI refuses duplicate scopes, unsafe numbers and implicitly coerced quotas', () => {
  const grant = { conversationId: 'group:123', submitUses: 100, sendUses: 200, expiresAt: null };
  const authorization = { revision: '0'.repeat(64), version: 'new', grants: [grant] };
  assert.deepEqual(parseChatAuthorization(authorization)?.grants, [grant]);
  for (const patch of [{ submitUses: '100' }, { sendUses: -1 }, { expiresAt: -1 }, { conversationId: 'private:9999999999999999' }]) {
    assert.equal(parseChatAuthorization({ ...authorization, grants: [{ ...grant, ...patch }] }), null);
  }
  assert.equal(parseChatAuthorization({ ...authorization, grants: [grant, grant] }), null);
});

test('configuration IDs use getRandomValues on non-secure local-network pages without randomUUID', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  assert(descriptor);
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
    getRandomValues(bytes: Uint8Array) { bytes.fill(171); return bytes; }
  } });
  try { assert.equal(newChatConfigurationId(), 'ab'.repeat(16)); }
  finally { Object.defineProperty(globalThis, 'crypto', descriptor); }
});

test('runtime UI does not describe budget exhaustion or follow failure as a protocol outage', () => {
  for (const [reason, badge, page] of [
    ['authorization_budget_unavailable', '授权需要处理', 'access'],
    ['agent_follow_unavailable', '引擎回复连接中断', 'adapters'],
    ['host_not_ready', '聊天暂不可用', 'adapters'],
    ['configuration_changed', '设置等待应用', 'adapters'],
  ]) {
    const parsed = parseChatRuntimeStatus({ ...status, state: 'running', canStart: false,
      protocolConnected: true, missingReasons: [reason], activeRevisions: { ...revisions, access: '1'.repeat(64) },
      modelExecutionVerified: false, readinessScope: 'verified-protocol-authenticated-dsh-and-assembled-host' });
    assert(parsed);
    if (reason !== 'configuration_changed') {
      const current = { ...parsed, configurationChanged: false };
      assert.equal(chatRuntimeBadge(current), badge);
    } else assert.equal(chatRuntimeBadge(parsed), badge);
    assert.deepEqual(chatRuntimeVisibleReasons(parsed), [reason]);
    assert.equal(chatRuntimeReason(reason).page, page);
    assert.equal(parsed.modelExecutionVerified, false);
  }
  const stopped = parseChatRuntimeStatus(status);
  assert(stopped);
  assert.deepEqual(chatRuntimeVisibleReasons(stopped), []);
  assert.equal(chatRuntimeBadge(stopped), '聊天已停止');
  assert.equal(chatRuntimeBadge({ ...stopped, state: 'running', protocolConnected: false }), '协议连接中断');
});
