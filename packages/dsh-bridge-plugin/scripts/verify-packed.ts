import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'qq-dsh-packed-verification-'))
const fixture = join(temporary, 'host')
const keep = process.argv.includes('--keep')
try {
  await mkdir(fixture)
  const lockText = await readFile(join(root, 'package-lock.json'), 'utf8')
  const lock = object(JSON.parse(lockText))
  const manifest = object(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')))
  const packed: unknown = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  }))
  assert(Array.isArray(packed) && packed.length === 1)
  const filename = object(packed[0]).filename
  assert(typeof filename === 'string' && /^[A-Za-z0-9_.-]+\.tgz$/.test(filename))
  const files = object(packed[0]).files
  assert(Array.isArray(files) && files.length <= 64)
  assert(files.every(file => {
    const path = object(file).path
    return typeof path === 'string' && (['package.json', 'README.md'].includes(path) || /^dist\/[a-z0-9-]+\.(?:js|d\.ts)$/.test(path))
  }), 'The release tarball may contain only its public manifest, README and compiled plugin')
  const tarball = join(temporary, filename)
  const name = 'dsh-bridge-plugin-isolated-install-fixture'
  const dependencies = { '@qq-agent-framework/dsh-bridge-plugin': `file:${tarball}` }
  manifest.name = name
  manifest.dependencies = dependencies
  lock.name = name
  const rootPackage = object(object(lock.packages)[''])
  rootPackage.name = name
  rootPackage.dependencies = dependencies
  await writeFile(join(fixture, 'package.json'), JSON.stringify(manifest, null, 2))
  await writeFile(join(fixture, 'package-lock.json'), JSON.stringify(lock, null, 2))
  const options = { cwd: fixture, stdio: 'inherit' as const }
  execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], options)
  const assembled = object(object(JSON.parse(await readFile(join(fixture, 'package-lock.json'), 'utf8'))).packages)
  for (const [path, metadata] of Object.entries(object(lock.packages))) {
    if (path === '') continue
    const expected = object(metadata)
    const actual = object(assembled[path])
    for (const key of ['version', 'resolved', 'integrity']) assert.equal(actual[key], expected[key], `Locked dependency changed: ${path}`)
  }
  execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], options)
  for (const dependency of ['@qq-agent-framework/dsh-bridge-plugin', '@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-api-gateway']) {
    const info = await lstat(join(fixture, 'node_modules', dependency))
    assert(info.isDirectory() && !info.isSymbolicLink(), 'Packed verification must use installed packages, not linked old SDKs')
  }
  await mkdir(join(fixture, 'test'))
  await cp(join(root, 'test/sdk-entry.test.ts'), join(fixture, 'test/sdk-entry.test.ts'))
  await cp(join(root, 'test/controller-start.test.ts'), join(fixture, 'test/controller-start.test.ts'))
  execFileSync(process.execPath, ['--test', 'test/sdk-entry.test.ts', 'test/controller-start.test.ts'], options)
  if (process.env.QQ_FRAMEWORK_DSH_PORT_MODULE) {
    await cp(join(root, 'integration'), join(fixture, 'integration'), { recursive: true })
    execFileSync(process.execPath, ['--test', 'integration/bridge-client.test.ts'], options)
  }
  const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
  process.stdout.write(JSON.stringify({ state: 'verified-isolated-install', node: process.version,
    lockSha256: digest(lockText), tarballSha256: digest(await readFile(tarball)),
    frameworkIntegration: process.env.QQ_FRAMEWORK_DSH_PORT_MODULE ? 'passed' : 'not-requested',
    ...(keep ? { fixture } : {}),
  }) + '\n')
} finally {
  if (!keep) await rm(temporary, { recursive: true, force: true })
}
