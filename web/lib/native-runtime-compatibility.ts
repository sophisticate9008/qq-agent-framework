import { CHAT_PLAN_LIMITS, CHAT_PLAN_REASONING_EFFORTS } from '../../src/contracts/chat-plans.ts';
const compatibilityStates = ['no-history', 'compatible', 'blocked', 'unavailable'] as const;
const baselineStates = ['available', 'missing', 'invalid', 'not-required'] as const;
const baselineUnavailableReasons = ['not-recorded', 'invalid-record', 'sensitive-content', 'value-too-large', 'record-limit', 'storage-unavailable'] as const;
const recoveryModes = ['none', 'restore-original-values', 'operator-original-values-required', 'storage-unavailable'] as const;
const compatibilityReasons = ['persisted_session_configuration_conflict', 'persisted_persona_identity_conflict',
  'persisted_configuration_unavailable', 'current_configuration_unavailable'] as const;
const compatibilityDifferences = ['planId', 'instructions', 'personaId', 'model.provider', 'model.name', 'model.reasoningEffort',
  'contextLimits', 'capabilitySelection', 'persona.name', 'persona.identity', 'persona.style', 'endpoint', 'bindings'] as const;

export type NativeRuntimeCompatibilityState = typeof compatibilityStates[number];
export type NativeRuntimeCompatibilityReason = typeof compatibilityReasons[number];
export type NativeRuntimeCompatibilityDifference = typeof compatibilityDifferences[number];
export type NativeRuntimeBaselineUnavailableReason = typeof baselineUnavailableReasons[number];

export interface NativeRuntimeCompatibility {
  readonly schema: 1;
  readonly state: NativeRuntimeCompatibilityState;
  readonly hasPersistedSessions: boolean | null;
  readonly reasons: readonly NativeRuntimeCompatibilityReason[];
  readonly differences: readonly NativeRuntimeCompatibilityDifference[];
  readonly baseline: {
    readonly state: typeof baselineStates[number];
    readonly capturedAt: number | null;
    readonly unavailableReason?: NativeRuntimeBaselineUnavailableReason | null;
  };
  readonly recovery: {
    readonly mode: typeof recoveryModes[number];
    readonly automaticRestoreAvailable: false;
    readonly forwardMigrationAvailable: false;
  };
}

export interface NativeRuntimeBaselineBinding {
  readonly agentPreset: string;
  readonly conversationKind: 'group' | 'private' | null;
  readonly externalProvider: string | null;
  readonly definitionFingerprint: string;
}

export interface NativeRuntimeBaselineValues {
  readonly definition: ChatSessionDefinition;
  readonly persona: ChatPersona;
  readonly endpoint: string;
  readonly bindings: readonly NativeRuntimeBaselineBinding[];
}

export type NativeRuntimeConfigurationBaseline = {
  readonly schema: 1;
  readonly unavailableReason?: NativeRuntimeBaselineUnavailableReason | null;
} & (
  { readonly state: 'available'; readonly capturedAt: number; readonly values: NativeRuntimeBaselineValues }
  | { readonly state: 'missing' | 'invalid' | 'unavailable'; readonly capturedAt: null; readonly values: null }
);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fields(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  return record(value) && names.every(name => Object.hasOwn(value, name));
}

function choice<Choice extends string>(value: unknown, allowed: readonly Choice[]): Choice | undefined {
  return allowed.find(candidate => candidate === value);
}

function choices<Choice extends string>(value: unknown, allowed: readonly Choice[]): Choice[] | null {
  if (!Array.isArray(value) || value.length > allowed.length) return null;
  const result: Choice[] = [];
  for (const item of value) {
    const selected = choice(item, allowed);
    if (selected === undefined || result.includes(selected)) return null;
    result.push(selected);
  }
  return result;
}

function capturedTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function parseNativeRuntimeCompatibility(input: unknown): NativeRuntimeCompatibility | null {
  if (!fields(input, ['configurationCompatibility'])) return null;
  const value = input.configurationCompatibility;
  if (!fields(value, ['schema', 'state', 'hasPersistedSessions', 'reasons', 'differences', 'baseline', 'recovery']) || value.schema !== 1) return null;
  const state = choice(value.state, compatibilityStates);
  const reasons = choices(value.reasons, compatibilityReasons);
  const differences = choices(value.differences, compatibilityDifferences);
  if (!state || !reasons || !differences || value.hasPersistedSessions !== null && typeof value.hasPersistedSessions !== 'boolean'
    || !fields(value.baseline, ['state', 'capturedAt'])
    || !fields(value.recovery, ['mode', 'automaticRestoreAvailable', 'forwardMigrationAvailable'])) return null;
  const baselineState = choice(value.baseline.state, baselineStates);
  const recoveryMode = choice(value.recovery.mode, recoveryModes);
  const capturedAt = value.baseline.capturedAt;
  const unavailableReason = Object.hasOwn(value.baseline, 'unavailableReason') && value.baseline.unavailableReason !== null
    ? choice(value.baseline.unavailableReason, baselineUnavailableReasons) : null;
  if (!baselineState || !recoveryMode || capturedAt !== null && !capturedTime(capturedAt)
    || (baselineState === 'available' ? capturedAt === null : capturedAt !== null)
    || unavailableReason === undefined || baselineState === 'available' && unavailableReason !== null
    || value.recovery.automaticRestoreAvailable !== false || value.recovery.forwardMigrationAvailable !== false) return null;
  if (state !== 'unavailable' && typeof value.hasPersistedSessions !== 'boolean'
    || (state === 'blocked' || state === 'unavailable' ? reasons.length === 0 : reasons.length !== 0)) return null;
  if (state === 'no-history' && value.hasPersistedSessions !== false || state === 'compatible' && value.hasPersistedSessions !== true
    || (state === 'compatible' || state === 'no-history') && recoveryMode !== 'none'
    || state === 'unavailable' && recoveryMode !== 'storage-unavailable') return null;
  if (state === 'blocked' && (baselineState === 'available' ? recoveryMode !== 'restore-original-values'
    : baselineState === 'not-required' || recoveryMode !== 'operator-original-values-required')) return null;
  return {
    schema: 1, state, hasPersistedSessions: value.hasPersistedSessions, reasons, differences,
    baseline: { state: baselineState, capturedAt, ...(Object.hasOwn(value.baseline, 'unavailableReason') ? { unavailableReason } : {}) },
    recovery: { mode: recoveryMode, automaticRestoreAvailable: false, forwardMigrationAvailable: false },
  };
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum && value.trim().length > 0;
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function reference(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)
    && !value.includes('..') && !value.includes('//') && !value.endsWith('/');
}

function hash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function parseDefinition(input: unknown): ChatSessionDefinition | null {
  if (!fields(input, ['planId', 'personaId', 'instructions', 'persona', 'model'])
    || !identifier(input.planId) || !identifier(input.personaId) || !boundedText(input.instructions, CHAT_PLAN_LIMITS.instructions)
    || !fields(input.persona, ['identity', 'style']) || !boundedText(input.persona.identity, CHAT_PLAN_LIMITS.personaSection) || !boundedText(input.persona.style, CHAT_PLAN_LIMITS.personaSection)
    || !fields(input.model, ['provider', 'name', 'reasoningEffort']) || !reference(input.model.provider) || !reference(input.model.name)) return null;
  const reasoningEffort = choice(input.model.reasoningEffort, CHAT_PLAN_REASONING_EFFORTS);
  if (!reasoningEffort) return null;
  let contextLimits: ChatSessionDefinition['contextLimits'];
  if (Object.hasOwn(input, 'contextLimits')) {
    const limits = input.contextLimits;
    if (!fields(limits, ['group', 'private']) || typeof limits.group !== 'number' || typeof limits.private !== 'number'
      || ![limits.group, limits.private].every(limit => Number.isSafeInteger(limit) && limit >= CHAT_PLAN_LIMITS.contextMinimum && limit <= CHAT_PLAN_LIMITS.contextMaximum)) return null;
    contextLimits = { group: limits.group, private: limits.private };
  }
  let capabilitySelection: ChatSessionDefinition['capabilitySelection'];
  if (Object.hasOwn(input, 'capabilitySelection')) {
    const selection = input.capabilitySelection;
    if (selection === null) capabilitySelection = null;
    else {
      if (!fields(selection, ['schema', 'presetId', 'revision']) || selection.schema !== 1 || !reference(selection.presetId) || !hash(selection.revision)) return null;
      capabilitySelection = { schema: 1, presetId: selection.presetId, revision: selection.revision };
    }
  }
  return { planId: input.planId, personaId: input.personaId, instructions: input.instructions,
    persona: { identity: input.persona.identity, style: input.persona.style },
    model: { provider: input.model.provider, name: input.model.name, reasoningEffort },
    ...(contextLimits === undefined ? {} : { contextLimits }),
    ...(capabilitySelection === undefined ? {} : { capabilitySelection }) };
}

