import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilityLabel, chatReadinessLabel, featureLabel, featureStatusLabel, readDeclaredCapabilities } from '../web/lib/feature-labels.ts';

test('capability labels explain built-in actions without showing implementation IDs', () => {
  assert.equal(capabilityLabel('chat-plans'), '聊天方案');
  assert.equal(capabilityLabel('personas'), '人设');
  assert.equal(capabilityLabel('model-settings'), '模型设置');
  assert.equal(capabilityLabel('access-policy'), '访问范围');
  assert.equal(capabilityLabel('messaging.forward'), '合并转发');
  assert.equal(capabilityLabel('presentation.prepare'), '整理消息表达');
  assert.equal(capabilityLabel('agent.tools.delegate'), '委派含工具的会话');
  for (const unknown of ['constructor', '__proto__', 'private.extension.operation']) {
    assert.equal(capabilityLabel(unknown), '扩展能力');
  }
});

test('feature states use human descriptions without inventing success for unknown values', () => {
  assert.equal(featureStatusLabel('active'), '运行中');
  assert.equal(featureStatusLabel('installed'), '已登记');
  assert.equal(featureStatusLabel('unknown'), '状态待确认');
  assert.equal(featureStatusLabel('failed'), '发生故障');
  for (const unknown of ['constructor', 'toString', 'external-state']) {
    assert.equal(featureStatusLabel(unknown), '状态待确认');
  }
});

test('feature titles humanize the real relay and keep unknown implementation IDs folded', () => {
  assert.equal(featureLabel('agent-relay'), '聊天消息转接');
  assert.equal(featureLabel('agent-relay', 'agent-relay'), '聊天消息转接');
  assert.equal(featureLabel('extension', '运维命名的功能'), '运维命名的功能');
  for (const identifier of ['constructor', '__proto__', 'private.extension']) {
    assert.equal(featureLabel(identifier), '扩展功能');
    assert.equal(featureLabel(identifier, identifier), '扩展功能');
    assert.equal(featureLabel(identifier, ` ${identifier} `), '扩展功能');
    assert.equal(featureLabel(identifier, '  '), '扩展功能');
  }
});

test('readiness alone never diagnoses missing modules, installation or authorization', () => {
  assert.equal(chatReadinessLabel(true), '聊天当前已就绪');
  assert.equal(chatReadinessLabel(false), '聊天当前未就绪');
  assert.equal(chatReadinessLabel(null), '聊天就绪状态待确认');
  for (const readiness of [true, false, null]) assert.doesNotMatch(chatReadinessLabel(readiness), /未接入|未安装|已授权|模块缺失/);
});

test('declared capability projection preserves custom actions without implying authorization', () => {
  const input = ['review.work', 'messaging.send'];
  const result = readDeclaredCapabilities(input);
  assert.deepEqual(result, input);
  assert.notEqual(result, input);
  assert.equal(Object.isFrozen(result), true);
  input.push('agent.cancel');
  assert.deepEqual(result, ['review.work', 'messaging.send']);
});

test('missing or invalid capability declarations are unknown, not an empty or authorized inventory', () => {
  for (const value of [undefined, null, {}, ['review.work', 1], ['review.work', 'review.work'],
    ['__proto__'], ['bad\nname'], ['a'.repeat(101)], new Array(1), Array.from({ length: 4097 }, () => 'review.work')]) {
    assert.equal(readDeclaredCapabilities(value), null);
  }
  assert.deepEqual(readDeclaredCapabilities([]), []);
  assert.deepEqual(readDeclaredCapabilities(['constructor', 'review.work']), ['constructor', 'review.work']);
});
