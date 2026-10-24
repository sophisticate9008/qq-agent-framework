import type {
  FeatureDefinition,
  FeatureExecution,
  FeatureSetup,
  FrameworkEvent,
  JsonValue,
} from '../core/types.ts'

function firstText(values: readonly (JsonValue | undefined)[], fallback: string): string {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0) ?? fallback
}

async function handleReminder(execution: FeatureExecution, event: FrameworkEvent): Promise<unknown> {
  if (event.data.kind !== 'reminder') {
    return undefined
  }

  const configuration = execution.context.configuration
  const preferences = execution.context.preferences
  const text = firstText([
    event.data.text,
    preferences.reminderDefaultText,
    configuration.reminderDefaultText,
  ], '该处理提醒事项了。')
  const prefix = firstText([
    preferences.reminderPrefix,
    configuration.reminderPrefix,
  ], '提醒：')
  const receipt = await execution.send([{ type: 'text', text: `${prefix}${text}` }])
  if (receipt.status === 'confirmed') {
    const storedCount = execution.state.get('sentCount', 0)
    const sentCount = typeof storedCount === 'number' ? storedCount : 0
    execution.state.set('sentCount', sentCount + 1)
  }
  return receipt
}

export const reminderFeature: FeatureDefinition = Object.freeze({
  id: 'reminder',
  version: '1.0.0',
  apiVersion: 1,
  capabilities: Object.freeze(['messaging.send']),
  subscriptions: Object.freeze(['trigger.fired']),
  setup(context: FeatureSetup) {
    context.on('trigger.fired', handleReminder)
  },
})
