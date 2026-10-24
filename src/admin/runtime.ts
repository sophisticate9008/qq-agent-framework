import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import {
  CHAT_PLAN_REASONING_EFFORTS,
  validateChatPlanCatalog,
  validateChatPersonas,
  type ChatPlan,
  type ChatPlanCatalog,
  type ChatPlanReasoningEffort,
  type ChatPersona
} from '../host/chat-plans.ts'
import {
  publicModelProviders,
  updateModelProviders,
  validateModelProviders,
  type NativeModelProvider
} from '../host/model-providers.ts'
import {
  createDefaultAdapterConfiguration,
  publicAdapterConfiguration,
  updateAdapterConfiguration,
  validateAdapterConfiguration,
  type AdapterConnectionStatus,
  type AdapterRuntimePort,
  type NativeAdapterConfiguration
} from '../host/adapter-configuration.ts'
import { AdminRequestError, type AdminRoute } from './server.ts'
import { createHostAdminRoutes } from './host.ts'
import {
  DEFAULT_NATIVE_CHAT_AUTHORIZATION, DEFAULT_NATIVE_CHAT_DEPLOYMENT,
  validateNativeChatAuthorization,
  type NativeChatAuthorization, type NativeChatConfiguration, type NativeChatDeploymentConfiguration,
  type NativeChatDeploymentRuntime
} from '../host/native-chat-configuration.ts'
import { isNativeChatRuntime, type NativeChatRuntime } from '../host/native-chat-runtime.ts'
import { validateDshModelSettings } from '../adapters/dsh-deployment.ts'
import type { NativeUsageQuery } from '../host/native-usage.ts'
import { createNativeUsageProjection } from '../host/native-usage-projection.ts'

const MAX_DOCUMENT_BYTES = 64 * 1024
const MAX_ACCESS_ENTRIES = 1_024
const LOCK_FILENAME = '.chat-runtime.lock'
const REVISION_PATTERN = /^[a-f0-9]{64}$/
const SCOPE_PATTERN = /^(?:group|private):[1-9][0-9]{0,19}$/
const OWNER_PATTERN = /^[1-9][0-9]{0,19}$/

interface StoredPlans {
  readonly schema: 1
  readonly activePlanId: string | null
  readonly plans: readonly ChatPlan[]
}

interface StoredPersonas {
  readonly schema: 1
  readonly personas: readonly ChatPersona[]
}

interface StoredAccess {
  readonly schema: 1
  readonly allow: readonly string[]
  readonly deny: readonly string[]
  readonly owner: string | null
}

interface StoredAdapters {
  readonly schema: 1
  readonly adapters: NativeAdapterConfiguration
}

interface StoredProviders {
  readonly schema: 1
  readonly providers: readonly NativeModelProvider[]
}

interface Document<Value> {
  readonly revision: string
  readonly value: Value
}

export interface NativeRuntimeRouteOptions {
  readonly directory: string
  readonly adapterRuntime?: AdapterRuntimePort
  readonly chatRuntime?: NativeChatRuntime
  readonly deploymentRuntime?: NativeChatDeploymentRuntime
}

interface StoredAuthorization { readonly schema: 1; readonly authorization: NativeChatAuthorization }
interface StoredDeployment { readonly schema: 1; readonly deployment: NativeChatDeploymentConfiguration }
const DEFAULT_AUTHORIZATION: StoredAuthorization = { schema: 1, authorization: DEFAULT_NATIVE_CHAT_AUTHORIZATION }
const DEFAULT_DEPLOYMENT: StoredDeployment = { schema: 1, deployment: DEFAULT_NATIVE_CHAT_DEPLOYMENT }

const DEFAULT_PLANS: StoredPlans = Object.freeze({ schema: 1, activePlanId: null, plans: Object.freeze([]) })
const DEFAULT_PERSONAS: StoredPersonas = Object.freeze({ schema: 1, personas: Object.freeze([]) })
const DEFAULT_ACCESS: StoredAccess = Object.freeze({
  schema: 1,
  allow: Object.freeze([]),
  deny: Object.freeze([]),
  owner: null
})
const DEFAULT_ADAPTERS: StoredAdapters = Object.freeze({ schema: 1, adapters: createDefaultAdapterConfiguration() })
const DEFAULT_PROVIDERS: StoredProviders = Object.freeze({ schema: 1, providers: Object.freeze([]) })
const writeTails = new Map<string, Promise<void>>()
const adapterControls = new Map<string, Promise<unknown>>()
const nativeControls = new Set<string>()

function requestError(statusCode: number, code: string): never {
  throw new AdminRequestError(statusCode, code)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every(key => keys.includes(key))
}

function revision(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

function sameFile(
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number }
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function serialize(value: unknown): Buffer {
  const content = Buffer.from(`${JSON.stringify(value)}\n`)
  if (content.byteLength > MAX_DOCUMENT_BYTES) requestError(413, 'chat_document_too_large')
  return content
}

function parseRevision(value: unknown): string {
  if (typeof value !== 'string' || !REVISION_PATTERN.test(value)) requestError(400, 'invalid_chat_request')
  return value
}

function requireEmptyQuery(query: URLSearchParams): void {
  if ([...query.keys()].length !== 0) requestError(400, 'invalid_query')
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  try {
    const before = await lstat(directory).catch((error: unknown) => {
      if (isRecord(error) && error.code === 'ENOENT') return null
      throw error
    })
    if (before !== null && !before.isDirectory()) requestError(500, 'chat_storage_invalid')
    if (before === null) await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const after = await lstat(directory)
    if (!after.isDirectory() || after.isSymbolicLink() || (after.mode & 0o777) !== 0o700) {
      requestError(500, 'chat_storage_invalid')
    }
  } catch (error: unknown) {
    if (error instanceof AdminRequestError) throw error
    requestError(500, 'chat_storage_invalid')
  }
}

async function readDocument<Value>(
  filename: string,
  fallback: Value,
  validate: (value: unknown) => Value
): Promise<Document<Value>> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error: unknown) {
    if (isRecord(error) && error.code === 'ENOENT') {
      const content = serialize(fallback)
      return { revision: revision(content), value: fallback }
    }
    requestError(500, 'chat_storage_invalid')
  }
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600
      || before.size > MAX_DOCUMENT_BYTES) requestError(500, 'chat_storage_invalid')
    const content = await handle.readFile()
    const after = await handle.stat()
    const pathname = await lstat(filename)
    if (content.byteLength > MAX_DOCUMENT_BYTES || !sameFile(before, after) || !sameFile(after, pathname)
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      requestError(409, 'chat_revision_conflict')
    }
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content))
    return { revision: revision(content), value: validate(parsed) }
  } catch (error: unknown) {
    if (error instanceof AdminRequestError) throw error
    requestError(500, 'chat_storage_invalid')
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function serializeWrite<Value>(directory: string, operation: () => Promise<Value>): Promise<Value> {
  const previous = writeTails.get(directory) ?? Promise.resolve()
  let release: (() => void) | undefined
  const current = new Promise<void>(resolvePromise => { release = resolvePromise })
  const tail = previous.catch(() => undefined).then(() => current)
  writeTails.set(directory, tail)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release?.()
    if (writeTails.get(directory) === tail) writeTails.delete(directory)
  }
}

