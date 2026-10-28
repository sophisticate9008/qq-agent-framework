import type { PluginCapabilityClient } from './plugin-capability-service.ts'
import type { PluginModelClient } from '../contracts/plugin-model.ts'
import type { SessionBinding } from '../contracts/ports.ts'
import type { NativeSessionResetTarget } from './native-session-management.ts'
import type { NativeImageReferenceReader } from '../contracts/native-media.ts'
import type { PluginSchedulerClient } from './plugin-scheduler.ts'
import type { PluginToolDirectoryClient } from './plugin-tool-directory.ts'

/** Supplied only to loaded trusted code, never reconstructed from a model's arguments. */
export interface PluginRuntimeServices {
  readonly scheduler?: PluginSchedulerClient
  readonly tools?: PluginToolDirectoryClient
  readonly capabilities: PluginCapabilityClient
  readonly models: PluginModelClient
  readonly media?: NativeImageReferenceReader
  readonly sessions: {
    resolve(conversationId: string): (SessionBinding & { readonly target: NativeSessionResetTarget }) | null
    bind(target: NativeSessionResetTarget, sessionId: string, signal?: AbortSignal): Promise<unknown>
    unbind(target: NativeSessionResetTarget): Promise<unknown>
  }
}
