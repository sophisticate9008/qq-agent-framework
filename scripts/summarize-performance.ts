import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface Latency { p50: number; p95: number; p99: number }
interface Point { operations: number; opsPerSecond: number; latencyMs: Latency }
interface CoreScenario extends Point {
  name: string; unrelatedFeatures: number; timerTicks: number; stateNamespaces: number;
  heapDeltaBytesAfterGc: number | null; rssDeltaBytes: number; cpuMs: number;
}
interface ObservationSample { method: string; supported: boolean; opsPerSecond?: number }
interface CoreReport {
  node: string; platform: string; architecture: string; cpu: string; availableParallelism: number;
  scenarios: CoreScenario[];
  burst: { attempted: number; accepted: number; rejected: number; peakPendingEvents: number };
  slowPeer: { fastPeerLatencyMs: number; configuredConcurrency: number };
  observation: { samples: ObservationSample[] };
}
interface ContextPoint { scenario: string; preferences: number; ops: number; warmup: number;
  opsPerSecond: number; p50Ms: number; p95Ms: number; p99Ms: number }
interface PolicyPoint extends Latency { scenario: string; grants: number; ops: number; opsPerSecond: number }
interface AdminPoint extends Point { route: string; concurrency: number; requests: number; errorCount: number; responseBytes: number }
interface SoakReport { windows: Array<{ completedEvents: number; heapDeltaBytesFromWarmup: number;
  rssBytes: number; heapUsedBytes: number; stateNamespaces: number; timerTicks: number }> }
const directory = new URL('../runtime/iterations/002/', import.meta.url);
const sourceRoot = new URL('../', import.meta.url);
const rawDigests: Record<string, string> = {};

function load<Report>(name: string): Report {
  const contents = readFileSync(new URL(name, directory), 'utf8');
  rawDigests[name] = createHash('sha256').update(contents).digest('hex');
  return JSON.parse(contents) as Report;
}

function median(values: number[]): number {
  assert.equal(values.length, 3);
  assert(values.every(Number.isFinite));
  return [...values].sort((left, right) => left - right)[1];
}

function summarize(points: Point[]) {
  assert.equal(points.length, 3);
  return { operationsPerRun: points.map(point => point.operations),
    medianOpsPerSecond: median(points.map(point => point.opsPerSecond)),
    medianOfRunQuantilesMs: {
      p50: median(points.map(point => point.latencyMs.p50)), p95: median(points.map(point => point.latencyMs.p95)),
      p99: median(points.map(point => point.latencyMs.p99)),
    }, rawOpsPerSecond: points.map(point => point.opsPerSecond) };
}

function comparison(name: string, baseline: Point[], candidate: Point[]) {
  const before = summarize(baseline);
  const after = summarize(candidate);
  return { name, baseline: before, candidate: after, throughputRatio: after.medianOpsPerSecond / before.medianOpsPerSecond };
}

const baselineCore = [1, 2, 3].map(repeat => load<CoreReport>(`baseline-${repeat}-core.json`));
const candidateCore = [1, 2, 3].map(repeat => load<CoreReport>(`candidate-${repeat}-core.json`));
const context = { baseline: [1, 2, 3].map(repeat => load<{ results: ContextPoint[] }>(`baseline-${repeat}-context.json`)),
  candidate: [1, 2, 3].map(repeat => load<{ results: ContextPoint[] }>(`candidate-${repeat}-context.json`)) };
const policy = { baseline: [1, 2, 3].map(repeat => load<{ results: PolicyPoint[] }>(`baseline-${repeat}-policy.json`)),
  candidate: [1, 2, 3].map(repeat => load<{ results: PolicyPoint[] }>(`candidate-${repeat}-policy.json`)) };
const admin = { baseline: [1, 2, 3].map(repeat => load<{ ok: boolean; measurements: AdminPoint[] }>(`baseline-${repeat}-admin.json`)),
  candidate: [1, 2, 3].map(repeat => load<{ ok: boolean; measurements: AdminPoint[] }>(`candidate-${repeat}-admin.json`)) };
