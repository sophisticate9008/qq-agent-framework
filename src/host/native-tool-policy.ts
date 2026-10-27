import type { NativeToolPermissionRuntime } from '../contracts/native-tool-permissions.ts'
import type { NativeChatAccess } from '../contracts/native-access.ts'
import type { createBridgeHost } from './bridge.ts'
import { digest } from './data.ts'

const prefix = 'native-framework-whitelist:'
/** Project the current whitelist through policy; tool handlers enforce sensitive owner operations. */
export function createNativeToolPolicy(options: {
  readonly directory: string
  readonly currentHost: () => ReturnType<typeof createBridgeHost> | undefined
  readonly available: () => boolean
  readonly signal: () => AbortSignal | undefined
  readonly access: () => NativeChatAccess | undefined
  readonly capabilities: () => readonly string[]
}) {
  let operation: Promise<void> = Promise.resolve()
  async function synchronize(signal: AbortSignal) {
    signal.throwIfAborted()
    const host = options.currentHost()
    const access = options.access()
    if (!host || !access || options.signal()?.aborted !== false || !options.available()) return
    const capabilities = [...new Set(options.capabilities())].sort()
    const allowed = access.allow.filter(scope => !access.deny.includes(scope))
    const previous = host.policy.describe().grants
    const matches = (grant: typeof previous[number]) => grant.id.startsWith(prefix)
      && allowed.includes(grant.conversationId) && grant.capabilities.length === capabilities.length
      && capabilities.every(capability => grant.capabilities.includes(capability) && grant.maxUses[capability] === null)
    for (const grant of previous) {
      if (grant.active && (grant.id.startsWith('native-framework-tool:') || grant.id.startsWith(prefix) && !matches(grant))) host.policy.revoke(grant.id)
    }
    if (capabilities.length === 0) return
    for (const conversationId of allowed) {
      if (previous.some(grant => grant.active && grant.conversationId === conversationId && matches(grant))) continue
      const id = prefix + digest([conversationId, capabilities, previous.filter(grant => grant.id.startsWith(prefix)).map(grant => grant.id).sort()])
      host.policy.grant({ ...(host.accountScope ? { accountScope: host.accountScope } : {}), id, featureId: 'framework-tools', conversationId,
        capabilities, maxUses: Object.fromEntries(capabilities.map(capability => [capability, null])), expiresAt: null })
    }
  }
  return Object.freeze({
    sync(signal: AbortSignal): Promise<void> {
      operation = operation.catch(() => undefined).then(() => synchronize(signal))
      void operation.catch(() => undefined)
      return operation
    },
    // Legacy grant documents are retained for inspection and no longer applied.
    status(_revision: string): NativeToolPermissionRuntime { return { state: 'not-running', appliedRevision: null } },
    async drain() { await operation.catch(() => undefined) }
  })
}
