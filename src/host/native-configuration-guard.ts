import { performance } from 'node:perf_hooks';
import type { NativeDeploymentPresetBinding } from '../contracts/native-deployment.ts';
import type { ChatSessionDefinition } from '../contracts/chat-session.ts';
import { FrameworkError, snapshot } from '../core/values.ts';
import type { NativeChatConfiguration } from './native-chat-configuration.ts';
import { analyzeNativeConfigurationImpact } from './native-configuration-impact.ts';

export type NativeGuardPhase = 'operation' | 'admission' | 'submit' | 'delivery' | 'resource' | 'interaction' | 'protocol';
interface GuardGeneration {
  readonly state: string;
  readonly signal?: AbortSignal;
  readonly configuration?: NativeChatConfiguration;
  readonly bindings: readonly NativeDeploymentPresetBinding[];
}
/** Message boundaries read current local authority. Full DSH verification belongs to start/apply. */
export function createNativeConfigurationGuard(options: {
  readonly current: () => GuardGeneration;
  readonly loadConfiguration: () => Promise<NativeChatConfiguration>;
  readonly definition: (configuration: NativeChatConfiguration) => ChatSessionDefinition | null;
  readonly resolveDeployment: (configuration: NativeChatConfiguration, definition: ChatSessionDefinition) => Promise<{
    readonly missingReasons: readonly string[]; readonly presetBindings: readonly NativeDeploymentPresetBinding[];
  }>;
}) {
  const pending = new Set<Promise<void>>();
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
    check(conversationId: string, signal: AbortSignal, _recheckConfiguration = false, phase: NativeGuardPhase = 'operation'): Promise<void> {
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
      })().catch(error => { metrics.failures++; throw error; }).finally(() => {
        const elapsed = performance.now() - began;
        metrics.totalMs += elapsed; metrics.maxMs = Math.max(metrics.maxMs, elapsed);
      });
      pending.add(operation);
      void operation.catch(() => undefined).finally(() => pending.delete(operation));
      return operation;
    },
    describe() { return snapshot({ schema: 1, inFlight: pending.size, permissionCaching: false,
      deploymentVerification: 'startup-and-apply' as const, coalescedReads: 0, activeDeploymentReads: 0, phases }); },
    async drain() { await Promise.allSettled([...pending]); },
  });
}