async function acquireDirectoryLock(directory: string): Promise<() => Promise<void>> {
  const filename = join(directory, LOCK_FILENAME)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(filename,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  } catch (error: unknown) {
    if (isRecord(error) && error.code === 'EEXIST') requestError(409, 'chat_storage_busy')
    requestError(500, 'chat_storage_invalid')
  }
  try {
    await handle.chmod(0o600)
    await handle.sync()
    const opened = await handle.stat()
    const current = await lstat(filename)
    if (!opened.isFile() || opened.nlink !== 1 || (opened.mode & 0o777) !== 0o600
      || !sameFile(opened, current)) requestError(500, 'chat_storage_invalid')
    return async () => {
      await handle?.close().catch(() => undefined)
      try {
        const latest = await lstat(filename)
        if (sameFile(opened, latest)) await unlink(filename)
      } catch {
        return
      }
    }
  } catch (error: unknown) {
    await handle.close().catch(() => undefined)
    await unlink(filename).catch(() => undefined)
    if (error instanceof AdminRequestError) throw error
    requestError(500, 'chat_storage_invalid')
  }
}

async function withDirectoryWriteLock<Value>(
  directory: string,
  operation: () => Promise<Value>
): Promise<Value> {
  return serializeWrite(directory, async () => {
    const release = await acquireDirectoryLock(directory)
    try {
      return await operation()
    } finally {
      await release()
    }
  })
}

async function writeDocumentLocked<Value>(
  directory: string,
  filename: string,
  expectedRevision: string,
  fallback: Value,
  validate: (value: unknown) => Value,
  value: Value
): Promise<Document<Value>> {
  const content = serialize(value)
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let renamed = false
  try {
    handle = await open(temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    await handle.chmod(0o600)
    await handle.writeFile(content)
    await handle.sync()
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600
      || metadata.size !== content.byteLength) requestError(500, 'chat_storage_write_failed')
    await handle.close()
    handle = undefined
    const latest = await readDocument(filename, fallback, validate)
    if (latest.revision !== expectedRevision) requestError(409, 'chat_revision_conflict')
    await rename(temporary, filename)
    renamed = true
    const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
    const saved = await readDocument(filename, fallback, validate)
    if (saved.revision !== revision(content)) requestError(500, 'chat_write_unknown')
    return saved
  } catch (error: unknown) {
    if (renamed) requestError(500, 'chat_write_unknown')
    if (error instanceof AdminRequestError) throw error
    requestError(500, 'chat_storage_write_failed')
  } finally {
    await handle?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
  }
  throw new AdminRequestError(500, 'chat_storage_write_failed')
}

async function updateDocument<Value>(
  directory: string,
  filename: string,
  expectedRevision: string,
  fallback: Value,
  validate: (value: unknown) => Value,
  update: (current: Value) => Value | Promise<Value>,
  precommit: (next: Value, current: Value) => void | Promise<void> = () => undefined
): Promise<Document<Value>> {
  return withDirectoryWriteLock(directory, async () => {
    const current = await readDocument(filename, fallback, validate)
    if (current.revision !== expectedRevision) requestError(409, 'chat_revision_conflict')
    const next = await update(current.value)
    await precommit(next, current.value)
    return writeDocumentLocked(directory, filename, expectedRevision, fallback, validate, next)
  })
}

function validateStoredPlans(value: unknown): StoredPlans {
  if (!isRecord(value) || !hasExactKeys(value, ['schema', 'activePlanId', 'plans']) || value.schema !== 1) {
    throw new TypeError('Invalid plans document')
  }
  const catalog = validateChatPlanCatalog({ activePlanId: value.activePlanId, plans: value.plans })
  return Object.freeze({ schema: 1, activePlanId: catalog.activePlanId, plans: catalog.plans })
}

function validateStoredPersonas(value: unknown): StoredPersonas {
  if (!isRecord(value) || !hasExactKeys(value, ['schema', 'personas']) || value.schema !== 1) {
    throw new TypeError('Invalid personas document')
  }
  return Object.freeze({ schema: 1, personas: validateChatPersonas(value.personas) })
}

function validAccessEntries(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= MAX_ACCESS_ENTRIES
    && value.every(entry => typeof entry === 'string' && SCOPE_PATTERN.test(entry))
    && new Set(value).size === value.length
}

function validateStoredAccess(value: unknown): StoredAccess {
  if (!isRecord(value) || !hasExactKeys(value, ['schema', 'allow', 'deny', 'owner']) || value.schema !== 1
    || !validAccessEntries(value.allow) || !validAccessEntries(value.deny)
    || value.owner !== null && (typeof value.owner !== 'string' || !OWNER_PATTERN.test(value.owner))) {
    throw new TypeError('Invalid access document')
  }
  const denied = new Set(value.deny)
  if (value.allow.some(entry => denied.has(entry))) throw new TypeError('Ambiguous access document')
  return Object.freeze({
    schema: 1,
    allow: Object.freeze([...value.allow]),
    deny: Object.freeze([...value.deny]),
    owner: value.owner
  })
}

function validateStoredAdapters(value: unknown): StoredAdapters {
  if (!isRecord(value) || !hasExactKeys(value, ['schema', 'adapters']) || value.schema !== 1) {
    throw new TypeError('Invalid adapters document')
  }
  return Object.freeze({ schema: 1, adapters: validateAdapterConfiguration(value.adapters) })
}

function validateStoredProviders(value: unknown): StoredProviders {
  if (!isRecord(value) || !hasExactKeys(value, ['schema', 'providers']) || value.schema !== 1) {
    throw new TypeError('Invalid providers document')
  }
  return Object.freeze({ schema: 1, providers: validateModelProviders(value.providers) })
}

