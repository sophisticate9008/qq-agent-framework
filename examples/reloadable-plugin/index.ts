import { fileURLToPath } from 'node:url'
import {
  createExtensionModuleLoader, createReloadableHandler, createReloadableService, defineNativeBootstrap,
  PLUGIN_RUNTIME_PACKAGE_ID, PLUGIN_SCHEDULER_SERVICE_CONTRACT, PLUGIN_TOOLS_SERVICE_CONTRACT,
  PLUGIN_EXTENSIONS_SERVICE_CONTRACT, publishService, serviceDeclaration, useService,
  type NativePackageDefinition, type PluginDirectoryTool, type PluginScheduledOccurrence,
} from '@qq-bridge-framework/sdk/host'
import type { JsonObject } from '@qq-bridge-framework/sdk/contracts'
import { EXAMPLE_BEHAVIOR_CONTRACT } from './contract.ts'

const owner = 'reloadable-example'

export default defineNativeBootstrap({
  manifest: { id: 'reloadable-example-bootstrap', version: '1.0.0', apiVersion: 1 },
  create(hostContext) {
    const definition: NativePackageDefinition = {
      manifest: {
        schema: 1, id: owner, version: '1.0.0', displayName: '可重载服务示例', description: '固定工具和日程入口，按版本替换处理行为。',
        toolNames: [`extension.${owner}.status`, `extension.${owner}.run`], dependencies: [PLUGIN_RUNTIME_PACKAGE_ID],
        provides: [serviceDeclaration(EXAMPLE_BEHAVIOR_CONTRACT)],
        requires: [serviceDeclaration(PLUGIN_SCHEDULER_SERVICE_CONTRACT), serviceDeclaration(PLUGIN_TOOLS_SERVICE_CONTRACT),
          serviceDeclaration(PLUGIN_EXTENSIONS_SERVICE_CONTRACT)],
        contributions: [],
      },
      async start(context) {
        const scheduler = useService(context, PLUGIN_SCHEDULER_SERVICE_CONTRACT)
        const tools = useService(context, PLUGIN_TOOLS_SERVICE_CONTRACT)
        const extensions = useService(context, PLUGIN_EXTENSIONS_SERVICE_CONTRACT)
        const store = context.store(hostContext.store)
        const loader = createExtensionModuleLoader({
          entry: fileURLToPath(new URL('./behavior/index.ts', import.meta.url)),
          root: fileURLToPath(new URL('./behavior/', import.meta.url)),
        })
        const { manager, service } = await createReloadableService({
          id: owner, displayName: '可重载服务示例', contract: EXAMPLE_BEHAVIOR_CONTRACT,
          asyncMethods: ['describe', 'tick'], signal: context.signal,
          async load(signal) {
            const loaded = await loader.load(signal)
            if (loaded.namespace === null || typeof loaded.namespace !== 'object'
              || !('contract' in loaded.namespace) || !('default' in loaded.namespace)) throw new Error('Example behavior module exports are missing')
            return { revision: loaded.revision, contract: loaded.namespace.contract, value: loaded.namespace.default }
          },
        })
        // Own the manager before registering anything that may fail later in package startup.
        context.own('other', 'behavior-manager', () => manager.close())
        context.own('subscription', 'reload-registration', extensions.register(manager))
        publishService(context, EXAMPLE_BEHAVIOR_CONTRACT, service)

        const remember = (id: string, result: JsonObject) => {
          const prior = store.read('runs', id)
          if (prior) return prior.value
          store.write('runs', id, result, { expectedRevision: null, expiresAt: Date.now() + 7 * 86_400_000 })
          return result
        }
        const lastRunAt = () => {
          const rows = store.list('runs', { limit: 1000 })
          return rows.length ? Math.max(...rows.map(row => row.updatedAt)) : null
        }
        context.own('subscription', 'status-tool', tools.register({
          id: 'status', description: '查看可重载示例的当前行为与最近执行时间。', permission: 'owner', readOnly: true,
          parameters: { type: 'object', additionalProperties: false, properties: {} },
          async execute(_input, request) {
            request.signal.throwIfAborted()
            return service.describe({ lastRunAt: lastRunAt() })
          },
        }))
        context.own('subscription', 'run-tool', tools.register({
          id: 'run', description: '执行一次示例行为并保存本地结果。', permission: 'owner', readOnly: false,
          parameters: { type: 'object', additionalProperties: false, properties: {} },
          execute: createReloadableHandler(manager, async (behavior, _input: JsonObject, request: Parameters<PluginDirectoryTool['execute']>[1]) => {
            request.signal.throwIfAborted()
            const result = await behavior.tick({ id: request.invocationId, at: Date.now(), origin: 'tool' })
            request.signal.throwIfAborted()
            return remember(request.invocationId, result)
          }),
        }))
        context.own('subscription', 'scheduled-handler', scheduler.registerHandler('example-tick',
          createReloadableHandler(manager, async (behavior, occurrence: PluginScheduledOccurrence) => {
            occurrence.signal.throwIfAborted()
            const result = await behavior.tick({ id: occurrence.id, at: occurrence.scheduledAt, origin: 'schedule' })
            occurrence.signal.throwIfAborted()
            remember(occurrence.id, result)
          })))
        // Register this fixed rule once; loading a candidate only replaces its behavior.
        scheduler.schedule({ id: 'example-daily', handler: 'example-tick', payload: {}, timeZone: 'UTC',
          schedule: { kind: 'daily', hour: 9, minute: 0 }, windowMs: 3_600_000, misfire: 'skip' })
      },
    }
    return { packages: [definition] }
  },
})
