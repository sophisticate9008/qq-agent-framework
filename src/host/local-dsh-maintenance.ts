import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
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
      && metadata.uid === process.getuid?.() && basename(manager) === 'qqbridge' && basename(dirname(manager)) === 'ops',
    'LOCAL_DSH_MANAGER_UNSUPPORTED', 'The configured manager is not a supported local DSH manager.')
    const root = dirname(dirname(manager))
    for (const directory of [root, dirname(manager)]) {
      const info = await lstat(directory)
      assert(info.isDirectory() && (info.mode & 0o022) === 0 && info.uid === process.getuid?.(),
        'LOCAL_DSH_MANAGER_UNSAFE', 'The trusted manager directory is not private to its owner.')
    }
    const adapter = configuration.adapters.dshAgent
    assert(adapter.enabled && adapter.localCredentialsPath, 'LOCAL_DSH_RESTART_UNAVAILABLE', 'Local DSH discovery is required.')
    const target = await discoverLocalDshDeployment({ endpoint: adapter.endpoint, localCredentialsPath: adapter.localCredentialsPath, signal })
    const credentials = await realpath(join(root, 'dsh', 'home', '.credentials.yaml'))
    assert(target.credentialsPath === credentials, 'LOCAL_DSH_MANAGER_TARGET_MISMATCH', 'The manager does not own the discovered DSH instance.')
    signal.throwIfAborted()
    return { manager, root, identity: digest({ manager, target, endpoint: adapter.endpoint }) }
  }
  return {
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
