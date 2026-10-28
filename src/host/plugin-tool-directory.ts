import type { DurableStore } from '../contracts/ports.ts'
import type { EffectScope, JsonObject, JsonValue } from '../core/types.ts'
import { assert, snapshot } from '../core/values.ts'
import { decodeQqCapabilityInput, isBoundedQqJson } from '../contracts/qq-capability-input.ts'
import { digest, json, object } from './data.ts'
import type { DirectoryTool } from './native-capability-directory.ts'

export interface PluginDirectoryTool {
  readonly id: string
  readonly description: string
  readonly parameters: JsonObject
  readonly permission: 'owner' | 'autonomous'
  readonly readOnly: boolean
  execute(input: JsonObject, context: { readonly scope: Readonly<EffectScope>; readonly signal: AbortSignal;
    readonly invocationId: string }): Promise<JsonValue>
}
export interface PluginToolDirectoryClient {
  /** Returns an unregister function. Entries are discovered through the shared catalog, never projected as top-level tools. */
  register(tool: PluginDirectoryTool): () => void
}

export function createPluginToolDirectory(options: { readonly store: DurableStore }) {
  const entries = new Map<string, DirectoryTool>()
  return {
    entries: (): readonly DirectoryTool[] => [...entries.values()],
    forPlugin(owner: string, lifetime: AbortSignal, assertActive: () => void = () => {}): PluginToolDirectoryClient {
      assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(owner), 'PLUGIN_TOOL_OWNER_INVALID', 'A registered plugin owner is required.')
      return { register(input) {
        lifetime.throwIfAborted(); assertActive()
        const id = `extension.${owner}.${input.id}`
        assert(/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(input.id) && id.length <= 160
          && input.description.trim().length > 0 && input.description.length <= 1000
          && (input.permission === 'owner' || input.permission === 'autonomous') && typeof input.readOnly === 'boolean'
          && typeof input.execute === 'function' && isBoundedQqJson(input.parameters)
          && Buffer.byteLength(JSON.stringify(input.parameters)) <= 16384 && input.parameters.type === 'object',
        'PLUGIN_TOOL_INVALID', 'A bounded tool declaration and handler are required.')
        assert(!entries.has(id) && entries.size < 256, 'PLUGIN_TOOL_REGISTRATION_CONFLICT', 'Tool IDs must be unique and bounded.')
        const declaration = snapshot({ description: input.description, parameters: input.parameters,
          permission: input.permission, readOnly: input.readOnly })
        const validate = (value: JsonValue) => {
          const result = decodeQqCapabilityInput({ inputSchema: declaration.parameters }, value)
          assert(result, 'PLUGIN_TOOL_INPUT_INVALID', 'Read this tool schema before calling it.')
          return result
        }
        const entry: DirectoryTool = { category: 'extensions', permission: declaration.permission,
          tool: { definition: { name: id, capability: 'native.capabilities.call', featureId: 'framework-tools',
            description: declaration.description, parameters: declaration.parameters, timeoutMs: 120000,
            registrationSource: { origin: 'extension', ownerId: owner, ownerName: owner, transport: 'native' } }, validate },
          effect: { async execute(request) {
            lifetime.throwIfAborted(); assertActive()
            assert(entries.get(id) === entry, 'PLUGIN_TOOL_UNREGISTERED', 'This tool is no longer registered.')
            const value = validate(request.input), signal = AbortSignal.any([lifetime, request.signal])
            const key = digest([owner, id, request.scope.accountScope ?? null, request.scope.conversationId, request.scope.eventId])
            const fingerprint = digest(value), namespace = 'plugin-tool.invocations'
            const prior = options.store.read(namespace, key)
            if (!declaration.readOnly && prior) {
              const previous = object(prior.value)
              assert(previous.fingerprint === fingerprint, 'PLUGIN_TOOL_CONFLICT', 'The same invocation cannot change its input.')
              return previous.result ?? { status: 'unknown', retry: false }
            }
            assert(declaration.readOnly || options.store.list(namespace, { limit: 1000 }).length < 1000,
              'PLUGIN_TOOL_JOURNAL_FULL', 'Resolve retained operations before creating new writes.')
            const record = declaration.readOnly ? null : options.store.write(namespace, key,
              { fingerprint, owner, toolId: id, status: 'running', at: Date.now() }, { expectedRevision: null })
            let result: JsonValue
            try {
              signal.throwIfAborted()
              result = json(await input.execute(value, { scope: request.scope, signal, invocationId: key }))
              assert(Buffer.byteLength(JSON.stringify(result)) <= 65536, 'PLUGIN_TOOL_OUTPUT_LIMIT', 'Tool result exceeds the catalog response limit.')
            } catch (error) {
              if (record) options.store.write(namespace, key, { fingerprint, owner, toolId: id, status: 'unknown', at: Date.now() }, { expectedRevision: record.revision })
              throw error
            }
            const uncertain = typeof result === 'object' && result !== null && !Array.isArray(result) && result.status === 'unknown'
            if (record) options.store.write(namespace, key, { fingerprint, owner, toolId: id, status: uncertain ? 'unknown' : 'completed', result, at: Date.now() },
              { expectedRevision: record.revision, ...(uncertain ? {} : { expiresAt: Date.now() + 7 * 86400000 }) })
            return result
          } } }
        const unregister = () => { if (entries.get(id) === entry) entries.delete(id); lifetime.removeEventListener('abort', unregister) }
        entries.set(id, entry)
        lifetime.addEventListener('abort', unregister, { once: true })
        return unregister
      } }
    },
  }
}
