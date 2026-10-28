import { FrameworkError, errorCode } from '../core/values.ts'
import type { DshJsonRpcPort } from '../adapters/dsh-jsonrpc.ts'
import type { createBridgeHost } from './bridge.ts'
import type { createNativeReminderRuntime } from './native-reminder-runtime.ts'
import type { createNativeMemoryRuntime } from './native-memory-runtime.ts'
import type { createNativeQuotedContext } from './native-quoted-context.ts'
import type { createNativeInbox } from './native-inbox.ts'
import type { createNativeWorkExecutor } from './native-work.ts'
import type { createNativeWorkFeedback } from './native-work-feedback.ts'
import type { createNativeExecutionClaims } from './native-execution-claims.ts'
import type { createNativeExecutionController } from './native-execution.ts'
import type { NativeBootstrapMount } from './native-bootstrap.ts'
import type { createNativeFrameworkTools } from './native-framework-tools.ts'
import type { createNativePackages } from './native-packages.ts'

/** Preparation may fail at any point; one captured ownership set is drained in explicit phases. */
export interface NativePreparedRunResources {
  readonly scheduler?: { stop(): Promise<void> }
  readonly lifetime: AbortController | undefined
  readonly host: ReturnType<typeof createBridgeHost> | undefined
  readonly dsh: DshJsonRpcPort | undefined
  readonly work: ReturnType<typeof createNativeWorkExecutor> | undefined
  readonly workFeedback?: ReturnType<typeof createNativeWorkFeedback>
  readonly claims: ReturnType<typeof createNativeExecutionClaims> | undefined
  readonly executions: ReturnType<typeof createNativeExecutionController> | undefined
  readonly bootstrap: NativeBootstrapMount | undefined
  readonly tools: ReturnType<typeof createNativeFrameworkTools> | undefined
  readonly packages: ReturnType<typeof createNativePackages> | undefined
  readonly inbox: ReturnType<typeof createNativeInbox> | undefined
  readonly quotedContext: ReturnType<typeof createNativeQuotedContext> | undefined
  readonly reminders: Pick<ReturnType<typeof createNativeReminderRuntime>, 'stop'>
  readonly memory: Pick<ReturnType<typeof createNativeMemoryRuntime>, 'stop'>
  readonly releaseInteractions: (() => void) | undefined
  readonly closeInteractions: (() => Promise<void>) | undefined
  readonly claimTimer: ReturnType<typeof setInterval> | undefined
  readonly clearIngress: () => void
  readonly drainConfiguration: () => Promise<void>
  readonly drainPolicy: () => Promise<void>
}
export interface NativeRunningRunResources extends NativePreparedRunResources {
  readonly lifetime: AbortController
  readonly host: ReturnType<typeof createBridgeHost>
  readonly dsh: DshJsonRpcPort
  readonly executions: ReturnType<typeof createNativeExecutionController>
  readonly claims: ReturnType<typeof createNativeExecutionClaims>
  readonly packages: ReturnType<typeof createNativePackages>
  readonly inbox: ReturnType<typeof createNativeInbox>
}

export async function drainNativeRun(resources: NativePreparedRunResources) {
  const errors: unknown[] = []
  let packageUnknown = false
  let bootstrapUnknown = false
  async function phase(operations: readonly (() => unknown | Promise<unknown>)[]) {
    const results = await Promise.allSettled(operations.map(operation => Promise.resolve().then(operation)))
    for (const result of results) if (result.status === 'rejected') {
      errors.push(result.reason)
      const code = errorCode(result.reason)
      if (code.includes('BOOTSTRAP') && code.includes('UNKNOWN')) bootstrapUnknown = true
    }
  }
  resources.lifetime?.abort()
  if (resources.claimTimer) clearInterval(resources.claimTimer)
  // Stop producing work before draining consumers. Failure of one producer must not skip the rest.
  await phase([() => resources.scheduler?.stop(), () => resources.reminders.stop(), () => resources.releaseInteractions?.(),
    () => resources.memory.stop(), () => resources.quotedContext?.clear(), () => resources.inbox?.stop(), resources.clearIngress])
  await phase([() => resources.work?.close(new AbortController().signal), () => resources.workFeedback?.drain(), () => resources.claims?.drain(),
    () => resources.executions?.stop(), () => {
      const bootstrap = resources.bootstrap
      if (!bootstrap) return
      const metadata = bootstrap.metadata()
      if (metadata.state === 'prepared') return bootstrap.abandonPrepared()
      if (metadata.state === 'stopped' && !metadata.pendingStart && !metadata.pendingStop) return
      return resources.host ? bootstrap.stop(resources.host) : undefined
    },
    () => resources.tools?.close(new AbortController().signal), async () => {
      const states = await resources.packages?.stop()
      if (states?.some(item => item.state === 'unknown')) {
        packageUnknown = true
        throw new FrameworkError('NATIVE_CHAT_PACKAGE_STOP_UNKNOWN', 'Package cleanup is not confirmed.')
      }
    }])
  await phase([() => resources.closeInteractions?.(), () => resources.dsh?.close(), () => resources.host?.stop()])
  await phase([resources.drainConfiguration, resources.drainPolicy])
  const bootstrap = resources.bootstrap?.metadata()
  bootstrapUnknown ||= bootstrap?.pendingStart === true || bootstrap?.pendingStop === true
  return { errors, packageUnknown, bootstrapUnknown }
}
