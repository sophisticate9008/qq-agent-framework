import { defineServiceContract } from '../contracts/service-contract.ts'
import type { ServiceContract } from '../contracts/service-contract.ts'
import type { ImageGenerationService } from '../contracts/image-generation.ts'
import type { QzoneToolPort } from '../contracts/qzone-tools.ts'
import { NATIVE_HOST_SERVICE_IDS, NATIVE_HOST_SERVICE_VERSION } from '../contracts/native-services.ts'
import type { NativeChatInputPackageService, NativeMediaPackageService, NativeMemoryPackageService } from './default-native-packages.ts'
import type { NativeOutputService } from './native-output.ts'
import type { NativeReminderService } from './native-reminders.ts'
import type { NativeAgentService, NativeExecutionsService, NativeHostServiceMap, NativeInteractionsService,
  NativeToolsService, NativeWorkService } from './native-services.ts'

/** Shared interface declarations; acquiring a service never grants additional permissions. */
export const CHAT_INPUT_SERVICE_CONTRACT = defineServiceContract<NativeChatInputPackageService>({
  id: 'chat-input', version: 1, description: '读取当前会话与人设的聊天唤醒配置。', methods: ['read']
})
export const MEDIA_SERVICE_CONTRACT = defineServiceContract<NativeMediaPackageService>({
  id: 'media', version: 1, description: '登记、读取和解析当前会话的媒体资源；检查与读取适配器另由属性提供。',
  methods: ['readImage', 'register', 'readForPrompt', 'resolveOutgoing']
})
export const REMINDERS_SERVICE_CONTRACT = defineServiceContract<NativeReminderService>({
  id: 'reminders', version: 1, description: '管理提醒规则、发生记录与调度生命周期；功能和效果适配器由属性提供。',
  methods: ['read', 'list', 'history', 'create', 'update', 'setEnabled', 'cancel', 'tick', 'start', 'stop', 'status']
})
export const MEMORY_SERVICE_CONTRACT = defineServiceContract<NativeMemoryPackageService>({
  id: 'memory', version: 1, description: '查询有来源的记忆、准备上下文或提出待确认的记忆建议。', methods: ['query', 'context', 'propose']
})
export const CHAT_OUTPUT_SERVICE_CONTRACT = defineServiceContract<NativeOutputService>({
  id: 'chat-output', version: 1, description: '准备回复内容、读取呈现配置并规划完整消息的发送分组。', methods: ['prepare', 'context', 'split', 'clear']
})
export const QZONE_SERVICE_CONTRACT = defineServiceContract<QzoneToolPort>({
  id: 'qzone', version: 1, description: '检查当前协议端的空间操作支持范围并执行类型化底层操作。', methods: ['describe', 'inspect', 'execute']
})
export const NATIVE_AGENT_SERVICE_CONTRACT = defineServiceContract<NativeAgentService>({
  id: NATIVE_HOST_SERVICE_IDS.agent, version: NATIVE_HOST_SERVICE_VERSION,
  description: '读取聊天代理可用性和实际会话绑定。', methods: ['status', 'binding']
})
export const NATIVE_INTERACTIONS_SERVICE_CONTRACT = defineServiceContract<NativeInteractionsService>({
  id: NATIVE_HOST_SERVICE_IDS.interactions, version: NATIVE_HOST_SERVICE_VERSION,
  description: '读取当前模型交互的有界状态快照。', methods: ['snapshot']
})
export const NATIVE_EXECUTIONS_SERVICE_CONTRACT = defineServiceContract<NativeExecutionsService>({
  id: NATIVE_HOST_SERVICE_IDS.executions, version: NATIVE_HOST_SERVICE_VERSION,
  description: '读取和分页列出实际执行记录。', methods: ['read', 'list']
})
export const NATIVE_TOOLS_SERVICE_CONTRACT = defineServiceContract<NativeToolsService>({
  id: NATIVE_HOST_SERVICE_IDS.tools, version: NATIVE_HOST_SERVICE_VERSION,
  description: '按需读取模型侧的实际工具目录。', methods: ['catalog']
})
export const NATIVE_WORK_SERVICE_CONTRACT = defineServiceContract<NativeWorkService>({
  id: NATIVE_HOST_SERVICE_IDS.work, version: NATIVE_HOST_SERVICE_VERSION,
  description: '读取后台工作状态，并通过调用者作用域启动、追加、停止和核对工作。',
  methods: ['status', 'read', 'list', 'start', 'followup', 'interrupt', 'reconcile']
})
export const IMAGE_GENERATION_SERVICE_CONTRACT = defineServiceContract<ImageGenerationService>({
  id: 'image-generation', version: 1, description: '以稳定幂等键生成图片并返回实际图片字节和摘要。', methods: ['generate']
})

export const NATIVE_HOST_SERVICE_CONTRACTS: {
  readonly [Id in keyof NativeHostServiceMap]: ServiceContract<NativeHostServiceMap[Id]>
} = Object.freeze({
  'native-agent': NATIVE_AGENT_SERVICE_CONTRACT,
  'native-interactions': NATIVE_INTERACTIONS_SERVICE_CONTRACT,
  'native-executions': NATIVE_EXECUTIONS_SERVICE_CONTRACT,
  'native-tools': NATIVE_TOOLS_SERVICE_CONTRACT,
  'native-work': NATIVE_WORK_SERVICE_CONTRACT
})

export interface FrameworkServiceMap extends NativeHostServiceMap {
  'chat-input': NativeChatInputPackageService
  media: NativeMediaPackageService
  reminders: NativeReminderService
  memory: NativeMemoryPackageService
  'chat-output': NativeOutputService
  qzone: QzoneToolPort
  'image-generation': ImageGenerationService
}

/** Definitions of available interfaces, including optional providers; this is not a readiness inventory. */
export const FRAMEWORK_SERVICE_CONTRACTS = Object.freeze({
  'chat-input': CHAT_INPUT_SERVICE_CONTRACT,
  media: MEDIA_SERVICE_CONTRACT,
  reminders: REMINDERS_SERVICE_CONTRACT,
  memory: MEMORY_SERVICE_CONTRACT,
  'chat-output': CHAT_OUTPUT_SERVICE_CONTRACT,
  qzone: QZONE_SERVICE_CONTRACT,
  ...NATIVE_HOST_SERVICE_CONTRACTS,
  'image-generation': IMAGE_GENERATION_SERVICE_CONTRACT
} satisfies { readonly [Id in keyof FrameworkServiceMap]: ServiceContract<FrameworkServiceMap[Id]> })