function validateStoredAuthorization(value: unknown): StoredAuthorization {
  if (!isRecord(value) || !hasExactKeys(value, ['schema', 'authorization']) || value.schema !== 1) {
    throw new TypeError('Invalid authorization document')
  }
  return { schema: 1, authorization: validateNativeChatAuthorization(value.authorization) }
}

function validateStoredDeployment(value: unknown): StoredDeployment {
  if (!isRecord(value) || !hasExactKeys(value, ['schema', 'deployment']) || value.schema !== 1
    || !isRecord(value.deployment) || !hasExactKeys(value.deployment, ['target', 'modelSettings', 'namespace'])) {
    throw new TypeError('Invalid deployment document')
  }
  const input = value.deployment
  if (typeof input.namespace !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.namespace)
    || input.target !== null && (!isRecord(input.target)
      || !['profilePath', 'credentialsPath', 'schemaVersion'].every(key => Object.hasOwn(input.target as object, key))
      || !Object.keys(input.target).every(key => ['profilePath', 'credentialsPath', 'layerPaths', 'schemaVersion'].includes(key))
      || typeof input.target.profilePath !== 'string' || input.target.profilePath.length > 4_096
      || !isAbsolute(input.target.profilePath) || /[\u0000-\u001f\u007f]/.test(input.target.profilePath)
      || typeof input.target.credentialsPath !== 'string' || input.target.credentialsPath.length > 4_096
      || !isAbsolute(input.target.credentialsPath) || /[\u0000-\u001f\u007f]/.test(input.target.credentialsPath)
      || input.target.layerPaths !== undefined && (!Array.isArray(input.target.layerPaths) || input.target.layerPaths.length > 16
        || !input.target.layerPaths.every(path => typeof path === 'string' && path.length <= 4_096
          && isAbsolute(path) && !/[\u0000-\u001f\u007f]/.test(path)))
      || input.target.schemaVersion !== '0.2.1-rc.2')) throw new TypeError('Invalid deployment target')
  return { schema: 1, deployment: {
    namespace: input.namespace,
    target: input.target === null ? null : {
      profilePath: (input.target as Record<string, unknown>).profilePath as string,
      credentialsPath: (input.target as Record<string, unknown>).credentialsPath as string,
      ...((input.target as Record<string, unknown>).layerPaths === undefined ? {}
        : { layerPaths: (input.target as Record<string, unknown>).layerPaths as readonly string[] }),
      schemaVersion: '0.2.1-rc.2'
    },
    modelSettings: input.modelSettings === null ? null : validateDshModelSettings(input.modelSettings)
  } }
}

export async function readNativeChatConfiguration(directory: string): Promise<NativeChatConfiguration> {
  if (!isAbsolute(directory) || directory.includes('\0')) throw new TypeError('An absolute runtime directory is required')
  await ensurePrivateDirectory(directory)
  return withDirectoryWriteLock(directory, async () => {
    const plans = await readDocument(join(directory, 'chat-plans.json'), DEFAULT_PLANS, validateStoredPlans)
    const personas = await readDocument(join(directory, 'chat-personas.json'), DEFAULT_PERSONAS, validateStoredPersonas)
    const access = await readDocument(join(directory, 'chat-access.json'), DEFAULT_ACCESS, validateStoredAccess)
    const adapters = await readDocument(join(directory, 'chat-adapters.json'), DEFAULT_ADAPTERS, validateStoredAdapters)
    const providers = await readDocument(join(directory, 'chat-providers.json'), DEFAULT_PROVIDERS, validateStoredProviders)
    const authorization = await readDocument(join(directory, 'chat-authorization.json'), DEFAULT_AUTHORIZATION, validateStoredAuthorization)
    const deployment = await readDocument(join(directory, 'chat-deployment.json'), DEFAULT_DEPLOYMENT, validateStoredDeployment)
    return {
      revisions: { plans: plans.revision, personas: personas.revision, access: access.revision,
        adapters: adapters.revision, providers: providers.revision, authorization: authorization.revision,
        deployment: deployment.revision },
      catalog: { activePlanId: plans.value.activePlanId, plans: plans.value.plans },
      personas: personas.value.personas, access: access.value, adapters: adapters.value.adapters,
      providers: providers.value.providers, authorization: authorization.value.authorization,
      deployment: deployment.value.deployment
    }
  })
}

interface AdapterRuntimeStatus {
  readonly assembled: boolean
  readonly running: boolean
  readonly applyAvailable: boolean
}

async function adapterRuntimeStatus(port: AdapterRuntimePort | undefined): Promise<AdapterRuntimeStatus> {
  if (port === undefined) return { assembled: false, running: false, applyAvailable: false }
  try {
    const status: unknown = await port.status()
    if (!isRecord(status) || !hasExactKeys(status, ['running']) || typeof status.running !== 'boolean') {
      requestError(503, 'adapter_runtime_status_unavailable')
    }
    return { assembled: true, running: status.running, applyAvailable: typeof port.connect === 'function' }
  } catch {
    requestError(503, 'adapter_runtime_status_unavailable')
  }
}

async function adapterConnectionStatus(port: AdapterRuntimePort | undefined, chatRuntime?: NativeChatRuntime): Promise<AdapterConnectionStatus | undefined> {
  if (port?.connectionStatus === undefined) return undefined
  try {
    const status: unknown = await port.connectionStatus()
    if (!isRecord(status) || !hasExactKeys(status, ['state', 'selfId', 'lastError', 'received', 'dropped', 'chatReady'])
      || !['disconnected', 'connecting', 'connected', 'reconnecting', 'error'].includes(String(status.state))
      || status.selfId !== null && (typeof status.selfId !== 'string' || !/^[1-9][0-9]{0,31}$/.test(status.selfId))
      || status.lastError !== null && typeof status.lastError !== 'string'
      || ![status.received, status.dropped].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      || typeof status.chatReady !== 'boolean'
      || status.chatReady && (!isNativeChatRuntime(chatRuntime) || port !== chatRuntime.adapterRuntime
        || status.state !== 'connected' || status.selfId === null)) requestError(503, 'adapter_runtime_status_unavailable')
    return Object.freeze({
      state: status.state as AdapterConnectionStatus['state'], selfId: status.selfId as string | null,
      lastError: status.lastError === null ? null
        : /^(?:onebot_ws_[a-z0-9_]{1,64}|adapter_runtime_(?:aborted|closed|busy))$/.test(String(status.lastError))
          ? String(status.lastError) : 'adapter_connection_error',
      received: status.received as number, dropped: status.dropped as number, chatReady: status.chatReady
    })
  } catch {
    requestError(503, 'adapter_runtime_status_unavailable')
  }
}

