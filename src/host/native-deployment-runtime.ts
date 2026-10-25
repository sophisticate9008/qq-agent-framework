import { FrameworkError } from '../core/values.ts'
import { parseNativeDeploymentPreparationResult, parseNativeDeploymentApplyResult,
  parseNativeDeploymentReconciliationResult } from '../contracts/native-deployment.ts'
import type { NativeChatDeploymentRuntime, NativeChatDeploymentRuntimeInput, NativeChatConfiguration } from './native-chat-configuration.ts'

export const NATIVE_DEPLOYMENT_ERROR_CODES = Object.freeze({
  runtime: 'NATIVE_DEPLOYMENT_RUNTIME_INVALID',
  preparation: 'NATIVE_DEPLOYMENT_PREPARATION_INVALID',
  application: 'NATIVE_DEPLOYMENT_APPLICATION_INVALID',
  reconciliation: 'NATIVE_DEPLOYMENT_RECONCILIATION_INVALID'
} as const)

const checked = new WeakMap<NativeChatDeploymentRuntimeInput, NativeChatDeploymentRuntime>()

/** Integrations enter through this boundary, which also normalizes legacy schema-less results. */
export function checkedNativeDeploymentRuntime(input: NativeChatDeploymentRuntimeInput): NativeChatDeploymentRuntime {
  if (!input || !['prepare', 'apply', 'reconcile'].every(key => typeof Reflect.get(input, key) === 'function')) {
    throw new FrameworkError(NATIVE_DEPLOYMENT_ERROR_CODES.runtime, 'A native deployment runtime is required.')
  }
  const existing = checked.get(input)
  if (existing) return existing
  const fail = (code: string): never => { throw new FrameworkError(code, 'The deployment runtime returned an invalid result.') }
  const runtime: NativeChatDeploymentRuntime = Object.freeze({
    async prepare(configuration: NativeChatConfiguration) {
      return parseNativeDeploymentPreparationResult(await input.prepare(configuration)) ?? fail(NATIVE_DEPLOYMENT_ERROR_CODES.preparation)
    },
    async reconcile(configuration: NativeChatConfiguration) {
      return parseNativeDeploymentReconciliationResult(await input.reconcile(configuration)) ?? fail(NATIVE_DEPLOYMENT_ERROR_CODES.reconciliation)
    },
    async apply(configuration: NativeChatConfiguration, signal: AbortSignal, targetRevision?: string) {
      return parseNativeDeploymentApplyResult(await input.apply(configuration, signal, targetRevision)) ?? fail(NATIVE_DEPLOYMENT_ERROR_CODES.application)
    }
  })
  checked.set(input, runtime)
  checked.set(runtime, runtime)
  return runtime
}
