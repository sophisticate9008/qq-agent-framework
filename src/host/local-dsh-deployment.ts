import { constants } from 'node:fs'
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises'
import { isUtf8 } from 'node:buffer'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { isIP } from 'node:net'
import { composeStaticDshLayers, readStaticDshProfile, staticDshProfileValues } from '../adapters/dsh-static-profile.ts'
import { FrameworkError, snapshot } from '../core/values.ts'

export interface LocalDshDeploymentTarget {
  readonly profilePath: string
  readonly credentialsPath: string
  readonly layerPaths: readonly string[]
  readonly schemaVersion: '0.2.1-rc.2'
}

export interface LocalDshDeploymentRequest {
  readonly endpoint: string
  readonly localCredentialsPath: string
  readonly signal: AbortSignal
}

interface LocalDshProcess {
  readonly directory: string
  readonly command: string
  readonly anchor: string
  readonly home: string
  readonly profile: string
  readonly overlays: readonly string[]
}

function fail(code = 'LOCAL_DSH_DEPLOYMENT_UNAVAILABLE'): never {
  throw new FrameworkError(code, 'The local DSH deployment target could not be determined safely.')
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function missing(error: unknown): boolean {
  return object(error) && error.code === 'ENOENT'
}

async function text(filename: string, signal: AbortSignal, maximum = 1_048_576): Promise<string> {
  signal.throwIfAborted()
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > maximum) fail('LOCAL_DSH_DEPLOYMENT_METADATA_UNSAFE')
    const buffer = Buffer.alloc(maximum + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const after = await handle.stat()
    if (bytesRead > maximum || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || !isUtf8(buffer.subarray(0, bytesRead))) fail('LOCAL_DSH_DEPLOYMENT_METADATA_CHANGED')
    signal.throwIfAborted()
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally { await handle.close() }
}

async function metadata(filename: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await text(filename, signal, 262_144))
  if (!object(value)) fail('LOCAL_DSH_DEPLOYMENT_MANIFEST_INVALID')
  return value
}

async function patch(filename: string, signal: AbortSignal, optional = false): Promise<{ readonly path: string; readonly length: number } | null> {
  let path: string
  try { path = await realpath(filename) } catch (error) {
    if (optional && missing(error)) return null
    throw error
  }
  const information = await lstat(path)
  if (!information.isFile() || information.isSymbolicLink() || information.nlink !== 1 || (information.mode & 0o022) !== 0) fail('LOCAL_DSH_DEPLOYMENT_PATCH_UNSAFE')
  let value: unknown
  const content = await text(path, signal)
  try { value = staticDshProfileValues(readStaticDshProfile(content)) }
  catch { return fail('LOCAL_DSH_DEPLOYMENT_PATCH_INVALID') }
  if (value !== null && !Array.isArray(value)) fail('LOCAL_DSH_DEPLOYMENT_PATCH_INVALID')
  return { path, length: Array.isArray(value) ? value.length : 0 }
}

