import { createBuiltinPackageContent } from './native-package-content.ts'
import type { DshToolCatalog } from '../adapters/dsh-tool-catalog.ts'
import type { FeatureExecution, JsonValue } from '../core/types.ts'
import { assert, reference, snapshot } from '../core/values.ts'
import { NATIVE_HOST_SERVICES_PACKAGE_ID,
  type NativeServiceAgentBinding, type NativeServiceAvailability } from '../contracts/native-services.ts'
import type { NativeWorkReadQuery, NativeWorkView } from '../contracts/native-work.ts'
import type { createNativeExecutionController, NativeExecutionRecord } from './native-execution.ts'
import type { NativeInteractions } from './native-interactions.ts'
import type { NativePackageContext, NativePackageDefinition } from './native-packages.ts'
import { NATIVE_HOST_SERVICE_CONTRACTS } from './framework-service-contracts.ts'
import { publishService, serviceDeclaration, useService } from './service-contract.ts'

const CONTENT = createBuiltinPackageContent(import.meta.url, ['./framework-service-contracts', './service-contract', '../contracts/service-contract'])

export type NativeServiceInteractionsSnapshot = ReturnType<NativeInteractions['snapshot']>
export type NativeServiceExecutionQuery = { readonly limit?: number; readonly after?: string }
export type NativeServiceExecutionList = ReturnType<ReturnType<typeof createNativeExecutionController>['list']>
export interface NativeAgentService {
  status(): Readonly<NativeServiceAvailability>
  binding(conversationId: string): Readonly<NativeServiceAgentBinding> | null
}
export interface NativeInteractionsService { snapshot(): Readonly<NativeServiceInteractionsSnapshot> }
export interface NativeExecutionsService {
  read(id: string): Readonly<NativeExecutionRecord> | null
  list(query?: NativeServiceExecutionQuery): NativeServiceExecutionList
}
export interface NativeToolsService { catalog(signal: AbortSignal): Promise<Readonly<DshToolCatalog>> }
export interface NativeWorkService {
  status(): Readonly<NativeServiceAvailability>
  read(id: string): Readonly<NativeWorkView> | null
  list(query?: NativeWorkReadQuery): { readonly records: readonly NativeWorkView[]; readonly next: string | null }
  start(execution: NativeWorkServiceCaller, input: { readonly task: string; readonly context?: string }): Promise<JsonValue>
  followup(execution: NativeWorkServiceCaller, input: { readonly id: string; readonly text: string; readonly delivery: 'queue' | 'steer' }): Promise<JsonValue>
  interrupt(execution: NativeWorkServiceCaller, id: string): Promise<JsonValue>
  reconcile(execution: NativeWorkServiceCaller, id: string): Promise<JsonValue>
}
export type NativeWorkServiceCaller = Pick<FeatureExecution, 'invoke' | 'signal'>
export interface NativeHostServiceMap {
  'native-agent': NativeAgentService
  'native-interactions': NativeInteractionsService
  'native-executions': NativeExecutionsService
  'native-tools': NativeToolsService
  'native-work': NativeWorkService
}
export interface NativeHostServicePorts {
  readonly agent: NativeAgentService
  readonly interactions: NativeInteractionsService
  readonly executions: NativeExecutionsService
  readonly tools: NativeToolsService
  readonly work: Pick<NativeWorkService, 'status' | 'read' | 'list'>
}

/** Version resolution remains checked by the package registry's declared dependency graph. */
export function requireNativeHostService<Id extends keyof NativeHostServiceMap>(context: Pick<NativePackageContext, 'service'>, id: Id): NativeHostServiceMap[Id] {
  return useService<NativeHostServiceMap[Id]>(context, NATIVE_HOST_SERVICE_CONTRACTS[id])
}