function parsePersona(input: unknown): ChatPersona | null {
  if (!fields(input, ['id', 'name', 'identity', 'style']) || !identifier(input.id) || !boundedText(input.name, 128)
    || !boundedText(input.identity, 16_000) || !boundedText(input.style, 16_000)) return null;
  return { id: input.id, name: input.name, identity: input.identity, style: input.style };
}

function safeEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048
    || !/^https?:\/\//.test(value) || /[\u0000-\u0020\u007f\\?#]/.test(value)) return false;
  try {
    const endpoint = new URL(value);
    const authority = value.slice(value.indexOf('://') + 3).split('/', 1)[0];
    if (authority.includes('@') || endpoint.username !== '' || endpoint.password !== '' || endpoint.search !== '' || endpoint.hash !== '') return false;
    if (endpoint.protocol === 'https:') return true;
    const host = /^(localhost|127(?:\.[0-9]{1,3}){3}|\[::1\])(?::[0-9]{1,5})?$/.exec(authority)?.[1];
    return host !== undefined && (host === 'localhost' || host === '[::1]' || host.split('.').every(part => Number(part) <= 255 && String(Number(part)) === part));
  } catch { return false; }
}

function descriptorIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value);
}

function parseBindings(input: unknown): NativeRuntimeBaselineBinding[] | null {
  if (!Array.isArray(input) || input.length > 128) return null;
  const bindings: NativeRuntimeBaselineBinding[] = [];
  for (const value of input) {
    if (!fields(value, ['agentPreset', 'conversationKind', 'externalProvider', 'definitionFingerprint']) || !descriptorIdentifier(value.agentPreset)
      || value.conversationKind !== null && value.conversationKind !== 'group' && value.conversationKind !== 'private'
      || value.externalProvider !== null && !descriptorIdentifier(value.externalProvider) || !hash(value.definitionFingerprint)) return null;
    bindings.push({ agentPreset: value.agentPreset, conversationKind: value.conversationKind,
      externalProvider: value.externalProvider, definitionFingerprint: value.definitionFingerprint });
  }
  return bindings;
}

export function parseNativeRuntimeConfigurationBaseline(input: unknown): NativeRuntimeConfigurationBaseline | null {
  if (!fields(input, ['schema', 'state', 'capturedAt', 'values']) || input.schema !== 1) return null;
  const unavailableReason = Object.hasOwn(input, 'unavailableReason') && input.unavailableReason !== null
    ? choice(input.unavailableReason, baselineUnavailableReasons) : null;
  if (unavailableReason === undefined || input.state === 'available' && unavailableReason !== null) return null;
  const reason = Object.hasOwn(input, 'unavailableReason') ? { unavailableReason } : {};
  if (input.state === 'missing' || input.state === 'invalid' || input.state === 'unavailable') {
    return input.capturedAt === null && input.values === null ? { schema: 1, state: input.state, capturedAt: null, values: null, ...reason } : null;
  }
  if (input.state !== 'available' || !capturedTime(input.capturedAt) || !fields(input.values, ['definition', 'persona', 'endpoint', 'bindings'])) return null;
  const definition = parseDefinition(input.values.definition);
  const persona = parsePersona(input.values.persona);
  const bindings = parseBindings(input.values.bindings);
  if (!definition || !persona || !bindings || !safeEndpoint(input.values.endpoint)
    || definition.personaId !== persona.id || definition.persona.identity !== persona.identity || definition.persona.style !== persona.style) return null;
  const values = { definition, persona, endpoint: input.values.endpoint, bindings };
  if (new TextEncoder().encode(JSON.stringify(values)).byteLength > 512 * 1_024) return null;
  return { schema: 1, state: 'available', capturedAt: input.capturedAt, values, ...reason };
}

