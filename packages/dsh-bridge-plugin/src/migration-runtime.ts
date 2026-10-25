import type { Context } from '@deepseek-ai/cordis'
import { isVolatile } from '@deepseek-ai/cosmokit'
import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type {} from '@deepseek-ai/dsh-config-editor'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-workspace'
import { installModelSelection, type AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { buildForkSeed, SessionId, SessionLogOffset, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { isAlias, parseDocument, visit } from 'yaml'
import { migrationDigest, type PreparedMigration } from './migration-journal.js'
import type { ForkPreviewRequest, MigrationTargetSelection } from './migration-protocol.js'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('migration_metadata_unavailable')
  return value as Record<string, unknown>
}

function reject(reason: string): never { throw new Error(reason) }

function resourceFree(events: readonly SessionEvent[]): boolean {
  let nodes = 0
  function check(value: unknown, depth: number): boolean {
    if (++nodes > 250_000 || depth > 48) return false
    if (!value || typeof value !== 'object') return true
    if (Array.isArray(value)) return value.every(item => check(item, depth + 1))
    const item = record(value)
    if (['image', 'audio', 'video', 'file', 'resource', 'attachment'].includes(String(item.type))
      || Object.keys(item).some(key => /^(?:attachments?|attachmentId|receiptId|assetId|imageUrl|fileUrl)$/i.test(key)
        && item[key] !== null && item[key] !== undefined)) return false
    return Object.values(item).every(child => check(child, depth + 1))
  }
  return check(events, 0)
}

function idleLog(events: readonly SessionEvent[]): boolean {
  let open = false
  let completed = false
  const inbox: Record<string, number> = { 'next-turn': 0, 'next-step': 0 }
  for (const event of events) {
    if (event.type === 'turn/start') open = true
    if (event.type === 'turn/end') { open = false; completed = true }
    if (event.type === 'agent/inbox/spliced') {
      const data = record(event.data)
      const target = String(data.target)
      if (!(target in inbox) || !Number.isSafeInteger(data.start) || Number(data.start) < 0
        || Number(data.start) > inbox[target]! || !Array.isArray(data.inserted)) return false
      const removed = data.removedCount ?? 0
      if (!Number.isSafeInteger(removed) || Number(removed) < 0 || Number(removed) > inbox[target]! - Number(data.start)) return false
      inbox[target] = inbox[target]! - Number(removed) + data.inserted.length
    }
  }
  return completed && !open && Object.values(inbox).every(count => count === 0)
}

async function plugins(ctx: Context, id: string): Promise<unknown[]> {
  const resolved = await ctx.agentPresets.resolve(id)
  if (resolved.broken) reject('migration_preset_unavailable')
  const document = await ctx.agentPresets.readDocument(id)
  if (Buffer.byteLength(document.content) > 524_288) reject('migration_preset_too_large')
  const parsed = parseDocument(document.content, { strict: true, uniqueKeys: true, prettyErrors: false, logLevel: 'silent' })
  if (parsed.errors.length || parsed.warnings.length) reject('migration_preset_unsupported')
  let nodes = 0
  visit(parsed, (_key, node, ancestry) => {
    if (++nodes > 16_384 || ancestry.length > 32 || isAlias(node)) reject('migration_preset_unsupported')
  })
  const value: unknown = parsed.toJS({ maxAliasCount: 0 })
  if (!Array.isArray(value)) reject('migration_preset_unsupported')
  return value
}

function providerConfigurations(ctx: Context): Record<string, unknown> {
  const editor = ctx.get('configEditor')
  if (!editor) reject('migration_provider_unverified')
  const entries = editor.configuration().filter(({ entry }) => entry.options.name === '@deepseek-ai/dsh-llm-pi-ai')
  if (entries.length !== 1 || !entries[0]!.entry.fiber) reject('migration_provider_unverified')
  const providers = record(entries[0]!.entry.fiber.config).providers
  return record(isVolatile(providers) ? providers.get() : providers)
}

async function providerIdentity(ctx: Context, providers: Record<string, unknown>, id: string) {
  if (!Object.hasOwn(providers, id)) reject('migration_provider_unverified')
  const { apiKeyEnv, ...configuration } = record(providers[id])
  let credential: string | null = null
  if (apiKeyEnv !== undefined) {
    const credentials = ctx.get('credentials')
    if (!credentials || typeof apiKeyEnv !== 'string') reject('migration_provider_unverified')
    const resolved = await credentials.resolve(credentialRef(apiKeyEnv))
    if (!resolved || typeof resolved.value !== 'string') reject('migration_provider_unverified')
    credential = resolved.value
  }
  return { configuration, credential }
}

async function sourceSelection(ctx: Context, inherited: AgentOptions, selected: Record<string, unknown> | undefined) {
  let provider = inherited.provider!
  if (selected) {
    if (typeof selected.provider !== 'string' || selected.model !== inherited.model
      || selected.reasoningEffort !== inherited.reasoningEffort) reject('migration_model_changed')
    provider = selected.provider
  }
  const providers = providerConfigurations(ctx)
  const headerRoute = await providerIdentity(ctx, providers, inherited.provider!)
  const actualRoute = provider === inherited.provider ? headerRoute : await providerIdentity(ctx, providers, provider)
  if (migrationDigest(headerRoute) !== migrationDigest(actualRoute)) reject('migration_model_changed')
  return { options: { ...inherited, provider }, routeRevision: migrationDigest({ headerRoute, actualRoute }) }
}

async function equivalentPresets(ctx: Context, source: unknown[], target: unknown[], options: AgentOptions, selection?: MigrationTargetSelection, signal?: AbortSignal): Promise<{ options: AgentOptions; routeRevision: string }> {
  const providers = providerConfigurations(ctx)
  const routes: string[][] = [[], []]
  const routeProofs: unknown[][] = [[], []]
  let side = 0
  async function normalize(rows: unknown[]): Promise<unknown[]> {
    const output: unknown[] = []
    for (const raw of rows) {
      const row = record(raw)
      if (row.name === '@deepseek-ai/dsh-persona') {
        const config = record(row.config)
        if (typeof config.prefix !== 'string') reject('migration_persona_unverified')
        output.push({ ...row, config: { ...config, prefix: '<managed-instructions>' } })
      } else if (row.name === 'cordis:group' && row.group === true && Array.isArray(row.config)) {
        output.push({ ...row, config: await normalize(row.config) })
      } else if (row.name === '@deepseek-ai/dsh-compaction-basic') {
        const config = record(row.config)
        if (typeof config.summarizationProvider !== 'string') reject('migration_provider_unverified')
        routes[side]!.push(config.summarizationProvider)
        if (selection) {
          if (config.auto !== true || !Number.isSafeInteger(config.maxTokens) || Number(config.maxTokens) < 1
            || !Number.isSafeInteger(config.headroomTokens) || Number(config.headroomTokens) < 0) reject('migration_capacity_unverified')
          if (side === 0 && (config.summarizationModel !== options.model || config.summarizationProvider !== options.provider)) reject('migration_model_changed')
          if (side === 1 && (config.summarizationModel !== selection.model || config.summarizationProvider !== selection.provider
            || config.maxTokens !== selection.contextLimits.maxTokens || config.headroomTokens !== selection.contextLimits.headroomTokens)) reject('migration_target_selection_mismatch')
          routeProofs[side]!.push(await providerIdentity(ctx, providers, config.summarizationProvider))
          output.push({ ...row, config: { ...config, summarizationProvider: '<managed-provider>', summarizationModel: '<managed-model>',
            maxTokens: '<managed-output-reserve>', headroomTokens: '<managed-headroom>' } })
        } else {
          if (config.summarizationModel !== options.model) reject('migration_model_changed')
          output.push({ ...row, config: { ...config, summarizationProvider: await providerIdentity(ctx, providers, config.summarizationProvider) } })
        }
      } else {
        output.push(row)
      }
    }
    return output
  }
  const normalizedSource = await normalize(source)
  side = 1
  const normalizedTarget = await normalize(target)
  if (migrationDigest(normalizedSource) !== migrationDigest(normalizedTarget)) reject('migration_capability_or_model_changed')
  if (!source.some(row => record(row).name === '@deepseek-ai/dsh-persona')
    || !target.some(row => record(row).name === '@deepseek-ai/dsh-persona')) reject('migration_persona_unverified')
  if (routes[0]!.length !== 1 || routes[1]!.length !== 1 || routes[0]![0] !== options.provider) reject('migration_provider_unverified')
  if (!selection) return { options: { ...options, provider: routes[1]![0]! }, routeRevision: migrationDigest(normalizedTarget) }
  if (routes[1]![0] !== selection.provider) reject('migration_target_selection_mismatch')
  signal?.throwIfAborted()
  const llm = ctx.get('llm')
  if (!llm) reject('migration_model_metadata_unverified')
  const metadata = await llm.resolveModelInfo(selection.provider, selection.model, signal)
  signal?.throwIfAborted()
  const configured = record(providers[selection.provider])
  if (!Array.isArray(configured.models)) reject('migration_model_metadata_unverified')
  const models = configured.models.filter(model => record(model).id === selection.model)
  if (models.length !== 1 || record(models[0]).contextWindow !== selection.contextLimits.contextWindow
    || record(models[0]).maxTokens !== selection.contextLimits.maxTokens
    || metadata.provider !== selection.provider || metadata.id !== selection.model
    || metadata.context?.contextWindow !== selection.contextLimits.contextWindow
    || metadata.defaultMaxTokens !== selection.contextLimits.maxTokens) reject('migration_model_metadata_unverified')
  if (selection.reasoningEffort === undefined ? metadata.reasoning !== undefined
    : !metadata.reasoning?.efforts.some(effort => effort.id === selection.reasoningEffort)) reject('migration_reasoning_unverified')
  return { options: { provider: selection.provider, model: selection.model, maxTokens: selection.contextLimits.maxTokens,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }) },
    routeRevision: migrationDigest({ normalizedTarget, routeProofs, selection, metadata: { provider: metadata.provider, id: metadata.id,
      context: metadata.context, defaultMaxTokens: metadata.defaultMaxTokens, ...(metadata.reasoning === undefined ? {} : { reasoning: metadata.reasoning }) } }) }
}

