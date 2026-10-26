import type { AccountScope } from '../contracts/account-scope.ts'
import { createHash } from 'node:crypto'
import { assert } from '../core/values.ts'
import type { LoadedNativeBootstrap } from '../host/native-bootstrap.ts'
import { createNativeChatRuntime } from '../host/native-chat-runtime.ts'
import { checkedNativeDeploymentRuntime } from '../host/native-deployment-runtime.ts'
import type { NativeChatConfiguration, NativeChatDeploymentRuntimeInput } from '../host/native-chat-configuration.ts'
import { createNativeDshDeploymentRuntime } from '../adapters/dsh-profile-deployment.ts'
import { createNativeAssistantTarget } from '../host/native-assistant-target.ts'
import { createNativePackageConfigurationRegistry } from '../host/native-package-configuration.ts'
import { createAccessService } from '../host/access-service.ts'
import { ACCESS_COMMAND_REPLIES, createAccessCommandHandler, parseAccessCommand } from '../features/access-commands.ts'
import type { NativeAccountRuntime, NativeAccounts } from '../host/native-accounts.ts'
import { NativeConfigurationRepository, createNativeAccessPersistence, prepareNativeChatAuthorization, readNativeChatConfiguration } from './native-configuration-repository.ts'
import { createNativeCapabilityApprovalResolver, createNativeCapabilityManagement } from './native-capabilities.ts'
import { applyNativeAccessRuntime, createNativeRuntimeApplicationPorts, createNativeRuntimeRoutes, restoreNativeChatRunningIntent } from './runtime.ts'
import { AdminRequestError, type AdminRoute } from './server.ts'
import { nativeRuntimeIsQuiescent } from '../contracts/native-runtime-quiescence.ts'
import { NATIVE_DSH_RESTART_PATH } from '../contracts/native-dsh-restart.ts'

