import { isChatPlan, validateChatPlan, validateChatPlanCatalog, type NormalizedChatPlan } from '../../src/contracts/chat-plans.ts';
import { NATIVE_REVISION_PATTERN } from '../../src/contracts/native-revisions.ts';
import { isRecord } from './api.ts';

/** The form can be incomplete; persisted plans always use the shared domain decoder. */
export type ChatPlanDraft = Omit<NormalizedChatPlan, 'reasoningEffort'> & {
  readonly reasoningEffort: NormalizedChatPlan['reasoningEffort'] | '';
};

export interface ChatPlanCatalogSnapshot {
  readonly revision: string;
  readonly activePlanId: string | null;
  readonly plans: readonly NormalizedChatPlan[];
}

export function parsePlan(value: unknown): NormalizedChatPlan | null {
  return isChatPlan(value) ? validateChatPlan(value) : null;
}

export function parsePlanCatalog(value: unknown): ChatPlanCatalogSnapshot | null {
  if (!isRecord(value) || typeof value.revision !== 'string' || !NATIVE_REVISION_PATTERN.test(value.revision)
    || Object.keys(value).length !== 3 || !Object.keys(value).every(key => ['revision', 'activePlanId', 'plans'].includes(key))) return null;
  try {
    const catalog = validateChatPlanCatalog({ activePlanId: value.activePlanId, plans: value.plans });
    return { revision: value.revision, activePlanId: catalog.activePlanId, plans: catalog.plans.map(validateChatPlan) };
  } catch { return null; }
}
