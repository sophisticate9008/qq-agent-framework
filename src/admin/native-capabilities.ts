import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { createDshJsonRpcPort } from '../adapters/dsh-jsonrpc.ts'
import { createDshAuthenticationOptions } from '../adapters/dsh-authentication.ts'
import { CHAT_CAPABILITY_BOUNDARY, createChatCapabilityService, validateChatCapabilityApprovalRequest,
  validateChatCapabilityCompositionApproval } from '../host/chat-capabilities.ts'
import type { ChatCapabilityApprovalRequest, ChatCapabilityCompositionApproval } from '../host/chat-capabilities.ts'
import type { NativeChatConfiguration, NativeChatDeploymentRuntimeInput } from '../host/native-chat-configuration.ts'
import { checkedNativeDeploymentRuntime } from '../host/native-deployment-runtime.ts'
import { nativeAuthorizationMode } from '../host/native-access.ts'
import { withNativeChatControl } from './runtime.ts'
import { readNativeChatConfiguration, setNativeChatCapabilityApproval } from './native-configuration-repository.ts'
import { AdminRequestError, type AdminRoute } from './server.ts'

import { NATIVE_CONFIGURATION_REVISION_KEYS as revisionKeys, NATIVE_REVISION_PATTERN as revisionPattern } from '../contracts/native-revisions.ts'