export interface NativeAccountRuntimeBundle extends NativeAccountRuntime {
  readonly routes: readonly AdminRoute[]
  restore(signal: AbortSignal): ReturnType<typeof restoreNativeChatRunningIntent>
  quiescent(): Promise<boolean>
}
/** Full default assembly is reused per account, with every private configuration and journal rooted in its directory. */
export function createNativeAccountRuntimeBundle(options: {
  readonly directory: string
  readonly accountScope: AccountScope
  readonly expectedSelfId: string
  readonly bootstrap?: LoadedNativeBootstrap
  readonly deploymentRuntime?: NativeChatDeploymentRuntimeInput
}): NativeAccountRuntimeBundle {
  const { directory } = options
  // A loaded module is shared code; each account owns its mount lifecycle and pending-work gate.
  const bootstrap = options.bootstrap ? Object.freeze({ ...options.bootstrap }) : undefined
  const repository = new NativeConfigurationRepository(directory)
  const deploymentPort = checkedNativeDeploymentRuntime(options.deploymentRuntime ?? createNativeDshDeploymentRuntime({
    sessionDirectory: directory,
    resolveCapabilityApproval: createNativeCapabilityApprovalResolver(directory)
  }))
  const namespace = (kind: 'chat' | 'work', configured = '') => (kind === 'chat' ? 'qa' : 'qw') + createHash('sha256')
    .update(JSON.stringify([options.accountScope.protocolId, options.accountScope.accountId, configured])).digest('hex').slice(0, 14)
  const scopedConfiguration = (configuration: NativeChatConfiguration): NativeChatConfiguration => ({ ...configuration,
    deployment: { ...configuration.deployment, namespace: namespace('chat', configuration.deployment.namespace) } })
  const deploymentRuntime = checkedNativeDeploymentRuntime({
    prepare: configuration => deploymentPort.prepare(scopedConfiguration(configuration)),
    apply: (configuration, signal, targetRevision) => deploymentPort.apply(scopedConfiguration(configuration), signal, targetRevision),
    reconcile: configuration => deploymentPort.reconcile(scopedConfiguration(configuration))
  })
  const packageConfigurationRegistry = createNativePackageConfigurationRegistry({ directory, contributions: options.bootstrap?.packageConfigurations })
  const assistantTarget = createNativeAssistantTarget({ directory, deploymentNamespace: namespace('work'), loadConfiguration: () => readNativeChatConfiguration(directory), loadAssistant: () => repository.readAssistant(),
    async authorizeApply(signal) {
      signal.throwIfAborted()
      assert((await runtime.status()).canApplyDeployment, 'ASSISTANT_DEPLOYMENT_REQUIRES_STOPPED', 'Stop this account before applying its assistant target.')
    } })
  const accessService = createAccessService({ ...createNativeAccessPersistence(directory),
    publish: (saved, previous, signal) => applyNativeAccessRuntime(directory, runtime, previous.revision, saved.revision, signal).then(() => undefined) })
  const accessCommand = createAccessCommandHandler({ readAccess: signal => accessService.read(signal), change: (request, signal) => accessService.change(request, signal) })
  const runtime = createNativeChatRuntime({ directory, accountScope: options.accountScope, expectedSelfId: options.expectedSelfId,
    packageConfigurationRegistry, bootstrap, resolveWorkTarget: signal => assistantTarget.resolve(signal),
    controlCommands: [{ id: 'access-management', replyTexts: ACCESS_COMMAND_REPLIES, matches: message => parseAccessCommand(message) !== null,
      handle: context => accessCommand(context.message, context.reply, context.signal) }],
    prepareAuthorization: () => prepareNativeChatAuthorization(directory), loadConfiguration: () => readNativeChatConfiguration(directory),
    resolveDeployment: configuration => deploymentRuntime.reconcile(configuration) })
  const application = createNativeRuntimeApplicationPorts({ directory, runtime, deploymentRuntime })
  const routes = Object.freeze([
    ...createNativeRuntimeRoutes({ directory, chatRuntime: runtime, adapterRuntime: runtime.adapterRuntime,
      deploymentRuntime, assistantTarget, packageConfigurationRegistry, interactions: () => runtime.interactions(), tools: signal => runtime.tools(signal) }),
    { method: 'GET' as const, pathname: NATIVE_DSH_RESTART_PATH, async handle() {
      return { schema: 1, available: false, missingReasons: ['LOCAL_DSH_RESTART_ACCOUNT_UNAVAILABLE'], operation: null }
    } },
    ...createNativeCapabilityManagement({ directory, deploymentRuntime, canApplyDeployment: async () => (await runtime.status()).canApplyDeployment }).routes
  ])
  return Object.freeze({ routes,
    async quiescent() { return nativeRuntimeIsQuiescent(await runtime.status()) },
    restore: (signal: AbortSignal) => restoreNativeChatRunningIntent(directory, runtime, signal),
    state() { const state = runtime.activity().state; return state === 'error' ? 'unknown' : state },
    async start(signal: AbortSignal, revisions?: Readonly<Record<string, string>>) { await application.start(revisions ?? (await repository.read()).revisions, signal) },
    async stop(signal: AbortSignal) { signal.throwIfAborted(); await application.stop(false) },
    close: () => runtime.close()
  })
}
export const NATIVE_ACCOUNT_DISPATCH_PATH = '/api/accounts/dispatch'
/** Only concrete routes created by this account's native bundle can be dispatched. No URLs/global settings/proxying. */
export function createNativeAccountDispatchRoutes(options: {
  readonly accounts: NativeAccounts
  readonly bundle: (id: string) => Promise<NativeAccountRuntimeBundle>
}): readonly AdminRoute[] {
  return Object.freeze((['GET', 'POST'] as const).map(method => ({ method, pathname: NATIVE_ACCOUNT_DISPATCH_PATH,
    ...(method === 'POST' ? { maxRequestBytes: 1_048_576 } : {}), maxResponseBytes: 4_194_304,
    async handle(request: Parameters<AdminRoute['handle']>[0]) {
      const id = request.query.get('account'); const path = request.query.get('path')
      if (!id || !/^[a-f0-9]{64}$/.test(id) || request.query.getAll('account').length !== 1 || request.query.getAll('path').length !== 1
        || !path || !path.startsWith('/api/chat/') || path.includes('?') || path.includes('#') || path.includes('%') || path.includes('..')) throw new AdminRequestError(400, 'invalid_account_dispatch')
      // Establish registry membership and identity before obtaining any runtime or private reader.
      await options.accounts.accountDirectory(id)
      const bundle = await options.bundle(id)
      const route = bundle.routes.find(candidate => candidate.method === method && candidate.pathname === path)
      if (!route) throw new AdminRequestError(404, 'account_route_not_found')
      const query = new URLSearchParams(request.query); query.delete('account'); query.delete('path')
      return route.handle({ ...request, query })
    }
  })))
}
