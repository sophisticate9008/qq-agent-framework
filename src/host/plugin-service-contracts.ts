import { defineServiceContract } from '../contracts/service-contract.ts'
import type { PluginRuntimeServices } from './plugin-runtime.ts'

export const PLUGIN_RUNTIME_PACKAGE_ID = 'plugin-runtime'
export const PLUGIN_MODELS_SERVICE_CONTRACT = defineServiceContract<PluginRuntimeServices['models']>({ id: 'plugin-models', version: 1,
  description: '插件模型选择、持久会话和多模态请求。', methods: ['models', 'list', 'bind', 'unbind', 'create', 'run'] })
export const PLUGIN_PROTOCOL_SERVICE_CONTRACT = defineServiceContract<PluginRuntimeServices['capabilities']>({ id: 'plugin-protocol', version: 1,
  description: '实际协议能力目录与按插件去重的协议调用。', methods: ['catalog', 'call'] })
export const PLUGIN_SESSIONS_SERVICE_CONTRACT = defineServiceContract<PluginRuntimeServices['sessions']>({ id: 'plugin-sessions', version: 1,
  description: '读取及管理实际 QQ 会话绑定。', methods: ['resolve', 'bind', 'unbind'] })
export const PLUGIN_SCHEDULER_SERVICE_CONTRACT = defineServiceContract<NonNullable<PluginRuntimeServices['scheduler']>>({ id: 'plugin-scheduler', version: 1,
  description: '插件持久日程、回调与只读业务详情登记及发生记录。', methods: ['registerHandler', 'registerDetailsProvider', 'schedule', 'list', 'cancel', 'history'] })
export const PLUGIN_TOOLS_SERVICE_CONTRACT = defineServiceContract<NonNullable<PluginRuntimeServices['tools']>>({ id: 'plugin-tools', version: 1,
  description: '登记插件二级工具并随生命周期撤销。', methods: ['register'] })
export const PLUGIN_MEDIA_SERVICE_CONTRACT = defineServiceContract<NonNullable<PluginRuntimeServices['media']>>({ id: 'plugin-media', version: 1,
  description: '按实际会话访问规则读取已登记图片。', methods: ['readImage'] })
export const PLUGIN_EXTENSIONS_SERVICE_CONTRACT = defineServiceContract<NonNullable<PluginRuntimeServices['extensions']>>({ id: 'plugin-extensions', version: 1,
  description: '登记及查看本插件可热重载的实现。', methods: ['register', 'list'] })
export const PLUGIN_USAGE_SERVICE_CONTRACT = defineServiceContract<NonNullable<PluginRuntimeServices['usage']>>({ id: 'plugin-usage', version: 1,
  description: '只读查询实际归属于本插件的用量账本。', methods: ['list', 'summary'] })
export const PLUGIN_EVENTS_SERVICE_CONTRACT = defineServiceContract<NonNullable<PluginRuntimeServices['events']>>({ id: 'plugin-events', version: 1,
  description: '读取及订阅宿主生命周期和可核实归属的插件执行事件。', methods: ['read', 'subscribe'] })
export const PLUGIN_SERVICE_CONTRACTS = Object.freeze({ models: PLUGIN_MODELS_SERVICE_CONTRACT, capabilities: PLUGIN_PROTOCOL_SERVICE_CONTRACT,
  sessions: PLUGIN_SESSIONS_SERVICE_CONTRACT, scheduler: PLUGIN_SCHEDULER_SERVICE_CONTRACT, tools: PLUGIN_TOOLS_SERVICE_CONTRACT,
  media: PLUGIN_MEDIA_SERVICE_CONTRACT, extensions: PLUGIN_EXTENSIONS_SERVICE_CONTRACT,
  usage: PLUGIN_USAGE_SERVICE_CONTRACT, events: PLUGIN_EVENTS_SERVICE_CONTRACT })