export async function prepareSdkMigration(ctx: Context, request: ForkPreviewRequest, signal: AbortSignal): Promise<PreparedMigration> {
  signal.throwIfAborted()
  const query = ctx.get('sessionQuery')
  const persistence = ctx.get('sessionPersistence')
  const sessions = ctx.get('sessions')
  const workspaces = ctx.get('workspaceRegistry')
  if (!query || !persistence || !workspaces || !sessions) reject('migration_storage_or_workspace_unverified')
  const sourceId = SessionId(request.sourceSessionId)
  const observation = await query.observeSession(sourceId, { signal })
  try {
    const header = observation.header
    const events = observation.events
    if (header.id !== sourceId || header.origin === 'subagent' || events.length === 0 || events.length > 100_000
      || Buffer.byteLength(JSON.stringify(events)) > 16_777_216) reject('migration_source_unsupported')
    const membership = workspaces.list().filter(workspace => workspace.sessionIds.includes(sourceId))
    if (membership.length > 1) reject('migration_workspace_unverified')
    const workspace = membership[0]
    const validateWorkspace = async () => {
      const current = workspaces.list().filter(candidate => candidate.sessionIds.includes(sourceId))
      if (current.length !== membership.length || current[0] !== workspace) reject('migration_workspace_changed')
      if (!workspace) return
      if (typeof header.cwd !== 'string' || !isAbsolute(header.cwd) || await realpath(header.cwd) !== workspace.path
        || await realpath(workspace.path) !== workspace.path || await workspace.status() !== 'ok') reject('migration_workspace_unverified')
      const directory = await stat(workspace.path)
      if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o022) !== 0) reject('migration_workspace_unverified')
      await access(workspace.path, constants.R_OK | constants.W_OK | constants.X_OK)
    }
    await validateWorkspace()
    if (!idleLog(events)) reject('migration_source_not_idle')
    if (!resourceFree(events)) reject('migration_resources_unsupported')
    const live = ctx.agents.get(sourceId)
    if (live && (live.status !== 'idle' || live.inbox.nextTurn.length > 0 || live.inbox.nextStep.length > 0
      || ctx.agentPresets.composedPreset(live.ctx) !== request.expectedPreset)) reject('migration_source_not_idle')
    const retained = ctx.agentPresets.inspectCompositions().filter(composition => composition.id === request.expectedPreset)
    if (retained.length > 1 || (live && ctx.agentPresets.inspectCompositions(live.ctx).length !== 1)) reject('migration_source_revision_unverified')
    let sourcePreset: unknown = header.agentPreset
    for (const event of events) if (event.type === 'agent-preset/selected') sourcePreset = event.data.agentPreset
    if (sourcePreset !== request.expectedPreset) reject('migration_source_preset_changed')
    const latest = [...events].reverse().find(event => event.type === 'request/header')
    if (!latest) reject('migration_model_unverified')
    const config = record(record(record(latest.data).header).config)
    if (typeof config.provider !== 'string' || typeof config.model !== 'string') reject('migration_model_unverified')
    const inheritedOptions: AgentOptions = { provider: config.provider, model: config.model,
      ...(typeof config.reasoningEffort === 'string' ? { reasoningEffort: ReasoningEffortId(config.reasoningEffort) } : {}),
      ...(typeof config.maxTokens === 'number' ? { maxTokens: config.maxTokens } : {}) }
    const selected = [...events].reverse().find(event => event.type === 'model/selection')
    const selection = selected ? record(selected.data) : undefined
    const actualSource = await sourceSelection(ctx, inheritedOptions, selection)
    const options = actualSource.options
    const sourcePlugins = await plugins(ctx, request.expectedPreset)
    const targetPlugins = await plugins(ctx, request.targetPreset)
    const verified = await equivalentPresets(ctx, sourcePlugins, targetPlugins, options, request.targetSelection, signal)
    const targetOptions = verified.options
    const sourceCursor = Number(observation.cursor)
    if (sourceCursor !== events.length - 1 || sourceCursor < 0) reject('migration_source_changed')
    const sourceDigest = migrationDigest({ header, events })
    const targetRevision = migrationDigest({ id: request.targetPreset, plugins: targetPlugins, routeRevision: verified.routeRevision,
      sourceRouteRevision: actualSource.routeRevision, ...(request.targetSelection === undefined ? {} : { targetSelection: request.targetSelection }) })
    const validateTarget = async () => {
      const currentSource = await plugins(ctx, request.expectedPreset)
      if (migrationDigest(currentSource) !== migrationDigest(sourcePlugins)) reject('migration_source_changed')
      const currentTarget = await plugins(ctx, request.targetPreset)
      const current = await equivalentPresets(ctx, currentSource, currentTarget, options, request.targetSelection, signal)
      const currentSourceSelection = await sourceSelection(ctx, inheritedOptions, selection)
      if (migrationDigest({ id: request.targetPreset, plugins: currentTarget, routeRevision: current.routeRevision,
        sourceRouteRevision: currentSourceSelection.routeRevision, ...(request.targetSelection === undefined ? {} : { targetSelection: request.targetSelection }) }) !== targetRevision) reject('migration_target_changed')
    }
    const seed = buildForkSeed(events, SessionSeq(sourceCursor))
    const validateSource = () => {
      const current = ctx.agents.get(sourceId)
      const session = sessions.get(sourceId)
      if (current !== live || (current && (current.status !== 'idle' || current.inbox.nextTurn.length || current.inbox.nextStep.length))) reject('migration_source_changed')
      if (session && migrationDigest({ header: session.header, events: session.snapshotEvents() }) !== sourceDigest) reject('migration_source_changed')
    }
    validateSource()
    return {
      sourceCursor, sourceDigest, targetRevision,
      async create(childSessionId, createSignal) {
        createSignal.throwIfAborted()
        validateSource()
        await validateWorkspace()
        const fresh = await query.observeSession(sourceId, { signal: createSignal })
        try { if (migrationDigest({ header: fresh.header, events: fresh.events }) !== sourceDigest) reject('migration_source_changed') }
        finally { fresh[Symbol.dispose]() }
        await validateTarget()
        const childId = SessionId(childSessionId)
        if (ctx.agents.get(childId) || await persistence.stat(childId)) reject('migration_child_already_exists')
        const handle = await ctx.agents.create({ sessionId: childId, seed, inheritedEventCount: SessionLogOffset(sourceCursor + 1),
          meta: { parentSession: sourceId, isSeeded: true, agentPreset: request.targetPreset,
            ...(header.cwd === undefined ? {} : { cwd: header.cwd }) }, agentOptions: targetOptions, signal: createSignal,
          setup: async (agentCtx, agent) => {
            installModelSelection(agentCtx, { current: { provider: targetOptions.provider!, model: targetOptions.model!,
              ...(targetOptions.reasoningEffort === undefined ? {} : { reasoningEffort: targetOptions.reasoningEffort }) }, assembled: undefined })
            await ctx.agentPresets.mount(agentCtx, request.targetPreset)
            agent.session.append('agent-preset/selected', { agentPreset: request.targetPreset })
            agent.session.append('model/selection', { provider: targetOptions.provider!, model: targetOptions.model!,
              ...(targetOptions.reasoningEffort === undefined ? {} : { reasoningEffort: targetOptions.reasoningEffort }) })
            return { commit() { createSignal.throwIfAborted(); validateSource() } }
          } })
        await persistence.flush()
        if (workspace) {
          await validateWorkspace()
          await workspace.attachSession(childId)
          if (!workspace.sessionIds.includes(childId) || workspaces.get(workspace.id) !== workspace) reject('migration_workspace_unverified')
        }
        createSignal.throwIfAborted()
        const child = handle.agent
        if (child.session.header.parentSession !== sourceId || child.session.header.isSeeded !== true
          || ctx.agentPresets.composedPreset(child.ctx) !== request.targetPreset
          || migrationDigest(child.session.snapshotEvents().slice(0, sourceCursor + 1)) !== migrationDigest(events)) reject('migration_child_verification_failed')
        const projection = ctx.get('sessionProjections')?.stateOf(child.session, 'agentPreset')
        if (projection !== request.targetPreset) reject('migration_child_verification_failed')
        const selection = [...child.session.snapshotEvents()].reverse().find(event => event.type === 'model/selection')
        if (!selection || selection.data.provider !== targetOptions.provider || selection.data.model !== targetOptions.model
          || selection.data.reasoningEffort !== targetOptions.reasoningEffort) reject('migration_child_verification_failed')
        const durable = await persistence.open(childId, 'read', { signal: createSignal })
        try {
          const inspected = await durable.read()
          if (durable.header.parentSession !== sourceId || durable.header.agentPreset !== request.targetPreset
            || durable.inheritedEventCount !== sourceCursor + 1
            || migrationDigest(inspected.events) !== migrationDigest(child.session.snapshotEvents())) reject('migration_child_verification_failed')
        } finally { await durable.close() }
        await validateTarget()
        validateSource()
      },
    }
  } finally { observation[Symbol.dispose]() }
}
