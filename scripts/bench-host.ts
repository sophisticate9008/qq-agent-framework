import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { createContextStore } from '../src/core/context.ts';
import type { DeliveryReceipt, SendRequest, TransportAdapter } from '../src/core/types.ts';
import { createBridgeHost } from '../src/host/bridge.ts';
import type { AgentAdapter, AgentEvent, InboundMessage } from '../src/host/types.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

const CONVERSATION_COUNT = 10;
const TASK_PAGE_LIMIT = 1_000;
const HISTORY_LIMIT = 100;

function iterationsFromEnvironment(): number {
  const raw = process.env.BENCH_ITERATIONS ?? '200';
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 100 || value > 2_000) {
    throw new Error('BENCH_ITERATIONS must be an integer between 100 and 2000.');
  }
  return value;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function percentile(sorted: readonly number[], fraction: number): number {
  const value = sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  if (value === undefined) throw new Error('No latency samples were collected.');
  return round(value);
}

function bytes(filename: string): number {
  return existsSync(filename) ? statSync(filename).size : 0;
}

function statusCounts(items: readonly { status: unknown }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const status = String(item.status);
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function collectCursorPages<Item extends { cursor: string }>(
  list: (options: { limit: number; after?: string }) => readonly Item[]
): Item[] {
  const items: Item[] = [];
  let after: string | undefined;
  do {
    const page = list(after === undefined ? { limit: TASK_PAGE_LIMIT } : { limit: TASK_PAGE_LIMIT, after });
    items.push(...page);
    after = page.at(-1)?.cursor;
    if (page.length < TASK_PAGE_LIMIT) break;
  } while (after !== undefined);
  return items;
}

class FakeAgent implements AgentAdapter {
  private readonly listeners = new Map<string, (event: AgentEvent) => void | Promise<void>>();
  private created = 0;

  async createSession(): Promise<{ sessionId: string }> {
    this.created += 1;
    return { sessionId: `bench-session-${this.created}` };
  }

  async submit(): Promise<{ status: 'accepted' }> {
    return { status: 'accepted' };
  }

  async follow(request: Parameters<AgentAdapter['follow']>[0]): Promise<() => void> {
    this.listeners.set(request.sessionId, request.onEvent);
    return () => {
      if (this.listeners.get(request.sessionId) === request.onEvent) this.listeners.delete(request.sessionId);
    };
  }

  async emit(sessionId: string, event: Omit<AgentEvent, 'sessionId'>): Promise<void> {
    const listener = this.listeners.get(sessionId);
    if (!listener) throw new Error(`Missing follow listener for ${sessionId}.`);
    await listener({ ...event, sessionId });
  }
}

class FakeTransport implements TransportAdapter {
  confirmed = 0;

  async send(_request: SendRequest): Promise<DeliveryReceipt> {
    this.confirmed += 1;
    return { status: 'confirmed', messageId: `bench-message-${this.confirmed}` };
  }
}

async function waitForConfirmation(
  host: ReturnType<typeof createBridgeHost>,
  transport: FakeTransport,
  expected: number
): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await host.tasks.runDue({ limit: 100 });
    if (transport.confirmed === expected) return;
    await nextTurn();
  }
  throw new Error('The simulated delivery did not reach a confirmed durable state.');
}

async function exercise(
  host: ReturnType<typeof createBridgeHost>,
  agent: FakeAgent,
  transport: FakeTransport,
  phase: 'warmup' | 'measure',
  ordinal: number
): Promise<void> {
  const conversationId = `bench:${ordinal % CONVERSATION_COUNT}`;
  const inbound: InboundMessage = {
    id: `${phase}-inbound-${ordinal}`,
    conversationId,
    userId: 'bench-user',
    receivedAt: Date.now(),
    content: [{ type: 'text', text: `synthetic inbound ${phase} ${ordinal}` }],
    directed: true,
    isSelf: false
  };
  const receipt = await host.receive(inbound);
  if (receipt.status !== 'accepted') throw new Error(`Unexpected ingress status: ${receipt.status}.`);
  const binding = host.sessions.get(conversationId);
  if (!binding) throw new Error(`Missing session binding for ${conversationId}.`);
  const expected = transport.confirmed + 1;
  await agent.emit(binding.sessionId, {
    id: `${phase}-agent-${ordinal}`,
    type: 'message',
    content: [{ type: 'text', text: `synthetic agent event ${phase} ${ordinal}` }]
  });
  await waitForConfirmation(host, transport, expected);
  await nextTurn();
}

