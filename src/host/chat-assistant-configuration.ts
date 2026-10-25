import { assert, isRecord, snapshot } from '../core/values.ts'
import type { NativeModelProvider } from './model-providers.ts'
import { CHAT_PLAN_REASONING_EFFORTS, type ChatPlanReasoningEffort } from './chat-plans.ts'

export interface ChatAssistantConfiguration {
  readonly schema: 1
  readonly mode: 'chat-only' | 'chat-assistant'
  readonly provider: string | null
  readonly model: string | null
  readonly nickname: string
  readonly reasoningEffort: ChatPlanReasoningEffort | null
}

export const DEFAULT_CHAT_ASSISTANT_CONFIGURATION: Readonly<ChatAssistantConfiguration> = Object.freeze({
  schema: 1, mode: 'chat-only', provider: null, model: null, nickname: '', reasoningEffort: null,
})

export function validateChatAssistantConfiguration(input: unknown): Readonly<ChatAssistantConfiguration> {
  assert(isRecord(input) && Object.keys(input).length >= 4 && Object.keys(input).length <= 6
    && Object.keys(input).every(key => ['schema', 'mode', 'provider', 'model', 'nickname', 'reasoningEffort'].includes(key))
    && (input.reasoningEffort === undefined || input.reasoningEffort === null
      || typeof input.reasoningEffort === 'string' && (CHAT_PLAN_REASONING_EFFORTS as readonly string[]).includes(input.reasoningEffort))
    && (input.nickname === undefined || typeof input.nickname === 'string' && input.nickname.length <= 48
      && !/[\u0000-\u001f\u007f-\u009f]/.test(input.nickname))
    && input.schema === 1 && (input.mode === 'chat-only' || input.mode === 'chat-assistant')
    && (input.provider === null || typeof input.provider === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.provider) && !input.provider.includes('..'))
    && (input.model === null || typeof input.model === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(input.model)
      && !input.model.includes('..') && !input.model.includes('//') && !input.model.endsWith('/'))
    && (input.mode === 'chat-only' || input.provider !== null && input.model !== null),
  'INVALID_CHAT_ASSISTANT', 'An explicit assistant mode and bounded model target are required.')
  return snapshot({ schema: 1, mode: input.mode, provider: input.provider, model: input.model,
    nickname: input.nickname ?? '', reasoningEffort: input.reasoningEffort as ChatPlanReasoningEffort | null | undefined ?? null })
}

export function chatAssistantTargetAvailable(configuration: ChatAssistantConfiguration,
  providers: readonly NativeModelProvider[]): boolean {
  if (configuration.mode === 'chat-only') return true
  const provider = providers.find(candidate => candidate.id === configuration.provider)
  return provider?.enabled === true && provider.models.some(model => model.id === configuration.model)
}

export function chatAssistantConfigurationResponse(revision: string, configuration: ChatAssistantConfiguration) {
  return snapshot({ revision, configuration, executionAvailable: false as const,
    missingReasons: ['assistant_backend_not_connected'] })
}
