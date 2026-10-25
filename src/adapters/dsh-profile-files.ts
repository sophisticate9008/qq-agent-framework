import { createHash, randomUUID } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { isMap, isSeq } from 'yaml'
import type { JsonObject, JsonValue } from '../contracts/data.ts'
import type { DshDeploymentProposal, DshDeploymentSnapshot, DshProfileTarget, DshProfileFilePort } from '../contracts/dsh-profile.ts'
import { snapshot } from '../core/values.ts'
import { composeStaticDshLayers, readStaticDshProfile, staticDshProfileValues, StaticDshProfileError, type StaticDshYamlDocument } from './dsh-static-profile.ts'
const DSH_DEPLOYMENT_SCHEMA = '0.2.1-rc.2'
type DeploymentTarget = DshProfileTarget
type YamlDocument = StaticDshYamlDocument
interface PrivateFile { readonly path: string; readonly text: string; readonly exists: boolean }
interface ProfileRead {
  readonly target: DeploymentTarget
  readonly files: readonly PrivateFile[]
  readonly profile: YamlDocument
  readonly credentials: YamlDocument
  readonly credentialValues: Readonly<Record<string, string>>
  readonly credentialEntryId: string | undefined
  readonly credentialEntryConfig: JsonObject | undefined
  readonly snapshot: DshDeploymentSnapshot
}
export class DshProfileFileError extends Error {
  readonly code: string
  constructor(code: string) {
    super('DSH profile deployment did not complete safely.')
    this.code = code
  }
}

function fail(code: string): never {
  throw new DshProfileFileError(code)
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
  try { return readStaticDshProfile(text) }
  catch (error) { return fail(error instanceof StaticDshProfileError ? error.code : 'dsh_yaml_invalid') }
}

function values(document: YamlDocument): JsonValue {
  try { return staticDshProfileValues(document) }
  catch (error) { return fail(error instanceof StaticDshProfileError ? error.code : 'dsh_yaml_invalid') }
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
  try { return composeStaticDshLayers(layers) }
  catch (error) { return fail(error instanceof StaticDshProfileError ? error.code : 'dsh_patch_schema_unsupported') }
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
  const credentialEntry = credentialEntries.length === 1 ? credentialEntries[0] : undefined
  const credentialEntryId = typeof credentialEntry?.id === 'string' && credentialEntry.id ? credentialEntry.id : undefined
  const credentialEntryConfig = credentialEntry && (credentialEntry.disabled === undefined || credentialEntry.disabled === false)
    ? credentialEntry.config === undefined ? {} : object(credentialEntry.config) : undefined
  const presets = entries.filter(row => row.name === '@deepseek-ai/dsh-agent-preset').map(row => {
    if (typeof row.id !== 'string' || !object(row.config)) return fail('dsh_preset_schema_unsupported')
    return { entryId: row.id, config: object(row.config)! }
  })
  return {
    target, files, profile, credentials, credentialValues, credentialEntryId, credentialEntryConfig,
    snapshot: snapshot({ profilePath: target.profilePath, credentialsPath: target.credentialsPath, schemaVersion: target.schemaVersion, revision: digest(files),
      providerEntryId: String(provider.id), providerConfig, presets, credentialChecks: [], configurationLoaded: false }),
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

function patchProfile(document: YamlDocument, proposal: DshDeploymentProposal, credentialPatch: JsonObject): string {
  if (!isSeq(document.contents)) fail('dsh_patch_sequence_required')
  for (const patch of proposal.patch) {
    if (patch.insert !== undefined) document.add(document.createNode(patch))
    else document.add(document.createNode({ id: patch.id, config: patch.config }))
  }
  document.add(document.createNode(credentialPatch))
  const rendered = String(document)
  parse(rendered)
  return rendered
}

async function writeProposal(target: DeploymentTarget, proposal: DshDeploymentProposal, signal: AbortSignal, backedUp: (backupId: string) => void): Promise<string> {
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
    if (!current.credentialEntryId || !current.credentialEntryConfig) fail('dsh_credential_target_unverified')
    if (dynamic(current.credentialEntryConfig)) fail('dsh_dynamic_credentials_unsupported')
    const profileText = patchProfile(current.profile, proposal, {
      id: current.credentialEntryId,
      config: { ...current.credentialEntryConfig, path: target.credentialsPath },
    })
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


export function createDshProfileFilePort(): DshProfileFilePort {
  return Object.freeze({
    async read(target) {
      const profile = await readProfile(target)
      return { target: profile.target, snapshot: profile.snapshot, credentialEntryId: profile.credentialEntryId,
        credentialEntryConfig: profile.credentialEntryConfig }
    },
    async matchCredentials(target, expectedRevision, candidates) {
      const profile = await readProfile(target)
      if (profile.snapshot.revision !== expectedRevision) fail('deployment_revision_conflict')
      return candidates.map(candidate => ({ ref: candidate.ref, matches: profile.credentialValues[candidate.ref] === candidate.value }))
    },
    write: writeProposal
  } satisfies DshProfileFilePort)
}
