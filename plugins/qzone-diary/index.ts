import { assert } from '../../src/core/values.ts'
import { json } from '../../src/host/data.ts'
import { fileURLToPath } from 'node:url'
import type { NativePackageDefinition } from '../../src/host/native-packages.ts'
import { validateServiceContractImplementation } from '../../src/contracts/service-contract.ts'
import { createExtensionModuleLoader } from '../../src/host/extension-module-loader.ts'
import { createBuiltinPackageContent } from '../../src/host/native-package-content.ts'
import { createReloadableExtension } from '../../src/host/reloadable-extensions.ts'
import { IMAGE_GENERATION_SERVICE_CONTRACT } from '../../src/host/framework-service-contracts.ts'
import { PLUGIN_RUNTIME_PACKAGE_ID, PLUGIN_MODELS_SERVICE_CONTRACT, PLUGIN_PROTOCOL_SERVICE_CONTRACT,
  PLUGIN_SCHEDULER_SERVICE_CONTRACT, PLUGIN_TOOLS_SERVICE_CONTRACT, PLUGIN_EXTENSIONS_SERVICE_CONTRACT } from '../../src/host/plugin-service-contracts.ts'
import { serviceDeclaration, useService } from '../../src/host/service-contract.ts'
import { DIARY_WORKFLOW_CONTRACT } from './workflow-contract.ts'
import type { DiaryOptions, DiaryWorkflow } from './types.ts'
import { createDiaryScheduleDetails } from './management.ts'

const fixedContent = createBuiltinPackageContent(import.meta.url, ['./workflow-contract', './types', './management', './media-store', './time'])
const moduleExtension = import.meta.url.endsWith('.ts') ? '.ts' : '.js'

