import { performance } from 'node:perf_hooks';
import type { NativeDeploymentPresetBinding } from '../contracts/native-deployment.ts';
import type { ChatSessionDefinition } from '../contracts/chat-session.ts';
import { FrameworkError, snapshot } from '../core/values.ts';
import type { NativeChatConfiguration } from './native-chat-configuration.ts';
import { analyzeNativeConfigurationImpact } from './native-configuration-impact.ts';
import { digest } from './data.ts';

export type NativeGuardPhase = 'operation' | 'admission' | 'submit' | 'delivery' | 'resource' | 'interaction' | 'protocol';
interface GuardGeneration {
  readonly state: string;
  readonly signal?: AbortSignal;
  readonly configuration?: NativeChatConfiguration;
  readonly bindings: readonly NativeDeploymentPresetBinding[];
}
/** Every side-effect boundary rechecks authority. Measurements do not introduce a permission cache. */
export function createNativeConfigurationGuard(options: {
  readonly current: () => GuardGeneration;
  readonly loadConfiguration: () => Promise<NativeChatConfiguration>;
  readonly definition: (configuration: NativeChatConfiguration) => ChatSessionDefinition | null;
  readonly resolveDeployment: (configuration: NativeChatConfiguration, definition: ChatSessionDefinition) => Promise<{
    readonly missingReasons: readonly string[]; readonly presetBindings: readonly NativeDeploymentPresetBinding[];
  }>;
}) {
  const pending = new Set<Promise<void>>();
  type Deployment = Awaited<ReturnType<typeof options.resolveDeployment>>;
  const deploymentReads = new WeakMap<AbortSignal, Map<string, Promise<Deployment>>>();
  let coalescedReads = 0;
  let activeDeploymentReads = 0;
  const phases = Object.fromEntries(['operation', 'admission', 'submit', 'delivery', 'resource', 'interaction', 'protocol']
    .map(phase => [phase, { calls: 0, failures: 0, configurationReads: 0, deploymentReads: 0, totalMs: 0, maxMs: 0 }])) as
    Record<NativeGuardPhase, { calls: number; failures: number; configurationReads: number; deploymentReads: number; totalMs: number; maxMs: number }>;
  function failure(code: string): never { throw new FrameworkError(code, 'Current configuration authority could not be verified.'); }
  function allowed(configuration: NativeChatConfiguration, conversationId: string) {
    return configuration.access.allow.includes(conversationId) && !configuration.access.deny.includes(conversationId);
  }
  function verifyGeneration(initial: GuardGeneration, signal: AbortSignal) {
    const current = options.current();
    if (!initial.signal || initial.signal.aborted || signal.aborted || current.signal !== initial.signal
      || !['starting', 'running'].includes(current.state)) failure('NATIVE_CHAT_STOPPED');
  }
  return Object.freeze({
    check(conversationId: string, signal: AbortSignal, recheckConfiguration = false, phase: NativeGuardPhase = 'operation'): Promise<void> {
      const metrics = phases[phase];
      metrics.calls++;
      const began = performance.now();
      const initial = options.current();
      const operation = (async () => {
        verifyGeneration(initial, signal);
        metrics.configurationReads++;
        const latest = await options.loadConfiguration();
        verifyGeneration(initial, signal);
        const active = initial.configuration;
        if (!active || !analyzeNativeConfigurationImpact(active, latest).canContinue) failure('NATIVE_CHAT_CONFIGURATION_CHANGED');
        if (!allowed(active, conversationId) || !allowed(latest, conversationId)) failure('NATIVE_CHAT_ACCESS_DENIED');
        const definition = options.definition(latest);
        if (!definition) failure('NATIVE_CHAT_CONFIGURATION_CHANGED');
        let reads = deploymentReads.get(initial.signal!);
        if (!reads) { reads = new Map(); deploymentReads.set(initial.signal!, reads); }
        // Share only an unfinished read for exactly the same observed inputs and runtime lifetime.
        // Every caller still reads current configuration and checks its own conversation authority.
        const key = digest({ configuration: latest, definition, bindings: initial.bindings });
        let deploymentRead = reads.get(key);
        if (deploymentRead) coalescedReads++;
        else {
          metrics.deploymentReads++;
          deploymentRead = Promise.resolve().then(() => options.resolveDeployment(latest, definition));
          if (reads.size < 32) {
            reads.set(key, deploymentRead); activeDeploymentReads++;
            const current = reads;
            void deploymentRead.finally(() => { current.delete(key); activeDeploymentReads--; }).catch(() => undefined);
          }
        }
        const deployment = await deploymentRead;
        verifyGeneration(initial, signal);
        if (deployment.missingReasons.length > 0 || deployment.presetBindings.length === 0
          || !analyzeNativeConfigurationImpact(active, latest, { previousBindings: initial.bindings,
            nextBindings: deployment.presetBindings }).canContinue) failure('NATIVE_CHAT_DEPLOYMENT_CHANGED');
        if (recheckConfiguration || ['submit', 'delivery', 'resource', 'interaction'].includes(phase)) {
          metrics.configurationReads++;
          const final = await options.loadConfiguration();
          verifyGeneration(initial, signal);
          if (!analyzeNativeConfigurationImpact(active, final).canContinue) failure('NATIVE_CHAT_CONFIGURATION_CHANGED');
          if (!allowed(active, conversationId) || !allowed(final, conversationId)) failure('NATIVE_CHAT_ACCESS_DENIED');
        }
      })().catch(error => { metrics.failures++; throw error; }).finally(() => {
        const elapsed = performance.now() - began;
        metrics.totalMs += elapsed; metrics.maxMs = Math.max(metrics.maxMs, elapsed);
      });
      pending.add(operation);
      void operation.catch(() => undefined).finally(() => pending.delete(operation));
      return operation;
    },
    describe() { return snapshot({ schema: 1, inFlight: pending.size, permissionCaching: false,
      coalescedReads, activeDeploymentReads, phases }); },
    async drain() { await Promise.allSettled([...pending]); },
  });
}
