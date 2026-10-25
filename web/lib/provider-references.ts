import type { ChatAssistantSnapshot } from './chat-assistant.ts';
import type { ChatPlanCatalogSnapshot } from './chat-plans.ts';

export type ProviderReference = {
  readonly kind: 'plan'; readonly id: string; readonly name: string; readonly provider: string; readonly model: string;
} | {
  readonly kind: 'assistant'; readonly id: 'assistant'; readonly name: string; readonly provider: string; readonly model: string;
};

export function providerReferences(provider: string, plans: ChatPlanCatalogSnapshot | null,
  assistant: ChatAssistantSnapshot | null): readonly ProviderReference[] {
  const references: ProviderReference[] = (plans?.plans ?? []).filter(plan => plan.provider === provider)
    .map(plan => ({ kind: 'plan', id: plan.id, name: plan.name, provider: plan.provider, model: plan.model }));
  const configuration = assistant?.configuration;
  if (configuration?.provider === provider && configuration.model !== null) references.push({ kind: 'assistant', id: 'assistant',
    name: configuration.mode === 'chat-assistant' ? '独立助手' : '独立助手（保留的模型选择）',
    provider, model: configuration.model });
  return references;
}
