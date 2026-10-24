import assert from 'node:assert/strict';
import test from 'node:test';

import {
  configurationSearchMatch,
  resolveConfigurationVisibility,
  type VisibilityGroup
} from '../web/lib/configuration-visibility.ts';

const groups: readonly VisibilityGroup[] = [
  {
    id: 'social-v1', title: '一代仿真', fields: [
      { id: 'social.enabled', label: '启用一代仿真' },
      { id: 'social.contextWindow', label: '上下文条数' },
      { id: 'social.activeDurationEnabled', label: '限制活跃时长' },
      { id: 'social.activeDurationMinMs', label: '活跃时长下限' },
      { id: 'social.proactiveEnabled', label: '启用定时主动话题' },
      { id: 'social.proactiveProbability', label: '主动开口概率' },
      { id: 'social.burstEnabled', label: '启用分条发送' },
      { id: 'social.burstIntervalMinMs', label: '分条间隔下限' }
    ]
  },
  {
    id: 'social-v2-general', title: '二代仿真总体', fields: [
      { id: 'socialV2.enabled', label: '启用二代仿真' },
      { id: 'socialV2.agentPreset', label: '二代聊天方案' },
      { id: 'socialV2.provideRecommendations', label: '提供行为建议' },
      { id: 'socialV2.autoReplyCheckEnabled', label: '启用后台自动检查' },
      { id: 'socialV2.autoReplyCheckMs', label: '自动检查间隔' }
    ]
  },
  {
    id: 'social-v2-wake', title: '二代唤醒与潜水', fields: [
      { id: 'socialV2.wake.defaultMode', label: '默认状态' },
      { id: 'socialV2.wake.preSleepWaitEnabled', label: '沉睡前观察' },
      { id: 'socialV2.wake.preSleepWaitMs', label: '沉睡前观察时间' },
      { id: 'socialV2.wake.recommendedDefaultInfinite', label: '默认无限期潜水' }
    ]
  },
  {
    id: 'social-v2-send', title: '二代发送节奏', fields: [
      { id: 'socialV2.send.burstEnabled', label: '启用分条发送' },
      { id: 'socialV2.send.burstMaxMessages', label: '单次分条上限' },
      { id: 'socialV2.send.maxMessageChars', label: '单条字符上限' },
      { id: 'socialV2.send.recommendedHint', label: '发送建议文本' }
    ]
  },
  {
    id: 'social-v2-proactive', title: '二代主动话题', fields: [
      { id: 'socialV2.proactive.enabled', label: '启用主动话题' },
      { id: 'socialV2.proactive.probability', label: '主动开口概率' }
    ]
  },
  {
    id: 'social-v2-context', title: '二代上下文', fields: [
      { id: 'socialV2.context.inlineWakeMessages', label: '唤醒时内联消息' },
      { id: 'socialV2.context.wakeMessageLimit', label: '唤醒消息上限' },
      { id: 'socialV2.context.contextWindow', label: '提示上下文条数' }
    ]
  },
  {
    id: 'social-v2-sticker', title: '二代表情策略', fields: [
      { id: 'socialV2.sticker.enabled', label: '启用表情体系' },
      { id: 'socialV2.sticker.includeInPrompt', label: '提示中附带表情' },
      { id: 'socialV2.sticker.promptMaxStickers', label: '提示表情上限' },
      { id: 'socialV2.sticker.collect.enabled', label: '允许 AI 收藏' },
      { id: 'socialV2.sticker.collect.maxPerHour', label: '每小时收藏上限' }
    ]
  },
  {
    id: 'social-v2-voice', title: '二代语音', fields: [
      { id: 'socialV2.voice.enabled', label: '启用语音发送' },
      { id: 'socialV2.voice.dir', label: '语音库目录' }
    ]
  },
  {
    id: 'bridge-slang', title: '黑话学习', fields: [
      { id: 'slang.enabled', label: '启用黑话学习' },
      { id: 'slang.extractMinMessages', label: '提取最少消息数' },
      { id: 'slang.autoResearch', label: '自动联网研究' },
      { id: 'slang.inferenceThresholds', label: '研究触发阈值' }
    ]
  }
];

function visibleIds(mode: string | null, values: Readonly<Record<string, unknown>> = {}, showInactive = false): Record<string, readonly string[]> {
  return Object.fromEntries([...resolveConfigurationVisibility(groups, { activeMode: mode, values, showInactive })]
    .filter(([, visibility]) => visibility.visible)
    .map(([groupId, visibility]) => [groupId, [...visibility.fieldIds]]));
}

