import type { EffectAdapter, FeatureDefinition } from '../core/types.ts'
import { assert, identifier, isRecord } from '../core/values.ts'
import type { BridgeHostOptions, createBridgeHost } from './bridge.ts'
import { composeAgentInputPreparation, type AgentInputProvider } from './input-preparation.ts'
import type { NativePackageDefinition, NativePackages } from './native-packages.ts'

/** General bootstrap input providers declare capabilities and order in their manifest. */
export type NativePackageInputProvider = Pick<AgentInputProvider, 'capabilities' | 'prepare'>
type Host = ReturnType<typeof createBridgeHost>
type EventValidator = NonNullable<BridgeHostOptions['eventValidators']>[string]

export function createNativePackageBindings(options: {
  readonly definitions: readonly NativePackageDefinition[]
  readonly signal: AbortSignal
}) {
  const owners = new Set<string>()
  const declarations: { owner: string; kind: string; id: string; capabilities: readonly string[]; order: number }[] = []
  const keys = new Set<string>()
  assert(Array.isArray(options.definitions) && options.definitions.length <= 128,
    'INVALID_NATIVE_BOOTSTRAP', 'Bootstrap package declarations must be bounded.')
  for (const definition of options.definitions) {
    assert(isRecord(definition) && isRecord(definition.manifest) && identifier(definition.manifest.id)
      && !owners.has(definition.manifest.id) && Array.isArray(definition.manifest.contributions)
      && definition.manifest.contributions.length <= 128, 'INVALID_NATIVE_BOOTSTRAP', 'Bootstrap packages require distinct manifests.')
    const owner = definition.manifest.id
    owners.add(owner)
    for (const item of definition.manifest.contributions) {
      assert(isRecord(item) && ['effect', 'feature', 'event-validator', 'input-provider'].includes(String(item.kind)) && identifier(item.id),
        'INVALID_NATIVE_BOOTSTRAP', 'A package contribution declaration is invalid.')
      const key = `${item.kind}:${item.id}`
      assert(!keys.has(key), 'NATIVE_PACKAGE_CONTRIBUTION_DUPLICATE', 'Package contributions cannot replace one another.')
      keys.add(key)
      const reserved = item.kind === 'effect' ? ['messaging.send', 'messaging.forward', 'model.respond'].includes(item.id) || item.id.startsWith('agent.')
        : item.kind === 'event-validator' ? ['message.received', 'trigger.fired'].includes(item.id) || item.id.startsWith('agent.')
          : item.kind === 'feature' && item.id === 'agent-relay'
      assert(!reserved, 'INVALID_NATIVE_BOOTSTRAP', 'Package contributions cannot replace host capabilities.')
      const capabilities = item.capabilities ?? []
      assert(item.kind === 'input-provider' || item.capabilities === undefined && item.order === undefined,
        'INVALID_NATIVE_BOOTSTRAP', 'Input preparation metadata belongs to input providers only.')
      assert(Array.isArray(capabilities) && capabilities.length <= 32 && capabilities.every(identifier)
        && new Set(capabilities).size === capabilities.length && (item.order === undefined || Number.isSafeInteger(item.order)),
      'INVALID_NATIVE_BOOTSTRAP', 'Input providers require bounded capabilities and explicit ordering.')
      declarations.push({ owner, kind: String(item.kind), id: item.id, capabilities: Object.freeze([...capabilities]), order: Number(item.order ?? 0) })
    }
  }
  let manager: NativePackages | undefined
  let installedHost: Host | undefined
  let stopped = false
  const installed: { id: string; state: 'active' | 'disposed' | 'unknown' }[] = []
  async function uninstall(host: Host) {
    let unknown = false
    for (const item of [...installed].reverse()) {
      if (item.state !== 'active') { unknown ||= item.state === 'unknown'; continue }
      item.state = 'unknown'
      try { await host.engine.uninstall(item.id); item.state = 'disposed' } catch { unknown = true }
    }
    assert(!unknown, 'NATIVE_PACKAGE_FEATURE_CLEANUP_UNKNOWN', 'Package feature cleanup remains unresolved.')
  }
  function contribution(kind: string, id: string): unknown {
    options.signal.throwIfAborted()
    assert(!stopped && manager, 'NATIVE_PACKAGE_INACTIVE', 'The package binding is not active.')
    const item = manager.contributions().find(item => item.kind === kind && item.id === id && owners.has(item.owner))
    assert(item, 'NATIVE_PACKAGE_CONTRIBUTION_UNAVAILABLE', 'The package contribution is unavailable.')
    return item.value
  }
  const effects: NonNullable<BridgeHostOptions['effectAdapters']> = {}
  const validators: NonNullable<BridgeHostOptions['eventValidators']> = {}
  const inputs: AgentInputProvider[] = []
  for (const item of declarations) {
    if (item.kind === 'effect') effects[item.id] = Object.freeze<EffectAdapter>({ execute(request) {
      const adapter = contribution('effect', item.id)
      assert(isRecord(adapter) && typeof adapter.execute === 'function', 'INVALID_NATIVE_PACKAGE_CONTRIBUTION', 'The effect adapter is invalid.')
      return (adapter as unknown as EffectAdapter).execute({ ...request, signal: AbortSignal.any([request.signal, options.signal]) })
    } })
    if (item.kind === 'event-validator') validators[item.id] = (data => {
      if (!manager || stopped || options.signal.aborted) return false
      const validator = contribution('event-validator', item.id)
      assert(typeof validator === 'function', 'INVALID_NATIVE_PACKAGE_CONTRIBUTION', 'The event validator is invalid.')
      return (validator as EventValidator)(data)
    })
    if (item.kind === 'input-provider') inputs.push({ id: item.id, order: item.order, capabilities: item.capabilities, prepare(execution, event) {
      const provider = contribution('input-provider', item.id) as NativePackageInputProvider
      return provider.prepare({ ...execution, signal: AbortSignal.any([execution.signal, options.signal]) }, event)
    } })
  }
  const input = inputs.length > 0 ? composeAgentInputPreparation(inputs) : undefined
  return Object.freeze({
    bridgeOptions: Object.freeze({ effectAdapters: Object.freeze(effects), eventValidators: Object.freeze(validators),
      ...(input ? { agentInputPreparation: input } : {}) }),
    async install(host: Host, packages: NativePackages) {
      assert(!manager && !stopped && !options.signal.aborted, 'NATIVE_PACKAGE_BINDING_DENIED', 'Package contributions can only be bound once.')
      manager = packages
      installedHost = host
      try {
        // Validate every contribution before installing features or exposing preparation.
        for (const item of declarations) {
          const value = contribution(item.kind, item.id)
          if (item.kind === 'effect') assert(isRecord(value) && typeof value.execute === 'function', 'INVALID_NATIVE_PACKAGE_CONTRIBUTION', 'An effect adapter is required.')
          if (item.kind === 'event-validator') assert(typeof value === 'function', 'INVALID_NATIVE_PACKAGE_CONTRIBUTION', 'An event validator is required.')
          if (item.kind === 'feature') assert(isRecord(value) && value.id === item.id, 'INVALID_NATIVE_PACKAGE_CONTRIBUTION', 'A matching feature is required.')
          if (item.kind === 'input-provider') assert(isRecord(value) && typeof value.prepare === 'function'
            && Array.isArray(value.capabilities) && value.capabilities.length === item.capabilities.length
            && item.capabilities.every(capability => value.capabilities instanceof Array && value.capabilities.includes(capability))
            && Object.keys(value).every(key => ['capabilities', 'prepare'].includes(key)),
          'INVALID_NATIVE_PACKAGE_CONTRIBUTION', 'An input provider must match its declared preparation capabilities.')
        }
        for (const item of declarations.filter(item => item.kind === 'feature')) {
          host.engine.install(contribution('feature', item.id) as FeatureDefinition)
          installed.push({ id: item.id, state: 'active' })
        }
      } catch (error) {
        stopped = true
        await uninstall(host)
        throw error
      }
    },
    async stop(host: Host) {
      stopped = true
      assert(!installedHost || installedHost === host, 'NATIVE_BOOTSTRAP_HOST_MISMATCH', 'Package bindings cannot change hosts.')
      await uninstall(host)
    },
    metadata() { return { owners: [...owners], installedFeatureIds: installed.filter(item => item.state !== 'disposed').map(item => item.id), active: manager !== undefined && !stopped && !options.signal.aborted } }
  })
}
