import type { EventReport, FeatureOutcome } from './types.ts';
import { FrameworkError, assert, identifier, isRecord, reference } from './values.ts';

export function assertRequiredEventOutcomes(report: EventReport, requiredFeatures: readonly string[]): void {
  assert(Array.isArray(requiredFeatures) && requiredFeatures.length > 0 && requiredFeatures.length <= 256
    && requiredFeatures.every(identifier) && new Set(requiredFeatures).size === requiredFeatures.length,
  'INVALID_REQUIRED_CONSUMERS', 'Explicit distinct required event consumers are needed.');
  assert(isRecord(report) && reference(report.eventId) && reference(report.conversationId)
    && Array.isArray(report.outcomes) && report.outcomes.length <= 4096,
  'EVENT_REPORT_UNKNOWN', 'The event report could not be verified.');
  const outcomes = new Map<string, FeatureOutcome>();
  for (const outcome of report.outcomes) {
    assert(isRecord(outcome) && identifier(outcome.featureId) && !outcomes.has(outcome.featureId)
      && ['completed', 'failed'].includes(outcome.status)
      && (outcome.errorCode === undefined || typeof outcome.errorCode === 'string' && /^[A-Z][A-Z_]{1,63}$/.test(outcome.errorCode))
      && (outcome.status !== 'completed' || outcome.errorCode === undefined),
    'EVENT_REPORT_UNKNOWN', 'The event report could not be verified.');
    outcomes.set(outcome.featureId, outcome);
  }
  const required = requiredFeatures.map(featureId => outcomes.get(featureId));
  if (required.some(outcome => outcome?.status === 'failed'
    && (!outcome.errorCode || /UNKNOWN|TIMEOUT|ABORT/.test(outcome.errorCode)))) {
    throw new FrameworkError('EVENT_REQUIRED_OUTCOME_UNKNOWN', 'A required consumer did not confirm completion.');
  }
  if (required.some(outcome => outcome === undefined)) {
    throw new FrameworkError('EVENT_REQUIRED_CONSUMER_MISSING', 'A required consumer did not handle the event.');
  }
  const failed = required.find(outcome => outcome?.status === 'failed');
  if (failed) throw new FrameworkError(failed.errorCode ?? 'EVENT_REQUIRED_OUTCOME_UNKNOWN', 'A required consumer failed.');
}
