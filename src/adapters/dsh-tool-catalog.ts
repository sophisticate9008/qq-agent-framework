import { snapshot } from '../core/values.ts'
import type { DshBridgePluginPort } from './dsh-tool-scope.ts'

export interface DshToolCatalogScope {
  readonly sessionId: string
  readonly agentPreset: string
  readonly names: readonly string[]
  readonly schemaFingerprint: string
}

export interface DshToolCatalogItem {
  readonly name: string
  readonly description: string | null
}

export interface DshToolCatalog {
  readonly state: 'available' | 'declared' | 'not-connected' | 'unavailable'
  readonly items: readonly DshToolCatalogItem[]
  readonly scope: 'session' | 'declaration' | null
  readonly limited: boolean
  readonly missingReasons: readonly string[]
  readonly externalToolAuthorizationVerified: false
}

export type DshToolCatalogSnapshot = DshToolCatalog

export interface DshToolCatalogRequest {
  readonly running: boolean
  readonly scopes: readonly DshToolCatalogScope[]
  readonly sessions?: readonly { readonly sessionId: string; readonly agentPreset: string }[]
  readonly port?: Pick<DshBridgePluginPort, 'describe' | 'inspectScope'>
  readonly signal: AbortSignal
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)
}

function unavailable(state: 'not-connected' | 'unavailable', reason: string): DshToolCatalog {
  return snapshot<DshToolCatalog>({ state, items: [], scope: null, limited: false, missingReasons: [reason], externalToolAuthorizationVerified: false })
}

function catalog(scopes: readonly DshToolCatalogScope[], live: boolean,
  descriptions: ReadonlyMap<string, string | null> = new Map(), partial = false): DshToolCatalog {
  const names = [...new Set(scopes.flatMap(scope => [...scope.names]))].sort()
  return snapshot<DshToolCatalog>({
    state: live ? 'available' : 'declared',
    items: names.slice(0, 256).map<DshToolCatalogItem>(name => ({ name, description: descriptions.get(name) ?? null })),
    scope: 'session',
    limited: names.length > 256,
    missingReasons: [...(live ? [] : ['live_tool_scope_not_checked']),
      ...(names.some(name => !descriptions.get(name)) ? ['tool_descriptions_not_exposed'] : []),
      ...(partial ? ['some_tool_scopes_unavailable'] : [])],
    externalToolAuthorizationVerified: false,
  })
}

export async function readDshToolCatalog(request: DshToolCatalogRequest): Promise<DshToolCatalog> {
  request.signal.throwIfAborted()
  if (!request.running) return unavailable('not-connected', 'native_chat_not_running')
  if (request.sessions !== undefined) return readLiveCatalog(request)
  const scopes = request.scopes
  if (!Array.isArray(scopes) || scopes.length > 128 || scopes.some(scope => !scope || typeof scope !== 'object'
    || !identifier(scope.sessionId) || !identifier(scope.agentPreset)
    || !Array.isArray(scope.names) || scope.names.length > 256 || !scope.names.every(identifier)
    || new Set(scope.names).size !== scope.names.length
    || typeof scope.schemaFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(scope.schemaFingerprint))
    || new Set(scopes.map(scope => scope.sessionId)).size !== scopes.length) {
    return unavailable('unavailable', 'saved_tool_scope_invalid')
  }
  if (scopes.length === 0) return unavailable('unavailable', 'native_tool_scope_not_observed')
  const saved = snapshot(scopes.map(scope => ({ sessionId: scope.sessionId, agentPreset: scope.agentPreset,
    names: [...scope.names], schemaFingerprint: scope.schemaFingerprint })))
  if (!request.port) return catalog(saved, false)
  const deadline = AbortSignal.timeout(5_000)
  const signal = AbortSignal.any([request.signal, deadline])
  try {
    const description = await request.port.describe(signal)
    signal.throwIfAborted()
    const observed: DshToolCatalogScope[] = []
    for (const scope of saved) {
      const inspection = await request.port.inspectScope({ sessionId: scope.sessionId, expectedPreset: scope.agentPreset,
        expectedNames: [...scope.names], expectedSchemaFingerprint: scope.schemaFingerprint }, description.issuerEpoch, signal)
      signal.throwIfAborted()
      if (inspection.state !== 'verified-scope') return unavailable('unavailable', 'live_tool_scope_unverified')
      if (inspection.sessionId !== scope.sessionId || inspection.agentPreset !== scope.agentPreset
        || inspection.schemaFingerprint !== scope.schemaFingerprint
        || JSON.stringify([...inspection.names].sort()) !== JSON.stringify([...scope.names].sort())) {
        return unavailable('unavailable', 'live_tool_scope_changed')
      }
      observed.push({ sessionId: inspection.sessionId, agentPreset: inspection.agentPreset,
        names: [...inspection.names], schemaFingerprint: inspection.schemaFingerprint })
    }
    return catalog(observed, true)
  } catch {
    request.signal.throwIfAborted()
    return unavailable('unavailable', deadline.aborted ? 'tool_catalog_read_timeout' : 'tool_catalog_read_failed')
  }
}

async function readLiveCatalog(request: DshToolCatalogRequest): Promise<DshToolCatalog> {
  const sessions = request.sessions!
  if (!Array.isArray(sessions) || sessions.length > 128 || sessions.some(session => !session
    || !identifier(session.sessionId) || !identifier(session.agentPreset))
    || new Set(sessions.map(session => session.sessionId)).size !== sessions.length) {
    return unavailable('unavailable', 'native_tool_session_binding_unverified')
  }
  if (sessions.length === 0) return unavailable('unavailable', 'native_tool_scope_not_observed')
  const port = request.port
  if (!port) return unavailable('unavailable', 'tool_catalog_read_failed')
  const inspectScope = port.inspectScope.bind(port)
  const deadline = AbortSignal.timeout(4_500)
  const signal = AbortSignal.any([request.signal, deadline])
  const observed: DshToolCatalogScope[] = []
  const descriptions = new Map<string, string | null>()
  let next = 0
  let missing = 0
  let cold = 0
  try {
    const description = await port.describe(signal)
    async function readSession(): Promise<void> {
      while (next < sessions.length && !signal.aborted) {
        const session = sessions[next++]!
        try {
          const result = await inspectScope({ sessionId: session.sessionId,
            expectedPreset: session.agentPreset }, description.issuerEpoch, signal)
          if (result.state !== 'verified-scope' || result.sessionId !== session.sessionId
            || result.agentPreset !== session.agentPreset) {
            missing++
            if (result.state === 'unverified' && result.missingReasons.includes('dsh_live_agent_scope_missing')) cold++
            continue
          }
          observed.push({ ...session, names: [...result.names], schemaFingerprint: result.schemaFingerprint })
          for (const item of result.items ?? []) {
            if (!descriptions.has(item.name)) descriptions.set(item.name, item.description)
            else if (descriptions.get(item.name) !== item.description) descriptions.set(item.name, null)
          }
        } catch { missing++ }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, sessions.length) }, () => readSession()))
    request.signal.throwIfAborted()
    if (observed.length > 0) return catalog(observed, true, descriptions, missing > 0 || next < sessions.length)
    return unavailable('unavailable', cold === sessions.length ? 'native_tool_scope_not_observed'
      : deadline.aborted ? 'tool_catalog_read_timeout' : 'live_tool_scope_unverified')
  } catch {
    request.signal.throwIfAborted()
    return unavailable('unavailable', deadline.aborted ? 'tool_catalog_read_timeout' : 'tool_catalog_read_failed')
  }
}
