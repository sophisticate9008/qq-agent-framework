import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { createDshJsonRpcPort } from '../adapters/dsh-jsonrpc.ts'
import { createLocalDshAuthenticationProvider } from '../adapters/dsh-local-auth.ts'
import { FrameworkError } from '../core/values.ts'

interface LocalDshCandidate {
  readonly endpoint: string
  readonly credentialsPath: string
}

async function boundedText(filename: string): Promise<string> {
  const handle = await open(filename, 'r')
  try {
    const buffer = Buffer.alloc(65_537)
    const result = await handle.read(buffer, 0, buffer.length, 0)
    if (result.bytesRead > 65_536) throw new Error('Local process metadata is too large')
    return buffer.subarray(0, result.bytesRead).toString('utf8')
  } finally { await handle.close() }
}

function flag(argumentsList: readonly string[], name: string): string | undefined {
  const inline = argumentsList.find(argument => argument.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = argumentsList.indexOf(name)
  return index < 0 ? undefined : argumentsList[index + 1]
}

function endpoint(host: string, port: string): string | null {
  if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65_535) return null
  if (host === '0.0.0.0' || host === '::') host = '127.0.0.1'
  if (host !== 'localhost' && host !== '::1' && !/^127(?:\.[0-9]{1,3}){3}$/.test(host)) return null
  return `http://${host === '::1' ? '[::1]' : host}:${port}`
}

export async function discoverLocalDsh(options: {
  readonly signal: AbortSignal
  readonly preferredEndpoint?: string
}): Promise<LocalDshCandidate> {
  options.signal.throwIfAborted()
  const candidates: LocalDshCandidate[] = []
  const homes = new Set<string>([process.env.DSH_HOME ?? join(homedir(), '.dsh')])
  if (process.platform === 'linux' && process.getuid) {
    const processes = (await readdir('/proc')).filter(name => /^[1-9][0-9]*$/.test(name)).slice(0, 4_096)
    for (const identifier of processes) {
      options.signal.throwIfAborted()
      try {
        const directory = join('/proc', identifier)
        if ((await lstat(directory)).uid !== process.getuid()) continue
        const argumentsList = (await boundedText(join(directory, 'cmdline'))).split('\0').filter(Boolean)
        if (!argumentsList.some(argument => /(?:^|\/)@deepseek-ai\/dsh\/(?:lib\/bin\.js|bin\/dsh\.js)$/.test(argument)
          || /(?:^|\/)dsh(?:\.exe)?$/.test(argument)) || !argumentsList.includes('web')) continue
        const environment = (await boundedText(join(directory, 'environ'))).split('\0')
        const home = environment.find(value => value.startsWith('DSH_HOME='))?.slice(9) ?? join(homedir(), '.dsh')
        if (!isAbsolute(home) || /[\u0000-\u001f\u007f]/.test(home)) continue
        homes.add(home)
        const address = endpoint(flag(argumentsList, '--host') ?? '127.0.0.1', flag(argumentsList, '--port') ?? '3000')
        if (address) candidates.push({ endpoint: address, credentialsPath: join(resolve(home), '.credentials.yaml') })
      } catch {}
    }
  }
  for (const home of homes) {
    if (!isAbsolute(home) || /[\u0000-\u001f\u007f]/.test(home)) continue
    for (const address of [options.preferredEndpoint, 'http://127.0.0.1:3080', 'http://127.0.0.1:3000']) {
      if (address) candidates.push({ endpoint: address, credentialsPath: join(resolve(home), '.credentials.yaml') })
    }
  }
  const seen = new Set<string>()
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(10_000)])
  for (const candidate of candidates.slice(0, 16)) {
    options.signal.throwIfAborted()
    if (signal.aborted) break
    const key = JSON.stringify(candidate)
    if (seen.has(key)) continue
    seen.add(key)
    let client: ReturnType<typeof createDshJsonRpcPort> | undefined
    try {
      const resolved = { ...candidate, credentialsPath: await realpath(candidate.credentialsPath) }
      const provider = createLocalDshAuthenticationProvider(resolved)
      await provider('none', signal)
      client = createDshJsonRpcPort({ endpoint: candidate.endpoint, auth: '', authenticationProvider: provider, timeoutMs: 2_000 })
      await client.verify(signal)
      options.signal.throwIfAborted()
      return resolved
    } catch {} finally { await client?.close() }
  }
  options.signal.throwIfAborted()
  throw new FrameworkError('LOCAL_DSH_NOT_FOUND', 'No authenticated local DSH service could be connected.')
}