function adaptersResponse(
  document: Document<StoredAdapters>,
  status: AdapterRuntimeStatus,
  connection?: AdapterConnectionStatus
): Record<string, unknown> {
  return {
    revision: document.revision, adapters: publicAdapterConfiguration(document.value.adapters), status,
    ...(connection === undefined ? {} : { connection })
  }
}

async function controlAdapterRuntime<Value>(
  directory: string,
  signal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<Value>
): Promise<Value> {
  if (adapterControls.has(directory) || nativeControls.has(directory)) requestError(409, 'adapter_runtime_busy')
  if (signal.aborted) requestError(499, 'request_aborted')
  const controller = new AbortController()
  let rejectDeadline: ((error: AdminRequestError) => void) | undefined
  const deadline = new Promise<never>((_resolvePromise, rejectPromise) => { rejectDeadline = rejectPromise })
  const cancel = (): void => {
    controller.abort()
    rejectDeadline?.(new AdminRequestError(499, 'request_aborted'))
  }
  signal.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => {
    controller.abort()
    rejectDeadline?.(new AdminRequestError(504, 'adapter_runtime_timeout'))
  }, 5_000)
  const pending = (async () => {
    const release = await acquireDirectoryLock(directory)
    try {
      if (controller.signal.aborted) requestError(499, 'request_aborted')
      return await operation(controller.signal)
    } catch (error: unknown) {
      if (error instanceof AdminRequestError) throw error
      requestError(503, 'adapter_connection_failed')
    } finally {
      await release()
    }
  })()
  adapterControls.set(directory, pending)
  void pending.finally(() => {
    if (adapterControls.get(directory) === pending) adapterControls.delete(directory)
  }).catch(() => undefined)
  try {
    return await Promise.race([pending, deadline])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
  }
}

function plansResponse(document: Document<StoredPlans>): Record<string, unknown> {
  return { revision: document.revision, activePlanId: document.value.activePlanId, plans: document.value.plans }
}

function providersResponse(document: Document<StoredProviders>): Record<string, unknown> {
  return { revision: document.revision, providers: publicModelProviders(document.value.providers) }
}

function personasResponse(document: Document<StoredPersonas>): Record<string, unknown> {
  return { revision: document.revision, personas: document.value.personas }
}

function accessResponse(document: Document<StoredAccess>): Record<string, unknown> {
  return {
    revision: document.revision,
    allow: document.value.allow,
    deny: document.value.deny,
    owner: document.value.owner
  }
}

function modelResponse(document: Document<StoredPlans>): Record<string, unknown> {
  const active = document.value.activePlanId === null
    ? undefined
    : document.value.plans.find(plan => plan.id === document.value.activePlanId)
  return {
    revision: document.revision,
    activePlanId: active?.id ?? null,
    provider: active?.provider ?? null,
    model: active?.model ?? null,
    reasoningEffort: active?.reasoningEffort ?? null
  }
}

function parsePlansRequest(body: Record<string, unknown> | null): { revision: string; value: StoredPlans } {
  if (!isRecord(body) || !hasExactKeys(body, ['revision', 'activePlanId', 'plans'])) {
    requestError(400, 'invalid_chat_request')
  }
  try {
    const catalog = validateChatPlanCatalog({ activePlanId: body.activePlanId, plans: body.plans })
    return {
      revision: parseRevision(body.revision),
      value: Object.freeze({ schema: 1, activePlanId: catalog.activePlanId, plans: catalog.plans })
    }
  } catch (error: unknown) {
    if (error instanceof AdminRequestError) throw error
    requestError(400, 'invalid_chat_request')
  }
}

function parsePersonasRequest(body: Record<string, unknown> | null): { revision: string; value: StoredPersonas } {
  if (!isRecord(body) || !hasExactKeys(body, ['revision', 'personas'])) requestError(400, 'invalid_chat_request')
  try {
    return {
      revision: parseRevision(body.revision),
      value: Object.freeze({ schema: 1, personas: validateChatPersonas(body.personas) })
    }
  } catch (error: unknown) {
    if (error instanceof AdminRequestError) throw error
    requestError(400, 'invalid_chat_request')
  }
}

function parseAccessRequest(body: Record<string, unknown> | null): { revision: string; value: StoredAccess } {
  if (!isRecord(body) || !hasExactKeys(body, ['revision', 'allow', 'deny', 'owner'])) {
    requestError(400, 'invalid_chat_request')
  }
  try {
    return {
      revision: parseRevision(body.revision),
      value: validateStoredAccess({ schema: 1, allow: body.allow, deny: body.deny, owner: body.owner })
    }
  } catch (error: unknown) {
    if (error instanceof AdminRequestError) throw error
    requestError(400, 'invalid_chat_request')
  }
}

function parseModelRequest(body: Record<string, unknown> | null): {
  readonly revision: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: ChatPlanReasoningEffort
} {
  if (!isRecord(body) || !hasExactKeys(body, ['revision', 'provider', 'model', 'reasoningEffort'])
    || typeof body.provider !== 'string' || typeof body.model !== 'string'
    || typeof body.reasoningEffort !== 'string'
    || !(CHAT_PLAN_REASONING_EFFORTS as readonly string[]).includes(body.reasoningEffort)) {
    requestError(400, 'invalid_chat_request')
  }
  return {
    revision: parseRevision(body.revision),
    provider: body.provider,
    model: body.model,
    reasoningEffort: body.reasoningEffort as ChatPlanReasoningEffort
  }
}

function assertPersonaReferences(plans: readonly ChatPlan[], personas: readonly ChatPersona[]): void {
  const ids = new Set(personas.map(persona => persona.id))
  if (plans.some(plan => !ids.has(plan.personaId))) requestError(409, 'persona_in_use_or_missing')
}

function assertPlanModelReferences(
  next: StoredPlans,
  current: StoredPlans,
  providers: readonly NativeModelProvider[]
): void {
  for (const plan of next.plans) {
    const provider = providers.find(entry => entry.id === plan.provider)
    if (provider?.enabled && provider.models.some(model => model.id === plan.model)) continue
    const previous = current.plans.find(entry => entry.id === plan.id)
    const unchanged = previous?.provider === plan.provider && previous.model === plan.model
    const newlyActive = next.activePlanId === plan.id && current.activePlanId !== plan.id
    if (!unchanged || newlyActive) requestError(409, 'provider_model_missing_or_disabled')
  }
}

