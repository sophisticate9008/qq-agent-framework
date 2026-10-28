import { parseChatCapacityRecommendation, type ChatCapacityRecommendation } from '../../src/contracts/chat-capacity.ts';
import { CHAT_PLAN_REASONING_EFFORTS, type ChatPlanReasoningEffort } from '../../src/contracts/chat-plans.ts';
import { asRecord } from './api.ts';

export interface ModelCapabilities {
  readonly provider: string;
  readonly model: string;
  readonly state: 'available' | 'unavailable';
  readonly reasoningEfforts: readonly ChatPlanReasoningEffort[];
  readonly missingReasons: readonly string[];
  readonly capacity?: ChatCapacityRecommendation;
  readonly cache?: { readonly source: 'dsh' | 'provider'; readonly updatedAt: number };
}

export interface ProviderModelCapabilities {
  readonly provider: string;
  readonly providersRevision: string;
  readonly models: readonly ModelCapabilities[];
}

export function modelCapabilitiesPath(provider: string, model: string): string {
  return `/api/chat/model-capabilities?${new URLSearchParams({ provider, model })}`;
}

export function providerModelCapabilitiesPath(provider: string): string {
  return `/api/chat/provider-model-capabilities?${new URLSearchParams({ provider })}`;
}

const effortLabels: Readonly<Record<ChatPlanReasoningEffort, string>> = {
  off: '关闭', low: '低', medium: '中', high: '高', max: '最高',
};

export function modelReasoningEffortLabel(effort: string): string {
  return Object.hasOwn(effortLabels, effort) ? effortLabels[effort as ChatPlanReasoningEffort] : effort;
}

const unavailableReasons: Readonly<Record<string, string>> = {
  local_dsh_connection_required: '尚未连接本机 DSH。请在连接页自动连接后重新读取。',
  model_provider_unavailable: '模型提供方未登记或已停用。请在“模型提供方”核对并启用后重新读取。',
  model_not_configured: '所选模型尚未登记。请在“模型提供方”补齐模型后重新读取。',
  local_dsh_metadata_unavailable: '暂未读到本机 DSH 的模型配置。请确认 DSH 正在运行后重新读取。',
  model_metadata_not_observed: '供应商尚未缓存这个模型的能力声明。请在模型服务的模型目录中刷新能力缓存。',
  model_capability_cache_empty: '这个模型尚无能力缓存。请在模型服务的模型目录中刷新能力。',
  model_metadata_unavailable: '供应商与 DSH 暂未返回可核对的能力声明；已有缓存保留，可在模型服务中查看。',
  model_capability_update_failed: '暂时无法更新能力缓存，请稍后在模型服务中重试。',
  model_metadata_conflict: '读到的多份模型能力声明不一致。请核对 DSH 模型配置后重新读取。',
  model_metadata_invalid: '读到的模型能力声明格式无效。请核对 DSH 模型配置后重新读取。',
  model_reasoning_metadata_unknown: '已找到模型，但未读到思考强度声明。请核对 DSH 模型配置后重新读取。',
  model_reasoning_metadata_invalid: '模型的思考强度声明格式暂不支持。请核对 DSH 模型配置后重新读取。',
  chat_configuration_changed: '读取期间模型设置发生变化。请重新读取当前模型的支持情况。',
  model_capabilities_timeout: '刷新模型能力超时，请在模型服务中核对能力缓存后重试。',
  model_capabilities_read_failed: '暂时无法读取供应商能力缓存，请在模型服务中核对并刷新能力。',
};

export function modelCapabilitiesUnavailableMessage(reasons: readonly string[]): string {
  const messages = [...new Set(reasons.flatMap(reason => Object.hasOwn(unavailableReasons, reason) ? [unavailableReasons[reason]] : []))];
  return messages.slice(0, 2).join(' ') || '供应商尚无可用的模型能力缓存，请到模型服务的模型目录核对并刷新能力。';
}

export function modelReasoningEffortOptions(capabilities: ModelCapabilities | null, current: ChatPlanReasoningEffort | ''):
  readonly { readonly value: ChatPlanReasoningEffort; readonly label: string; readonly disabled: boolean }[] {
  const supported = capabilities?.state === 'available' ? capabilities.reasoningEfforts : [];
  const options = supported.map(value => ({ value, label: modelReasoningEffortLabel(value), disabled: false }));
  if (current && !supported.includes(current)) options.unshift({ value: current,
    label: `${modelReasoningEffortLabel(current)}（当前值，${capabilities?.state === 'available' ? '未在支持列表中' : '支持待核验'}）`, disabled: true });
  return options;
}

export function parseModelCapabilities(value: unknown): ModelCapabilities | null {
  const record = asRecord(value);
  if (typeof record.provider !== 'string' || record.provider.trim() === '' || record.provider.length > 128
    || typeof record.model !== 'string' || record.model.trim() === '' || record.model.length > 128
    || record.state !== 'available' && record.state !== 'unavailable'
    || !Array.isArray(record.reasoningEfforts) || record.reasoningEfforts.length > CHAT_PLAN_REASONING_EFFORTS.length
    || !record.reasoningEfforts.every(effort => typeof effort === 'string' && (CHAT_PLAN_REASONING_EFFORTS as readonly string[]).includes(effort))
    || new Set(record.reasoningEfforts).size !== record.reasoningEfforts.length
    || record.state === 'available' && record.reasoningEfforts.length === 0
    || record.state === 'unavailable' && record.reasoningEfforts.length !== 0
    || !Array.isArray(record.missingReasons) || record.missingReasons.length > 128
    || !record.missingReasons.every(reason => typeof reason === 'string' && reason.trim() !== '' && reason.length <= 256)) return null;
  const capacity = record.capacity === undefined ? undefined : parseChatCapacityRecommendation(record.capacity);
  if (record.capacity !== undefined && (!capacity || record.state !== 'available')) return null;
  const cache = record.cache === undefined ? undefined : asRecord(record.cache);
  if (cache && (cache.source !== 'dsh' && cache.source !== 'provider'
    || typeof cache.updatedAt !== 'number' || !Number.isSafeInteger(cache.updatedAt) || cache.updatedAt < 0
    || !Number.isFinite(new Date(cache.updatedAt).getTime()) || record.state !== 'available')) return null;
  return { ...(capacity ? { capacity } : {}), ...(cache ? { cache: { source: cache.source as 'dsh' | 'provider', updatedAt: cache.updatedAt as number } } : {}), provider: record.provider, model: record.model, state: record.state,
    reasoningEfforts: record.reasoningEfforts as ChatPlanReasoningEffort[], missingReasons: record.missingReasons as string[] };
}

export function parseProviderModelCapabilities(value: unknown): ProviderModelCapabilities | null {
  const source = asRecord(value);
  if (typeof source.provider !== 'string' || source.provider.length === 0 || source.provider.length > 128
    || typeof source.providersRevision !== 'string' || !/^[a-f0-9]{64}$/.test(source.providersRevision)
    || !Array.isArray(source.models) || source.models.length > 128) return null;
  const models = source.models.map(parseModelCapabilities);
  if (models.some(model => model === null || model.provider !== source.provider)
    || new Set(models.map(model => model?.model)).size !== models.length) return null;
  return { provider: source.provider, providersRevision: source.providersRevision, models: models as ModelCapabilities[] };
}