function localEndpoint(value: string): URL {
  if (typeof value !== 'string' || value.length > 2_048 || !/^https?:\/\//.test(value)
    || /[\u0000-\u0020\u007f\\?#]/.test(value)) fail('LOCAL_DSH_DEPLOYMENT_ENDPOINT_INVALID')
  const authority = value.slice(value.indexOf('://') + 3).split('/', 1)[0]!
  if (!/^(?:localhost|127(?:\.[0-9]{1,3}){3}|\[::1\])(?::[0-9]{1,5})?$/.test(authority)) fail('LOCAL_DSH_DEPLOYMENT_ENDPOINT_INVALID')
  const url = new URL(value)
  if (url.username || url.password || url.pathname !== '/' || url.port === '0'
    || url.hostname !== 'localhost' && url.hostname !== '[::1]' && !(isIP(url.hostname) === 4 && url.hostname.startsWith('127.'))) fail('LOCAL_DSH_DEPLOYMENT_ENDPOINT_INVALID')
  return url
}

function selection(argumentsList: readonly string[]): { readonly profile: string; readonly overlays: readonly string[] } {
  const argumentsCopy = [...argumentsList]
  if (argumentsCopy[0] && !argumentsCopy[0].startsWith('-')) argumentsCopy.unshift('--profile')
  let profile: string | undefined
  const overlays: string[] = []
  for (let index = 0; index < argumentsCopy.length; index++) {
    const argument = argumentsCopy[index]!
    const name = argument.split('=', 1)[0]!
    if (!['--profile', '--patch', '--from-default-profile'].includes(name)) break
    const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : argumentsCopy[++index]
    if (!value || /[\u0000-\u001f\u007f]/.test(value)) fail('LOCAL_DSH_DEPLOYMENT_ARGUMENTS_INVALID')
    if (name === '--profile') {
      if (profile !== undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value === 'node_modules') fail('LOCAL_DSH_DEPLOYMENT_PROFILE_AMBIGUOUS')
      profile = value
    } else if (name === '--patch') overlays.push(value)
  }
  if (overlays.length > 16) fail('LOCAL_DSH_DEPLOYMENT_LAYERS_AMBIGUOUS')
  return { profile: profile ?? 'web', overlays }
}

async function ownsListener(directory: string, endpoint: URL, signal: AbortSignal): Promise<boolean> {
  const descriptors = await readdir(join(directory, 'fd'))
  if (descriptors.length > 1_024) fail('LOCAL_DSH_DEPLOYMENT_PROCESS_UNSAFE')
  const sockets = new Set<string>()
  for (const descriptor of descriptors) {
    signal.throwIfAborted()
    try {
      const match = /^socket:\[([0-9]+)\]$/.exec(await readlink(join(directory, 'fd', descriptor)))
      if (match) sockets.add(match[1]!)
    } catch {}
  }
  const port = Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80))
  for (const family of ['tcp', 'tcp6']) {
    const lines = (await text(join(directory, 'net', family), signal)).trim().split('\n').slice(1)
    for (const line of lines) {
      const columns = line.trim().split(/\s+/)
      const [address, encodedPort] = (columns[1] ?? '').split(':')
      if (columns[3] !== '0A' || !sockets.has(columns[9] ?? '') || Number.parseInt(encodedPort ?? '', 16) !== port) continue
      if (family === 'tcp6' && (address === '00000000000000000000000000000000'
        || address === '00000000000000000000000001000000' && ['localhost', '[::1]'].includes(endpoint.hostname))) return true
      if (family === 'tcp' && address) {
        const decoded = address.match(/../g)?.reverse().map(part => Number.parseInt(part, 16)).join('.')
        if (decoded === '0.0.0.0' || decoded === endpoint.hostname || endpoint.hostname === 'localhost' && decoded?.startsWith('127.')) return true
      }
    }
  }
  return false
}

