import { createHash, randomUUID } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { isAlias, isMap, isScalar, isSeq, parseDocument, visit } from 'yaml'
import type { JsonObject, JsonValue } from '../core/types.ts'
import { snapshot } from '../core/values.ts'
import { buildChatSessionDefinition } from '../host/chat-plans.ts'
import type { NativeChatConfiguration, NativeChatDeploymentRuntime } from '../host/native-chat-configuration.ts'
import { prepareDshDeployment, DSH_DEPLOYMENT_SCHEMA, DSH_DEPLOYMENT_VERIFICATION } from './dsh-deployment.ts'
import type { DshDeploymentPreparation, DshDeploymentProposal, DshDeploymentSnapshot } from './dsh-deployment.ts'
import { createDshJsonRpcPort } from './dsh-jsonrpc.ts'
import type { DshPresetBinding } from './dsh-jsonrpc.ts'

type DeploymentTarget = NonNullable<NativeChatConfiguration['deployment']['target']>
type YamlDocument = ReturnType<typeof parseDocument>

interface PrivateFile {
  readonly path: string
  readonly text: string
  readonly exists: boolean
}

interface ProfileRead {
  readonly target: DeploymentTarget
  readonly files: readonly PrivateFile[]
  readonly profile: YamlDocument
  readonly credentials: YamlDocument
  readonly credentialValues: Readonly<Record<string, string>>
  readonly credentialEntryId: string | undefined
  readonly snapshot: DshDeploymentSnapshot
}

interface PreparedProfile {
  readonly identity: string
  readonly read: ProfileRead
  readonly preparation: DshDeploymentPreparation
}

export interface DshProfileDeploymentOptions {
  readonly verificationTimeoutMs?: number
  readonly pollIntervalMs?: number
}

class ProfileError extends Error {
  readonly code: string
  constructor(code: string) {
    super('DSH profile deployment did not complete safely.')
    this.code = code
  }
}

function fail(code: string): never {
  throw new ProfileError(code)
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function object(value: JsonValue | undefined): JsonObject | undefined {
  return record(value) ? value as JsonObject : undefined
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function parse(text: string): YamlDocument {
  if (Buffer.byteLength(text) > 1_048_576) fail('dsh_document_too_large')
  const document = parseDocument(text, {
    version: '1.2', strict: true, uniqueKeys: true, stringKeys: true,
    prettyErrors: false, logLevel: 'silent', keepSourceTokens: true,
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
  })
  if (document.errors.length || document.warnings.length) fail('dsh_yaml_invalid')
  let nodes = 0
  visit(document, (_key, node, path) => {
    if (++nodes > 30_000 || path.length > 80 || isAlias(node)) fail('dsh_yaml_complexity_unsupported')
    if (isScalar(node) && node.tag !== undefined && node.tag !== 'tag:yaml.org,2002:js'
      && !['tag:yaml.org,2002:str', 'tag:yaml.org,2002:int', 'tag:yaml.org,2002:float', 'tag:yaml.org,2002:bool', 'tag:yaml.org,2002:null'].includes(node.tag)) {
      fail('dsh_yaml_tag_unsupported')
    }
    if (isMap(node)) for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string'
        || ['__proto__', 'constructor', 'prototype', '<<'].includes(pair.key.value)) fail('dsh_yaml_key_unsupported')
    }
  })
  return document
}

function values(document: YamlDocument): JsonValue {
  const copy = document.clone()
  visit(copy, { Scalar(_key, node) {
    if (node.tag === 'tag:yaml.org,2002:js') node.value = { __jsExpr: node.value }
  } })
  try {
    return snapshot(copy.toJS({ maxAliasCount: 0 }) as unknown) as JsonValue
  } catch {
    return fail('dsh_yaml_invalid')
  }
}

function dynamic(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(dynamic)
  if (record(value)) return Object.hasOwn(value, '__jsExpr') || Object.values(value).some(dynamic)
  return false
}

async function safePath(filename: string, allowMissing: boolean): Promise<boolean> {
  if (!isAbsolute(filename) || resolve(filename) !== filename || filename.includes('\0')) fail('explicit_dsh_path_required')
  if (await realpath(dirname(filename)) !== dirname(filename)) fail('dsh_symlink_path_rejected')
  const parent = await lstat(dirname(filename))
  if (!parent.isDirectory() || (parent.mode & 0o022) !== 0) fail('dsh_directory_permissions_unsafe')
  const stat = await lstat(filename).catch(error => {
    if (allowMissing && record(error) && error.code === 'ENOENT') return undefined
    throw error
  })
  if (!stat) return false
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1_048_576
    || (stat.mode & 0o022) !== 0
    || typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail('dsh_file_unsafe')
  return true
}

