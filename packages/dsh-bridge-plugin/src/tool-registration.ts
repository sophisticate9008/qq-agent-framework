/** Recorded by the trusted installer, independent of DSH scope and tool naming. */
export interface ToolRegistrationSource {
  readonly origin: 'framework-builtin' | 'dsh-builtin' | 'extension'
  readonly ownerId: string
  readonly ownerName: string
  readonly transport: 'native' | 'mcp'
}

function own(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value as unknown : undefined
}

export function readToolRegistrationSource(value: unknown): ToolRegistrationSource | undefined {
  const origin = own(value, 'origin')
  const ownerId = own(value, 'ownerId')
  const ownerName = own(value, 'ownerName')
  const transport = own(value, 'transport')
  if (origin !== 'framework-builtin' && origin !== 'dsh-builtin' && origin !== 'extension'
    || typeof ownerId !== 'string' || !/^[a-zA-Z0-9_.:@/-]{1,128}$/.test(ownerId)
    || typeof ownerName !== 'string' || !ownerName.trim() || ownerName.length > 80 || /[\u0000-\u001f\u007f]/.test(ownerName)
    || transport !== 'native' && transport !== 'mcp') return undefined
  return { origin, ownerId, ownerName, transport }
}

/** Attach provenance before ctx.tools.register(); this never registers or authorizes a tool. */
export function withToolRegistration<T extends { readonly name: string }>(definition: T, source: ToolRegistrationSource): T & { readonly qafRegistration: ToolRegistrationSource } {
  const registration = readToolRegistrationSource(source)
  if (!registration) throw new TypeError('Invalid tool registration source')
  return { ...definition, qafRegistration: Object.freeze(registration) }
}

const mcpSources = new Map<symbol, { scopeId: string; prefix: string; source: ToolRegistrationSource }>()

/** For MCP clients which register definitions internally. Own the disposer with ctx.effect().
 * The declaration supplies origin; the namespace only matches actual registered tools. */
export function declareMcpToolRegistration(scopeId: string, serverName: string, source: Omit<ToolRegistrationSource, 'transport'>): () => void {
  const registration = readToolRegistrationSource({ ...source, transport: 'mcp' })
  if (!registration || !/^dsh-(?:global|preset:[a-zA-Z0-9_.:-]{1,256})$/.test(scopeId)
    || !/^[a-zA-Z0-9_-]{1,32}$/.test(serverName) || serverName.includes('__') || mcpSources.size >= 128) {
    throw new TypeError('Invalid MCP registration declaration')
  }
  const key = Symbol(serverName)
  mcpSources.set(key, { scopeId, prefix: `mcp__${serverName}__`, source: Object.freeze(registration) })
  return () => { mcpSources.delete(key) }
}

export function declaredMcpToolSource(scopeId: string, name: string): ToolRegistrationSource | undefined {
  const matches = [...mcpSources.values()].filter(item => item.scopeId === scopeId && name.startsWith(item.prefix))
  return matches.length === 1 ? matches[0]?.source : undefined
}