export function createQzoneDiaryPackage(options: Omit<DiaryOptions, 'runtime' | 'images' | 'signal'> & {
  readonly imagePackageId: string
  readonly setEnabled?: (enabled: boolean) => Promise<void>
}): NativePackageDefinition {
  const names = ['status', 'plan', 'set-enabled'].map(id => `extension.qzone-diary.${id}`)
  return {
    manifest: { schema: 1, id: 'qzone-diary', version: '1.0.0', displayName: '空间生活日记',
      description: '在每日时间段内安排1–3条图文动态，使用角色参考图生成生活画面，经图像审查后发布到QQ空间。',
      toolNames: names, dependencies: [options.imagePackageId, PLUGIN_RUNTIME_PACKAGE_ID], provides: [],
      requires: [serviceDeclaration(IMAGE_GENERATION_SERVICE_CONTRACT), serviceDeclaration(PLUGIN_MODELS_SERVICE_CONTRACT),
        serviceDeclaration(PLUGIN_PROTOCOL_SERVICE_CONTRACT), serviceDeclaration(PLUGIN_SCHEDULER_SERVICE_CONTRACT),
        serviceDeclaration(PLUGIN_TOOLS_SERVICE_CONTRACT), serviceDeclaration(PLUGIN_EXTENSIONS_SERVICE_CONTRACT)], contributions: [] },
    async start(context) {
      const images = useService(context, IMAGE_GENERATION_SERVICE_CONTRACT)
      const models = useService(context, PLUGIN_MODELS_SERVICE_CONTRACT)
      const capabilities = useService(context, PLUGIN_PROTOCOL_SERVICE_CONTRACT)
      const scheduler = useService(context, PLUGIN_SCHEDULER_SERVICE_CONTRACT)
      const tools = useService(context, PLUGIN_TOOLS_SERVICE_CONTRACT)
      const extensions = useService(context, PLUGIN_EXTENSIONS_SERVICE_CONTRACT)
      const workflowOptions: DiaryOptions = { ...options, runtime: { models, capabilities, scheduler }, images, signal: context.signal }
      for (const handler of ['plan', 'publish'] as const) {
        context.own('subscription', `schedule-details-${handler}`, scheduler.registerDetailsProvider(handler, createDiaryScheduleDetails(handler, workflowOptions)))
      }
      const loader = createExtensionModuleLoader({ entry: fileURLToPath(new URL(`./workflow${moduleExtension}`, import.meta.url)),
        root: fileURLToPath(new URL('./', import.meta.url)) })
      const manager = await createReloadableExtension<DiaryWorkflow>({ id: 'qzone-diary', displayName: '空间生活日记', signal: context.signal,
        async load(signal) {
          // A new workflow revision must never claim to have applied edits to fixed registrations.
          fixedContent.verify(signal)
          const loaded = await loader.load(signal)
          fixedContent.verify(signal)
          const namespace = loaded.namespace
          assert(namespace !== null && typeof namespace === 'object' && 'DIARY_WORKFLOW_CONTRACT' in namespace
            && 'createQzoneDiary' in namespace && typeof namespace.createQzoneDiary === 'function',
          'DIARY_WORKFLOW_MODULE_INVALID', 'A versioned diary workflow factory is required.')
          const contract = namespace.DIARY_WORKFLOW_CONTRACT
          assert(contract !== null && typeof contract === 'object' && 'id' in contract && contract.id === DIARY_WORKFLOW_CONTRACT.id
            && 'version' in contract && contract.version === DIARY_WORKFLOW_CONTRACT.version
            && 'methods' in contract && Array.isArray(contract.methods),
          'DIARY_WORKFLOW_CONTRACT_MISMATCH', 'Workflow handler inputs and methods must remain compatible with the installed package.')
          const methods: readonly unknown[] = contract.methods
          assert(methods.length === DIARY_WORKFLOW_CONTRACT.methods.length
            && DIARY_WORKFLOW_CONTRACT.methods.every(method => methods.includes(method)),
          'DIARY_WORKFLOW_CONTRACT_MISMATCH', 'Workflow handler inputs and methods must remain compatible with the installed package.')
          // Candidate construction has no registrations, recovery pass or scheduled side effects.
          const value: unknown = Reflect.apply(namespace.createQzoneDiary, undefined, [workflowOptions])
          validateServiceContractImplementation(DIARY_WORKFLOW_CONTRACT, value)
          return { revision: loaded.revision, value, dispose: () => value.stop() }
        } })
      context.own('task', 'workflow', () => manager.close())
      context.own('subscription', 'workflow-reload', extensions.register(manager))
      const releaseHandlers = manager.current().start({
        plan: occurrence => manager.withCurrent(async diary => { await diary.maintain(); await diary.planDay(occurrence.signal) }),
        publish: occurrence => manager.withCurrent(async diary => {
          assert(typeof occurrence.payload.date === 'string' && typeof occurrence.payload.slot === 'number', 'DIARY_TRIGGER_INVALID', 'A saved slot is required.')
          await diary.publishSlot(occurrence.payload.date, occurrence.payload.slot, occurrence.signal)
        })
      })
      context.own('subscription', 'workflow-handlers', releaseHandlers)
      context.own('subscription', 'status', tools.register({ id: 'status', description: '查看空间生活日记插件的今日时间安排、图文审查与发布状态。',
        readOnly: true, permission: 'owner', parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute() { return manager.withCurrent(diary => json(diary.status())) } }))
      context.own('subscription', 'plan', tools.register({ id: 'plan', description: '为空间生活日记安排今日计划；已有计划保持不变，不额外增加当天发布次数。',
        readOnly: false, permission: 'owner', parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute(_input, request) { return manager.withCurrent(async () => {
          request.signal.throwIfAborted()
          scheduler.schedule({ id: `manual-${request.invocationId}`, handler: 'plan', payload: {},
            presentation: { title: '检查今天的空间日记安排', ownerLabel: '空间生活日记', description: '沿用已有计划，不额外增加当天发布次数。' },
            schedule: { kind: 'once', at: Date.now() + 1000 }, windowMs: 1800000, timeZone: options.configuration().timeZone })
          return { status: 'confirmed', state: 'scheduled', summary: '已安排检查今日计划，已有日程不会重复创建。' }
        }) } }))
      context.own('subscription', 'set-enabled', tools.register({ id: 'set-enabled', description: '启用或暂停空间生活日记；暂停后不再生成或发布新的动态。',
        readOnly: false, permission: 'owner', parameters: { type: 'object', required: ['enabled'], additionalProperties: false,
          properties: { enabled: { type: 'boolean' } } },
        execute(input, request) { return manager.withCurrent(async () => {
          request.signal.throwIfAborted()
          assert(options.setEnabled && typeof input.enabled === 'boolean', 'DIARY_SETTING_UNAVAILABLE', 'An operator configuration writer is required.')
          await options.setEnabled(input.enabled)
          return { status: 'confirmed', enabled: input.enabled }
        }) } }))
    },
  }
}
export { createQzoneDiary, validateDiaryConfiguration } from './workflow.ts'
export { createLocalDiaryMedia } from './media-store.ts'
export type { DiaryConfiguration, DiaryOptions, DiaryMedia, DiaryDay, DiarySlot } from './types.ts'
