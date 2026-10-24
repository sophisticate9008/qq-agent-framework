import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCurrentPageVisibility, buildWorkspaceSearchTargets, searchWorkspaceTargets, workspacePageTargets } from '../web/lib/workspace-search.ts';

const configuration = { groups: [
  { id: 'connection', title: '模型连接', category: 'model', fields: [
    { id: 'provider', label: '模型提供方', value: 'never-index-this-provider' },
    { id: 'credential', label: '模型访问令牌', value: 'never-index-this-secret' },
  ] },
] };
const settings = {
  gateway: { values: { budgetEnabled: false, timeoutMs: 60_000 } },
  admin: { values: { host: '127.0.0.1', port: 3210 } },
};

test('empty search returns exactly ten page shortcuts', () => {
  const results = searchWorkspaceTargets(workspacePageTargets, '  ');
  assert.equal(results.length, 10);
  assert(results.every(target => target.kind === 'page'));
  assert.equal(new Set(results.map(target => target.page)).size, 10);
  assert(results.some(target => target.page === 'providers' && target.title === '模型提供方'));
});

test('search matches normalized metadata without indexing values', () => {
  const targets = buildWorkspaceSearchTargets({ configuration, settings });
  assert.deepEqual(searchWorkspaceTargets(targets, '模型 提供').filter(target => target.kind === 'field').map(target => target.title), ['模型提供方']);
  for (const value of ['never-index-this-provider', 'never-index-this-secret', '127.0.0.1']) {
    assert.equal(searchWorkspaceTargets(targets, value).length, 0);
  }
});

test('native chat plan and persona management remain discoverable without a running host', () => {
  const targets = buildWorkspaceSearchTargets({ configuration, settings, runtimeStatus: { runtimeConnected: false } });
  assert.equal(searchWorkspaceTargets(targets, '聊天方案').some(target => target.page === 'model'), true);
  assert.equal(searchWorkspaceTargets(targets, '人设库').some(target => target.page === 'persona'), true);
  assert.equal(searchWorkspaceTargets(targets, '模型提供方').some(target => target.page === 'providers'), true);
});

test('adapter providers and renamed chat plans are discoverable from any page', () => {
  for (const query of ['DSH', 'OneBot', 'WebSocket', 'WSS', 'HTTP', 'webhook', '协议 接入']) {
    assert.deepEqual(searchWorkspaceTargets(workspacePageTargets, query).map(target => target.page), ['adapters']);
  }
  assert.deepEqual(searchWorkspaceTargets(workspacePageTargets, '模型 回复').map(target => target.page), ['model']);
});

test('central provider aliases and per-conversation context settings find their own pages', () => {
  for (const query of ['模型 提供方', 'provider', 'OpenAI', 'Anthropic', 'API key', '服务商', '密钥']) {
    assert.deepEqual(searchWorkspaceTargets(workspacePageTargets, query).map(target => target.page), ['providers']);
  }
  for (const query of ['群聊上下文', '私聊上下文']) {
    assert.deepEqual(searchWorkspaceTargets(workspacePageTargets, query).map(target => target.page), ['model']);
  }
});

test('activity aliases find sessions and usage without indexing records', () => {
  assert.deepEqual(searchWorkspaceTargets(workspacePageTargets, 'TOKEN 费用').map(target => target.page), ['usage']);
  assert.deepEqual(searchWorkspaceTargets(workspacePageTargets, 'session 私聊').map(target => target.page), ['sessions']);
  assert.equal(searchWorkspaceTargets(workspacePageTargets, 'private:12345').length, 0);
});

test('usage sections are indexed only when native runtime reports connected', () => {
  const sources = { configuration, settings };
  const connected = buildWorkspaceSearchTargets({ ...sources, runtimeStatus: { runtimeConnected: true } });
  const disconnected = buildWorkspaceSearchTargets({ ...sources, runtimeStatus: { runtimeConnected: false } });
  assert(searchWorkspaceTargets(connected, '逐轮').length > 0);
  assert.equal(searchWorkspaceTargets(disconnected, '逐轮').length, 0);
});

test('disabled budgets keep the switch but hide numeric budget controls', () => {
  const targets = buildWorkspaceSearchTargets({ configuration, settings });
  assert(searchWorkspaceTargets(targets, '启用发送预算').length > 0);
  assert.equal(searchWorkspaceSearchTitles(targets).includes('发送次数上限'), false);
});

function searchWorkspaceSearchTitles(targets: ReturnType<typeof buildWorkspaceSearchTargets>): readonly string[] {
  return targets.map(target => target.title);
}

test('current visible entries replace hidden page metadata without inspecting form values', () => {
  const targets = buildWorkspaceSearchTargets({ configuration, settings });
  const result = applyCurrentPageVisibility(targets, 'model', [
    { kind: 'section', title: '当前方案', sectionTitle: '当前方案' },
  ]);
  assert.equal(searchWorkspaceTargets(result, '模型提供方').some(target => target.page === 'model'), false);
  assert.equal(searchWorkspaceTargets(result, '模型提供方').some(target => target.page === 'providers'), true);
  assert.equal(searchWorkspaceTargets(result, '当前方案').length, 1);
});
