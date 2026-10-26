import assert from 'node:assert/strict';
import test from 'node:test';
import { chatRuntimeCanRecoverStoppedControl, chatRuntimeEngineReadiness, parseChatRuntimeStatus } from '../web/lib/chat-runtime.ts';
import { NATIVE_CONFIGURATION_REVISION_KEYS } from '../src/contracts/native-revisions.ts';

const revisions = Object.fromEntries(NATIVE_CONFIGURATION_REVISION_KEYS.map(key => [key, 'a'.repeat(64)]));
const stopped = { state: 'stopped', chatReady: false, canStart: true, canApplyDeployment: true, protocolConnected: true,
  revisions, activeRevisions: { ...revisions, providers: 'b'.repeat(64) }, configurationIssues: [], missingReasons: ['runtime_not_started'], lastError: null,
  lifecycleHooks: { manager: { pendingRaw: 0 }, chat: { pendingRaw: 0 } }, controlCommands: { pendingRaw: 0, inflight: 0 },
  host: null, execution: { metrics: null }, bootstrap: null, packages: [], modelExecutionVerified: false };

test('runtime stop recovery accepts quiescent stopped evidence with retained historical active revisions', () => {
  assert(chatRuntimeCanRecoverStoppedControl(stopped));
  for (const value of [{ ...stopped, state: 'running' }, { ...stopped, canApplyDeployment: false },
    { ...stopped, lifecycleHooks: { ...stopped.lifecycleHooks, chat: { pendingRaw: 1 } } },
    { ...stopped, controlCommands: { pendingRaw: 0, inflight: 1 } },
    { ...stopped, bootstrap: { state: 'unknown' } }, { ...stopped, packages: [{ state: 'unknown' }] },
    { ...stopped, lifecycleHooks: undefined }, { ...stopped, host: { pendingIngress: 1 } }]) {
    assert.equal(chatRuntimeCanRecoverStoppedControl(value), false);
  }
});

test('runtime readiness does not require a synthetic model call and preserves the actual execution field', () => {
  const ready = parseChatRuntimeStatus({ ...stopped, state: 'running', chatReady: true }); assert(ready);
  assert.equal(chatRuntimeEngineReadiness(ready), '已就绪');
  assert.equal(ready.modelExecutionVerified, false);
  assert.equal(chatRuntimeEngineReadiness(parseChatRuntimeStatus(stopped)), '未启动');
  assert.equal(chatRuntimeEngineReadiness(parseChatRuntimeStatus({ ...stopped, state: 'starting' })), '正在连接');
});