export function nativeRuntimeCompatibilityLabel(value: NativeRuntimeCompatibility | null): string {
  if (value === null) return '兼容性预检未提供或响应无效，无法确认兼容性';
  return {
    'no-history': '没有需要比较的持久会话',
    compatible: '当前设置与持久会话兼容',
    blocked: '当前设置与持久会话不兼容',
    unavailable: '无法确认持久会话兼容性',
  }[value.state];
}

export function nativeRuntimeCompatibilityReasonLabel(reason: NativeRuntimeCompatibilityReason): string {
  return {
    persisted_session_configuration_conflict: '当前会话定义或连接与已有绑定不一致。',
    persisted_persona_identity_conflict: '当前人设内容版本与已有身份记录不一致。',
    persisted_configuration_unavailable: '无法安全读取已有配置记录，不能确认兼容性。',
    current_configuration_unavailable: '当前配置尚不能用于兼容性比较。',
  }[reason];
}

export function nativeRuntimeCompatibilityDifferenceLabel(difference: NativeRuntimeCompatibilityDifference): string {
  return {
    planId: '聊天方案标识', instructions: '方案行为指令', personaId: '关联人设标识',
    'model.provider': '模型提供方', 'model.name': '模型标识', 'model.reasoningEffort': '推理档位',
    contextLimits: '群聊／私聊上下文上限', capabilitySelection: '能力选择',
    'persona.name': '人设名称', 'persona.identity': '人设身份正文', 'persona.style': '人设表达风格',
    endpoint: 'DSH 连接地址', bindings: 'DSH 预设绑定',
  }[difference];
}

export function nativeRuntimeCompatibilityRecoveryText(value: NativeRuntimeCompatibility): string {
  return {
    none: '本次检查无需回填原值；兼容不代表已启动聊天、模型可用或获得新的权限。',
    'restore-original-values': '基线仅供操作者核对原值，不会自动应用或重建会话。核对本次差异并使用当前版本条件保存；涉及部署的修改还需单独预览、确认应用和检查加载。',
    'operator-original-values-required': '没有可用的原值基线，请操作者自行核对可信原值；不要根据指纹或缺失字段猜测恢复，也不要清空会话或补充授权强行启动。',
    'storage-unavailable': '无法安全读取原有记录，请先检查存储；不要重复启动、删除数据或猜测恢复。',
  }[value.recovery.mode];
}

export function nativeRuntimeConfigurationBaselineLabel(value: NativeRuntimeConfigurationBaseline | null): string {
  if (value === null) return '原值基线未提供或响应无效，无法提供恢复值';
  return {
    available: '原值基线可供人工核对，不代表可以自动恢复',
    missing: '没有原值基线，需操作者核对可信原值',
    invalid: '原值基线无效，不提供部分恢复值',
    unavailable: '原值基线暂不可读取，无法提供恢复值',
  }[value.state];
}

export function nativeRuntimeBaselineUnavailableReasonLabel(reason: NativeRuntimeBaselineUnavailableReason | null | undefined): string {
  if (reason === null || reason === undefined) return '未提供基线不可用的具体原因，不能据此猜测恢复值。';
  return {
    'not-recorded': '没有记录与原身份匹配的原值基线；不表示没有会话或历史。',
    'invalid-record': '基线记录未通过校验，不能用于恢复。',
    'sensitive-content': '基线含敏感内容，未发布原值；不返回部分恢复数据。',
    'value-too-large': '基线超过原值大小上限，未发布；不会截断后用于恢复。',
    'record-limit': '存储记录容量达到上限，未发布原值基线。',
    'storage-unavailable': '无法安全读取基线存储，不能提供恢复值。',
  }[reason];
}
import type { ChatPersona, ChatSessionDefinition } from '../../src/host/chat-plans.ts';