async function readFile(filename: string, secret = false, allowMissing = false): Promise<PrivateFile> {
  if (!await safePath(filename, allowMissing)) return { path: filename, text: '', exists: false }
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > 1_048_576 || secret && (before.mode & 0o077) !== 0) fail('dsh_file_permissions_unsafe')
    const buffer = Buffer.alloc(before.size + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const after = await handle.stat()
    const current = await lstat(filename)
    if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || current.dev !== before.dev || current.ino !== before.ino) fail('dsh_read_conflict')
    const content = buffer.subarray(0, bytesRead)
    if (!isUtf8(content)) fail('dsh_document_encoding_unsupported')
    return { path: filename, text: content.toString('utf8'), exists: true }
  } finally {
    await handle.close()
  }
}

function compose(layers: readonly JsonValue[]): JsonObject[] {
  const rows: JsonObject[] = []
  const indexed = new Map<string, JsonObject>()
  const indexRows = (entries: JsonValue[]): void => {
    for (const entry of entries) {
      const row = object(entry)
      if (!row || typeof row.id !== 'string' || typeof row.name !== 'string' || indexed.has(row.id)) fail('dsh_entry_schema_unsupported')
      indexed.set(row.id, row)
      if (row.group === true && Array.isArray(row.config)) indexRows(row.config)
    }
  }
  for (const layer of layers) {
    if (!Array.isArray(layer)) fail('dsh_patch_sequence_required')
    for (const raw of layer) {
      const patch = object(raw)
      if (!patch) fail('dsh_patch_schema_unsupported')
      if (patch.insert !== undefined) {
        if (!Array.isArray(patch.insert)) fail('dsh_patch_schema_unsupported')
        const insertions = structuredClone(patch.insert)
        if (patch.id === undefined) rows.push(...insertions as JsonObject[])
        else {
          const parent = typeof patch.id === 'string' ? indexed.get(patch.id) : undefined
          if (!parent || parent.group !== true || !Array.isArray(parent.config)) fail('dsh_patch_target_missing')
          parent.config.push(...insertions)
        }
        indexRows(insertions)
      } else {
        const target = typeof patch.id === 'string' ? indexed.get(patch.id) : undefined
        if (!target || patch.name !== undefined && patch.name !== target.name) fail('dsh_explicit_layers_required')
        if (target.group === true && patch.config !== undefined) fail('dsh_group_replacement_unsupported')
        for (const [key, value] of Object.entries(patch)) if (key !== 'id' && key !== 'name') target[key] = structuredClone(value)
      }
    }
  }
  return [...indexed.values()]
}

