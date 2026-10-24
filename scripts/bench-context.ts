import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

type Scenario = 'mostly-unrelated' | 'all-same-scope'

interface BenchmarkResult {
  scenario: Scenario
  preferences: number
  matchingPreferences: number
  ops: number
  warmup: number
  elapsedMs: number
  opsPerSecond: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
}

function countFromEnvironment(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  assert(Number.isSafeInteger(value) && value >= minimum, 'Invalid benchmark count')
  return value
}

function percentile(sorted: readonly number[], fraction: number): number {
  const value = sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
  assert(value !== undefined)
  return value
}

async function measure(scenario: Scenario, size: number): Promise<BenchmarkResult> {
  const root = process.env.BENCH_ROOT ?? fileURLToPath(new URL('../', import.meta.url))
  const moduleUrl = pathToFileURL(resolve(root, 'src/core/context.ts')).href
  const { createContextStore } = await import(moduleUrl) as typeof import('../src/core/context.ts')
  const store = createContextStore({ clock: () => 1_000 })
  const persona = store.registerPersona({
    id: 'benchmark', version: '1', name: 'Benchmark', identity: {}, style: {}
  })
  let persistent: number | null = null
  let temporary: number | null = null
  for (let index = 0; index < size; index += 1) {
    const matching = scenario === 'all-same-scope' || index === 0
    const expiresAt = index % 3 === 0 ? null : index % 3 === 1 ? 2_000 : 1_000
    store.setPreferences({
      id: `preference-${index}`,
      scope: { kind: 'conversation', id: matching ? 'target' : `unrelated-${index}` },
      values: { marker: index },
      source: 'operator',
      expiresAt
    })
    if (matching && expiresAt === null) persistent = index
    if (matching && expiresAt !== null && expiresAt > 1_000) temporary = index
  }
  const input = { persona, conversationId: 'target' }
  const expected = temporary ?? persistent
  assert.equal(store.resolve(input).preferences.marker, expected)
  const ops = countFromEnvironment('BENCH_OPS', 200, 1)
  const warmup = countFromEnvironment('BENCH_WARMUP', 20, 0)
  for (let index = 0; index < warmup; index += 1) store.resolve(input)
  const samples: number[] = []
  let observed: unknown
  const started = performance.now()
  for (let index = 0; index < ops; index += 1) {
    const operationStarted = performance.now()
    observed = store.resolve(input).preferences.marker
    samples.push(performance.now() - operationStarted)
  }
  const elapsedMs = performance.now() - started
  assert.equal(observed, expected)
  samples.sort((left, right) => left - right)
  return {
    scenario,
    preferences: size,
    matchingPreferences: scenario === 'all-same-scope' ? size : 1,
    ops,
    warmup,
    elapsedMs,
    opsPerSecond: ops * 1_000 / elapsedMs,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    p99Ms: percentile(samples, 0.99)
  }
}

const childScenario = process.argv[2]
if (childScenario !== undefined) {
  assert(childScenario === 'mostly-unrelated' || childScenario === 'all-same-scope')
  const size = Number(process.argv[3])
  assert(Number.isSafeInteger(size) && size > 0)
  process.stdout.write(`${JSON.stringify(await measure(childScenario, size))}\n`)
} else {
  const results: unknown[] = []
  for (const scenario of ['mostly-unrelated', 'all-same-scope'] as const) {
    for (const size of [10, 1_000, 10_000]) {
      const child = spawnSync(process.execPath, [
        fileURLToPath(import.meta.url), scenario, String(size)
      ], { encoding: 'utf8', env: process.env })
      if (child.error) throw child.error
      if (child.status !== 0) {
        process.stderr.write(child.stderr)
        throw new Error('Benchmark child failed')
      }
      const result: unknown = JSON.parse(child.stdout)
      results.push(result)
    }
  }
  process.stdout.write(`${JSON.stringify({ results })}\n`)
}
