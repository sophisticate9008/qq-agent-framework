const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Inspect the raw runtime response; retained activeRevisions are historical evidence. */
export function nativeRuntimeIsQuiescent(value: unknown): boolean {
  if (!record(value) || value.state !== 'stopped' || value.canApplyDeployment !== true
    || !record(value.lifecycleHooks) || !record(value.lifecycleHooks.manager) || value.lifecycleHooks.manager.pendingRaw !== 0
    || !record(value.lifecycleHooks.chat) || value.lifecycleHooks.chat.pendingRaw !== 0
    || !record(value.controlCommands) || value.controlCommands.pendingRaw !== 0 || value.controlCommands.inflight !== 0
    || !Array.isArray(value.packages) || value.packages.some(item => !record(item) || item.state === 'unknown')
    || value.bootstrap !== null && (!record(value.bootstrap) || value.bootstrap.state === 'unknown'
      || value.bootstrap.pendingStart === true || value.bootstrap.pendingStop === true || value.bootstrap.unsettledLifecycle === true)) return false
  if (value.execution !== undefined) {
    if (!record(value.execution)) return false
    const metrics = value.execution.metrics
    if (metrics !== null && (!record(metrics) || metrics.rawPending !== 0 || metrics.pendingActions !== 0)) return false
  }
  if (value.host !== null) {
    if (!record(value.host) || value.host.pendingIngress !== 0 || value.host.unsettledAuthorizations !== 0 || !record(value.host.engine)
      || !record(value.host.engine.queues) || value.host.engine.queues.pendingEvents !== 0 || value.host.engine.queues.pendingEffects !== 0
      || value.host.engine.queues.rawPendingEffects !== 0 || !record(value.host.engine.scheduling)
      || value.host.engine.scheduling.activeSends !== 0 || value.host.engine.scheduling.waitingSends !== 0) return false
  }
  return true
}