async function readProfile(target: DeploymentTarget): Promise<ProfileRead> {
  if (target.schemaVersion !== DSH_DEPLOYMENT_SCHEMA || basename(target.profilePath) !== 'cordis.patch.yml'
    || !target.credentialsPath || target.profilePath === target.credentialsPath) fail('explicit_dsh_target_required')
  const paths = [...target.layerPaths ?? [], target.profilePath, target.credentialsPath]
  if (paths.length > 34 || new Set(paths).size !== paths.length) fail('dsh_target_paths_ambiguous')
  const files: PrivateFile[] = []
  for (const path of paths) files.push(await readFile(path, path === target.credentialsPath, path === target.profilePath || path === target.credentialsPath))
  const profile = parse(files[files.length - 2]!.text || '[]\n')
  const credentials = parse(files[files.length - 1]!.text)
  const credentialRoot = object(values(credentials)) ?? (credentials.contents === null ? {} : undefined)
  if (!credentialRoot || Object.keys(credentialRoot).length > 0 && credentialRoot.version !== 1
    || credentialRoot.refs !== undefined && !object(credentialRoot.refs)) fail('dsh_credentials_version_unsupported')
  const credentialValues: Record<string, string> = {}
  for (const [ref, value] of Object.entries(object(credentialRoot.refs) ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(ref) || typeof value !== 'string' || !value) fail('dsh_credentials_schema_unsupported')
    credentialValues[ref] = value
  }
  const entries = compose(files.slice(0, -1).map(file => values(parse(file.text || '[]\n'))))
  const providers = entries.filter(row => row.name === '@deepseek-ai/dsh-llm-pi-ai')
  if (providers.length !== 1) fail('dsh_provider_entry_ambiguous')
  const provider = providers[0]!
  if (provider.disabled !== undefined && provider.disabled !== false || dynamic(provider.config ?? {})) fail('dsh_dynamic_provider_unsupported')
  const providerConfig = object(provider.config) ?? {}
  const credentialEntries = entries.filter(row => row.name === '@deepseek-ai/dsh-credentials-local')
  const credentialEntryId = credentialEntries.length === 1 ? String(credentialEntries[0]!.id) : undefined
  const presets = entries.filter(row => row.name === '@deepseek-ai/dsh-agent-preset').map(row => {
    if (typeof row.id !== 'string' || !object(row.config)) return fail('dsh_preset_schema_unsupported')
    return { entryId: row.id, config: object(row.config)! }
  })
  return {
    target, files, profile, credentials, credentialValues, credentialEntryId,
    snapshot: snapshot({ profilePath: target.profilePath, credentialsPath: target.credentialsPath, schemaVersion: target.schemaVersion, revision: digest(files),
      providerEntryId: String(provider.id), providerConfig, presets, credentialChecks: [], configurationLoaded: false }),
  }
}

function configurationIdentity(configuration: NativeChatConfiguration): string {
  return digest(configuration)
}

async function prepareProfile(configuration: NativeChatConfiguration): Promise<PreparedProfile> {
  const target = configuration.deployment.target
  if (!target) fail('explicit_dsh_target_required')
  const plan = configuration.catalog.plans.find(candidate => candidate.id === configuration.catalog.activePlanId)
  const persona = configuration.personas.find(candidate => candidate.id === plan?.personaId)
  if (!plan || !persona) fail('active_chat_plan_required')
  const read = await readProfile(target)
  const preparation = prepareDshDeployment({
    definition: buildChatSessionDefinition(plan, persona), providers: configuration.providers, target: read.snapshot,
    modelSettings: configuration.deployment.modelSettings ?? undefined, namespace: configuration.deployment.namespace,
  })
  return { identity: configurationIdentity(configuration), read, preparation }
}

function subset(actual: JsonValue | undefined, expected: JsonValue): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => subset(actual[index], item))
  if (record(expected)) return record(actual) && Object.entries(expected).every(([key, value]) => subset(actual[key], value))
  return isDeepStrictEqual(actual, expected)
}

