import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { createDshAdapter } from '../adapters/dsh.ts'
import { createDshJsonRpcPort, type DshPresetBinding } from '../adapters/dsh-jsonrpc.ts'
import { createOneBotTransport, normalizeOneBotMessage } from '../adapters/onebot.ts'
import { classifyOneBotResponse } from '../adapters/onebot-response.ts'
import { createContextStore } from '../core/context.ts'
import { FrameworkError, errorCode, snapshot } from '../core/values.ts'
import { createSqliteStore, type SqliteStore } from '../storage/sqlite.ts'
import { type AdapterRuntimePort, type NativeAdapterConfiguration } from './adapter-configuration.ts'
import { createBridgeHost } from './bridge.ts'
import { buildChatSessionDefinition, type ChatSessionDefinition } from './chat-plans.ts'
import { withDeadline } from './deadlines.ts'
import type { NativeChatConfiguration } from './native-chat-configuration.ts'
import { createOneBotConnectionManager } from './onebot-connection.ts'
import type { AgentAdapter, InboundMessage } from './types.ts'
import type { AgentEvent } from './types.ts'
import { createNativeUsage, type NativeUsageTokens } from './native-usage.ts'

export interface NativeChatDeploymentResolution {
  readonly missingReasons: readonly string[]
  readonly presetBindings: readonly DshPresetBinding[]
  readonly verificationScope?: string
  readonly credentialValueIdentityVerified?: false
  readonly unverified?: readonly string[]
}

export interface NativeChatRuntimeOptions {
  readonly directory: string
  readonly loadConfiguration: () => Promise<NativeChatConfiguration>
  readonly resolveDeployment: (configuration: NativeChatConfiguration, definition: ChatSessionDefinition)
    => Promise<NativeChatDeploymentResolution>
}

export type NativeChatRuntime = ReturnType<typeof createNativeChatRuntime>
type BridgeHost = ReturnType<typeof createBridgeHost>
type RuntimeState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
const nativeRuntimes = new WeakSet<object>()

export function isNativeChatRuntime(value: unknown): value is NativeChatRuntime {
  return value !== null && typeof value === 'object' && nativeRuntimes.has(value)
}

function failure(code: string): never {
  throw new FrameworkError(code, 'Native chat runtime operation did not complete safely.')
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function sameRevisions(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => left[key] === right[key])
}

function allowed(configuration: NativeChatConfiguration, conversationId: string): boolean {
  return configuration.access.allow.includes(conversationId) && !configuration.access.deny.includes(conversationId)
}

function configuredDefinition(configuration: NativeChatConfiguration): ChatSessionDefinition | null {
  const plan = configuration.catalog.plans.find(value => value.id === configuration.catalog.activePlanId)
  const persona = configuration.personas.find(value => value.id === plan?.personaId)
  return plan && persona ? buildChatSessionDefinition(plan, persona) : null
}

