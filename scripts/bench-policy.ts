import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type PolicyModule = typeof import('../src/core/policy.ts');
type Policy = ReturnType<PolicyModule['createPolicy']>;
interface Measurement {
  scenario: string;
  grants: number;
  ops: number;
  p50: number;
  p95: number;
  p99: number;
  elapsedMs: number;
  opsPerSecond: number;
}

const root = resolve(process.env.BENCH_ROOT ?? process.cwd());
const policyUrl = pathToFileURL(resolve(root, 'src/core/policy.ts')).href;
const policyModule: PolicyModule = await import(policyUrl);
const configuredOps = Number(process.env.BENCH_OPS ?? 1000);
if (!Number.isSafeInteger(configuredOps) || configuredOps <= 0) throw new Error('BENCH_OPS must be a positive integer.');

function percentile(sorted: readonly number[], proportion: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * proportion) - 1)] ?? 0;
}

function summarize(scenario: string, grants: number, durations: number[], elapsedMs: number): Measurement {
  const sorted = durations.toSorted((left, right) => left - right);
  return {
    scenario,
    grants,
    ops: durations.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    elapsedMs,
    opsPerSecond: durations.length * 1000 / elapsedMs,
  };
}

function measureAuthorized(grantCount: number): Measurement {
  const policy = policyModule.createPolicy();
  const warmupOps = Math.min(100, configuredOps);
  for (let index = 0; index < grantCount; index++) {
    policy.grant({
      id: `grant-${index}`,
      featureId: 'sample',
      conversationId: `demo:room-${index}`,
      capabilities: ['messaging.send'],
      maxUses: { 'messaging.send': index === grantCount - 1 ? configuredOps + warmupOps : 1 },
    });
  }
  const request = {
    featureId: 'sample',
    conversationId: `demo:room-${grantCount - 1}`,
    capability: 'messaging.send',
  };
  for (let index = 0; index < warmupOps; index++) policy.begin(policy.reserve(request));
  const durations: number[] = [];
  const elapsedStart = performance.now();
  for (let index = 0; index < configuredOps; index++) {
    const start = performance.now();
    policy.begin(policy.reserve(request));
    durations.push(performance.now() - start);
  }
  return summarize('authorized-distinct-conversations', grantCount, durations, performance.now() - elapsedStart);
}

function isBudgetExhausted(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'BUDGET_EXHAUSTED';
}

function reserveExhausted(policy: Policy, request: { featureId: string; conversationId: string; capability: string }): void {
  try {
    policy.reserve(request);
  } catch (error) {
    if (isBudgetExhausted(error)) return;
    throw error;
  }
  throw new Error('Expected an exhausted budget.');
}

function measureExhausted(grantCount: number): Measurement {
  const policy = policyModule.createPolicy();
  const request = { featureId: 'sample', conversationId: 'demo:shared', capability: 'messaging.send' };
  for (let index = 0; index < grantCount; index++) {
    policy.grant({
      id: `exhausted-${index}`,
      featureId: request.featureId,
      conversationId: request.conversationId,
      capabilities: [request.capability],
      maxUses: { [request.capability]: 0 },
    });
  }
  const warmupOps = Math.min(100, configuredOps);
  for (let index = 0; index < warmupOps; index++) reserveExhausted(policy, request);
  const durations: number[] = [];
  const elapsedStart = performance.now();
  for (let index = 0; index < configuredOps; index++) {
    const start = performance.now();
    reserveExhausted(policy, request);
    durations.push(performance.now() - start);
  }
  return summarize('exhausted-same-tuple', grantCount, durations, performance.now() - elapsedStart);
}

const results = [10, 1000, 10000].map(measureAuthorized);
results.push(measureExhausted(10000));
process.stdout.write(`${JSON.stringify({ root, results })}\n`);