async function liveSnapshot(configuration: NativeChatConfiguration, prepared: PreparedProfile, signal: AbortSignal): Promise<DshDeploymentSnapshot> {
  const preview = prepared.preparation.preview()
  if (!preview || !configuration.adapters.dshAgent.enabled) fail('dsh_live_verification_required')
  const port = createDshJsonRpcPort({ endpoint: configuration.adapters.dshAgent.endpoint, auth: configuration.adapters.dshAgent.auth, timeoutMs: 3_000 })
  try {
    const inspection = await port.inspectDeployment({ agentPresets: preview.presets.map(preset => String(preset.config.id)), credentialRefs: preview.credentialRefs, signal })
    const settings = object(inspection.settings)
    const namespaces = settings?.namespaces
    if (!Array.isArray(namespaces)) fail('dsh_live_schema_mismatch')
    const section = namespaces.map(object).filter(row => row?.ns === prepared.read.snapshot.providerEntryId)
    const credentialSections = namespaces.map(object).filter(row => row?.ns === prepared.read.credentialEntryId)
    const credentialConfig = credentialSections.length === 1 ? object(credentialSections[0]?.value) : undefined
    const explicitCredentialPath = typeof credentialConfig?.path === 'string' && isAbsolute(credentialConfig.path)
      ? credentialConfig.path
      : credentialConfig?.path === undefined && typeof credentialConfig?.dshHome === 'string' && isAbsolute(credentialConfig.dshHome)
        ? join(credentialConfig.dshHome, '.credentials.yaml') : undefined
    if (!prepared.read.credentialEntryId || explicitCredentialPath !== prepared.read.target.credentialsPath) fail('dsh_credential_target_unverified')
    const liveConfig = section.length === 1 ? object(section[0]?.value) : undefined
    const liveProviders = object(liveConfig?.providers)
    const roster = object(inspection.roster)?.presets
    if (!liveConfig || !liveProviders || !Array.isArray(roster)) fail('pending_reload')
    for (const [route, expected] of Object.entries(preview.providerUpdates)) if (!subset(liveProviders[route], expected)) fail('pending_reload')
    for (const preset of preview.presets) {
      const rows = roster.map(object).filter(row => row?.id === preset.config.id)
      const documents = inspection.documents.map(object).filter(doc => doc?.agentPreset === preset.config.id)
      if (rows.length !== 1 || rows[0]?.broken !== undefined || documents.length !== 1 || typeof documents[0]?.content !== 'string'
        || !isDeepStrictEqual(values(parse(documents[0].content)), preset.config.plugins)) fail('pending_reload')
    }
    const credentials = object(inspection.credentials)
    const definitionProvider = configuration.catalog.plans.find(plan => plan.id === configuration.catalog.activePlanId)?.provider
    const desiredKey = configuration.providers.find(candidate => candidate.id === definitionProvider)?.apiKey
    const credentialChecks = preview.credentialRefs.map(ref => {
      const live = object(credentials?.[ref])
      return { ref, localValueMatches: desiredKey !== undefined && prepared.read.credentialValues[ref] === desiredKey,
        liveConfigured: live?.configured === true && live?.writable === true, liveSource: typeof live?.source === 'string' ? live.source : null,
        targetPath: explicitCredentialPath }
    })
    if (credentialChecks.some(check => !check.localValueMatches || !check.liveConfigured || check.liveSource !== 'file')) {
      fail('dsh_credential_file_source_unverified')
    }
    return snapshot({ ...prepared.read.snapshot, credentialChecks, configurationLoaded: true })
  } finally {
    await port.close()
  }
}