function assertProviderReferences(
  next: readonly NativeModelProvider[],
  current: readonly NativeModelProvider[],
  plans: readonly ChatPlan[]
): void {
  for (const plan of plans) {
    const previous = current.find(entry => entry.id === plan.provider)
    if (previous === undefined) continue
    const provider = next.find(entry => entry.id === plan.provider)
    if (provider === undefined || previous.enabled && !provider.enabled
      || previous.models.some(model => model.id === plan.model)
        && !provider.models.some(model => model.id === plan.model)) {
      requestError(409, 'provider_model_in_use')
    }
  }
}

function validAdapterRuntimePort(value: unknown): value is AdapterRuntimePort {
  return isRecord(value) && typeof value.status === 'function'
    && ['connect', 'disconnect', 'connectionStatus'].every(key => !Object.hasOwn(value, key)
      || typeof value[key] === 'function')
}

export function createNativeRuntimeRoutes(options: NativeRuntimeRouteOptions): readonly AdminRoute[] {
  if (!isRecord(options) || !Object.hasOwn(options, 'directory')
    || !Object.keys(options).every(key => ['directory', 'adapterRuntime', 'chatRuntime', 'deploymentRuntime'].includes(key))
    || typeof options.directory !== 'string'
    || options.directory.length === 0 || options.directory.includes('\0') || !isAbsolute(options.directory)
    || options.chatRuntime !== undefined && !isNativeChatRuntime(options.chatRuntime)
    || options.adapterRuntime !== undefined && !validAdapterRuntimePort(options.adapterRuntime)) {
    throw new TypeError('Native runtime routes require an absolute directory and an optional runtime status port.')
  }
  const directory = resolve(options.directory)
  const ready = ensurePrivateDirectory(directory)
  void ready.catch(() => undefined)
  const plansFile = join(directory, 'chat-plans.json')
  const personasFile = join(directory, 'chat-personas.json')
  const accessFile = join(directory, 'chat-access.json')
  const adaptersFile = join(directory, 'chat-adapters.json')
  const providersFile = join(directory, 'chat-providers.json')
  const adapterRuntime = options.adapterRuntime
  const chatRuntime = options.chatRuntime

  const routes: AdminRoute[] = [
    {
      method: 'GET', pathname: '/api/chat/plans',
      async handle({ query }) {
        requireEmptyQuery(query)
        await ready
        return plansResponse(await readDocument(plansFile, DEFAULT_PLANS, validateStoredPlans))
      }
    },
    {
      method: 'POST', pathname: '/api/chat/plans',
      async handle({ query, body }) {
        requireEmptyQuery(query)
        await ready
        const request = parsePlansRequest(body)
        return plansResponse(await updateDocument(
          directory, plansFile, request.revision, DEFAULT_PLANS, validateStoredPlans,
          () => request.value,
          async (next, current) => {
            const personas = await readDocument(personasFile, DEFAULT_PERSONAS, validateStoredPersonas)
            assertPersonaReferences(next.plans, personas.value.personas)
            const providers = await readDocument(providersFile, DEFAULT_PROVIDERS, validateStoredProviders)
            assertPlanModelReferences(next, current, providers.value.providers)
          }
        ))
      }
    },
    {
      method: 'GET', pathname: '/api/chat/personas',
      async handle({ query }) {
        requireEmptyQuery(query)
        await ready
        return personasResponse(await readDocument(personasFile, DEFAULT_PERSONAS, validateStoredPersonas))
      }
    },
    {
      method: 'POST', pathname: '/api/chat/personas',
      async handle({ query, body }) {
        requireEmptyQuery(query)
        await ready
        const request = parsePersonasRequest(body)
        return personasResponse(await updateDocument(
          directory, personasFile, request.revision, DEFAULT_PERSONAS, validateStoredPersonas,
          () => request.value,
          async next => {
            const plans = await readDocument(plansFile, DEFAULT_PLANS, validateStoredPlans)
            assertPersonaReferences(plans.value.plans, next.personas)
          }
        ))
      }
    },
    {
      method: 'GET', pathname: '/api/chat/model',
      async handle({ query }) {
        requireEmptyQuery(query)
        await ready
        return modelResponse(await readDocument(plansFile, DEFAULT_PLANS, validateStoredPlans))
      }
    },
    {
      method: 'POST', pathname: '/api/chat/model',
      async handle({ query, body }) {
        requireEmptyQuery(query)
        await ready
        const request = parseModelRequest(body)
        return modelResponse(await updateDocument(
          directory, plansFile, request.revision, DEFAULT_PLANS, validateStoredPlans,
          current => {
            if (current.activePlanId === null) requestError(409, 'no_active_plan')
            const plans = current.plans.map(plan => plan.id === current.activePlanId
              ? { ...plan, provider: request.provider, model: request.model,
                reasoningEffort: request.reasoningEffort }
              : plan)
            try {
              return validateStoredPlans({ schema: 1, activePlanId: current.activePlanId, plans })
            } catch {
              requestError(400, 'invalid_chat_request')
            }
          },
          async (next, current) => {
            const providers = await readDocument(providersFile, DEFAULT_PROVIDERS, validateStoredProviders)
            assertPlanModelReferences(next, current, providers.value.providers)
          }
        ))
      }
    },
    {
      method: 'GET', pathname: '/api/chat/providers',
      async handle({ query }) {
        requireEmptyQuery(query)
        await ready
        return providersResponse(await readDocument(providersFile, DEFAULT_PROVIDERS, validateStoredProviders))
      }
    },
    {
      method: 'POST', pathname: '/api/chat/providers',
      async handle({ query, body }) {
        requireEmptyQuery(query)
        await ready
        if (!isRecord(body) || !hasExactKeys(body, ['revision', 'providers'])
          || typeof body.revision !== 'string' || !REVISION_PATTERN.test(body.revision)) {
          requestError(400, 'invalid_model_providers')
        }
        return providersResponse(await updateDocument(
          directory, providersFile, body.revision, DEFAULT_PROVIDERS, validateStoredProviders,
          current => {
            try {
              return Object.freeze({ schema: 1, providers: updateModelProviders(current.providers, body.providers) })
            } catch {
              requestError(400, 'invalid_model_providers')
            }
          },
          async (next, current) => {
            const plans = await readDocument(plansFile, DEFAULT_PLANS, validateStoredPlans)
            assertProviderReferences(next.providers, current.providers, plans.value.plans)
          }
        ))
      }
    },
    {
      method: 'GET', pathname: '/api/chat/access',
      async handle({ query }) {
        requireEmptyQuery(query)
        await ready
        return accessResponse(await readDocument(accessFile, DEFAULT_ACCESS, validateStoredAccess))
      }
    },
    {
      method: 'POST', pathname: '/api/chat/access',
      async handle({ query, body }) {
        requireEmptyQuery(query)
        await ready
        const request = parseAccessRequest(body)
        return accessResponse(await updateDocument(
          directory, accessFile, request.revision, DEFAULT_ACCESS, validateStoredAccess, () => request.value
        ))
      }
    },
    {
      method: 'GET', pathname: '/api/chat/status',
      async handle({ query }) {
        requireEmptyQuery(query)
        await ready
        return chatRuntime === undefined ? { runtimeConnected: false } : chatRuntime.status()
      }
    },
    {
      method: 'GET', pathname: '/api/chat/features',
      async handle({ query }) {
        requireEmptyQuery(query)
        await ready
        if (chatRuntime !== undefined) {
          const status = await chatRuntime.status()
          const features = chatRuntime.host()?.engine.describe().features ?? []
          const installed = features.some(feature => feature.id === 'agent-relay' && feature.status === 'active')
          return { runtimeConnected: status.chatReady, editableResources: true,
            capabilities: ['chat-plans', 'personas', 'model-settings', 'access-policy'].map(id => ({ id, installed })),
            features: features.map(feature => ({ id: feature.id, version: feature.version, status: feature.status,
              capabilities: feature.capabilities.filter(capability => ['agent.submit', 'messaging.send'].includes(capability)) })) }
        }
        return {
          runtimeConnected: false,
          editableResources: true,
          capabilities: [
            { id: 'chat-plans', installed: false },
            { id: 'personas', installed: false },
            { id: 'model-settings', installed: false },
            { id: 'access-policy', installed: false }
          ],
          features: []
        }
      }
    },
    {
      method: 'GET', pathname: '/api/chat/sessions',
      maxResponseBytes: 1_048_576,
      async handle({ query }) {
        if (chatRuntime?.host() === undefined) requestError(503, 'runtime_not_connected')
        const page = await hostRoute(chatRuntime, '/api/host/sessions').handle({ query, body: null, signal: new AbortController().signal })
        if (!isRecord(page) || !Array.isArray(page.items)) requestError(500, 'native_session_metadata_invalid')
        const configuration = await readNativeChatConfiguration(directory)
        const sessions = page.items.filter(item => isRecord(item) && item.state === 'ready').map(item => {
          const entry = item as Record<string, unknown>
          return { key: entry.conversationId, sessionId: entry.sessionId,
            owner: entry.conversationId === `private:${configuration.access.owner}` }
        })
        return { ...page, sessions, revision: revision(Buffer.from(JSON.stringify({ sessions, items: page.items }))), resetAvailable: false }
      }
    },
    {
      method: 'GET', pathname: '/api/chat/usage',
      maxResponseBytes: 4_194_304,
      async handle({ query }) {
        const host = chatRuntime?.host()
        if (host === undefined) requestError(503, 'runtime_not_connected')
        const usage = chatRuntime?.usage()
        if (usage === undefined) requestError(503, 'runtime_not_connected')
        const policy = host.policy.describe()
        return { ...createNativeUsageProjection({ usage }).summary(usageQuery(query)),
          policy: { paused: policy.paused, grants: policy.grants.slice(0, 1_000), limited: policy.grants.length > 1_000 },
          metrics: host.metrics(), outbox: host.outbox.metrics() }
      }
    },
    {
      method: 'POST', pathname: '/api/chat/sessions/reset',
      handle() {
        if (chatRuntime?.host()) requestError(405, 'session_reset_not_enabled')
        requestError(503, 'runtime_not_connected')
      }
    },
    {
      method: 'GET', pathname: '/api/chat/usage/series',
      maxResponseBytes: 4_194_304,
      handle({ query }) {
        const usage = chatRuntime?.usage()
        if (usage) {
          if (query.has('hours') || query.has('buckets')) {
            const parameters = new URLSearchParams(query)
            const hours = integerQuery(parameters, 'hours', 24, 2_160)
            const buckets = integerQuery(parameters, 'buckets', 48, 120)
            return createNativeUsageProjection({ usage }).series(hours, buckets, usageQuery(parameters))
          }
          const parameters = new URLSearchParams(query)
          const bucket = parameters.get('bucketMs')
          if (parameters.getAll('bucketMs').length > 1 || bucket !== null && !/^[1-9][0-9]{0,8}$/.test(bucket)) {
            requestError(400, 'invalid_query')
          }
          if (bucket !== null && (Number(bucket) < 60_000 || Number(bucket) > 86_400_000)) requestError(400, 'invalid_query')
          parameters.delete('bucketMs')
          return usage.series(usageQuery(parameters), bucket === null ? undefined : Number(bucket))
        }
        requestError(503, 'runtime_not_connected')
      }
    },
    {
      method: 'GET', pathname: '/api/chat/usage/turns',
      maxResponseBytes: 4_194_304,
      handle({ query }) {
        const usage = chatRuntime?.usage()
        if (usage) {
          if (query.has('key')) {
            const parameters = new URLSearchParams(query)
            if (parameters.getAll('key').length !== 1) requestError(400, 'invalid_query')
            const key = parameters.get('key')!
            if (!SCOPE_PATTERN.test(key)) requestError(400, 'invalid_query')
            parameters.delete('key')
            return createNativeUsageProjection({ usage }).conversation(key, usageQuery(parameters))
          }
          return usage.list(usageQuery(query))
        }
        requestError(503, 'runtime_not_connected')
      }
    },
    {
      method: 'GET', pathname: '/api/chat/usage/recent',
      maxResponseBytes: 1_048_576,
      handle({ query }) {
        const usage = chatRuntime?.usage()
        if (usage) return createNativeUsageProjection({ usage }).recent(usageQuery(query))
        requestError(503, 'runtime_not_connected')
      }
    },
    {
      method: 'POST', pathname: '/api/chat/usage/reset',
      handle() {
        if (chatRuntime?.usage()) requestError(405, 'usage_reset_not_enabled')
        requestError(503, 'runtime_not_connected')
      }
    },
    {
      method: 'GET', pathname: '/api/chat/adapters',
      async handle({ query }) {
        requireEmptyQuery(query)
        await ready
        const document = await readDocument(adaptersFile, DEFAULT_ADAPTERS, validateStoredAdapters)
        const status = await adapterRuntimeStatus(adapterRuntime)
        return adaptersResponse(document, status, await adapterConnectionStatus(adapterRuntime, chatRuntime))
      }
    },
    {
      method: 'POST', pathname: '/api/chat/adapters',
      async handle({ query, body }) {
        requireEmptyQuery(query)
        await ready
        if (!isRecord(body) || !hasExactKeys(body, ['revision', 'adapters'])
          || typeof body.revision !== 'string' || !REVISION_PATTERN.test(body.revision)) {
          requestError(400, 'invalid_adapter_configuration')
        }
        const status = await adapterRuntimeStatus(adapterRuntime)
        const connection = await adapterConnectionStatus(adapterRuntime, chatRuntime)
        const document = await updateDocument(
          directory, adaptersFile, body.revision, DEFAULT_ADAPTERS, validateStoredAdapters,
          current => {
            try {
              return Object.freeze({ schema: 1, adapters: updateAdapterConfiguration(current.adapters, body.adapters) })
            } catch {
              requestError(400, 'invalid_adapter_configuration')
            }
          }
        )
        return adaptersResponse(document, status, connection)
      }
    },
    {
      method: 'POST', pathname: '/api/chat/adapters/connect',
      async handle({ query, body, signal }) {
        requireEmptyQuery(query)
        if (!isRecord(body) || !hasExactKeys(body, ['revision'])
          || typeof body.revision !== 'string' || !REVISION_PATTERN.test(body.revision)) {
          requestError(400, 'invalid_adapter_configuration')
        }
        if (adapterRuntime?.connect === undefined) requestError(503, 'adapter_runtime_unavailable')
        await ready
        const document = await controlAdapterRuntime(directory, signal, async controlSignal => {
          const document = await readDocument(adaptersFile, DEFAULT_ADAPTERS, validateStoredAdapters)
          if (document.revision !== body.revision) requestError(409, 'chat_revision_conflict')
          await adapterRuntime.connect?.(document.value.adapters, controlSignal)
          return document
        })
        return adaptersResponse(document, await adapterRuntimeStatus(adapterRuntime), await adapterConnectionStatus(adapterRuntime, chatRuntime))
      }
    },
    {
      method: 'POST', pathname: '/api/chat/adapters/disconnect',
      async handle({ query, body, signal }) {
        requireEmptyQuery(query)
        if (!isRecord(body) || !hasExactKeys(body, [])) requestError(400, 'invalid_adapter_configuration')
        if (adapterRuntime?.disconnect === undefined) requestError(503, 'adapter_runtime_unavailable')
        await ready
        const document = await controlAdapterRuntime(directory, signal, async controlSignal => {
          if (controlSignal.aborted) requestError(499, 'request_aborted')
          await adapterRuntime.disconnect?.()
          return readDocument(adaptersFile, DEFAULT_ADAPTERS, validateStoredAdapters)
        })
        return adaptersResponse(document, await adapterRuntimeStatus(adapterRuntime), await adapterConnectionStatus(adapterRuntime, chatRuntime))
      }
    }
  ]
  if (chatRuntime !== undefined) routes.push(...nativeChatControlRoutes(directory, chatRuntime, options.deploymentRuntime))
  const documents = new Set(['plans', 'personas', 'model', 'providers', 'access', 'adapters', 'authorization', 'deployment', 'usage/pricing']
    .map(name => `/api/chat/${name}`))
  return Object.freeze(routes.map(route => Object.freeze(route.method === 'POST' && documents.has(route.pathname)
    ? { ...route, maxRequestBytes: 128 * 1024 } : route)))
}

