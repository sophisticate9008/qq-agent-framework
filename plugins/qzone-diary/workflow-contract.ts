import { defineServiceContract } from '../../src/contracts/service-contract.ts'
import type { DiaryWorkflow } from './types.ts'

/** Fixed handler inputs and behavior methods are compatible within this version. */
export const DIARY_WORKFLOW_CONTRACT = defineServiceContract<DiaryWorkflow>({
  id: 'qzone-diary-workflow', version: 1, description: '空间日记的规划、图像审查、发布与日程恢复行为。',
  methods: ['start', 'planDay', 'publishSlot', 'publishApproved', 'status', 'read', 'maintain', 'stop']
})
