import { randomBytes } from 'node:crypto'
import { Agent, request, Server } from 'node:http'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { AdminServerOptions } from '../src/admin/server.ts'

interface AdminModule {
  createAdminServer: (options: AdminServerOptions) => Server
}

interface Sample {
  latencyMs: number
  status: number
  responseBytes: number
  transportError: boolean
}

interface Measurement {
  route: string
  concurrency: number
  requests: number
  elapsedMs: number
  latencyMs: { p50: number; p95: number; p99: number }
  opsPerSecond: number
  responseBytes: number
  errorCount: number
  httpErrors: number
  transportErrors: number
  statusCounts: Record<string, number>
}

function isAdminModule(value: unknown): value is AdminModule {
  return value !== null
    && typeof value === 'object'
    && 'createAdminServer' in value
    && typeof value.createAdminServer === 'function'
}

function requestsPerCase(): number {
  const raw = process.env.BENCH_REQUESTS ?? '100'
  const count = Number(raw)
  if (!Number.isSafeInteger(count) || count < 1 || count > 250) {
    throw new Error('BENCH_REQUESTS must be an integer between 1 and 250')
  }
  return count
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function percentile(sorted: readonly number[], quantile: number): number {
  const value = sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]
  if (value === undefined) throw new Error('No benchmark samples')
  return round(value)
}

async function sampleRequest(origin: string, route: string, token: string, agent: Agent): Promise<Sample> {
  const started = performance.now()
  return new Promise<Sample>(resolvePromise => {
    let settled = false
    let responseBytes = 0
    const finish = (status: number, transportError: boolean): void => {
      if (settled) return
      settled = true
      resolvePromise({ latencyMs: performance.now() - started, status, responseBytes, transportError })
    }
    const outgoing = request(new URL(route, origin), {
      method: 'GET',
      agent,
      headers: route === '/api/snapshot' ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(10_000)
    }, response => {
      response.on('data', (chunk: unknown) => {
        if (!(chunk instanceof Uint8Array)) {
          response.destroy(new Error('Invalid response bytes'))
          return
        }
        responseBytes += chunk.byteLength
      })
      response.once('end', () => finish(response.statusCode ?? 0, false))
      response.once('error', () => finish(0, true))
    })
    outgoing.once('error', () => finish(0, true))
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('Benchmark request timed out')))
    outgoing.end()
  })
}

async function measure(
  origin: string,
  route: string,
  token: string,
  concurrency: number,
  requests: number
): Promise<Measurement> {
  const agent = new Agent({ keepAlive: true, maxSockets: concurrency, maxFreeSockets: concurrency })
  const samples: Sample[] = []
  let next = 0
  const started = performance.now()
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, async () => {
      while (next < requests) {
        next += 1
        samples.push(await sampleRequest(origin, route, token, agent))
      }
    }))
  } finally {
    agent.destroy()
  }
  const elapsedMs = performance.now() - started
  const sorted = samples.map(sample => sample.latencyMs).sort((left, right) => left - right)
  const statusCounts: Record<string, number> = {}
  let responseBytes = 0
  let httpErrors = 0
  let transportErrors = 0
  for (const sample of samples) {
    responseBytes += sample.responseBytes
    if (sample.transportError) transportErrors += 1
    else if (sample.status !== 200) httpErrors += 1
    const status = String(sample.status)
    statusCounts[status] = (statusCounts[status] ?? 0) + 1
  }
  return {
    route,
    concurrency,
    requests: samples.length,
    elapsedMs: round(elapsedMs),
    latencyMs: { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99) },
    opsPerSecond: round(samples.length * 1000 / elapsedMs),
    responseBytes,
    errorCount: httpErrors + transportErrors,
    httpErrors,
    transportErrors,
    statusCounts
  }
}

async function main(): Promise<void> {
  const count = requestsPerCase()
  const defaultRoot = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../' : '../../', import.meta.url))
  const root = resolve(process.env.BENCH_ROOT ?? defaultRoot)
  const imported: unknown = await import(pathToFileURL(resolve(root, 'src/admin/server.ts')).href)
  if (!isAdminModule(imported)) throw new Error('Invalid benchmark server module')
  const token = randomBytes(32).toString('hex')
  const fixture = {
    overview: { mode: 'demo', source: 'synthetic-benchmark' },
    features: [],
    context: { persona: null, configuration: {}, preferences: {}, provenance: [] },
    policy: { paused: true, grants: [] },
    outbox: Array.from({ length: 500 }, (_, index) => ({
      id: `demo-message-${index}`,
      conversationId: 'demo:room',
      status: 'confirmed',
      content: [{ type: 'text', text: `Synthetic demo message ${index}` }]
    })),
    audit: Array.from({ length: 500 }, (_, index) => ({
      id: `demo-audit-${index}`,
      type: 'benchmark.observed',
      featureId: 'demo',
      status: 'recorded'
    }))
  }
  let snapshotCalls = 0
  let dispatchCalls = 0
  const server = imported.createAdminServer({
    token,
    snapshot() {
      snapshotCalls += 1
      return structuredClone(fixture)
    },
    dispatchDemo() {
      dispatchCalls += 1
      throw new Error('Demo dispatch is disabled for benchmarks')
    }
  })
  if (!(server instanceof Server)) throw new Error('Benchmark requires a native HTTP server')
  const measurements: Measurement[] = []
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', rejectPromise)
        resolvePromise()
      })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Missing loopback address')
    const origin = `http://127.0.0.1:${address.port}`
    for (const route of ['/health', '/api/snapshot']) {
      for (const concurrency of [1, 16]) {
        measurements.push(await measure(origin, route, token, concurrency, count))
      }
    }
  } finally {
    if (server.listening) {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.close(error => {
          if (error) rejectPromise(error)
          else resolvePromise()
        })
        server.closeAllConnections()
      })
    }
  }
  const errorCount = measurements.reduce((total, measurement) => total + measurement.errorCount, 0)
  const ok = errorCount === 0 && dispatchCalls === 0 && snapshotCalls === 2 * count
  console.log(JSON.stringify({
    benchmark: 'admin-http',
    ok,
    node: process.version,
    target: process.env.BENCH_ROOT === undefined ? 'current' : 'BENCH_ROOT',
    totalRequests: measurements.reduce((total, measurement) => total + measurement.requests, 0),
    requestLimit: 1000,
    warmupRequests: 0,
    fixture: { auditEntries: 500, outboxEntries: 500, snapshotCalls, dispatchCalls },
    staticAssets: { measured: false, reason: 'Static routes are excluded; target assets require a build.' },
    measurements
  }))
  if (!ok) process.exitCode = 1
}

main().catch(() => {
  console.log(JSON.stringify({ benchmark: 'admin-http', ok: false, error: 'benchmark_failed' }))
  process.exitCode = 1
})