function integerQuery(query: URLSearchParams, key: string, fallback: number, maximum: number): number {
  const value = query.get(key)
  if (query.getAll(key).length > 1 || value !== null && (!/^[1-9][0-9]{0,5}$/.test(value)
    || Number(value) > maximum)) requestError(400, 'invalid_query')
  query.delete(key)
  return value === null ? fallback : Number(value)
}

function hostRoute(runtime: NativeChatRuntime, pathname: string): AdminRoute {
  const host = runtime.host()
  if (!host) requestError(503, 'runtime_not_connected')
  const route = createHostAdminRoutes(host).find(candidate => candidate.pathname === pathname)
  if (!route) requestError(404, 'not_found')
  return route
}

function startRevisions(body: Record<string, unknown> | null, withTarget = false): Readonly<Record<string, string>> {
  const keys = ['plans', 'personas', 'access', 'adapters', 'providers', 'authorization', 'deployment']
  if (!isRecord(body) || !hasExactKeys(body, withTarget ? ['revisions', 'targetRevision'] : ['revisions'])
    || withTarget && (typeof body.targetRevision !== 'string' || !REVISION_PATTERN.test(body.targetRevision))
    || !isRecord(body.revisions)
    || !hasExactKeys(body.revisions, keys) || !Object.values(body.revisions).every(value =>
      typeof value === 'string' && REVISION_PATTERN.test(value))) requestError(400, 'invalid_runtime_revisions')
  return body.revisions as Readonly<Record<string, string>>
}

