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
}

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

async function adapterConnectionStatus(port: AdapterRuntimePort | undefined): Promise<AdapterConnectionStatus | undefined> {
  if (port?.connectionStatus === undefined) return undefined
  try {
    const status: unknown = await port.connectionStatus()
    if (!isRecord(status) || !hasExactKeys(status, ['state', 'selfId', 'lastError', 'received', 'dropped', 'chatReady'])
      || !['disconnected', 'connecting', 'connected', 'reconnecting', 'error'].includes(String(status.state))
      || status.selfId !== null && (typeof status.selfId !== 'string' || !/^[1-9][0-9]{0,31}$/.test(status.selfId))
      || status.lastError !== null && typeof status.lastError !== 'string'
      || ![status.received, status.dropped].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      || status.chatReady !== false) requestError(503, 'adapter_runtime_status_unavailable')
    return Object.freeze({
      state: status.state as AdapterConnectionStatus['state'], selfId: status.selfId as string | null,
      lastError: status.lastError === null ? null
        : /^(?:onebot_ws_[a-z0-9_]{1,64}|adapter_runtime_(?:aborted|closed|busy))$/.test(String(status.lastError))
          ? String(status.lastError) : 'adapter_connection_error',
      received: status.received as number, dropped: status.dropped as number, chatReady: false
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
  if (adapterControls.has(directory)) requestError(409, 'adapter_runtime_busy')
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
    || !Object.keys(options).every(key => key === 'directory' || key === 'adapterRuntime')
    || typeof options.directory !== 'string'
    || options.directory.length === 0 || options.directory.includes('\0') || !isAbsolute(options.directory)
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
        return { runtimeConnected: false }
      }
    },
    {
      method: 'GET', pathname: '/api/chat/features',
      async handle({ query }) {
        requireEmptyQuery(query)
        await ready
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
      handle({ query }) {
        requireEmptyQuery(query)
        requestError(503, 'runtime_not_connected')
      }
    },
    {
      method: 'GET', pathname: '/api/chat/usage',
      handle({ query }) {
        requireEmptyQuery(query)
        requestError(503, 'runtime_not_connected')
      }
    },
    {
      method: 'POST', pathname: '/api/chat/sessions/reset',
      handle() {
        requestError(503, 'runtime_not_connected')
      }
    },
    {
      method: 'GET', pathname: '/api/chat/usage/series',
      handle() {
        requestError(503, 'runtime_not_connected')
      }
    },
    {
      method: 'GET', pathname: '/api/chat/usage/turns',
      handle() {
        requestError(503, 'runtime_not_connected')
      }
    },
    {
      method: 'GET', pathname: '/api/chat/usage/recent',
      handle() {
        requestError(503, 'runtime_not_connected')
      }
    },
    {
      method: 'POST', pathname: '/api/chat/usage/reset',
      handle() {
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
        return adaptersResponse(document, status, await adapterConnectionStatus(adapterRuntime))
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
        const connection = await adapterConnectionStatus(adapterRuntime)
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
        return controlAdapterRuntime(directory, signal, async controlSignal => {
          const document = await readDocument(adaptersFile, DEFAULT_ADAPTERS, validateStoredAdapters)
          if (document.revision !== body.revision) requestError(409, 'chat_revision_conflict')
          await adapterRuntime.connect?.(document.value.adapters, controlSignal)
          return adaptersResponse(document, await adapterRuntimeStatus(adapterRuntime), await adapterConnectionStatus(adapterRuntime))
        })
      }
    },
    {
      method: 'POST', pathname: '/api/chat/adapters/disconnect',
      async handle({ query, body, signal }) {
        requireEmptyQuery(query)
        if (!isRecord(body) || !hasExactKeys(body, [])) requestError(400, 'invalid_adapter_configuration')
        if (adapterRuntime?.disconnect === undefined) requestError(503, 'adapter_runtime_unavailable')
        await ready
        return controlAdapterRuntime(directory, signal, async controlSignal => {
          if (controlSignal.aborted) requestError(499, 'request_aborted')
          await adapterRuntime.disconnect?.()
          const document = await readDocument(adaptersFile, DEFAULT_ADAPTERS, validateStoredAdapters)
          return adaptersResponse(document, await adapterRuntimeStatus(adapterRuntime), await adapterConnectionStatus(adapterRuntime))
        })
      }
    }
  ]
  return Object.freeze(routes.map(route => Object.freeze(route)))
}
