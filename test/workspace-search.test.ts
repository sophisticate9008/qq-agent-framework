import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCurrentPageVisibility, buildWorkspaceSearchTargets, searchWorkspaceTargets, workspacePageTargets } from '../web/lib/workspace-search.ts';
import { pageRegistry } from '../web/lib/page-registry.ts';
import { nativeFormMetadata, nativeFormSearchTargets } from '../web/lib/native-form-metadata.ts';

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

test('empty search returns one shortcut for every registered page', () => {
  const results = searchWorkspaceTargets(workspacePageTargets, '  ');
  assert.equal(results.length, pageRegistry.length);
  assert(results.every(target => target.kind === 'page'));
  assert.equal(new Set(results.map(target => target.page)).size, pageRegistry.length);
  assert(results.some(target => target.page === 'providers' && target.title === '模型提供方'));
});

test('search matches normalized metadata without indexing values', () => {
  const targets = buildWorkspaceSearchTargets({ configuration, settings });
  const fields = searchWorkspaceTargets(targets, '模型 提供').filter(target => target.kind === 'field');
  assert(fields.length > 0);
  assert(fields.every(target => target.title === '模型提供方'));
  for (const value of ['never-index-this-provider', 'never-index-this-secret', '127.0.0.1']) {
    assert.equal(searchWorkspaceTargets(targets, value).length, 0);
  }
});

test('native chat plan and persona management remain discoverable without a running host', () => {
  const targets = buildWorkspaceSearchTargets({ configuration, settings, runtimeStatus: { runtimeConnected: false } });
  assert.equal(searchWorkspaceTargets(targets, '聊天方案').some(target => target.page === 'model'), true);
  assert.equal(searchWorkspaceTargets(targets, '人设库').some(target => target.page === 'persona'), true);
  assert.equal(searchWorkspaceTargets(targets, '模型提供方').some(target => target.page === 'providers'), true);
  assert.equal(searchWorkspaceTargets(targets, '可信扩展装配摘要').some(target => target.page === 'features'
    && target.sectionId === 'native-bootstrap-summary' && target.kind === 'section'), true);
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


test('Q1 first overview with empty groups finds real native fields without draft or runtime data', () => {
  const targets = buildWorkspaceSearchTargets({ configuration: { groups: [] }, settings: {},
    runtimeStatus: { runtimeConnected: false }, currentPage: 'overview', visibleEntries: [] });
  for (const [title, page, sectionId] of [
    ['超时提醒内容', 'security', 'chat-execution'],
    ['群聊白名单', 'security', 'native-access'],
    ['私聊白名单', 'security', 'native-access'],
    ['模型显示名称（可选）', 'providers', 'native-provider-editor'],
  ]) {
    const fieldMatches = searchWorkspaceTargets(targets, title).filter(target => target.kind === 'field');
    assert.equal(fieldMatches.length, 1);
    assert.equal(fieldMatches[0]?.page, page);
    assert.equal(fieldMatches[0]?.sectionId, sectionId);
    assert.equal(fieldMatches[0]?.availability, 'unknown');
    assert(fieldMatches[0]?.unavailableMessage);
  }
});

test('every registered native field is discoverable by its actual label, never by page aliases', () => {
  const targets = buildWorkspaceSearchTargets({ configuration: { groups: [] }, settings: {} });
  for (const expected of nativeFormSearchTargets().filter(target => target.kind === 'field')) {
    assert(searchWorkspaceTargets(targets, expected.title).some(target => target.kind === 'field'
      && target.sectionId === expected.sectionId && target.title === expected.title));
  }
  assert.equal(searchWorkspaceTargets(targets, 'provider').filter(target => target.kind === 'field').length, 0);
  assert.equal(searchWorkspaceTargets(targets, '运行设置').filter(target => target.kind === 'field').length, 0);
});

test('current native visibility changes availability, not schema discoverability or draft values', () => {
  const initial = buildWorkspaceSearchTargets({ configuration: { groups: [] }, settings: {} });
  const hidden = applyCurrentPageVisibility(initial, 'settings', [
    { kind: 'section', title: '回复与超时', sectionTitle: '回复与超时', sectionId: 'chat-execution' },
  ]);
  const target = hidden.find(entry => entry.title === '超时提醒内容');
  assert.equal(target?.kind, 'field');
  assert.equal(target?.availability, 'requires-setup');
  const visible = applyCurrentPageVisibility(initial, 'settings', [
    { kind: 'field', title: '超时提醒内容', sectionTitle: '回复与超时', sectionId: 'chat-execution' },
  ]);
  assert.equal(visible.find(entry => entry.title === '超时提醒内容')?.availability, 'available');
});

test('current native resource titles never leak into the search projection', () => {
  const initial = buildWorkspaceSearchTargets({ configuration: { groups: [] }, settings: {} });
  const result = applyCurrentPageVisibility(initial, 'providers', [
    { kind: 'section', title: 'never-index-resource-name', sectionTitle: 'never-index-resource-name', sectionId: 'native-provider-editor' },
    { kind: 'field', title: '模型显示名称（可选）', sectionTitle: 'never-index-resource-name', sectionId: 'native-provider-editor' },
    { kind: 'field', title: '可用模型列表', sectionTitle: 'never-index-resource-name', sectionId: 'native-provider-editor' },
  ]);
  assert.equal(searchWorkspaceTargets(result, 'never-index-resource-name').length, 0);
  assert.equal(result.find(entry => entry.kind === 'section' && entry.sectionId === 'native-provider-editor')?.availability, 'available');
  assert.equal(result.find(entry => entry.title === '模型显示名称（可选）')?.availability, 'available');
});

function searchWorkspaceSearchTitles(targets: ReturnType<typeof buildWorkspaceSearchTargets>): readonly string[] {
  return targets.map(target => target.title);
}

test('current visible entries replace traditional hidden metadata but retain native schema fields', () => {
  const targets = buildWorkspaceSearchTargets({ configuration, settings });
  const result = applyCurrentPageVisibility(targets, 'model', [
    { kind: 'section', title: '当前方案', sectionTitle: '当前方案' },
  ]);
  assert.equal(searchWorkspaceTargets(result, '模型提供方').some(target => target.page === 'model' && !target.sectionId), false);
  assert.equal(searchWorkspaceTargets(result, '模型提供方').some(target => target.page === 'model' && target.sectionId === 'native-plan-editor'), true);
  assert.equal(searchWorkspaceTargets(result, '模型提供方').some(target => target.page === 'providers'), true);
  assert.equal(searchWorkspaceTargets(result, '当前方案').length, 1);
});
