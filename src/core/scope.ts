import type { OutboundScope } from './types.ts';
import { assert, isRecord, reference, snapshot } from './values.ts';

export function normalizeOutboundScope(input: unknown): Readonly<OutboundScope> {
  const value = snapshot(input);
  assert(isRecord(value) && Object.keys(value).every(key => ['persona', 'sessionId', 'generation'].includes(key))
    && isRecord(value.persona) && Object.keys(value.persona).every(key => ['id', 'version'].includes(key))
    && reference(value.persona.id) && reference(value.persona.version)
    && !value.persona.id.includes('@') && !value.persona.version.includes('@')
    && (value.sessionId === undefined || reference(value.sessionId))
    && (value.generation === undefined || reference(value.sessionId)
      && Number.isSafeInteger(value.generation) && Number(value.generation) > 0),
  'INVALID_SCOPE', 'An explicit, versioned outbound scope is required.');
  return value as unknown as Readonly<OutboundScope>;
}

export function personaKey(scope: Readonly<OutboundScope>): string {
  return `${scope.persona.id}@${scope.persona.version}`;
}
