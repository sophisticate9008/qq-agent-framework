import { defineServiceContract } from '@qq-agent-framework/sdk/host'
import type { JsonObject } from '@qq-agent-framework/sdk/contracts'

export interface ExampleBehavior {
  describe(input: { readonly lastRunAt: number | null }): Promise<JsonObject>
  tick(input: { readonly id: string; readonly at: number; readonly origin: 'tool' | 'schedule' }): Promise<JsonObject>
}

export const EXAMPLE_BEHAVIOR_CONTRACT = defineServiceContract<ExampleBehavior>({
  id: 'example-behavior', version: 1, description: '可替换的示例状态与定时处理行为。', methods: ['describe', 'tick'],
})
