export interface VisibilityField {
  readonly id: string;
  readonly label: string;
}

export interface VisibilityGroup {
  readonly id: string;
  readonly title: string;
  readonly fields: readonly VisibilityField[];
}

export interface ConfigurationVisibilityOptions {
  readonly activeMode?: string | null;
  readonly values: Readonly<Record<string, unknown>>;
  readonly dirtyFieldIds?: ReadonlySet<string>;
  readonly showInactive?: boolean;
}

export interface GroupVisibility {
  readonly visible: boolean;
  readonly fieldIds: ReadonlySet<string>;
  readonly inactiveDirtyFieldIds: ReadonlySet<string>;
}

const v1GroupIds = new Set(['social-v1']);
const v1ActiveDurationFields = new Set([
  'social.activeDurationMinMs',
  'social.activeDurationMaxMs'
]);
const v1ProactiveFields = new Set([
  'social.proactiveIdleThresholdMs',
  'social.proactiveCheckMinMs',
  'social.proactiveCheckMaxMs',
  'social.proactiveProbability'
]);
const v1BurstFields = new Set([
  'social.burstIntervalMinMs',
  'social.burstIntervalMaxMs',
  'social.longGapProbability',
  'social.longGapMinMs',
  'social.longGapMaxMs'
]);
const v2RecommendedFields = new Set([
  'socialV2.wake.recommendedDefaultInfinite',
  'socialV2.wake.recommendedSleepMinMs',
  'socialV2.wake.recommendedSleepMaxMs',
  'socialV2.wake.recommendedProbability',
  'socialV2.wake.recommendedKeywords',
  'socialV2.wake.recommendedAtMention',
  'socialV2.wake.recommendedNameMention',
  'socialV2.wake.recommendedQuestion',
  'socialV2.wake.recommendedPoke',
  'socialV2.wake.recommendedHint',
  'socialV2.send.recommendedHint'
]);
const v2BurstFields = new Set([
  'socialV2.send.burstMaxMessages',
  'socialV2.send.burstIntervalMinMs',
  'socialV2.send.burstIntervalMaxMs',
  'socialV2.send.longGapProbability',
  'socialV2.send.longGapMinMs',
  'socialV2.send.longGapMaxMs'
]);
const v2InlineWakeFields = new Set([
  'socialV2.context.wakeMessageLimit',
  'socialV2.context.wakeRecentLimit',
  'socialV2.context.wakeMaxChars'
]);
const v2StickerCollectionFields = new Set([
  'socialV2.sticker.collect.maxPerMinute',
  'socialV2.sticker.collect.maxPerHour',
  'socialV2.sticker.collect.maxRemarkChars'
]);

type Generation = 'v1' | 'v2' | null;

function activeGeneration(activeMode: string | null | undefined): Generation {
  if (activeMode === 'reserved') return 'v1';
  if (activeMode === 'reserved2' || activeMode === 'simulation') return 'v2';
  return null;
}

function groupGeneration(groupId: string): Generation {
  if (v1GroupIds.has(groupId)) return 'v1';
  if (groupId.startsWith('social-v2-')) return 'v2';
  return null;
}

function dependenciesFor(fieldId: string): readonly string[] {
  const dependencies: string[] = [];

  if (fieldId.startsWith('social.') && fieldId !== 'social.enabled') dependencies.push('social.enabled');
  if (v1ActiveDurationFields.has(fieldId)) dependencies.push('social.activeDurationEnabled');
  if (v1ProactiveFields.has(fieldId)) dependencies.push('social.proactiveEnabled');
  if (v1BurstFields.has(fieldId)) dependencies.push('social.burstEnabled');

  if (fieldId.startsWith('socialV2.') && fieldId !== 'socialV2.enabled') dependencies.push('socialV2.enabled');
  if (fieldId === 'socialV2.autoReplyCheckMs') dependencies.push('socialV2.autoReplyCheckEnabled');
  if (fieldId === 'socialV2.wake.preSleepWaitMs') dependencies.push('socialV2.wake.preSleepWaitEnabled');
  if (v2RecommendedFields.has(fieldId)) dependencies.push('socialV2.provideRecommendations');
  if (v2BurstFields.has(fieldId)) dependencies.push('socialV2.send.burstEnabled');
  if (v2InlineWakeFields.has(fieldId)) dependencies.push('socialV2.context.inlineWakeMessages');

  if (fieldId.startsWith('socialV2.proactive.') && fieldId !== 'socialV2.proactive.enabled') {
    dependencies.push('socialV2.proactive.enabled');
  }
  if (fieldId.startsWith('socialV2.sticker.') && fieldId !== 'socialV2.sticker.enabled') {
    dependencies.push('socialV2.sticker.enabled');
  }
  if (fieldId === 'socialV2.sticker.promptMaxStickers') dependencies.push('socialV2.sticker.includeInPrompt');
  if (v2StickerCollectionFields.has(fieldId)) dependencies.push('socialV2.sticker.collect.enabled');
  if (fieldId.startsWith('socialV2.voice.') && fieldId !== 'socialV2.voice.enabled') {
    dependencies.push('socialV2.voice.enabled');
  }

  if (fieldId.startsWith('slang.') && fieldId !== 'slang.enabled') dependencies.push('slang.enabled');
  if (fieldId === 'slang.inferenceThresholds') dependencies.push('slang.autoResearch');

  return dependencies;
}

function dependenciesEnabled(fieldId: string, values: Readonly<Record<string, unknown>>): boolean {
  return dependenciesFor(fieldId).every(parentId => values[parentId] !== false);
}

export function resolveConfigurationVisibility(
  groups: readonly VisibilityGroup[],
  options: ConfigurationVisibilityOptions
): ReadonlyMap<string, GroupVisibility> {
  const generation = activeGeneration(options.activeMode);
  const dirtyFieldIds = options.dirtyFieldIds ?? new Set<string>();
  const result = new Map<string, GroupVisibility>();

  for (const group of groups) {
    const requiredGeneration = groupGeneration(group.id);
    const modeActive = requiredGeneration === null || requiredGeneration === generation;
    const fieldIds = new Set<string>();
    const inactiveDirtyFieldIds = new Set<string>();

    for (const field of group.fields) {
      const normallyVisible = modeActive && dependenciesEnabled(field.id, options.values);
      const dirty = dirtyFieldIds.has(field.id);
      if (normallyVisible || modeActive && options.showInactive === true || dirty) fieldIds.add(field.id);
      if (dirty && !normallyVisible) inactiveDirtyFieldIds.add(field.id);
    }

    result.set(group.id, {
      visible: fieldIds.size > 0,
      fieldIds,
      inactiveDirtyFieldIds
    });
  }

  return result;
}

export function configurationSearchMatch(
  group: VisibilityGroup,
  visibleFieldIds: ReadonlySet<string>,
  normalizedQuery: string
): ReadonlySet<string> | null | undefined {
  if (visibleFieldIds.size === 0) return undefined;
  if (!normalizedQuery || group.title.toLocaleLowerCase('zh-CN').includes(normalizedQuery)) return null;
  const fieldIds = new Set(group.fields
    .filter(field => visibleFieldIds.has(field.id) && field.label.toLocaleLowerCase('zh-CN').includes(normalizedQuery))
    .map(field => field.id));
  return fieldIds.size > 0 ? fieldIds : undefined;
}
