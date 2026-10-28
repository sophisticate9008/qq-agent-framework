import type { PluginCapabilityClient } from './plugin-capability-service.ts'
import type { PluginModelClient } from '../contracts/plugin-model.ts'
import type { SessionBinding } from '../contracts/ports.ts'
import type { NativeSessionResetTarget } from './native-session-management.ts'

/** Supplied only to loaded trusted code, never reconstructed from a model's arguments. */
export interface PluginRuntimeServices {
  readonly capabilities: PluginCapabilityClient
  readonly models: PluginModelClient
  readonly sessions: {
    resolve(conversationId: string): SessionBinding | null
    bind(target: NativeSessionResetTarget, sessionId: string, signal?: AbortSignal): Promise<unknown>
    unbind(target: NativeSessionResetTarget): Promise<unknown>
  }
}
