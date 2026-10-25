import type { ConfigurationOperationSource } from './configuration-operation-recovery.ts';
export { configurationOperationStore } from './configuration-operation-recovery.ts';
export type { ConfigurationOperationSource, ConfigurationOperationReason, ConfigurationOperationBlock } from './configuration-operation-recovery.ts';

export function configurationApplyOutcome(value: unknown, source: ConfigurationOperationSource, revision: string): 'applied' | 'accepted' | 'unknown' {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unknown';
  const result = value as Record<string, unknown>;
  if (result.ok !== true || result.source !== source || result.revision !== revision
    || result.status !== undefined || result.result !== undefined
    || !result.application || typeof result.application !== 'object' || Array.isArray(result.application)) return 'unknown';
  const application = result.application as Record<string, unknown>;
  if (application.status !== undefined || application.result !== undefined || application.ok === false) return 'unknown';
  if (application.applied === true && application.accepted !== true) return 'applied';
  if (application.accepted !== true || application.applied === true || typeof application.reconnectUrl !== 'string') return 'unknown';
  try {
    const target = new URL(application.reconnectUrl);
    return ['http:', 'https:'].includes(target.protocol) && !target.username && !target.password ? 'accepted' : 'unknown';
  } catch {
    return 'unknown';
  }
}