/** Publish only host facts and caller-scoped invocations; no raw adapter, store or grants enter the package. */
export function createNativeServicesPackage(options: { readonly ports: NativeHostServicePorts }): NativePackageDefinition {
  return Object.freeze({
    content: CONTENT,
    manifest: { schema: 1, id: NATIVE_HOST_SERVICES_PACKAGE_ID, version: '1.0.0', dependencies: [],
      provides: [
        serviceDeclaration(NATIVE_HOST_SERVICE_CONTRACTS['native-agent']),
        serviceDeclaration(NATIVE_HOST_SERVICE_CONTRACTS['native-interactions']),
        serviceDeclaration(NATIVE_HOST_SERVICE_CONTRACTS['native-executions']),
        serviceDeclaration(NATIVE_HOST_SERVICE_CONTRACTS['native-tools']),
        serviceDeclaration(NATIVE_HOST_SERVICE_CONTRACTS['native-work'])
      ], requires: [], contributions: [] },
    install(context) {
      const ports = options.ports
      function active(): void { context.signal.throwIfAborted() }
      function read<Value>(operation: () => Value): Value {
        active()
        const value = operation()
        active()
        return snapshot(value)
      }
      async function invoke(execution: NativeWorkServiceCaller, capability: string, input: JsonValue): Promise<JsonValue> {
        active()
        execution.signal.throwIfAborted()
        const value = await execution.invoke(capability, input)
        active()
        execution.signal.throwIfAborted()
        return snapshot(value)
      }
      const services: NativeHostServiceMap = {
        'native-agent': Object.freeze<NativeAgentService>({
          status: () => read(() => { const status = ports.agent.status(); return { available: status.available, missingReasons: status.missingReasons } }),
          binding(conversationId) {
            assert(reference(conversationId), 'INVALID_NATIVE_SERVICE_QUERY', 'A bounded conversation identifier is required.')
            return read(() => { const binding = ports.agent.binding(conversationId); return binding ? { conversationId: binding.conversationId, sessionId: binding.sessionId, generation: binding.generation } : null })
          }
        }),
        'native-interactions': Object.freeze<NativeInteractionsService>({ snapshot: () => read(() => ports.interactions.snapshot()) }),
        'native-executions': Object.freeze<NativeExecutionsService>({ read: id => read(() => ports.executions.read(id)),
          list: query => read(() => ports.executions.list(query)) }),
        'native-tools': Object.freeze<NativeToolsService>({ async catalog(signal) {
          active()
          const combined = AbortSignal.any([signal, context.signal])
          combined.throwIfAborted()
          const value = await ports.tools.catalog(combined)
          combined.throwIfAborted()
          return snapshot(value)
        } }),
        'native-work': Object.freeze<NativeWorkService>({ status: () => read(() => { const status = ports.work.status(); return { available: status.available, missingReasons: status.missingReasons } }),
          read: id => read(() => ports.work.read(id)), list: query => read(() => ports.work.list(query)),
          start: (execution, input) => invoke(execution, 'native.work.start', { task: input.task, ...(input.context === undefined ? {} : { context: input.context }) }),
          followup: (execution, input) => invoke(execution, 'native.work.followup', { id: input.id, text: input.text, delivery: input.delivery }),
          interrupt: (execution, id) => invoke(execution, 'native.work.interrupt', { id }),
          reconcile: (execution, id) => invoke(execution, 'native.work.reconcile', { id })
        })
      }
      publishService(context, NATIVE_HOST_SERVICE_CONTRACTS['native-agent'], services['native-agent'])
      publishService(context, NATIVE_HOST_SERVICE_CONTRACTS['native-interactions'], services['native-interactions'])
      publishService(context, NATIVE_HOST_SERVICE_CONTRACTS['native-executions'], services['native-executions'])
      publishService(context, NATIVE_HOST_SERVICE_CONTRACTS['native-tools'], services['native-tools'])
      publishService(context, NATIVE_HOST_SERVICE_CONTRACTS['native-work'], services['native-work'])
    }
  } satisfies NativePackageDefinition)
}