test('shows exactly the generation selected by the runtime mode', () => {
  assert.deepEqual(Object.keys(visibleIds('reserved')), ['social-v1', 'bridge-slang']);
  assert.deepEqual(Object.keys(visibleIds('reserved2')), ['social-v2-general', 'social-v2-wake', 'social-v2-send', 'social-v2-proactive', 'social-v2-context', 'social-v2-sticker', 'social-v2-voice', 'bridge-slang']);
  assert.deepEqual(Object.keys(visibleIds('simulation')), ['social-v2-general', 'social-v2-wake', 'social-v2-send', 'social-v2-proactive', 'social-v2-context', 'social-v2-sticker', 'social-v2-voice', 'bridge-slang']);
  assert.deepEqual(Object.keys(visibleIds('chat')), ['bridge-slang']);
  assert.deepEqual(Object.keys(visibleIds('closed-agent')), ['bridge-slang']);
  assert.deepEqual(Object.keys(visibleIds(null)), ['bridge-slang']);
  assert.deepEqual(Object.keys(visibleIds('chat', {}, true)), ['bridge-slang']);
});

test('keeps parent switches visible and does not invent inherited boolean values', () => {
  assert.deepEqual(visibleIds('reserved', { 'social.enabled': false })['social-v1'], ['social.enabled']);
  assert.deepEqual(visibleIds('reserved')['social-v1'], groups[0]!.fields.map(field => field.id));
  assert.deepEqual(visibleIds('reserved', {
    'social.enabled': true,
    'social.activeDurationEnabled': false,
    'social.proactiveEnabled': false,
    'social.burstEnabled': false
  })['social-v1'], [
    'social.enabled',
    'social.contextWindow',
    'social.activeDurationEnabled',
    'social.proactiveEnabled',
    'social.burstEnabled'
  ]);
});

test('hides second-generation subgroups and nested settings behind explicit false switches', () => {
  const disabled = visibleIds('reserved2', { 'socialV2.enabled': false });
  assert.deepEqual(disabled, { 'social-v2-general': ['socialV2.enabled'], 'bridge-slang': groups[8]!.fields.map(field => field.id) });

  const nested = visibleIds('reserved2', {
    'socialV2.enabled': true,
    'socialV2.provideRecommendations': false,
    'socialV2.autoReplyCheckEnabled': false,
    'socialV2.wake.preSleepWaitEnabled': false,
    'socialV2.send.burstEnabled': false,
    'socialV2.proactive.enabled': false,
    'socialV2.context.inlineWakeMessages': false,
    'socialV2.sticker.enabled': true,
    'socialV2.sticker.includeInPrompt': false,
    'socialV2.sticker.collect.enabled': false,
    'socialV2.voice.enabled': false
  });
  assert(!nested['social-v2-general']!.includes('socialV2.autoReplyCheckMs'));
  assert.deepEqual(nested['social-v2-wake'], ['socialV2.wake.defaultMode', 'socialV2.wake.preSleepWaitEnabled']);
  assert.deepEqual(nested['social-v2-send'], ['socialV2.send.burstEnabled', 'socialV2.send.maxMessageChars']);
  assert.deepEqual(nested['social-v2-proactive'], ['socialV2.proactive.enabled']);
  assert.deepEqual(nested['social-v2-context'], ['socialV2.context.inlineWakeMessages', 'socialV2.context.contextWindow']);
  assert.deepEqual(nested['social-v2-sticker'], [
    'socialV2.sticker.enabled',
    'socialV2.sticker.includeInPrompt',
    'socialV2.sticker.collect.enabled'
  ]);
  assert.deepEqual(nested['social-v2-voice'], ['socialV2.voice.enabled']);
});

test('slang and advanced visibility follow explicit parent state', () => {
  const disabled = visibleIds('chat', { 'slang.enabled': false });
  assert.deepEqual(disabled['bridge-slang'], ['slang.enabled']);
  const advanced = visibleIds('chat', { 'slang.enabled': false }, true);
  assert.deepEqual(advanced['bridge-slang'], groups[8]!.fields.map(field => field.id));

  const noResearch = visibleIds('chat', { 'slang.enabled': true, 'slang.autoResearch': false });
  assert(!noResearch['bridge-slang']!.includes('slang.inferenceThresholds'));
  assert(noResearch['bridge-slang']!.includes('slang.autoResearch'));
});

test('keeps inactive dirty drafts visible without exposing unrelated inactive fields', () => {
  const dirtyFieldIds = new Set(['socialV2.voice.dir']);
  const visibility = resolveConfigurationVisibility(groups, {
    activeMode: 'reserved',
    values: { 'socialV2.enabled': true, 'socialV2.voice.enabled': false },
    dirtyFieldIds
  }).get('social-v2-voice')!;
  assert.equal(visibility.visible, true);
  assert.deepEqual([...visibility.fieldIds], ['socialV2.voice.dir']);
  assert.deepEqual([...visibility.inactiveDirtyFieldIds], ['socialV2.voice.dir']);
});

test('search only matches visible labels and never accepts field values', () => {
  const group = groups[5]!;
  const visibleFieldIds = new Set(['socialV2.context.inlineWakeMessages', 'socialV2.context.contextWindow']);
  assert.deepEqual([...configurationSearchMatch(group, visibleFieldIds, '提示')!], ['socialV2.context.contextWindow']);
  assert.equal(configurationSearchMatch(group, visibleFieldIds, '唤醒消息上限'), undefined);
  assert.equal(configurationSearchMatch(group, visibleFieldIds, '二代上下文'), null);
});