assert([...admin.baseline, ...admin.candidate].every(report => report.ok && report.measurements.every(point => point.errorCount === 0)));
assert([...baselineCore, ...candidateCore].every(report => report.burst.accepted === 256 && report.burst.rejected === 44));
const comparisons = [];
for (let index = 0; index < baselineCore[0].scenarios.length; index++) {
  const reference = baselineCore[0].scenarios[index];
  comparisons.push(comparison(`core:${reference.name}:unrelated=${reference.unrelatedFeatures}`,
    baselineCore.map(report => report.scenarios[index]), candidateCore.map(report => report.scenarios[index])));
}
for (let index = 0; index < context.baseline[0].results.length; index++) {
  const reference = context.baseline[0].results[index];
  const convert = (point: ContextPoint): Point => ({ operations: point.ops, opsPerSecond: point.opsPerSecond,
    latencyMs: { p50: point.p50Ms, p95: point.p95Ms, p99: point.p99Ms } });
  comparisons.push(comparison(`context:${reference.scenario}:preferences=${reference.preferences}`,
    context.baseline.map(report => convert(report.results[index])), context.candidate.map(report => convert(report.results[index]))));
}
for (let index = 0; index < policy.baseline[0].results.length; index++) {
  const reference = policy.baseline[0].results[index];
  const convert = (point: PolicyPoint): Point => ({ operations: point.ops, opsPerSecond: point.opsPerSecond,
    latencyMs: { p50: point.p50, p95: point.p95, p99: point.p99 } });
  comparisons.push(comparison(`policy:${reference.scenario}:grants=${reference.grants}`,
    policy.baseline.map(report => convert(report.results[index])), policy.candidate.map(report => convert(report.results[index]))));
}
for (let index = 0; index < admin.baseline[0].measurements.length; index++) {
  const reference = admin.baseline[0].measurements[index];
  const convert = (point: AdminPoint): Point => ({ ...point, operations: point.requests });
  comparisons.push({ ...comparison(`admin:${reference.route}:concurrency=${reference.concurrency}`,
    admin.baseline.map(report => convert(report.measurements[index])), admin.candidate.map(report => convert(report.measurements[index]))),
  errors: 0, responseBytesPerRun: reference.responseBytes });
}

const sourceDigests: Record<string, string> = {};
function digestSources(directoryName: string) {
  for (const entry of readdirSync(new URL(directoryName, sourceRoot), { withFileTypes: true })) {
    const relative = `${directoryName}/${entry.name}`;
    if (entry.isDirectory()) digestSources(relative);
    else if (entry.name.endsWith('.ts')) sourceDigests[relative] = createHash('sha256').update(readFileSync(new URL(relative, sourceRoot))).digest('hex');
  }
}
for (const name of ['src', 'test', 'scripts']) digestSources(name);
const output = {
  iteration: '002', recordedAt: new Date().toISOString(), baselineCommit: readFileSync(new URL('baseline-commit.txt', directory), 'utf8').trim(),
  environment: { node: baselineCore[0].node, platform: baselineCore[0].platform, architecture: baselineCore[0].architecture,
    cpu: baselineCore[0].cpu, reportedParallelism: baselineCore[0].availableParallelism, isolatedMachine: false },
  method: { repeats: 3, ordering: ['baseline,candidate', 'candidate,baseline', 'baseline,candidate'],
    aggregation: 'Median of three fresh-process runs; reported percentiles are medians of run percentiles, not pooled quantiles.',
    clientAndServerShareProcess: true, productionTraffic: false, contextOps: 100, contextWarmup: 10,
    disclaimer: 'Short offline synthetic workloads. No production SLA, statistical significance, or long-duration leak claim.' },
  comparisons,
  coreResources: baselineCore[0].scenarios.map((reference, index) => {
    const select = (reports: CoreReport[]) => reports.map(report => {
      const point = report.scenarios[index];
      return { operations: point.operations, cpuMs: point.cpuMs, heapDeltaBytesAfterGc: point.heapDeltaBytesAfterGc,
        rssDeltaBytes: point.rssDeltaBytes, stateNamespaces: point.stateNamespaces, timerTicks: point.timerTicks };
    });
    return { name: reference.name, unrelatedFeatures: reference.unrelatedFeatures,
      baselineRuns: select(baselineCore), candidateRuns: select(candidateCore) };
  }),
  overload: { attempted: 300, accepted: 256, rejected: 44, reason: 'EVENT_BACKPRESSURE' },
  fairness: { baselineTimerTicks: baselineCore.map(report => report.scenarios[0].timerTicks),
    candidateTimerTicks: candidateCore.map(report => report.scenarios[0].timerTicks) },
  sendIsolation: { simulatedSlowPeerMs: 80, defaultGlobalMedianFastPeerMs: median(baselineCore.map(report => report.slowPeer.fastPeerLatencyMs)),
    candidateDefaultMedianFastPeerMs: median(candidateCore.map(report => report.slowPeer.fastPeerLatencyMs)),
    candidateExplicitConcurrency4MedianFastPeerMs: median([1, 2, 3].map(repeat => load<CoreReport>(`parallel-${repeat}.json`).slowPeer.fastPeerLatencyMs)) },
  observation: { fullSnapshotMedianOpsPerSecond: median(candidateCore.map(report => report.observation.samples[0].opsPerSecond!)),
    countMetricsMedianOpsPerSecond: median(candidateCore.map(report => report.observation.samples[1].opsPerSecond!)),
    equivalentPayload: false },
  soak: { baseline: load<SoakReport>('soak-baseline-formal.json'), candidate: load<SoakReport>('soak-candidate.json') },
  sha256: { source: sourceDigests, rawMeasurements: rawDigests },
};
console.log(JSON.stringify(output, null, 2));
