import { FrameworkError, isRecord } from '../core/values.ts'
import { NATIVE_ASSISTANT_DEPLOYMENT_PATH, type NativeAssistantDeploymentRequest } from '../contracts/native-assistant-target.ts'
import { NATIVE_REVISION_PATTERN } from '../contracts/native-revisions.ts'
import type { NativeAssistantTarget } from '../host/native-assistant-target.ts'
import { AdminRequestError, type AdminRoute } from './server.ts'

function invalid(): never { throw new AdminRequestError(400, 'invalid_assistant_deployment') }
function exact(input: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(input).length === keys.length && keys.every(key => Object.hasOwn(input, key)) }
async function operation<Value>(run: () => Promise<Value>, signal: AbortSignal): Promise<Value> {
  try { return await run() }
  catch (error) {
    if (error instanceof AdminRequestError) throw error
    if (signal.aborted) throw new AdminRequestError(499, 'request_aborted')
    if (error instanceof FrameworkError) {
      if (['ASSISTANT_CONFIGURATION_CONFLICT', 'ASSISTANT_DEPLOYMENT_CONFLICT', 'ASSISTANT_DEPLOYMENT_BUSY',
        'ASSISTANT_DEPLOYMENT_RECONCILIATION_REQUIRED', 'ASSISTANT_DEPLOYMENT_PREVIEW_REQUIRED', 'ASSISTANT_DEPLOYMENT_REQUIRES_STOPPED'].includes(error.code))
        throw new AdminRequestError(409, error.code.toLowerCase())
    }
    throw new AdminRequestError(503, 'assistant_deployment_unavailable')
  }
}
export function createNativeAssistantDeploymentRoutes(options: {
  readonly target: NativeAssistantTarget
  readonly runExclusive?: <Value>(run: () => Promise<Value>) => Promise<Value>
}): readonly AdminRoute[] {
  function exclusive<Value>(run: () => Promise<Value>): Promise<Value> { return options.runExclusive ? options.runExclusive(run) : run() }
  const routes: AdminRoute[] = [{ method: 'GET', pathname: NATIVE_ASSISTANT_DEPLOYMENT_PATH,
    handle({ query, signal }) { if (query.size !== 0) invalid(); return operation(() => options.target.status(signal), signal) } }]
  for (const action of ['prepare', 'apply', 'reconcile'] as const) routes.push({ method: 'POST', pathname: `${NATIVE_ASSISTANT_DEPLOYMENT_PATH}/${action}`,
    handle({ query, body, signal }) {
      const keys = action === 'prepare' ? ['assistantRevision'] : ['assistantRevision', 'configurationRevision', 'operationRevision', ...(action === 'apply' ? ['targetRevision'] : [])]
      if (query.size !== 0 || !isRecord(body) || !exact(body, keys)
        || keys.some(key => typeof body[key] !== 'string' || !NATIVE_REVISION_PATTERN.test(String(body[key])))) invalid()
      if (action === 'prepare') return operation(() => exclusive(() => options.target.prepare(String(body.assistantRevision), signal)), signal)
      const request = body as unknown as NativeAssistantDeploymentRequest
      return operation(() => exclusive(() => action === 'apply' ? options.target.apply(request, signal) : options.target.reconcile(request, signal)), signal)
    } })
  return Object.freeze(routes)
}
