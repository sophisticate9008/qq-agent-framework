import { defineServiceContract } from '@qq-agent-framework/sdk/host'
import type { ExampleBehavior } from '../contract.ts'

// Module evaluation only declares behavior. Registrations and recurring work belong to the stable package.
export const contract = defineServiceContract<ExampleBehavior>({
  id: 'example-behavior', version: 1, description: '可替换的示例状态与定时处理行为。', methods: ['describe', 'tick'],
})

const behavior: ExampleBehavior = {
  async describe(input) {
    return { status: 'confirmed', message: '示例行为已就绪。', lastRunAt: input.lastRunAt }
  },
  async tick(input) {
    return { status: 'confirmed', id: input.id, at: input.at, origin: input.origin, message: '已完成本次示例处理。' }
  },
}

export default behavior
