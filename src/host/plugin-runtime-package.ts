import { FrameworkError } from '../core/values.ts'
import { createBuiltinPackageContent } from './native-package-content.ts'
import type { NativePackageDefinition, NativeServiceConsumer } from './native-packages.ts'
import type { PluginRuntimeServices } from './plugin-runtime.ts'
import { PLUGIN_RUNTIME_PACKAGE_ID, PLUGIN_SERVICE_CONTRACTS } from './plugin-service-contracts.ts'

export function createPluginRuntimePackage(factory: (owner: string, signal: AbortSignal, active: () => void) => PluginRuntimeServices): NativePackageDefinition {
  return {
    content: createBuiltinPackageContent(import.meta.url, ['./plugin-service-contracts', './service-contract', '../contracts/service-contract']),
    manifest: { schema: 1, id: PLUGIN_RUNTIME_PACKAGE_ID, version: '1.0.0', displayName: '插件宿主服务',
      description: '为插件提供按真实身份绑定的模型、会话、协议、调度与工具服务。', dependencies: [],
      provides: Object.values(PLUGIN_SERVICE_CONTRACTS).map(contract => ({ id: contract.id, version: contract.version })), requires: [], contributions: [] },
    install(context) {
      const clients = new Map<string, PluginRuntimeServices>()
      for (const name of Object.keys(PLUGIN_SERVICE_CONTRACTS) as (keyof typeof PLUGIN_SERVICE_CONTRACTS)[]) {
        const contract = PLUGIN_SERVICE_CONTRACTS[name]
        context.publishScoped(contract.id, contract.version, (consumer: NativeServiceConsumer) => {
          let client = clients.get(consumer.owner)
          if (!client) { client = factory(consumer.owner, consumer.signal, consumer.assertActive); clients.set(consumer.owner, client) }
          const value = client[name]
          if (!value) throw new FrameworkError('NATIVE_PACKAGE_SERVICE_UNAVAILABLE', 'This host does not provide the requested plugin service.')
          // All runtime bindings are objects with the declared function surface.
          for (const method of contract.methods) if (typeof Reflect.get(value, method) !== 'function')
            throw new FrameworkError('SERVICE_IMPLEMENTATION_INVALID', 'A plugin service does not implement its contract.')
          return value
        }, contract)
      }
      context.own('other', 'scoped-clients', () => clients.clear())
    },
  }
}
