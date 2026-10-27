import { nativeToolCapabilityDefinition, type NativeToolCapability } from '../contracts/native-tool-capabilities.ts';
import type { JsonObject, JsonValue } from '../core/types.ts';
import { assert, isRecord } from '../core/values.ts';
import { validateNativeReminderConfiguration } from '../contracts/native-reminders.ts';
import { validateNativeMemoryInput } from '../contracts/native-memory.ts';
import type { NativeToolContribution } from './native-framework-tools.ts';

const object = (properties: JsonObject): JsonObject => ({ type: 'object', additionalProperties: false,
  required: Object.keys(properties), properties });
const id: JsonObject = { type: 'string', minLength: 1, maxLength: 100 };
const revision: JsonObject = { type: 'integer', minimum: 1 };
const schedule: JsonObject = { oneOf: [object({ kind: { const: 'once' }, at: { type: 'integer', minimum: 0 } }),
  object({ kind: { const: 'delay' }, delayMs: { type: 'integer', minimum: 1000, maximum: 31622400000 } }),
  object({ kind: { const: 'daily' }, hour: { type: 'integer', minimum: 0, maximum: 23 }, minute: { type: 'integer', minimum: 0, maximum: 59 } }),
  object({ kind: { const: 'weekly' }, dayOfWeek: { type: 'integer', minimum: 1, maximum: 7 },
    hour: { type: 'integer', minimum: 0, maximum: 23 }, minute: { type: 'integer', minimum: 0, maximum: 59 } })] };
const reminderProperties: JsonObject = { text: { type: 'string', minLength: 1, maxLength: 4000 },
  timeZone: { type: 'string', minLength: 1, maxLength: 100 }, schedule, enabled: { type: 'boolean' } };
function exact(value: JsonValue, keys: readonly string[]): Record<string, JsonValue> {
  assert(isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)),
    'INVALID_TOOL_INPUT', 'The tool input contains unexpected or missing fields.');
  return value as Record<string, JsonValue>;
}
function identified(value: Record<string, JsonValue>) {
  assert(typeof value.id === 'string' && /^[a-z0-9][a-z0-9.-]{0,99}$/.test(value.id)
    && typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision > 0,
  'INVALID_TOOL_INPUT', 'The current stored identity and revision are required.');
}
function contribution(name: string, capability: NativeToolCapability, parameters: JsonObject,
  validate: (value: JsonValue) => JsonValue): NativeToolContribution {
  return { definition: { name, capability, description: nativeToolCapabilityDefinition(capability).description, parameters, featureId: 'framework-tools', timeoutMs: 10_000 }, validate };
}
function reminder(value: JsonValue): JsonValue {
  const input = exact(value, ['text', 'timeZone', 'schedule', 'enabled']);
  validateNativeReminderConfiguration({ ...input, conversationId: 'private:1' });
  return input;
}
export const NATIVE_REMINDER_TOOLS: readonly NativeToolContribution[] = Object.freeze([
  contribution('qaf_reminder_list', 'reminders.list', object({}), value => exact(value, [])),
  contribution('qaf_reminder_create', 'reminders.create',
    object(reminderProperties), reminder),
  contribution('qaf_reminder_update', 'reminders.update',
    object({ id, revision, configuration: object(reminderProperties) }), value => {
      const input = exact(value, ['id', 'revision', 'configuration']); identified(input); reminder(input.configuration); return input;
    }),
  contribution('qaf_reminder_set_enabled', 'reminders.set-enabled',
    object({ id, revision, enabled: { type: 'boolean' } }), value => {
      const input = exact(value, ['id', 'revision', 'enabled']); identified(input);
      assert(typeof input.enabled === 'boolean', 'INVALID_TOOL_INPUT', 'Enabled must be explicit.'); return input;
    }),
  contribution('qaf_reminder_cancel', 'reminders.cancel', object({ id, revision }), value => {
    const input = exact(value, ['id', 'revision']); identified(input); return input;
  })
]);
export const NATIVE_MEMORY_TOOLS: readonly NativeToolContribution[] = Object.freeze([
  contribution('qaf_memory_query', 'memory.query',
    object({ query: { type: 'string', maxLength: 256 } }), value => {
      const input = exact(value, ['query']); assert(typeof input.query === 'string' && input.query.length <= 256,
        'INVALID_TOOL_INPUT', 'Memory query must be bounded.'); return input;
    }),
  contribution('qaf_memory_propose', 'memory.propose',
    object({ kind: { enum: ['memory', 'preference'] }, content: { type: 'string', minLength: 1, maxLength: 4000 },
      tags: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 64 }, maxItems: 16, uniqueItems: true },
      expiresAt: { type: ['integer', 'null'], minimum: 0 } }), value => {
      const input = exact(value, ['kind', 'content', 'tags', 'expiresAt']);
      validateNativeMemoryInput({ ...input, scope: { kind: 'user', userId: '1', conversationId: 'private:1' } }); return input;
    })
]);
