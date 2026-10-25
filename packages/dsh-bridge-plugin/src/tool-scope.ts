import { createHash } from 'node:crypto'
function snapshot<Value>(value: Value): Value {
  let nodes = 0
  function check(item: unknown, depth: number): void {
    if (++nodes > 16384 || depth > 24) throw new TypeError('Invalid tool scope')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (Array.isArray(item)) { for (const child of item) check(child, depth + 1); return }
    if (typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(item))) {
        if (!('value' in descriptor)) throw new TypeError('Invalid tool scope')
        check(descriptor.value, depth + 1)
      }
      return
    }
    throw new TypeError('Invalid tool scope')
  }
  check(value, 0)
  return JSON.parse(JSON.stringify(value)) as Value
}

export interface DshScopedAgent {
  readonly id: string
  readonly ctx: object
  readonly session: { readonly id: string }
}

export interface DshToolScopeRuntime<Agent extends DshScopedAgent, SessionId extends string> {
  readonly sessionId: (value: string) => SessionId
  readonly agents: { get(id: SessionId): Agent | undefined }
  readonly agentPresets: { composedPreset(context: Agent['ctx']): string | undefined }
  readonly tools: { schemas(scope: Agent): readonly unknown[] }
}

export interface DshToolScopeRequest {
  readonly sessionId: string
  readonly expectedPreset: string
  readonly expectedNames?: readonly string[]
  readonly expectedSchemaFingerprint?: string
}

function identifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)
}

export function createDshToolScopeReader<Agent extends DshScopedAgent, SessionId extends string>(runtime: DshToolScopeRuntime<Agent, SessionId>) {
  if (typeof runtime.sessionId !== 'function' || typeof runtime.agents?.get !== 'function'
    || typeof runtime.agentPresets?.composedPreset !== 'function' || typeof runtime.tools?.schemas !== 'function') {
    throw new TypeError('An explicit in-process DSH tool scope runtime is required')
  }
  return Object.freeze({
    inspect(request: DshToolScopeRequest) {
      try {
        if (!identifier(request.sessionId) || !identifier(request.expectedPreset)
          || request.expectedNames !== undefined && (request.expectedNames.length > 256
            || new Set(request.expectedNames).size !== request.expectedNames.length || !request.expectedNames.every(identifier))
          || request.expectedSchemaFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(request.expectedSchemaFingerprint)) {
          throw new TypeError('Invalid scope request')
        }
        const sessionId = runtime.sessionId(request.sessionId)
        const agent = runtime.agents.get(sessionId)
        if (!agent || agent.id !== request.sessionId || agent.session.id !== request.sessionId
          || runtime.agentPresets.composedPreset(agent.ctx) !== request.expectedPreset) {
          return { state: 'unverified' as const, missingReasons: ['dsh_live_agent_scope_missing'], effectiveToolScopeVerified: false as const }
        }
        const raw = runtime.tools.schemas(agent)
        if (!Array.isArray(raw) || raw.length > 256) throw new TypeError('Invalid tool scope')
        const copied = snapshot(raw)
        if (Buffer.byteLength(JSON.stringify(copied)) > 262_144) throw new TypeError('Invalid tool scope')
        const items = copied.map(schema => {
          if (schema === null || typeof schema !== 'object' || Array.isArray(schema)
            || !('name' in schema) || typeof schema.name !== 'string' || !identifier(schema.name)) throw new TypeError('Invalid tool schema')
          return { name: schema.name, description: Object.hasOwn(schema, 'description')
            && 'description' in schema && typeof schema.description === 'string' ? schema.description.slice(0, 2000) : null }
        })
        const names = items.map(item => item.name).sort()
        const schemaFingerprint = createHash('sha256').update(JSON.stringify(copied)).digest('hex')
        if (new Set(names).size !== names.length || runtime.agents.get(sessionId) !== agent
          || runtime.agentPresets.composedPreset(agent.ctx) !== request.expectedPreset
          || request.expectedNames !== undefined && JSON.stringify([...request.expectedNames].sort()) !== JSON.stringify(names)
          || request.expectedSchemaFingerprint !== undefined && schemaFingerprint !== request.expectedSchemaFingerprint) {
          return { state: 'unverified' as const, missingReasons: ['dsh_tool_scope_changed'], effectiveToolScopeVerified: false as const }
        }
        return snapshot({ state: 'verified-scope' as const, sessionId: request.sessionId, agentPreset: request.expectedPreset,
          names, items: items.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
          schemaFingerprint, scope: 'current-agent-model-wire-schemas' as const, effectiveToolScopeVerified: true as const,
          externalToolAuthorizationVerified: false as const, declarationRevisionVerified: false as const })
      } catch {
        return { state: 'unverified' as const, missingReasons: ['dsh_tool_scope_invalid'], effectiveToolScopeVerified: false as const }
      }
    },
  })
}