async function candidates(endpoint: URL, credentialsPath: string, signal: AbortSignal): Promise<readonly LocalDshProcess[]> {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') fail('LOCAL_DSH_DEPLOYMENT_PLATFORM_UNSUPPORTED')
  const processes = (await readdir('/proc')).filter(name => /^[1-9][0-9]*$/.test(name))
  if (processes.length > 4_096) fail('LOCAL_DSH_DEPLOYMENT_PROCESS_LIMIT')
  const matches: LocalDshProcess[] = []
  for (const identifier of processes) {
    signal.throwIfAborted()
    const directory = join('/proc', identifier)
    try {
      if ((await lstat(directory)).uid !== process.getuid()) continue
      const command = await text(join(directory, 'cmdline'), signal, 65_536)
      const argumentsList = command.split('\0').filter(Boolean)
      const launchers = argumentsList.map((value, index) => ({ value, index })).filter(argument => /(?:^|\/)@deepseek-ai\/dsh\/(?:lib\/bin\.js|bin\/dsh\.js)$/.test(argument.value))
      if (launchers.length !== 1) continue
      const launcher = launchers[0]!
      const cwd = await realpath(join(directory, 'cwd'))
      const script = await realpath(resolve(cwd, launcher.value))
      const anchor = join(dirname(dirname(script)), 'package.json')
      const installation = await metadata(anchor, signal)
      if (installation.name !== '@deepseek-ai/dsh' || installation.version !== '0.2.1-rc.2') continue
      const environment = (await text(join(directory, 'environ'), signal, 65_536)).split('\0')
      const ownerHome = environment.find(value => value.startsWith('HOME='))?.slice(5) || homedir()
      const declaredHome = environment.find(value => value.startsWith('DSH_HOME='))?.slice(9) || join(ownerHome, '.dsh')
      const expanded = declaredHome === '~' ? ownerHome : declaredHome.startsWith('~/') ? join(ownerHome, declaredHome.slice(2)) : declaredHome
      if (!isAbsolute(ownerHome) || /[\u0000-\u001f\u007f]/.test(expanded)) continue
      const home = await realpath(resolve(cwd, expanded))
      if (await realpath(join(home, '.credentials.yaml')) !== credentialsPath || !await ownsListener(directory, endpoint, signal)) continue
      const selected = selection(argumentsList.slice(launcher.index + 1))
      matches.push({ directory, command, anchor, home, profile: selected.profile, overlays: selected.overlays.map(filename => resolve(cwd, filename)) })
    } catch { signal.throwIfAborted() }
  }
  return matches
}