async function main(): Promise<void> {
  const iterations = iterationsFromEnvironment();
  const warmup = Math.min(50, Math.max(20, Math.floor(iterations / 10)));
  const directory = mkdtempSync(join(tmpdir(), 'qq-agent-bench-host-'));
  const filename = join(directory, 'host.sqlite');
  const store = createSqliteStore({ filename });
  const agent = new FakeAgent();
  const transport = new FakeTransport();
  const context = createContextStore();
  const persona = context.registerPersona({
    id: 'host-benchmark',
    version: '1.0.0',
    name: 'Host Benchmark',
    identity: {},
    style: {}
  });
  const host = createBridgeHost({
    store,
    agent,
    transport,
    context,
    persona,
    authorizeIncoming: () => true,
    taskTickMs: 60_000
  });
  const loopDelay = monitorEventLoopDelay({ resolution: 1 });
  let output: unknown;

  try {
    const operationCount = warmup + iterations;
    const perConversationBudget = Math.ceil(operationCount / CONVERSATION_COUNT);
    for (let ordinal = 0; ordinal < CONVERSATION_COUNT; ordinal += 1) {
      const conversationId = `bench:${ordinal}`;
      host.policy.grant({
        id: `bench-relay-${ordinal}`,
        featureId: 'agent-relay',
        conversationId,
        capabilities: ['agent.submit', 'messaging.send'],
        maxUses: {
          'agent.submit': perConversationBudget,
          'messaging.send': perConversationBudget
        }
      });
    }
    await host.start();
    for (let ordinal = 0; ordinal < warmup; ordinal += 1) {
      await exercise(host, agent, transport, 'warmup', ordinal);
    }

    loopDelay.enable();
    loopDelay.reset();
    const memoryBefore = process.memoryUsage();
    const cpuBefore = process.cpuUsage();
    const samples: number[] = [];
    const started = performance.now();
    for (let ordinal = 0; ordinal < iterations; ordinal += 1) {
      const operationStarted = performance.now();
      await exercise(host, agent, transport, 'measure', ordinal);
      samples.push(performance.now() - operationStarted);
    }
    const elapsedMs = performance.now() - started;
    const cpu = process.cpuUsage(cpuBefore);
    const memoryAfter = process.memoryUsage();
    loopDelay.disable();
    samples.sort((left, right) => left - right);

    const tasks = collectCursorPages(host.tasks.list);
    const outbox = collectCursorPages(host.outbox.list);
    const sessions = host.sessions.list({ limit: 1_000 });
    const histories = Array.from({ length: CONVERSATION_COUNT }, (_, ordinal) => {
      const conversationId = `bench:${ordinal}`;
      return { conversationId, ...host.history.snapshot(conversationId, { afterSequence: 0, limit: HISTORY_LIMIT }) };
    });
    const policy = host.policy.describe();
    const grants = policy.grants.map(grant => ({
      id: grant.id,
      used: Object.values(grant.used).reduce((total, used) => total + used, 0),
      budget: Object.values(grant.maxUses).reduce<number | null>((total, maximum) =>
        total === null || maximum === null ? null : total + maximum, 0)
    }));
    const hostMetrics = host.metrics();
    await host.stop();

    const loopSamples = loopDelay.count;
    const nanosecondsToMilliseconds = (value: number): number | null => loopSamples === 0 ? null : round(value / 1_000_000);
    output = {
      benchmark: 'persistent-bridge-host',
      ok: true,
      node: process.version,
      mode: 'bounded offline simulation',
      limitations: [
        'Uses in-process fake agent and transport adapters with no network I/O.',
        'Measures this framework host path and is not a comparison with an older bridge.',
        'Confirmed fake receipts do not model gateway latency, rate limits, or ambiguous remote outcomes.'
      ],
      workload: {
        iterations,
        warmup,
        conversations: CONVERSATION_COUNT,
        explicitRelayGrants: grants.length
      },
      latencyMs: {
        p50: percentile(samples, 0.50),
        p95: percentile(samples, 0.95),
        p99: percentile(samples, 0.99)
      },
      elapsedMs: round(elapsedMs),
      throughputPerSecond: round(iterations * 1_000 / elapsedMs),
      cpuMs: {
        user: round(cpu.user / 1_000),
        system: round(cpu.system / 1_000),
        total: round((cpu.user + cpu.system) / 1_000)
      },
      rssBytes: {
        before: memoryBefore.rss,
        after: memoryAfter.rss,
        delta: memoryAfter.rss - memoryBefore.rss
      },
      eventLoopDelayMs: {
        samples: loopSamples,
        mean: nanosecondsToMilliseconds(loopDelay.mean),
        max: nanosecondsToMilliseconds(loopDelay.max),
        p50: nanosecondsToMilliseconds(loopDelay.percentile(50)),
        p95: nanosecondsToMilliseconds(loopDelay.percentile(95)),
        p99: nanosecondsToMilliseconds(loopDelay.percentile(99))
      },
      sqliteBytesBeforeClose: {
        database: bytes(filename),
        wal: bytes(`${filename}-wal`),
        sharedMemory: bytes(`${filename}-shm`)
      },
      occupancy: {
        host: hostMetrics,
        sessions: { records: sessions.length, pageLimit: 1_000 },
        tasks: { records: tasks.length, statuses: statusCounts(tasks), pageLimit: TASK_PAGE_LIMIT, runBatchLimit: 100 },
        outbox: { records: outbox.length, statuses: statusCounts(outbox), pageLimit: TASK_PAGE_LIMIT },
        history: {
          retainedMessages: histories.reduce((total, history) => total + history.messages.length, 0),
          partialConversations: histories.filter(history => history.partial).length,
          maximumLatestSequence: Math.max(...histories.map(history => history.latestSequence)),
          maximumDroppedThrough: Math.max(...histories.map(history => history.droppedThrough)),
          perConversationRetentionLimit: HISTORY_LIMIT
        },
        grants
      },
      cleanup: { temporaryArtifactsRetained: false }
    };
  } finally {
    loopDelay.disable();
    await host.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }

  console.log(JSON.stringify(output));
}

main().catch(() => {
  console.log(JSON.stringify({ benchmark: 'persistent-bridge-host', ok: false, error: 'benchmark_failed' }));
  process.exitCode = 1;
});
