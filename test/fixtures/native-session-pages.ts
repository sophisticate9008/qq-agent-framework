import type { createBridgeHost } from '../../src/host/bridge.ts'

export const NATIVE_SESSION_PAGE_FIXTURE_COUNT = 205

export function bindSyntheticPaginationSessions(host: ReturnType<typeof createBridgeHost>, count = NATIVE_SESSION_PAGE_FIXTURE_COUNT) {
  const bindings = Array.from({ length: count }, (_unused, index) => host.sessions.bind(
    `private:${10_000 + index}`, `pagination-session-${index + 1}`))
  return { count, conversationIds: bindings.map(binding => binding.conversationId).sort(), bindings }
}
