import assert from 'node:assert/strict';
import test from 'node:test';
import { chatRuntimeBadge, chatRuntimeLastError, chatRuntimeReason, chatRuntimeVisibleReasons, newChatConfigurationId, parseChatAuthorization, parseChatRuntimeStatus } from '../web/lib/chat-runtime.ts';

const revisions = Object.fromEntries(['plans', 'personas', 'access', 'adapters', 'providers', 'authorization', 'deployment'].map(key => [key, '0'.repeat(64)]));
const status = { state: 'stopped', canStart: true, configurationIssues: [], chatReady: false, protocolConnected: false,
  missingReasons: ['runtime_not_started', 'onebot_protocol_not_connected'], revisions, activeRevisions: null, lastError: null };

test('runtime errors explain missing plugins and retained sessions without revealing raw diagnostics', () => {
  assert.match(chatRuntimeLastError('NATIVE_CHAT_CORRELATION_PLUGIN_UNAVAILABLE'), /请求关联插件.*安装.*加载.*认证/);
  assert.match(chatRuntimeLastError('NATIVE_CHAT_SESSION_CONFIGURATION_CONFLICT'), /保留上下文/);
  assert.match(chatRuntimeLastError('NATIVE_CHAT_PERSONA_VERSION_MIGRATION_REQUIRED'), /显式迁移/);
  assert.match(chatRuntimeLastError('NATIVE_CHAT_STOP_UNKNOWN'), /不要重复启动/);
  assert.match(chatRuntimeReason('execution_controller_unavailable').text, /存储.*不要重复/);
  const privateDiagnostic = '/private/operator/token=do-not-display';
  assert.equal(chatRuntimeLastError(privateDiagnostic), chatRuntimeLastError('UNKNOWN'));
  assert.equal(chatRuntimeLastError(privateDiagnostic).includes(privateDiagnostic), false);
  for (const inherited of ['constructor', 'toString', '__proto__']) {
    assert.equal(chatRuntimeLastError(inherited), chatRuntimeLastError('UNKNOWN'));
    assert.deepEqual(chatRuntimeReason(inherited), chatRuntimeReason('UNKNOWN'));
  }
});

test('runtime UI separates startup prerequisites from expected stopped diagnostics', () => {
  const parsed = parseChatRuntimeStatus(status);
  assert(parsed?.canStart);
  assert.deepEqual(parsed.blockingReasons, []);
  assert.deepEqual(parsed.missingReasons, status.missingReasons);
  assert.equal(parseChatRuntimeStatus({ ...status, chatReady: true }), null);
  assert.equal(parseChatRuntimeStatus({ ...status, revisions: {} }), null);
  assert.equal(parseChatRuntimeStatus({ ...status, canStart: 'true' }), null);
  assert.equal(parseChatRuntimeStatus({ ...status, activeRevisions: { ...revisions, access: '1'.repeat(64) } })?.configurationChanged, true);
  assert.equal(chatRuntimeReason('explicit_authorization_missing').page, 'security');
  assert.equal(chatRuntimeReason('unknown_private_path_or_key').text.includes('unknown_private_path_or_key'), false);
  assert.match(chatRuntimeReason('dsh_credential_file_source_unverified').text, /环境变量/);
  assert.match(chatRuntimeReason('dsh_credential_target_unverified').text, /位置/);
  assert.equal(parseChatRuntimeStatus({ ...status, canApplyDeployment: true })?.canApplyDeployment, true);
  assert.equal(parsed.canApplyDeployment, false);
});

test('running runtime does not repeat stopped startup guidance beside a real authorization problem', () => {
  const running = parseChatRuntimeStatus({ ...status, state: 'running', canStart: false,
    missingReasons: ['authorization_budget_unavailable', 'runtime_not_started'] });
  assert(running);
  assert.deepEqual(chatRuntimeVisibleReasons(running), ['authorization_budget_unavailable']);
  const failed = parseChatRuntimeStatus({ ...status, state: 'error', canStart: false });
  assert(failed);
  assert(chatRuntimeVisibleReasons(failed).includes('runtime_not_started'));
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
    ['authorization_budget_unavailable', '授权需要处理', 'security'],
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
  assert.deepEqual(chatRuntimeVisibleReasons(stopped), ['runtime_not_started']);
  assert.equal(chatRuntimeBadge(stopped), '聊天已停止');
  assert.equal(chatRuntimeBadge({ ...stopped, state: 'running', protocolConnected: false }), '协议连接中断');
});

test('execution revision and cancellation grants remain explicit and do not silently upgrade legacy authorization', () => {
  const executionRevisions = { ...revisions, execution: '2'.repeat(64) };
  assert.deepEqual(parseChatRuntimeStatus({ ...status, revisions: executionRevisions })?.revisions, executionRevisions);
  assert.equal(parseChatRuntimeStatus({ ...status, revisions: { ...executionRevisions, untrusted: '3'.repeat(64) } }), null);
  assert.equal(parseChatRuntimeStatus({ ...status, revisions: { ...executionRevisions, execution: 'invalid' } }), null);
  assert.equal(parseChatRuntimeStatus({ ...status, revisions: executionRevisions, activeRevisions: {
    ...executionRevisions, execution: '3'.repeat(64),
  } })?.configurationChanged, true);
  const grant = { conversationId: 'group:123', submitUses: 100, sendUses: 200, expiresAt: null };
  const legacy = parseChatAuthorization({ revision: '0'.repeat(64), version: 'old', grants: [grant] });
  assert(legacy);
  assert.equal(Object.hasOwn(legacy.grants[0], 'cancelUses'), false);
  assert.equal(legacy.cancelAvailable, undefined);
  const authorized = parseChatAuthorization({ revision: '0'.repeat(64), version: 'new', cancelAvailable: true,
    grants: [{ ...grant, cancelUses: 3 }] });
  assert.equal(authorized?.grants[0].cancelUses, 3);
  for (const cancelUses of [-1, '3', 1_000_001]) {
    assert.equal(parseChatAuthorization({ revision: '0'.repeat(64), version: 'bad', grants: [{ ...grant, cancelUses }] }), null);
  }
});


test('runtime UI trusts verified dependency impact instead of requiring restart for unrelated catalog revisions', () => {
  const impact = { schema: 1, state: 'verified', action: 'none', canContinue: true, sessionMigrationRequired: false,
    immediatePolicyCheck: false, changedDependencies: [], changedRevisions: ['personas'], ignoredCatalogRevisions: ['personas'],
    withdrawnConversations: [], bindingsCompared: false, fingerprints: { previous: 'a'.repeat(64), next: 'a'.repeat(64) }, reasons: [] };
  const value = { ...status, state: 'running', chatReady: true, activeRevisions: { ...revisions, personas: '1'.repeat(64) }, configurationImpact: impact };
  assert.equal(parseChatRuntimeStatus(value)?.configurationChanged, false);
  assert.equal(parseChatRuntimeStatus(value)?.configurationImpact?.canContinue, true);
  const changed = { ...impact, action: 'migrate', canContinue: false, sessionMigrationRequired: true,
    changedDependencies: ['definition'], ignoredCatalogRevisions: [], fingerprints: { previous: 'a'.repeat(64), next: 'b'.repeat(64) } };
  assert.equal(parseChatRuntimeStatus({ ...value, chatReady: false, configurationImpact: changed })?.configurationChanged, true);
  assert.equal(parseChatRuntimeStatus({ ...value, configurationImpact: { ...impact, canContinue: 'true' } }), null);
});
