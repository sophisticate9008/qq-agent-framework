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
}

const effortLabels: Readonly<Record<ChatPlanReasoningEffort, string>> = {
  off: 'off', low: 'low', medium: 'medium', high: 'high', max: 'max',
};

export function modelReasoningEffortLabel(effort: string): string {
  return Object.hasOwn(effortLabels, effort) ? effortLabels[effort as ChatPlanReasoningEffort] : effort;
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
  return { ...(capacity ? { capacity } : {}), provider: record.provider, model: record.model, state: record.state,
    reasoningEfforts: record.reasoningEfforts as ChatPlanReasoningEffort[], missingReasons: record.missingReasons as string[] };
}
