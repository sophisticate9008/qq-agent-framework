import type { FeatureDefinition, FeatureExecution, FeatureSetup, FrameworkEvent } from '../core/types.ts'

async function handleConversation(execution: FeatureExecution, event: FrameworkEvent): Promise<unknown> {
  if (event.data.directed !== true || event.data.isSelf === true || typeof event.data.text !== 'string') {
    return undefined
  }

  const result = await execution.generate({
    persona: execution.context.persona.name,
    text: event.data.text,
    configuration: execution.context.configuration,
    preferences: execution.context.preferences,
  })
  const receipt = await execution.send([{ type: 'text', text: result.text }])
  if (receipt.status === 'confirmed') {
    const storedCount = execution.state.get('responseCount', 0)
    const responseCount = typeof storedCount === 'number' ? storedCount : 0
    execution.state.set('responseCount', responseCount + 1)
  }
  return receipt
}

export const conversationFeature: FeatureDefinition = Object.freeze({
  id: 'conversation',
  version: '1.0.0',
  apiVersion: 1,
  capabilities: Object.freeze(['model.respond', 'messaging.send']),
  subscriptions: Object.freeze(['message.received']),
  setup(context: FeatureSetup) {
    context.on('message.received', handleConversation)
  },
})