export function createNativeChatRuntime(options: NativeChatRuntimeOptions) {
  if (!isAbsolute(options.directory) || options.directory.includes('\0')
    || typeof options.loadConfiguration !== 'function' || typeof options.resolveDeployment !== 'function') {
    throw new TypeError('Native chat requires an absolute private directory and explicit configuration loaders.')
  }
  let state: RuntimeState = 'stopped'
  let host: BridgeHost | undefined
  let store: SqliteStore | undefined
  let usage: ReturnType<typeof createNativeUsage> | undefined
  let usageFaults = 0
  let lastUsageError: string | null = null
  let dsh: ReturnType<typeof createDshJsonRpcPort> | undefined
  let active: NativeChatConfiguration | undefined
  let lifetime: AbortController | undefined
  let starting: Promise<void> | undefined
  let stopping: Promise<void> | undefined
  let adapterOperation = false
  let closed = false
  let lastError: string | null = null
  let received = 0
  let rejected = 0
  let unknown = 0
  let droppedWhileStopped = 0
  let lastReceipt: { status: string; errorCode: string | null } | null = null
  let releaseLease: (() => Promise<void>) | undefined
  let deployedProviders = new Map<string, string>()

  const connection = createOneBotConnectionManager({
    async onEvent(event, context) {
      const current = host
      const generation = lifetime
      if (state !== 'running' || current === undefined || generation?.signal.aborted || context.signal.aborted) {
        droppedWhileStopped++
        return
      }
      const message = await normalizeOneBotMessage(event, { selfId: context.selfId, signal: context.signal })
      if (!message || current !== host || lifetime !== generation || context.signal.aborted) return
      const content = message.content.filter(part => part.type !== 'mention' || part.userId !== context.selfId)
      if (content.length === 0 || content.some(part => part.type !== 'text')) {
        rejected++
        lastReceipt = { status: 'rejected', errorCode: 'NATIVE_CHAT_TEXT_ONLY' }
        return
      }
      received++
      try {
        const receipt = await current.receive({ ...message, content })
        if (receipt.status === 'rejected') rejected++
        if (receipt.status === 'unknown') unknown++
        lastReceipt = { status: receipt.status, errorCode: receipt.errorCode ?? null }
      } catch (error) {
        unknown++
        lastReceipt = { status: 'unknown', errorCode: safeCode(error) }
      }
    }
  })

  function safeCode(error: unknown): string {
    const code = errorCode(error, 'NATIVE_CHAT_FAILED')
    return /^(?:[A-Z][A-Z0-9_]{1,80}|onebot_ws_[a-z0-9_]{1,64}|adapter_runtime_[a-z0-9_]{1,64})$/.test(code)
      ? code : 'NATIVE_CHAT_FAILED'
  }

  async function inspect() {
    const configuration = await options.loadConfiguration()
    const definition = configuredDefinition(configuration)
    const missingReasons: string[] = []
    if (!definition) missingReasons.push('active_plan_or_persona_missing')
    if (!configuration.adapters.onebotWs.enabled) missingReasons.push('onebot_ws_not_enabled')
    if (!configuration.adapters.onebotHttp.enabled) missingReasons.push('onebot_http_not_enabled')
    if (!configuration.adapters.dshAgent.enabled) missingReasons.push('dsh_agent_not_enabled')
    if (configuration.adapters.dshAgent.auth === '') missingReasons.push('dsh_auth_missing')
    if (!configuration.access.allow.some(scope => allowed(configuration, scope))) missingReasons.push('access_allow_missing')
    if (!configuration.authorization.grants.some(grant => allowed(configuration, grant.conversationId)
      && grant.submitUses > 0 && grant.sendUses > 0 && (grant.expiresAt === null || grant.expiresAt > Date.now()))) {
      missingReasons.push('explicit_authorization_missing')
    }
    if (definition) {
      const provider = configuration.providers.find(value => value.id === definition.model.provider)
      if (!provider?.enabled || !provider.models.some(model => model.id === definition.model.name)) {
        missingReasons.push('provider_model_missing_or_disabled')
      }
    }
    const deployment = definition ? await options.resolveDeployment(configuration, definition)
      : { missingReasons: [], presetBindings: [] }
    missingReasons.push(...deployment.missingReasons)
    if (definition && deployment.presetBindings.length === 0 && deployment.missingReasons.length === 0) {
      missingReasons.push('trusted_dsh_binding_missing')
    }
    return { configuration, definition, deployment, missingReasons }
  }

  async function status() {
    const current = await inspect()
    const protocol = connection.connectionStatus()
    const protocolConnected = protocol.state === 'connected' && protocol.selfId !== null
    const missingReasons = [...current.missingReasons]
    if (active && !sameRevisions(active.revisions, current.configuration.revisions)) missingReasons.push('configuration_changed')
    if (state !== 'running') missingReasons.push('runtime_not_started')
    if (!protocolConnected) missingReasons.push('onebot_protocol_not_connected')
    const metrics = host?.metrics() ?? null
    if (state === 'running' && metrics?.startupState !== 'ready') missingReasons.push('host_not_ready')
    if (state === 'running' && metrics && metrics.unhealthyFollows > 0) missingReasons.push('agent_follow_unavailable')
    if (state === 'running' && !host?.policy.describe().grants.some(grant => grant.active
      && allowed(current.configuration, grant.conversationId)
      && grant.maxUses['agent.submit'] > grant.used['agent.submit']
      && grant.maxUses['messaging.send'] > grant.used['messaging.send'])) missingReasons.push('authorization_budget_unavailable')
    const chatReady = state === 'running' && missingReasons.length === 0 && host !== undefined && dsh !== undefined
    return snapshot({ state, chatReady, runtimeConnected: chatReady, protocolConnected,
      configurationIssues: current.missingReasons,
      canStart: !closed && !starting && !stopping && !adapterOperation
        && (state === 'stopped' || state === 'error') && current.missingReasons.length === 0,
      canApplyDeployment: !closed && !starting && !stopping && !adapterOperation && releaseLease === undefined
        && (state === 'stopped' || state === 'error'),
      missingReasons: [...new Set(missingReasons)], revisions: current.configuration.revisions,
      activeRevisions: active?.revisions ?? null, lastError,
      connection: { ...protocol, chatReady }, host: metrics,
      ingress: { received, rejected, unknown, droppedWhileStopped, lastReceipt },
      usage: { available: usage !== undefined, faults: usageFaults, lastError: lastUsageError },
      readinessScope: current.deployment.verificationScope ?? 'verified-protocol-dsh-configuration-and-local-file-provenance',
      credentialValueIdentityVerified: false,
      unverified: current.deployment.unverified ?? ['credential_loaded_value_identity'],
      modelExecutionVerified: false })
  }

  function bindingForSession(sessionId: string) {
    let after: string | undefined
    while (host) {
      const page = host.sessions.list({ limit: 1_000, ...(after === undefined ? {} : { after }) })
      const binding = page.find(entry => entry.sessionId === sessionId)
      if (binding) return binding
      if (page.length < 1_000) return undefined
      after = page.at(-1)!.conversationId
    }
    return undefined
  }

  function recordUsage(event: AgentEvent) {
    if (!usage || !active || (event.type !== 'completed' && event.type !== 'failed')) return
    const binding = bindingForSession(event.sessionId)
    if (!binding || binding.state !== 'ready') return
    const data = event.data ?? {}
    if (data.terminal === true || !(typeof data.turn === 'string' && data.turn.length > 0
      || typeof data.turn === 'number' && Number.isSafeInteger(data.turn) && data.turn >= 0)) return
    const turnId = String(data.turn)
    const sourceSteps = Array.isArray(data.usageSteps) ? data.usageSteps : []
    const definition = configuredDefinition(active)!
    const steps = sourceSteps.length > 0 ? sourceSteps : [null]
    for (const input of steps.slice(0, 256)) {
      const step = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : null
      const source = step?.usage !== null && typeof step?.usage === 'object' && !Array.isArray(step.usage) ? step.usage : null
      const count = (key: string): number | null => {
        const value = source?.[key]
        return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
      }
      const tokens: NativeUsageTokens = { input: count('inputTokens'), output: count('outputTokens'),
        cacheRead: count('cacheReadTokens'), cacheWrite: count('cacheWriteTokens'), total: count('totalTokens'),
        reasoning: count('reasoningTokens') }
      const externalProvider = step && typeof step.provider === 'string' ? step.provider : definition.model.provider
      usage.append({ conversationId: binding.conversationId, sessionId: binding.sessionId!, generation: binding.generation,
        turnId, stepId: step && typeof step.eventId === 'string' ? step.eventId : null,
        stepNumber: step && typeof step.step === 'number' && Number.isSafeInteger(step.step) ? step.step : null,
        coverage: data.usageComplete === true && sourceSteps.length <= 256 ? 'complete' : sourceSteps.length > 0 ? 'partial' : 'unknown',
        provider: deployedProviders.get(externalProvider) ?? externalProvider, externalProvider,
        model: step && typeof step.model === 'string' ? step.model : definition.model.name,
        status: event.type, tokens, reportedCost: null })
    }
  }

  async function guard(conversationId: string, signal: AbortSignal): Promise<void> {
    if (lifetime?.signal.aborted || signal.aborted || !['starting', 'running'].includes(state)) failure('NATIVE_CHAT_STOPPED')
    const latest = await options.loadConfiguration()
    if (!active || !sameRevisions(active.revisions, latest.revisions)) failure('NATIVE_CHAT_CONFIGURATION_CHANGED')
    if (!allowed(latest, conversationId)) failure('NATIVE_CHAT_ACCESS_DENIED')
    const deployment = await options.resolveDeployment(latest, configuredDefinition(latest)!)
    if (deployment.missingReasons.length > 0 || deployment.presetBindings.length === 0) failure('NATIVE_CHAT_DEPLOYMENT_CHANGED')
    signal.throwIfAborted()
  }

  function applyAuthorization(configuration: NativeChatConfiguration, identity: string) {
    if (!host || !store) failure('NATIVE_CHAT_NOT_ASSEMBLED')
    const authorization = configuration.authorization
    const key = authorization.version
    const signature = fingerprint(authorization)
    const previous = store.read('native-chat.authorization', key)
    if (previous && (typeof previous.value !== 'object' || previous.value === null
      || Array.isArray(previous.value) || previous.value.signature !== signature)) failure('NATIVE_CHAT_AUTHORIZATION_VERSION_CONFLICT')
    if (!previous) store.write('native-chat.authorization', key, { signature }, { expectedRevision: null })
    const desired = new Set<string>()
    for (const grant of authorization.grants) {
      if (!allowed(configuration, grant.conversationId)) continue
      const id = `native-chat:${fingerprint([identity, authorization.version, grant.conversationId])}`
      desired.add(id)
      if (store.read('policy.grants', id)) continue
      if (grant.expiresAt !== null && grant.expiresAt <= Date.now()) continue
      host.policy.grant({ id, featureId: 'agent-relay', conversationId: grant.conversationId,
        capabilities: ['agent.submit', 'messaging.send'],
        maxUses: { 'agent.submit': grant.submitUses, 'messaging.send': grant.sendUses }, expiresAt: grant.expiresAt })
    }
    for (const grant of host.policy.describe().grants) {
      if (grant.id.startsWith('native-chat:') && !desired.has(grant.id)) host.policy.revoke(grant.id)
    }
  }

  async function verifyHttpIdentity(selfId: string, configuration: NativeChatConfiguration, signal: AbortSignal) {
    await withDeadline({ signal, timeoutMs: 5_000, code: 'NATIVE_CHAT_HTTP_VERIFY_TIMEOUT', async run(combined) {
      const endpoint = configuration.adapters.onebotHttp
      const base = new URL(endpoint.endpoint.endsWith('/') ? endpoint.endpoint : `${endpoint.endpoint}/`)
      const response = await fetch(new URL('get_login_info', base), { method: 'POST', redirect: 'error', signal: combined,
        headers: { 'content-type': 'application/json', ...(endpoint.secret === '' ? {} : { authorization: `Bearer ${endpoint.secret}` }) }, body: '{}' })
      const reader = response.body?.getReader()
      if (!response.ok || !reader) { await response.body?.cancel(); failure('NATIVE_CHAT_HTTP_IDENTITY_UNVERIFIED') }
      const chunks: Uint8Array[] = []
      let bytes = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.length
          if (bytes > 65_536) failure('NATIVE_CHAT_HTTP_IDENTITY_UNVERIFIED')
          chunks.push(chunk.value)
        }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (classifyOneBotResponse(body) !== 'confirmed' || !body || typeof body !== 'object'
          || !('data' in body) || !body.data || typeof body.data !== 'object'
          || !('user_id' in body.data) || String(body.data.user_id) !== selfId) failure('NATIVE_CHAT_HTTP_IDENTITY_UNVERIFIED')
      } finally {
        await reader.cancel().catch(() => undefined)
      }
    } })
  }

  async function cleanup() {
    lifetime?.abort()
    await connection.disconnect()
    await dsh?.close()
    await host?.stop()
    dsh = undefined
    await releaseLease?.()
    releaseLease = undefined
  }

  async function acquireLease() {
    if (releaseLease) failure('NATIVE_CHAT_LEASE_HELD')
    const filename = join(options.directory, '.native-chat-runtime.lock')
    const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      .catch(() => failure('NATIVE_CHAT_LEASE_HELD'))
    const held = await handle.stat()
    releaseLease = async () => {
      await handle.close()
      const current = await lstat(filename).catch(() => null)
      if (current && current.dev === held.dev && current.ino === held.ino) await unlink(filename)
    }
  }

  async function start(revisions: Readonly<Record<string, string>>, signal: AbortSignal): Promise<void> {
    if (closed) failure('NATIVE_CHAT_CLOSED')
    if (starting || stopping || adapterOperation || state === 'running') failure('NATIVE_CHAT_BUSY')
    signal.throwIfAborted()
    state = 'starting'
    lastError = null
    const controller = new AbortController()
    lifetime = controller
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, 30_000)
    let ownsResources = false
    const operation = (async () => {
      try {
        const selected = await withDeadline({ signal: controller.signal, timeoutMs: 15_000,
          code: 'NATIVE_CHAT_CONFIGURATION_TIMEOUT', run: inspect })
        if (!sameRevisions(revisions, selected.configuration.revisions)) failure('NATIVE_CHAT_REVISION_CONFLICT')
        if (selected.missingReasons.length > 0 || !selected.definition) failure('NATIVE_CHAT_CONFIGURATION_INCOMPLETE')
        controller.signal.throwIfAborted()
        const configuration = selected.configuration
        const definition = selected.definition
        const metadata = await lstat(options.directory)
        if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) failure('NATIVE_CHAT_STORAGE_INVALID')
        await acquireLease()
        ownsResources = true
        const filename = join(options.directory, 'native-chat.sqlite')
        const database = await lstat(filename).catch((error: unknown) => {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
          throw error
        })
        if (database && (!database.isFile() || database.isSymbolicLink() || database.nlink !== 1
          || (database.mode & 0o777) !== 0o600)) failure('NATIVE_CHAT_STORAGE_INVALID')
        store ??= createSqliteStore({ filename })
        usage ??= createNativeUsage({ store })
        const identity = fingerprint({ definition, endpoint: configuration.adapters.dshAgent.endpoint,
          bindings: selected.deployment.presetBindings })
        const prior = store.read('native-chat.meta', 'session-definition')
        if (prior && (typeof prior.value !== 'object' || prior.value === null || Array.isArray(prior.value)
          || prior.value.identity !== identity) && store.list('host.sessions', { limit: 1 }).length > 0) {
          failure('NATIVE_CHAT_SESSION_CONFIGURATION_CONFLICT')
        }
        if (!prior || typeof prior.value !== 'object' || prior.value === null || Array.isArray(prior.value)
          || prior.value.identity !== identity) {
          store.write('native-chat.meta', 'session-definition', { identity }, { expectedRevision: prior?.revision ?? null })
        }
        active = configuration
        deployedProviders = new Map(selected.deployment.presetBindings.map(binding =>
          [binding.externalProvider ?? binding.definition.model.provider, binding.definition.model.provider]))
        dsh = createDshJsonRpcPort({ endpoint: configuration.adapters.dshAgent.endpoint,
          auth: configuration.adapters.dshAgent.auth, sessionDefinition: definition,
          presetBindings: selected.deployment.presetBindings, timeoutMs: 5_000 })
        const sourceAgent = createDshAdapter(dsh)
        const agent: AgentAdapter = {
          async createSession(request) { await guard(request.conversationId, request.signal); return sourceAgent.createSession(request) },
          async submit(request) {
            const binding = bindingForSession(request.sessionId)
            if (!binding) failure('SESSION_STALE')
            await guard(binding.conversationId, request.signal)
            return sourceAgent.submit(request)
          },
          follow: request => sourceAgent.follow({ ...request, async onEvent(event) {
            if (controller.signal.aborted || lifetime !== controller || request.signal.aborted) return
            try { recordUsage(event) } catch (error) { usageFaults++; lastUsageError = safeCode(error) }
            await request.onEvent(event)
          } }),
          cancel: sourceAgent.cancel
        }
        const sourceTransport = createOneBotTransport({ endpoint: configuration.adapters.onebotHttp.endpoint,
          accessToken: configuration.adapters.onebotHttp.secret, timeoutMs: 5_000 })
        const context = createContextStore()
        const persona = configuration.personas.find(value => value.id === definition.personaId)!
        const contextPersonaId = `native-${fingerprint(persona.id).slice(0, 32)}`
        context.registerPersona({ ...persona, id: contextPersonaId, version: fingerprint(definition) })
        host = createBridgeHost({ store, agent, context, persona: `${contextPersonaId}@${fingerprint(definition)}`,
          transport: { capabilities: () => sourceTransport.capabilities!(), async send(request) {
            await guard(request.conversationId, request.signal)
            return sourceTransport.send(request)
          } },
          authorizeIncoming: async (message: InboundMessage) => {
            try { await guard(message.conversationId, controller.signal); return !message.isSelf } catch { return false }
          }, taskTickMs: 25, replyTimeoutNotice: null,
          timeouts: { createSessionMs: 6_000, followMs: 6_000, submitMs: 6_000, sendMs: 6_000, startMs: 15_000 },
          onFault(code) { lastError = safeCode(new FrameworkError(code, 'Native host operation failed.')) } })
        applyAuthorization(configuration, identity)
        await connection.connect(configuration.adapters, controller.signal)
        const selfId = connection.connectionStatus().selfId
        if (!selfId) failure('NATIVE_CHAT_PROTOCOL_UNVERIFIED')
        await verifyHttpIdentity(selfId, configuration, controller.signal)
        await dsh.verify(controller.signal)
        await host.start()
        controller.signal.throwIfAborted()
        if (host.metrics().startupState !== 'ready' || host.metrics().faults > 0) failure('NATIVE_CHAT_HOST_NOT_READY')
        const latest = await options.loadConfiguration()
        if (!sameRevisions(configuration.revisions, latest.revisions)) failure('NATIVE_CHAT_REVISION_CONFLICT')
        state = 'running'
      } catch (error) {
        lastError = safeCode(error)
        controller.abort()
        if (ownsResources) await cleanup().catch(() => undefined)
        state = 'error'
        throw new FrameworkError(lastError, 'Native chat did not start. Check runtime status.')
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
      }
    })()
    starting = operation
    try { await operation } finally { if (starting === operation) starting = undefined }
  }

  async function stop() {
    if (stopping) return stopping
    lifetime?.abort()
    state = 'stopping'
    const operation = (async () => {
      await starting?.catch(() => undefined)
      try {
        await withDeadline({ signal: new AbortController().signal, timeoutMs: 20_000,
          code: 'NATIVE_CHAT_STOP_UNKNOWN', run: cleanup })
        state = 'stopped'
      } catch (error) {
        state = 'error'
        lastError = safeCode(error)
        throw error
      }
    })()
    stopping = operation
    await operation
    if (stopping === operation) stopping = undefined
  }

  const adapterRuntime: AdapterRuntimePort = Object.freeze({
    status: () => connection.status(),
    async connectionStatus() {
      if (state !== 'running') return connection.connectionStatus()
      const runtime = await status()
      return runtime.connection
    },
    async connect(configuration: NativeAdapterConfiguration, signal: AbortSignal) {
      if (state !== 'stopped' || starting || stopping || adapterOperation || closed) failure('NATIVE_CHAT_BUSY')
      adapterOperation = true
      try { await connection.connect(configuration, signal) } finally { adapterOperation = false }
    },
    async disconnect() {
      if (state !== 'stopped' || starting || stopping || adapterOperation) failure('NATIVE_CHAT_BUSY')
      adapterOperation = true
      try { await connection.disconnect() } finally { adapterOperation = false }
    }
  })

  const runtime = Object.freeze({ status, start, stop, adapterRuntime,
    host() { return host },
    usage() { return usage },
    async close() {
      closed = true
      await stop()
      await connection.close()
      store?.close()
      store = undefined
    }
  })
  nativeRuntimes.add(runtime)
  return runtime
}