async function nativeControl<Value>(directory: string, operation: () => Promise<Value>): Promise<Value> {
  if (nativeControls.has(directory) || adapterControls.has(directory)) requestError(409, 'native_chat_busy')
  nativeControls.add(directory)
  try { return await operation() } finally { nativeControls.delete(directory) }
}

function nativeChatControlRoutes(directory: string, runtime: NativeChatRuntime,
  deploymentRuntime: NativeChatDeploymentRuntime | undefined): AdminRoute[] {
  const authorizationFile = join(directory, 'chat-authorization.json')
  const deploymentFile = join(directory, 'chat-deployment.json')
  const routes: AdminRoute[] = [
    { method: 'GET', pathname: '/api/chat/runtime', async handle({ query }) {
      requireEmptyQuery(query)
      return runtime.status()
    } },
    { method: 'POST', pathname: '/api/chat/runtime/start', async handle({ query, body, signal }) {
      requireEmptyQuery(query)
      const revisions = startRevisions(body)
      return nativeControl(directory, async () => {
        try { await runtime.start(revisions, signal) } catch (error) {
          if (isRecord(error) && error.code === 'NATIVE_CHAT_REVISION_CONFLICT') requestError(409, 'chat_revision_conflict')
          if (isRecord(error) && error.code === 'NATIVE_CHAT_BUSY') requestError(409, 'native_chat_busy')
          requestError(503, 'native_chat_start_failed')
        }
        return runtime.status()
      })
    } },
    { method: 'POST', pathname: '/api/chat/runtime/stop', async handle({ query, body }) {
      requireEmptyQuery(query)
      if (!isRecord(body) || !hasExactKeys(body, [])) requestError(400, 'invalid_chat_request')
      await runtime.stop()
      return runtime.status()
    } },
    { method: 'GET', pathname: '/api/chat/authorization', async handle({ query }) {
      requireEmptyQuery(query)
      await ensurePrivateDirectory(directory)
      const document = await readDocument(authorizationFile, DEFAULT_AUTHORIZATION, validateStoredAuthorization)
      return { revision: document.revision, ...document.value.authorization }
    } },
    { method: 'POST', pathname: '/api/chat/authorization', async handle({ query, body }) {
      requireEmptyQuery(query)
      if (!isRecord(body) || !hasExactKeys(body, ['revision', 'version', 'grants'])) requestError(400, 'invalid_chat_authorization')
      const expected = parseRevision(body.revision)
      let value: NativeChatAuthorization
      try { value = validateNativeChatAuthorization({ version: body.version, grants: body.grants }) }
      catch { requestError(400, 'invalid_chat_authorization') }
      await ensurePrivateDirectory(directory)
      const document = await updateDocument(directory, authorizationFile, expected, DEFAULT_AUTHORIZATION,
        validateStoredAuthorization, () => ({ schema: 1, authorization: value }))
      return { revision: document.revision, ...document.value.authorization }
    } },
    { method: 'GET', pathname: '/api/chat/deployment', async handle({ query }) {
      requireEmptyQuery(query)
      await ensurePrivateDirectory(directory)
      const document = await readDocument(deploymentFile, DEFAULT_DEPLOYMENT, validateStoredDeployment)
      return { revision: document.revision, deployment: document.value.deployment }
    } },
    { method: 'POST', pathname: '/api/chat/deployment', async handle({ query, body }) {
      requireEmptyQuery(query)
      if (!isRecord(body) || !hasExactKeys(body, ['revision', 'deployment'])) requestError(400, 'invalid_chat_deployment')
      const expected = parseRevision(body.revision)
      let value: StoredDeployment
      try { value = validateStoredDeployment({ schema: 1, deployment: body.deployment }) }
      catch { requestError(400, 'invalid_chat_deployment') }
      await ensurePrivateDirectory(directory)
      const document = await updateDocument(directory, deploymentFile, expected, DEFAULT_DEPLOYMENT,
        validateStoredDeployment, () => value)
      return { revision: document.revision, deployment: document.value.deployment }
    } },
    { method: 'GET', pathname: '/api/chat/usage/pricing', handle({ query }) {
      requireEmptyQuery(query)
      const usage = runtime.usage()
      if (!usage) requestError(503, 'runtime_not_connected')
      return usage.pricing()
    } },
    { method: 'POST', pathname: '/api/chat/usage/pricing', handle({ query, body }) {
      requireEmptyQuery(query)
      if (!isRecord(body) || !hasExactKeys(body, ['revision', 'prices'])
        || body.revision !== null && (typeof body.revision !== 'number' || !Number.isSafeInteger(body.revision) || body.revision < 1)) {
        requestError(400, 'invalid_usage_pricing')
      }
      const usage = runtime.usage()
      if (!usage) requestError(503, 'runtime_not_connected')
      try { return usage.setPricing(body.prices, body.revision as number | null) }
      catch (error) {
        if (isRecord(error) && error.code === 'STORE_CONFLICT') requestError(409, 'usage_pricing_revision_conflict')
        if (isRecord(error) && error.code === 'USAGE_INVALID_PRICING') requestError(400, 'invalid_usage_pricing')
        requestError(500, 'usage_pricing_operation_unknown')
      }
    } }
  ]
  for (const operation of ['prepare', 'reconcile', 'apply'] as const) routes.push({
    method: 'POST', pathname: `/api/chat/deployment/${operation}`, async handle({ query, body, signal }) {
      requireEmptyQuery(query)
      const revisions = startRevisions(body, operation === 'apply')
      if (!deploymentRuntime) requestError(503, 'trusted_deployment_runtime_unavailable')
      return nativeControl(directory, async () => {
        const configuration = await readNativeChatConfiguration(directory)
        if (Object.keys(revisions).some(key => revisions[key] !== configuration.revisions[key])) requestError(409, 'chat_revision_conflict')
        if (operation === 'apply' && !(await runtime.status()).canApplyDeployment) requestError(409, 'native_chat_busy')
        if (signal.aborted) requestError(499, 'request_aborted')
        return operation === 'prepare' ? deploymentRuntime.prepare(configuration)
          : operation === 'reconcile' ? publicDeploymentResolution(await deploymentRuntime.reconcile(configuration))
            : deploymentRuntime.apply(configuration, signal, body!.targetRevision as string)
      })
    }
  })
  for (const name of ['metrics', 'storage', 'sessions', 'tasks', 'outbox', 'replies']) routes.push({
    method: 'GET', pathname: `/api/host/${name}`,
    ...(name === 'sessions' ? { maxResponseBytes: 1_048_576 } : {}),
    handle(context) { return hostRoute(runtime, `/api/host/${name}`).handle(context) }
  })
  return routes
}

