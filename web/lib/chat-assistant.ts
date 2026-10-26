import { isRecord } from './api.ts';
import { CHAT_PLAN_REASONING_EFFORTS, type ChatPlanReasoningEffort } from '../../src/contracts/chat-plans.ts';
export { parseUsagePricingProviders as parseAssistantProviders } from './usage-pricing.ts';
export type { UsagePricingProvider as AssistantProvider } from './usage-pricing.ts';

export interface ChatAssistantConfiguration {
  readonly schema: 1;
  readonly mode: 'chat-only' | 'chat-assistant';
  readonly provider: string | null;
  readonly model: string | null;
  readonly nickname: string;
  readonly reasoningEffort: ChatPlanReasoningEffort | null;
}

interface ChatAssistantSnapshotBase {
  readonly revision: string;
  readonly configuration: ChatAssistantConfiguration;
}

export type ChatAssistantSnapshot = ChatAssistantSnapshotBase & ({
  readonly state: 'available';
  readonly executionAvailable: true;
  readonly missingReasons: readonly [];
} | {
  readonly state: 'unavailable';
  readonly executionAvailable: false;
  readonly missingReasons: readonly [string, ...string[]];
});

function reference(value: unknown, model = false): value is string {
  const pattern = model ? /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/ : /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  return typeof value === 'string' && pattern.test(value)
    && !value.includes('..') && !value.includes('//') && !value.endsWith('/');
}

export function parseAssistantConfiguration(value: unknown): ChatAssistantConfiguration | null {
  if (!isRecord(value) || Object.keys(value).length < 4 || Object.keys(value).length > 6
    || !Object.keys(value).every(key => ['schema', 'mode', 'provider', 'model', 'nickname', 'reasoningEffort'].includes(key)) || value.schema !== 1
    || value.reasoningEffort !== undefined && value.reasoningEffort !== null
      && (typeof value.reasoningEffort !== 'string' || !(CHAT_PLAN_REASONING_EFFORTS as readonly string[]).includes(value.reasoningEffort))
    || value.nickname !== undefined && (typeof value.nickname !== 'string' || value.nickname.length > 48
      || /[\u0000-\u001f\u007f-\u009f]/.test(value.nickname))
    || value.mode !== 'chat-only' && value.mode !== 'chat-assistant'
    || value.provider !== null && !reference(value.provider) || value.model !== null && !reference(value.model, true)
    || value.mode === 'chat-assistant' && (value.provider === null || value.model === null)) return null;
  return { schema: 1, mode: value.mode, provider: value.provider as string | null, model: value.model as string | null,
    nickname: typeof value.nickname === 'string' ? value.nickname : '',
    reasoningEffort: value.reasoningEffort as ChatPlanReasoningEffort | null | undefined ?? null };
}

export function parseChatAssistant(value: unknown): ChatAssistantSnapshot | null {
  if (!isRecord(value) || typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision)
    || typeof value.executionAvailable !== 'boolean' || !Array.isArray(value.missingReasons)
    || value.missingReasons.length > 32
    || !value.missingReasons.every((reason: unknown): reason is string => typeof reason === 'string'
      && /^[a-z][a-z0-9_.:-]{0,127}$/.test(reason))
    || new Set(value.missingReasons).size !== value.missingReasons.length) return null;
  const configuration = parseAssistantConfiguration(value.configuration);
  if (!configuration) return null;
  if (value.executionAvailable) return value.missingReasons.length === 0
    ? { revision: value.revision, configuration, state: 'available', executionAvailable: true, missingReasons: [] } : null;
  const [first, ...rest] = value.missingReasons;
  return first === undefined ? null : { revision: value.revision, configuration, state: 'unavailable', executionAvailable: false,
    missingReasons: [first, ...rest] };
}

export function assistantAvailabilityMessage(snapshot: ChatAssistantSnapshot): string {
  if (snapshot.configuration.mode === 'chat-only') return '助手已关闭';
  if (snapshot.state === 'available') return '助手已启用';
  const reasons = snapshot.missingReasons.join(' ');
  if (/not_running/.test(reasons)) return '助手已保存，聊天尚未启动';
  if (/not_applied/.test(reasons)) return '助手尚未启用';
  if (/reconciliation|unknown|interrupted/.test(reasons)) return '助手加载结果待确认，请刷新状态';
  if (/pending_reload|reload/.test(reasons)) return '助手模型等待 DSH 加载';
  if (/model_unavailable|model_not_configured|provider/.test(reasons)) return '所选助手模型不可用，请检查模型连接';
  if (/reasoning/.test(reasons)) return '助手思考等级不受支持，请重新选择';
  if (/connect|backend|channel|local_target/.test(reasons)) return '助手连接不可用，请检查 DSH';
  return '助手未就绪，请查看详情';
}

export function sameAssistantConfiguration(left: ChatAssistantConfiguration, right: ChatAssistantConfiguration): boolean {
  return left.schema === right.schema && left.mode === right.mode && left.provider === right.provider
    && left.model === right.model && left.nickname === right.nickname && left.reasoningEffort === right.reasoningEffort;
}
