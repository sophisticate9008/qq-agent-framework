import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cp, lstat, mkdir, readFile, realpath, symlink, writeFile, open } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { stringify } from 'yaml'
import { isRecord } from '../src/core/values.ts'
import { readStaticDshProfile, staticDshProfileValues } from '../src/adapters/dsh-static-profile.ts'
import { createDshJsonRpcPort } from '../src/adapters/dsh-jsonrpc.ts'
import { createDshAuthenticationOptions } from '../src/adapters/dsh-authentication.ts'
import type { NativeChatConfiguration } from '../src/host/native-chat-configuration.ts'
import { discoverLocalDshDeployment } from '../src/host/local-dsh-deployment.ts'

async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('simulation_port_unavailable')
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))
  return address.port
}

/** Build from an explicit small bundle set; production overlays and custom bundles are never mounted. */
export async function prepareSimulationDsh(options: {
  readonly directory: string
  readonly servicesFilename: string
  readonly configuration: NativeChatConfiguration
}) {
  const services: unknown = JSON.parse(await readFile(options.servicesFilename, 'utf8'))
  if (!isRecord(services) || !isRecord(services.services) || !isRecord(services.services.dsh)) throw new Error('simulation_dsh_service_missing')
  const service = services.services.dsh
  if (typeof service.command !== 'string' || !Array.isArray(service.args) || typeof service.args[0] !== 'string') throw new Error('simulation_dsh_service_invalid')
  const binary = resolve(service.args[0])
  if (!binary.endsWith('/@deepseek-ai/dsh/lib/bin.js')) throw new Error('simulation_dsh_binary_unsupported')
  const target = options.configuration.deployment.target
  if (!target) throw new Error('simulation_explicit_deployment_target_required')
  const home = join(options.directory, 'dsh-home')
  const profile = join(home, 'profiles', 'web')
  const workspace = join(options.directory, 'workspace')
  await mkdir(profile, { recursive: true, mode: 0o700 })
  await mkdir(workspace, { mode: 0o700 })
  const installed = createRequire(binary)
  const packages = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@qq-bridge-framework/dsh-bridge-plugin']
  const layers: string[] = []
  for (const name of packages) {
    let moduleDirectory: string
    if (name === '@qq-bridge-framework/dsh-bridge-plugin') {
      const sourceModule = await realpath(fileURLToPath(new URL('../packages/dsh-bridge-plugin/', import.meta.url)))
      const built = await lstat(join(sourceModule, 'dist', 'index.js')).catch(() => null)
      if (!built?.isFile()) throw new Error('simulation_build_current_bridge_plugin_first')
      // Pin the built code for this run. Rebuilding the worktree must not hot-reload a running experiment.
      moduleDirectory = join(options.directory, 'bridge-plugin')
      await mkdir(moduleDirectory, { mode: 0o700 })
      await cp(join(sourceModule, 'dist'), join(moduleDirectory, 'dist'), { recursive: true, errorOnExist: true, force: false })
      await cp(join(sourceModule, 'package.json'), join(moduleDirectory, 'package.json'), { errorOnExist: true, force: false })
      // DSH Session has private class state: host and bridge must share the same SDK instances.
      await symlink(await realpath(resolve(dirname(binary), '../../..')), join(moduleDirectory, 'node_modules'), 'dir')
    } else {
      let manifest: string
      try { manifest = installed.resolve(`${name}/package.json`) }
      catch { manifest = join(dirname(dirname(installed.resolve(name))), 'package.json') }
      moduleDirectory = await realpath(dirname(manifest))
    }
    const link = join(profile, 'node_modules', name)
    await mkdir(dirname(link), { recursive: true, mode: 0o700 })
    await symlink(moduleDirectory, link, 'dir')
    if (name !== '@qq-bridge-framework/dsh-bridge-plugin') {
      const manifest: unknown = JSON.parse(await readFile(join(moduleDirectory, 'package.json'), 'utf8'))
      const declaration = isRecord(manifest) && isRecord(manifest.dsh) && isRecord(manifest.dsh.bundle) ? manifest.dsh.bundle.patch : undefined
      const patches: unknown = typeof declaration === 'string' ? [declaration] : declaration
      if (!Array.isArray(patches) || patches.length < 1 || patches.length > 16 || !patches.every(path => typeof path === 'string' && !path.startsWith('/') && !path.split('/').includes('..'))) throw new Error('simulation_dsh_bundle_patch_invalid')
      for (const path of patches as string[]) layers.push(await realpath(join(moduleDirectory, path)))
    }
  }
  const source = staticDshProfileValues(readStaticDshProfile(await readFile(target.profilePath, 'utf8')))
  if (!Array.isArray(source)) throw new Error('simulation_dsh_source_patch_invalid')
  const provider = source.filter(value => isRecord(value) && value.id === 'llm-pi-ai').at(-1)
  if (!isRecord(provider) || !isRecord(provider.config) || !isRecord(provider.config.providers)) throw new Error('simulation_dsh_provider_configuration_missing')
  const credentials: unknown = structuredClone(staticDshProfileValues(readStaticDshProfile(await readFile(target.credentialsPath, 'utf8'))))
  if (!isRecord(credentials) || !isRecord(credentials.records)) throw new Error('simulation_dsh_credentials_invalid')
  // The independent browser signing grant prevents a production cookie authenticating this instance.
  const browser = credentials.records['client-connection/browser-session']
  if (!isRecord(browser) || !isRecord(browser.payload)) throw new Error('simulation_dsh_browser_grant_missing')
  browser.payload.secret = randomBytes(32).toString('base64url')
  const credentialsPath = join(home, '.credentials.yaml')
  await writeFile(credentialsPath, stringify(credentials), { mode: 0o600, flag: 'wx' })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'qbf-private-simulation', private: true,
    dsh: { profile: { bundles: packages.slice(0, 2) } } }, null, 2), { mode: 0o600, flag: 'wx' })
  await writeFile(join(profile, 'cordis.yml'), '[]\n', { mode: 0o600, flag: 'wx' })
  const profilePath = join(profile, 'cordis.patch.yml')
  await writeFile(profilePath, stringify([
    { id: 'llm-pi-ai', config: provider.config },
    { id: 'session-title-llm', disabled: true },
    { id: 'tool-plugin-manager', disabled: true },
    { insert: [{ id: 'qbf-bridge-evidence', name: '@qq-bridge-framework/dsh-bridge-plugin' }] }
  ]), { mode: 0o600, flag: 'wx' })
  const port = await unusedPort()
  const endpoint = `http://127.0.0.1:${port}`
  const configuration = { enabled: true, endpoint, auth: '', localCredentialsPath: credentialsPath }
  let child: ChildProcess | undefined
  let startupError: Error | undefined
  const logFilename = join(options.directory, 'dsh.log')
  async function stop() {
    const current = child
    if (!current || current.exitCode !== null || current.signalCode !== null) return
    const exited = new Promise<void>(done => current.once('exit', () => done()))
    current.kill('SIGTERM')
    await Promise.race([exited, delay(10_000)])
    if (current.exitCode === null && current.signalCode === null) { current.kill('SIGKILL'); await exited }
  }
  return {
    home, workspace, endpoint, configuration, bundles: packages,
    target: { profilePath, credentialsPath, layerPaths: layers, schemaVersion: '0.2.1-rc.2' as const },
    async start(signal: AbortSignal) {
      if (child && child.exitCode === null && child.signalCode === null) throw new Error('simulation_dsh_already_running')
      startupError = undefined
      const log = await open(logFilename, 'a', 0o600)
      try {
        child = spawn(service.command as string, [binary, 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
          cwd: workspace,
          env: { PATH: process.env.PATH, DSH_HOME: home,
            DSH_INSTALL_MODULES: resolve(dirname(binary), '../../..'), DSH_TELEMETRY_DISABLED: '1' },
          stdio: ['ignore', log.fd, log.fd]
        })
        child.on('error', error => { startupError = error })
      } finally { await log.close() }
      const current = child
      if (!current) throw new Error('simulation_dsh_spawn_failed')
      const client = createDshJsonRpcPort({ endpoint, ...createDshAuthenticationOptions(configuration), timeoutMs: 3000 })
      try {
        const deadline = Date.now() + 60_000
        while (Date.now() < deadline) {
          signal.throwIfAborted()
          if (startupError || current.exitCode !== null || current.signalCode !== null) throw new Error('simulation_dsh_start_failed_see_private_log')
          try {
            await client.bridgePlugin!.describe(signal)
            const discovered = await discoverLocalDshDeployment({ endpoint, localCredentialsPath: credentialsPath, signal })
            if (discovered.profilePath !== profilePath || discovered.credentialsPath !== credentialsPath
              || JSON.stringify(discovered.layerPaths) !== JSON.stringify(layers)) throw new Error('simulation_dsh_discovered_target_mismatch')
            return
          }
          catch { await delay(250, undefined, { signal }) }
        }
        throw new Error('simulation_dsh_start_timeout_see_private_log')
      } finally { await client.close() }
    },
    stop
  }
}
