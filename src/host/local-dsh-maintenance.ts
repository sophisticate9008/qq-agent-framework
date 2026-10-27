import { createConnection } from 'node:net'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { assert } from '../core/values.ts'
import { createDshAuthenticationOptions } from '../adapters/dsh-authentication.ts'
import { createDshJsonRpcPort } from '../adapters/dsh-jsonrpc.ts'
import type { NativeChatConfiguration } from './native-chat-configuration.ts'
import { discoverLocalDshDeployment } from './local-dsh-deployment.ts'
import { digest } from './data.ts'

const execute = promisify(execFile)
/** The program is selected only by server deployment configuration; browser requests supply no executable or arguments. */
export function createLocalDshMaintenance(serviceManager?: string) {
  async function inspect(configuration: NativeChatConfiguration, signal: AbortSignal) {
    assert(serviceManager, 'LOCAL_DSH_RESTART_NOT_CONFIGURED', 'A trusted local DSH manager is not configured.')
    const manager = await realpath(serviceManager)
    const metadata = await lstat(manager)
    assert(metadata.isFile() && metadata.nlink === 1 && (metadata.mode & 0o022) === 0 && (metadata.mode & 0o111) !== 0
      && metadata.uid === process.getuid?.() && ['qqagent', 'qqbridge'].includes(basename(manager)) && basename(dirname(manager)) === 'ops',
    'LOCAL_DSH_MANAGER_UNSUPPORTED', 'The configured manager is not a supported local DSH manager.')
    const root = dirname(dirname(manager))
    for (const directory of [root, dirname(manager)]) {
      const info = await lstat(directory)
      assert(info.isDirectory() && (info.mode & 0o022) === 0 && info.uid === process.getuid?.(),
        'LOCAL_DSH_MANAGER_UNSAFE', 'The trusted manager directory is not private to its owner.')
    }
    let dshHome = join(root, 'dsh', 'home')
    if (basename(manager) === 'qqagent') {
      const description = await execute(manager, ['describe', '--json'], { cwd: root, signal, timeout: 10_000, maxBuffer: 16 * 1024 })
      const value: unknown = JSON.parse(description.stdout)
      assert(value !== null && typeof value === 'object' && 'schema' in value && value.schema === 1
        && 'kind' in value && value.kind === 'qq-agent-framework' && 'dshHome' in value
        && typeof value.dshHome === 'string' && isAbsolute(value.dshHome) && !value.dshHome.includes('\0'),
      'LOCAL_DSH_MANAGER_UNSUPPORTED', 'The configured manager did not identify its DSH instance.')
      dshHome = await realpath(value.dshHome)
      const homeMetadata = await lstat(dshHome)
      assert(homeMetadata.isDirectory() && (homeMetadata.mode & 0o022) === 0 && homeMetadata.uid === process.getuid?.(),
        'LOCAL_DSH_MANAGER_UNSAFE', 'The DSH directory is not owner-controlled.')
    }
    const adapter = configuration.adapters.dshAgent
    assert(adapter.enabled && adapter.localCredentialsPath, 'LOCAL_DSH_RESTART_UNAVAILABLE', 'Local DSH discovery is required.')
    const target = await discoverLocalDshDeployment({ endpoint: adapter.endpoint, localCredentialsPath: adapter.localCredentialsPath, signal })
    const credentials = await realpath(join(dshHome, '.credentials.yaml'))
    assert(target.credentialsPath === credentials, 'LOCAL_DSH_MANAGER_TARGET_MISMATCH', 'The manager does not own the discovered DSH instance.')
    signal.throwIfAborted()
    return { manager, root, dshHome, identity: digest({ manager, target, endpoint: adapter.endpoint }) }
  }
  async function storage(configuration: NativeChatConfiguration, sessionId: string, signal: AbortSignal) {
    const trusted = await inspect(configuration, signal)
    const port = createDshJsonRpcPort({ endpoint: configuration.adapters.dshAgent.endpoint,
      ...createDshAuthenticationOptions(configuration.adapters.dshAgent), timeoutMs: 5000 })
    try {
      assert(port.inspectSessionStorage, 'SESSION_DELETE_UNAVAILABLE', 'Session storage inspection is unavailable.')
      const location = await port.inspectSessionStorage(sessionId, signal)
      if (!location.exists) return { trusted, location, directory: null, identity: null }
      const root = await realpath(join(trusted.dshHome, 'sessions'))
      const encoded = [...sessionId].map(char => /^[A-Za-z0-9._-]$/.test(char) ? char : '~' + char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')).join('')
      assert(location.root === root && location.filename, 'SESSION_DELETE_STORAGE_UNSUPPORTED', 'The storage root is not owned by this manager.')
      const directory = dirname(location.filename)
      assert(dirname(dirname(directory)) === root && basename(directory) === encoded && await realpath(directory) === directory,
        'SESSION_DELETE_STORAGE_UNSAFE', 'The session location is not an isolated storage directory.')
      for (const path of [root, dirname(directory), directory]) {
        const info = await lstat(path)
        assert(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o022) === 0 && info.uid === process.getuid?.(),
          'SESSION_DELETE_STORAGE_UNSAFE', 'The session directory is not owner-controlled.')
      }
      const info = await lstat(directory)
      return { trusted, location, directory, identity: { dev: info.dev, ino: info.ino } }
    } finally { await port.close() }
  }
  async function assertListenerStopped(endpoint: string): Promise<void> {
    const url = new URL(endpoint)
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) })
      socket.setTimeout(2000)
      socket.once('connect', () => { socket.destroy(); reject(new Error('SESSION_DELETE_SERVICE_STILL_RUNNING')) })
      socket.once('timeout', () => { socket.destroy(); reject(new Error('SESSION_DELETE_SERVICE_STATE_UNKNOWN')) })
      socket.once('error', error => { if ('code' in error && error.code === 'ECONNREFUSED') resolve(); else reject(error) })
    })
  }
  return {
    async inspectSession(configuration: NativeChatConfiguration, sessionId: string, signal: AbortSignal) {
      return (await storage(configuration, sessionId, signal)).location.exists
    },
    async deleteSession(configuration: NativeChatConfiguration, sessionId: string, signal: AbortSignal, beforeDelete: () => void | Promise<void>, afterDelete: () => void | Promise<void>) {
      const selected = await storage(configuration, sessionId, signal)
      assert(selected.directory && selected.identity, 'SESSION_DELETE_NOT_FOUND', 'The selected session is absent.')
      await beforeDelete()
      signal.throwIfAborted()
      await execute(selected.trusted.manager, ['stop', 'dsh'], { cwd: selected.trusted.root, signal, timeout: 60_000, maxBuffer: 64 * 1024 })
      // The manager confirms the listener has exited before touching the selected session artifacts.
      try {
        await beforeDelete()
        await assertListenerStopped(configuration.adapters.dshAgent.endpoint)
        signal.throwIfAborted()
        const lock = await lstat(join(selected.directory, 'session.lock'))
        assert(lock.isFile() && !lock.isSymbolicLink() && lock.nlink === 1 && lock.uid === process.getuid?.(), 'SESSION_DELETE_STORAGE_UNSAFE', 'The session lease must be a regular owned file.')
        const worker = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../adapters/dsh-session-files.ts' : '../adapters/dsh-session-files.js', import.meta.url))
        await execute('flock', ['--nonblock', '--exclusive', '--', join(selected.directory, 'session.lock'), process.execPath,
          worker, selected.directory, String(selected.identity.dev), String(selected.identity.ino)],
        { signal, timeout: 30_000, maxBuffer: 16 * 1024 })
        await afterDelete()
      } finally {
        // A failed removal must not leave unrelated conversations' model service shut down.
        await execute(selected.trusted.manager, ['start', 'dsh'], { cwd: selected.trusted.root, timeout: 120_000, maxBuffer: 64 * 1024 })
      }
    },
    inspect: async (configuration: NativeChatConfiguration, signal: AbortSignal) => (await inspect(configuration, signal)).identity,
    async restart(configuration: NativeChatConfiguration, signal: AbortSignal) {
      const trusted = await inspect(configuration, signal)
      signal.throwIfAborted()
      await execute(trusted.manager, ['restart', 'dsh'], { cwd: trusted.root, signal, timeout: 120_000, maxBuffer: 64 * 1024 })
    },
    async verify(configuration: NativeChatConfiguration, signal: AbortSignal) {
      await inspect(configuration, signal)
      const port = createDshJsonRpcPort({ endpoint: configuration.adapters.dshAgent.endpoint,
        ...createDshAuthenticationOptions(configuration.adapters.dshAgent), timeoutMs: 5000 })
      try { await port.verify(signal) } finally { await port.close() }
    },
  }
}