async function bundleDirectory(name: string, anchors: readonly string[], signal: AbortSignal): Promise<string> {
  for (const anchor of anchors) {
    const require = createRequire(anchor)
    try { return dirname(await realpath(require.resolve(`${name}/package.json`))) } catch {}
    let entry: string
    try { entry = await realpath(require.resolve(name)) } catch { continue }
    let directory = dirname(entry)
    for (let depth = 0; depth < 12; depth++) {
      try {
        if ((await metadata(join(directory, 'package.json'), signal)).name === name) return directory
      } catch { signal.throwIfAborted() }
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  return fail('LOCAL_DSH_DEPLOYMENT_BUNDLE_UNRESOLVED')
}

export async function discoverLocalDshDeployment(request: LocalDshDeploymentRequest): Promise<LocalDshDeploymentTarget> {
  request.signal.throwIfAborted()
  const endpoint = localEndpoint(request.endpoint)
  if (!isAbsolute(request.localCredentialsPath) || /[\u0000-\u001f\u007f]/.test(request.localCredentialsPath)) fail('LOCAL_DSH_DEPLOYMENT_CREDENTIALS_INVALID')
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
  try {
    const credentialsPath = await realpath(request.localCredentialsPath)
    const credential = await lstat(credentialsPath)
    if (!credential.isFile() || credential.uid !== process.getuid?.() || credential.nlink !== 1 || (credential.mode & 0o077) !== 0
      || credential.size > 1_048_576 || basename(credentialsPath) !== '.credentials.yaml') fail('LOCAL_DSH_DEPLOYMENT_CREDENTIALS_UNSAFE')
    const processes = await candidates(endpoint, credentialsPath, signal)
    if (processes.length !== 1) fail(processes.length > 1 ? 'LOCAL_DSH_DEPLOYMENT_PROCESS_AMBIGUOUS' : 'LOCAL_DSH_DEPLOYMENT_PROCESS_MISSING')
    const source = processes[0]!
    const profileDirectory = await realpath(join(source.home, 'profiles', source.profile))
    const manifestPath = join(profileDirectory, 'package.json')
    const manifest = await metadata(manifestPath, signal)
    const bundles = object(manifest.dsh) && object(manifest.dsh.profile) ? manifest.dsh.profile.bundles : undefined
    if (!Array.isArray(bundles) || bundles.length === 0 || bundles.length > 32 || !bundles.every(name => typeof name === 'string'
      && /^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(name)) || new Set(bundles).size !== bundles.length) fail('LOCAL_DSH_DEPLOYMENT_BUNDLES_INVALID')
    const layers: string[] = []
    for (const name of bundles as string[]) {
      const directory = await bundleDirectory(name, [source.anchor, manifestPath], signal)
      const metadataValue = await metadata(join(directory, 'package.json'), signal)
      if (object(metadataValue.engines) && metadataValue.engines.dsh !== undefined && metadataValue.engines.dsh !== '0.2.1-rc.2') fail('LOCAL_DSH_DEPLOYMENT_BUNDLE_VERSION_UNKNOWN')
      const declaration = object(metadataValue.dsh) && object(metadataValue.dsh.bundle) ? metadataValue.dsh.bundle.patch : undefined
      const files = typeof declaration === 'string' ? [declaration] : declaration
      if (!Array.isArray(files) || files.length === 0 || files.length > 32 || !files.every(filename => typeof filename === 'string'
        && !isAbsolute(filename) && !/[\u0000-\u001f\u007f]/.test(filename) && !relative(directory, resolve(directory, filename)).startsWith('..'))) fail('LOCAL_DSH_DEPLOYMENT_BUNDLE_INVALID')
      for (const filename of files as string[]) layers.push((await patch(resolve(directory, filename), signal))!.path)
    }
    const profile = await patch(join(profileDirectory, 'cordis.patch.yml'), signal, true)
    let profilePath = profile?.path ?? join(profileDirectory, 'cordis.patch.yml')
    const home = await patch(join(source.home, 'cordis.patch.yml'), signal, true)
    const overlays = []
    for (const filename of source.overlays) overlays.push((await patch(filename, signal))!)
    if (overlays.some(overlay => overlay.length > 0)) {
      const target = overlays[overlays.length - 1]!
      const location = relative(source.home, target.path)
      if (basename(target.path) !== 'cordis.patch.yml' || location === '..' || location.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(location)) fail('LOCAL_DSH_DEPLOYMENT_OVERLAY_UNSUPPORTED')
      if (profile) layers.push(profile.path)
      if (home) layers.push(home.path)
      layers.push(...overlays.slice(0, -1).map(overlay => overlay.path))
      profilePath = target.path
    } else if (home && home.length > 0) {
      if (profile) layers.push(profile.path)
      profilePath = home.path
    }
    const parent = await lstat(dirname(profilePath))
    if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o022) !== 0) fail('LOCAL_DSH_DEPLOYMENT_TARGET_UNSAFE')
    try {
      const target = await lstat(profilePath)
      if (target.isSymbolicLink() || !target.isFile() || target.uid !== process.getuid?.() || target.nlink !== 1 || (target.mode & 0o022) !== 0) fail('LOCAL_DSH_DEPLOYMENT_TARGET_UNSAFE')
    } catch (error) { if (!missing(error)) throw error }
    if (layers.length > 16 || new Set([...layers, profilePath, credentialsPath]).size !== layers.length + 2) fail('LOCAL_DSH_DEPLOYMENT_LAYERS_AMBIGUOUS')
    const values: unknown[] = []
    for (const path of [...layers, profilePath]) {
      let content: string
      try { content = await text(path, signal) }
      catch (error) { if (path === profilePath && missing(error)) continue; throw error }
      try { values.push(staticDshProfileValues(readStaticDshProfile(content || '[]\n'))) }
      catch { fail('LOCAL_DSH_DEPLOYMENT_PATCH_INVALID') }
    }
    try { composeStaticDshLayers(values) }
    catch { fail('LOCAL_DSH_DEPLOYMENT_PATCH_INVALID') }
    if (await text(join(source.directory, 'cmdline'), signal, 65_536) !== source.command) fail('LOCAL_DSH_DEPLOYMENT_PROCESS_CHANGED')
    signal.throwIfAborted()
    return snapshot({ profilePath, credentialsPath, layerPaths: layers, schemaVersion: '0.2.1-rc.2' as const })
  } catch (error) {
    request.signal.throwIfAborted()
    if (error instanceof FrameworkError) throw error
    return fail(signal.aborted ? 'LOCAL_DSH_DEPLOYMENT_TIMEOUT' : 'LOCAL_DSH_DEPLOYMENT_UNAVAILABLE')
  }
}