function fail(status: number, code: string): never {
  throw new AdminRequestError(status, code)
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function selection(configuration: NativeChatConfiguration) {
  return configuration.catalog.plans.find(plan => plan.id === configuration.catalog.activePlanId)?.capabilitySelection ?? null
}

function target(configuration: NativeChatConfiguration) {
  const value = configuration.deployment.target
  return value ? { ...value, layerPaths: value.layerPaths ?? [] } : null
}

function receipt(configuration: NativeChatConfiguration): ChatCapabilityCompositionApproval | null {
  const value = configuration.deployment.capabilityApproval
  return value == null ? null : validateChatCapabilityCompositionApproval(value)
}

function matches(approval: ChatCapabilityCompositionApproval | null, request: ChatCapabilityApprovalRequest): boolean {
  return approval !== null && isDeepStrictEqual({ schema: approval.schema, source: approval.source,
    compositionRevision: approval.compositionRevision, target: approval.target }, request)
}

function emptyQuery(query: URLSearchParams): void {
  if ([...query.keys()].length) fail(400, 'invalid_query')
}

function revisions(body: Record<string, unknown> | null, keys: readonly string[]) {
  if (!record(body) || !exact(body, keys) || !record(body.revisions) || !exact(body.revisions, revisionKeys)
    || !Object.values(body.revisions).every(value => typeof value === 'string' && revisionPattern.test(value))) {
    fail(400, 'invalid_runtime_revisions')
  }
  return body.revisions as Readonly<Record<string, string>>
}

function checkRevisions(configuration: NativeChatConfiguration, expected: Readonly<Record<string, string>>): void {
  if (revisionKeys.some(key => expected[key] !== configuration.revisions[key])) fail(409, 'chat_revision_conflict')
}

export function createNativeCapabilityApprovalResolver(directory: string) {
  return async (request: ChatCapabilityApprovalRequest, signal: AbortSignal): Promise<ChatCapabilityCompositionApproval | null> => {
    const captured = validateChatCapabilityApprovalRequest(request)
    signal.throwIfAborted()
    const configuration = await readNativeChatConfiguration(directory)
    signal.throwIfAborted()
    const approval = receipt(configuration)
    if (!isDeepStrictEqual(selection(configuration), captured.source)
      || !isDeepStrictEqual(target(configuration), captured.target)) return null
    return matches(approval, captured) ? approval : null
  }
}

export function createNativeCapabilityManagement(options: {
  readonly directory: string
  readonly deploymentRuntime: NativeChatDeploymentRuntimeInput
  readonly canApplyDeployment: () => Promise<boolean>
}) {
  const { directory } = options
  const deploymentRuntime = checkedNativeDeploymentRuntime(options.deploymentRuntime)
  if (!isAbsolute(directory) || directory.includes('\0')) throw new TypeError('A private absolute runtime directory is required')
  const load = () => readNativeChatConfiguration(directory)
  async function prepare(configuration: NativeChatConfiguration) {
    try { return await deploymentRuntime.prepare(configuration) }
    catch (error) {
      if (record(error) && error.code === 'NATIVE_DEPLOYMENT_PREPARATION_INVALID') fail(503, 'capability_preview_unavailable')
      throw error
    }
  }
  const routes: AdminRoute[] = [
    { method: 'GET', pathname: '/api/chat/capabilities', async handle({ query, signal }) {
      emptyQuery(query)
      const configuration = await load()
      const adapter = configuration.adapters.dshAgent
      let catalog: object = { ...CHAT_CAPABILITY_BOUNDARY, available: false, presets: [], missingReasons: ['capability_catalog_unavailable'] }
      if (adapter.enabled && adapter.endpoint && (adapter.auth || adapter.localCredentialsPath)) {
        let client: ReturnType<typeof createDshJsonRpcPort> | undefined
        try {
          client = createDshJsonRpcPort({ endpoint: adapter.endpoint, ...createDshAuthenticationOptions(adapter) })
          catalog = { ...await createChatCapabilityService({ client }).catalog(AbortSignal.any([signal, AbortSignal.timeout(5000)])),
            available: true, missingReasons: [] }
        } catch {
          signal.throwIfAborted()
        } finally { await client?.close() }
      }
      signal.throwIfAborted()
      const current = await load()
      checkRevisions(current, configuration.revisions)
      const approval = receipt(current)
      return { revisions: current.revisions, activePlanId: current.catalog.activePlanId,
        compositionApprovalRequired: nativeAuthorizationMode(current.authorization) !== 'whitelist',
        selection: selection(current), textOnly: selection(current) === null, approval, approvalState: approval ? 'saved' : 'none', catalog }
    } },
    { method: 'POST', pathname: '/api/chat/capabilities/preview', async handle({ query, body, signal }) {
      emptyQuery(query)
      const expected = revisions(body, ['revisions'])
      return withNativeChatControl(directory, async () => {
        const configuration = await load()
        checkRevisions(configuration, expected)
        const preparation = await prepare(configuration)
        signal.throwIfAborted()
        checkRevisions(await load(), expected)
        const approval = receipt(configuration)
        let approvalMatchesPreview = false
        if (preparation.capabilityApprovalRequest != null) {
          try { approvalMatchesPreview = matches(approval, validateChatCapabilityApprovalRequest(preparation.capabilityApprovalRequest)) }
          catch { fail(503, 'capability_preview_unavailable') }
        }
        return { revisions: configuration.revisions, selection: selection(configuration), approval, approvalMatchesPreview,
          textOnly: selection(configuration) === null, readOnly: true, externalMutation: false, preparation }
      })
    } },
    { method: 'POST', pathname: '/api/chat/capabilities/approval', async handle({ query, body, signal }) {
      emptyQuery(query)
      const expected = revisions(body, ['revisions', 'targetRevision', 'compositionRevision', 'confirm'])
      if (body!.confirm !== true || typeof body!.targetRevision !== 'string' || !revisionPattern.test(body!.targetRevision)
        || typeof body!.compositionRevision !== 'string' || !revisionPattern.test(body!.compositionRevision)) fail(400, 'invalid_capability_approval')
      return withNativeChatControl(directory, async () => {
        const configuration = await load()
        checkRevisions(configuration, expected)
        if (!await options.canApplyDeployment()) fail(409, 'native_chat_busy')
        const prepared = await prepare(configuration)
        signal.throwIfAborted()
        if (prepared.state !== 'prepared' || !record(prepared.summary) || prepared.summary.ready !== true) fail(409, 'capability_preview_blocked')
        if (prepared.targetRevision !== body!.targetRevision) fail(409, 'capability_preview_conflict')
        let request: ChatCapabilityApprovalRequest
        try { request = validateChatCapabilityApprovalRequest(prepared.capabilityApprovalRequest) }
        catch { fail(409, 'capability_preview_blocked') }
        if (request.compositionRevision !== body!.compositionRevision || !isDeepStrictEqual(request.source, selection(configuration))
          || !isDeepStrictEqual(request.target, target(configuration))) {
          fail(409, 'capability_preview_conflict')
        }
        if (!await options.canApplyDeployment()) fail(409, 'native_chat_busy')
        const approval = validateChatCapabilityCompositionApproval({ ...request, approvalId: randomUUID(), authority: 'owner',
          externalTools: 'separate-runtime-authorization-required' })
        const saved = await setNativeChatCapabilityApproval(directory, expected, approval, signal)
        return { revisions: saved.revisions, approval: receipt(saved), requiresNewPreview: true }
      })
    } },
    { method: 'POST', pathname: '/api/chat/capabilities/revoke', async handle({ query, body, signal }) {
      emptyQuery(query)
      const expected = revisions(body, ['revisions', 'approvalId', 'confirm'])
      if (body!.confirm !== true || typeof body!.approvalId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(body!.approvalId)) {
        fail(400, 'invalid_capability_approval')
      }
      return withNativeChatControl(directory, async () => {
        const configuration = await load()
        checkRevisions(configuration, expected)
        if (receipt(configuration)?.approvalId !== body!.approvalId) fail(409, 'capability_approval_conflict')
        const saved = await setNativeChatCapabilityApproval(directory, expected, null, signal)
        return { revisions: saved.revisions, approval: null, requiresNewPreview: true }
      })
    } }
  ]
  return Object.freeze({ routes: Object.freeze(routes), resolveCapabilityApproval: createNativeCapabilityApprovalResolver(directory) })
}