function publicDeploymentResolution(result: Awaited<ReturnType<NativeChatDeploymentRuntime['reconcile']>>) {
  return { verified: result.missingReasons.length === 0 && result.presetBindings.length > 0,
    missingReasons: result.missingReasons,
    verificationScope: result.verificationScope ?? null,
    credentialValueIdentityVerified: false,
    unverified: result.unverified ?? ['credential_loaded_value_identity'],
    presets: result.presetBindings.map(binding => ({ agentPreset: binding.agentPreset })) }
}

function usageQuery(query: URLSearchParams): NativeUsageQuery {
  const numeric = ['limit', 'since', 'until']
  const textual = ['after', 'conversationId', 'provider', 'model']
  if ([...query.keys()].some(key => ![...numeric, ...textual].includes(key))
    || [...query.keys()].some(key => query.getAll(key).length !== 1)) requestError(400, 'invalid_query')
  const result: Record<string, string | number> = {}
  for (const key of numeric) {
    const value = query.get(key)
    if (value === null) continue
    if (!/^(0|[1-9][0-9]{0,15})$/.test(value) || !Number.isSafeInteger(Number(value))
      || key === 'limit' && (Number(value) < 1 || Number(value) > 1_000)) requestError(400, 'invalid_query')
    result[key] = Number(value)
  }
  for (const key of textual) {
    const value = query.get(key)
    if (value === null) continue
    if (value.length === 0 || value.length > 1_024 || /[\u0000-\u001f\u007f]/.test(value)) requestError(400, 'invalid_query')
    result[key] = value
  }
  if (typeof result.since === 'number' && typeof result.until === 'number' && result.since >= result.until) requestError(400, 'invalid_query')
  return result
}