async function exclusiveWrite(filename: string, text: string): Promise<void> {
  const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function replace(filename: string, text: string): Promise<void> {
  const temporary = `${filename}.qqaf-${randomUUID()}.tmp`
  try {
    await exclusiveWrite(temporary, text)
    await rename(temporary, filename)
    const parent = await open(dirname(filename), constants.O_RDONLY | constants.O_DIRECTORY)
    try { await parent.sync() } finally { await parent.close() }
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

function patchProfile(document: YamlDocument, proposal: DshDeploymentProposal): string {
  if (!isSeq(document.contents)) fail('dsh_patch_sequence_required')
  for (const patch of proposal.patch) {
    if (patch.insert !== undefined) document.add(document.createNode(patch))
    else document.add(document.createNode({ id: patch.id, config: patch.config }))
  }
  const rendered = String(document)
  parse(rendered)
  return rendered
}

async function writeProposal(prepared: PreparedProfile, proposal: DshDeploymentProposal, signal: AbortSignal, backedUp: (backupId: string) => void): Promise<string> {
  const target = prepared.read.target
  const lockPaths = [...new Set([`${join(dirname(target.profilePath), 'package.json')}.lock`, `${target.credentialsPath}.lock`])].sort()
  const held: string[] = []
  try {
    for (const filename of lockPaths) {
      signal.throwIfAborted()
      try { await exclusiveWrite(filename, `${process.pid}\n`) } catch { return fail('deployment_revision_conflict') }
      held.push(filename)
    }
    const current = await readProfile(target)
    if (current.snapshot.revision !== proposal.expectedRevision) fail('deployment_revision_conflict')
    const profileText = patchProfile(current.profile, proposal)
    if (!isMap(current.credentials.contents)) current.credentials.contents = current.credentials.createNode({ version: 1, refs: {} })
    else {
      current.credentials.set('version', 1)
      if (!current.credentials.has('refs')) current.credentials.set('refs', {})
    }
    for (const credential of proposal.credentials) current.credentials.setIn(['refs', credential.ref], credential.value)
    const credentialText = String(current.credentials)
    parse(credentialText)
    const backupId = randomUUID()
    for (const file of current.files.slice(-2)) await exclusiveWrite(`${file.path}.qqaf-backup-${backupId}${file.exists ? '' : '.absent'}`, file.text)
    backedUp(backupId)
    signal.throwIfAborted()
    const recheck = await readProfile(target)
    if (recheck.snapshot.revision !== proposal.expectedRevision) fail('deployment_revision_conflict')
    await replace(target.credentialsPath, credentialText)
    await replace(target.profilePath, profileText)
    return backupId
  } finally {
    for (const filename of held.reverse()) await unlink(filename).catch(() => undefined)
  }
}

function reason(error: unknown): string {
  return error instanceof ProfileError ? error.code : 'dsh_profile_operation_failed'
}

export function createNativeDshDeploymentRuntime(options: DshProfileDeploymentOptions = {}): NativeChatDeploymentRuntime {
  const timeoutMs = options.verificationTimeoutMs ?? 5_000
  const pollMs = options.pollIntervalMs ?? 250
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000
    || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 5_000) throw new TypeError('Invalid DSH deployment options')
  let staged: PreparedProfile | undefined
  let applying = false
  const reconcile = async (configuration: NativeChatConfiguration, signal = AbortSignal.timeout(timeoutMs)) => {
    try {
      const prepared = await prepareProfile(configuration)
      if (!prepared.preparation.summary.ready) return { missingReasons: prepared.preparation.summary.missingReasons, presetBindings: [] }
      const readback = await liveSnapshot(configuration, prepared, signal)
      const result = prepared.preparation.reconcile(readback)
      if (result.status !== 'verified') return { missingReasons: result.missingReasons, presetBindings: [] }
      return { missingReasons: [], presetBindings: result.presetBindings, ...DSH_DEPLOYMENT_VERIFICATION }
    } catch (error) {
      return { missingReasons: [reason(error)], presetBindings: [] as readonly DshPresetBinding[] }
    }
  }
  return Object.freeze({
    async prepare(configuration: NativeChatConfiguration) {
      if (applying) return { state: 'blocked', missingReasons: ['deployment_busy'] }
      staged = undefined
      try {
        staged = await prepareProfile(configuration)
        return snapshot({ state: staged.preparation.summary.ready ? 'prepared' : 'blocked',
          targetRevision: staged.read.snapshot.revision, summary: staged.preparation.summary,
          preview: staged.preparation.preview(), ...DSH_DEPLOYMENT_VERIFICATION })
      } catch (error) {
        return { state: 'blocked', missingReasons: [reason(error)] }
      }
    },
    reconcile,
    async apply(configuration: NativeChatConfiguration, signal: AbortSignal, expectedTargetRevision?: string) {
      if (applying) return { state: 'blocked', missingReasons: ['deployment_busy'] }
      const prepared = staged
      staged = undefined
      if (!prepared || prepared.identity !== configurationIdentity(configuration)) return { state: 'blocked', missingReasons: ['deployment_preview_required'] }
      if (expectedTargetRevision !== prepared.read.snapshot.revision) return { state: 'conflict', missingReasons: ['deployment_preview_revision_conflict'] }
      if (signal.aborted) return { state: 'blocked', missingReasons: ['deployment_aborted'] }
      applying = true
      let backupId: string | undefined
      try {
        let writeFailure: string | undefined
        await prepared.preparation.apply(async proposal => {
          try {
            backupId = await writeProposal(prepared, proposal, signal, id => { backupId = id })
            const readback = await readProfile(prepared.read.target)
            return { status: 'committed', backupId, readback: readback.snapshot }
          } catch (error) {
            writeFailure = reason(error)
            return { status: 'conflict' }
          }
        }, signal)
        if (writeFailure) return { state: writeFailure === 'deployment_revision_conflict' ? 'conflict' : 'unknown',
          ...(backupId ? { backupId } : {}), missingReasons: [writeFailure] }
        if (!backupId) return { state: 'blocked', missingReasons: prepared.preparation.summary.missingReasons }
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        do {
          const result = await reconcile(configuration, deadline)
          if (result.missingReasons.length === 0) return { state: 'verified', backupId, missingReasons: [], ...DSH_DEPLOYMENT_VERIFICATION }
          if (deadline.aborted) break
          await delay(pollMs, undefined, { signal: deadline }).catch(() => undefined)
        } while (!deadline.aborted)
        return { state: 'pending_reload', backupId, missingReasons: ['pending_reload'] }
      } catch {
        return { state: backupId ? 'pending_reload' : 'unknown', ...(backupId ? { backupId } : {}), missingReasons: ['deployment_result_unknown'] }
      } finally {
        applying = false
      }
    },
  })
}
