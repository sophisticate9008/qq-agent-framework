import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyCurrentPageVisibility,
  buildWorkspaceSearchTargets,
  searchWorkspaceTargets,
  workspacePageTargets,
} from '../web/lib/workspace-search.ts';

const configuration = {
  groups: [
    {
      id: 'bridge-model', title: 'DSH 模型与连接', category: 'model', fields: [
        { id: 'model.provider', label: '模型提供方', type: 'text', value: 'OpenAI' },
        { id: 'model.apiKey', label: '模型访问令牌', type: 'secret', value: 'never-index-this-secret' },
      ],
    },
    {
      id: 'social-v1', title: '一代仿真', category: 'features', fields: [
        { id: 'social.enabled', label: '启用一代仿真', type: 'boolean', value: true },
        { id: 'social.proactiveEnabled', label: '启用定时主动话题', type: 'boolean', value: false },
        { id: 'social.proactiveProbability', label: '主动开口概率', type: 'number', value: 0.75 },
      ],
    },
    {
      id: 'social-v2-general', title: '二代仿真总体', category: 'features', fields: [
        { id: 'socialV2.enabled', label: '启用二代仿真', type: 'boolean', value: true },
        { id: 'socialV2.agentPreset', label: '二代聊天方案', type: 'text', value: 'secret-preset-body' },
      ],
    },
  ],
};

const settings = {
  gateway: { values: { budgetEnabled: false, timeoutMs: 10_000, maxPending: 4, maxBodyBytes: 1_024, maxRecords: 100 } },
  admin: { values: { host: '127.0.0.1', port: 8787 } },
};

test('empty search returns exactly the eight page shortcuts', () => {
  const results = searchWorkspaceTargets(workspacePageTargets, '  ');
  assert.equal(results.length, 8);
  assert(results.every(target => target.kind === 'page'));
});

test('search matches normalized case-insensitive words across the Chinese path', () => {
  const targets = buildWorkspaceSearchTargets({
    configuration,
    legacyMode: { mode: 'reserved' },
    settings,
  });
  assert.deepEqual(searchWorkspaceTargets(targets, 'ｄＳＨ 提供').map(target => target.title), ['模型提供方']);
  assert.deepEqual(searchWorkspaceTargets(targets, '模型 访问').map(target => target.title), ['模型访问令牌']);
});

test('activity page aliases find sessions and token usage without indexing records', () => {
  assert.deepEqual(searchWorkspaceTargets(workspacePageTargets, 'TOKEN 费用').map(target => target.page), ['usage']);
  assert.deepEqual(searchWorkspaceTargets(workspacePageTargets, 'session 私聊').map(target => target.page), ['sessions']);
  assert.equal(searchWorkspaceTargets(workspacePageTargets, 'private:12345').length, 0);
});

test('configuration values are never indexed and visibility follows real mode and parent switches', () => {
  const targets = buildWorkspaceSearchTargets({
    configuration,
    legacyMode: { mode: 'reserved' },
    settings,
  });
  assert.equal(searchWorkspaceTargets(targets, 'never-index-this-secret').length, 0);
  assert.equal(searchWorkspaceTargets(targets, 'secret-preset-body').length, 0);
  assert.equal(searchWorkspaceTargets(targets, '二代聊天方案').length, 0);
  assert.equal(searchWorkspaceTargets(targets, '主动开口概率').length, 0);
  assert.deepEqual(searchWorkspaceTargets(targets, '启用 定时 主动').map(target => target.title), ['启用定时主动话题']);
});

test('usage sections are searchable across pages only when a chat backend is connected', () => {
  const sources = { configuration, settings, legacyMode: { mode: 'reserved' } };
  const targets = buildWorkspaceSearchTargets(sources);
  for (const title of ['消耗走势', '逐轮花费', '最近调用流水', '当前生效价目表', '账本管理']) {
    assert.deepEqual(searchWorkspaceTargets(targets, title), [{
      page: 'usage', title, sectionTitle: title, kind: 'section',
    }]);
  }
  const disconnected = buildWorkspaceSearchTargets({ ...sources, legacyMode: null });
  assert.equal(searchWorkspaceTargets(disconnected, '逐轮花费').length, 0);
  assert.equal(searchWorkspaceTargets(disconnected, '用量统计').length, 1);
  const hidden = buildWorkspaceSearchTargets({ ...sources, currentPage: 'usage', visibleEntries: [] });
  assert.equal(searchWorkspaceTargets(hidden, '逐轮花费').length, 0);
});

test('disabled budgets hide numeric fields while retaining the switch and basic settings', () => {
  const targets = buildWorkspaceSearchTargets({
    configuration,
    legacyMode: { mode: 'reserved' },
    settings,
  });
  assert.equal(searchWorkspaceTargets(targets, '每次授权最多发送').length, 0);
  assert.equal(searchWorkspaceTargets(targets, '启用发送预算').length, 1);
  assert.equal(searchWorkspaceTargets(targets, '监听端口').length, 1);
});

test('current page visible entries replace hidden metadata without reading the DOM', () => {
  const targets = applyCurrentPageVisibility(workspacePageTargets, 'persona', [
    { title: '人设列表', sectionTitle: '人设列表', kind: 'section' },
    { title: '人设名称', sectionTitle: '当前人设', kind: 'field' },
  ]);
  assert.deepEqual(searchWorkspaceTargets(targets, '人设 名称'), [{
    page: 'persona', title: '人设名称', sectionTitle: '当前人设', kind: 'field',
  }]);
  assert.equal(searchWorkspaceTargets(targets, '人设正文').length, 0);
});
