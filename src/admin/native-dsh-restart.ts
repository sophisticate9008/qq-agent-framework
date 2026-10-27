import { NATIVE_DSH_RESTART_PATH, parseNativeDshRestartRequest } from '../contracts/native-dsh-restart.ts'
import { isNativeApplicationId } from '../contracts/native-application.ts'
import { errorCode } from '../core/values.ts'
import type { createNativeDshRestartService } from '../host/native-dsh-restart.ts'
import { AdminRequestError, type AdminRoute } from './server.ts'

export function createNativeDshRestartRoutes(service: ReturnType<typeof createNativeDshRestartService>): AdminRoute[] {
  const error = (failure: unknown): never => {
    const code = errorCode(failure, 'DSH_RESTART_UNAVAILABLE')
    throw new AdminRequestError(/CONFIGURATION_CHANGED|BUSY|CONFLICT|RECONCILIATION_REQUIRED|NOT_QUIESCENT|SHARED|HISTORY_FULL|RETIRED|NOT_RECEIVED/.test(code) ? 409 : 503,
      code.toLowerCase())
  }
  return [{ method: 'GET', pathname: NATIVE_DSH_RESTART_PATH, async handle({ query }) {
    const id = query.get('id')
    if ([...query.keys()].some(key => key !== 'id') || query.getAll('id').length > 1 || id !== null && !isNativeApplicationId(id)) {
      throw new AdminRequestError(400, 'invalid_dsh_restart_query')
    }
    return service.read(id ?? undefined)
  } }, { method: 'POST', pathname: NATIVE_DSH_RESTART_PATH, async handle({ body, query, signal }) {
    const request = parseNativeDshRestartRequest(body)
    if (query.size !== 0 || !request || request.deleteSession) throw new AdminRequestError(400, 'invalid_dsh_restart_request')
    signal.throwIfAborted()
    try { return await service.create(request) } catch (failure) { return error(failure) }
  } }, { method: 'POST', pathname: `${NATIVE_DSH_RESTART_PATH}/reconcile`, async handle({ body, query, signal }) {
    if (query.size !== 0 || !body || Object.keys(body).length !== 1 || !isNativeApplicationId(body.operationId)) {
      throw new AdminRequestError(400, 'invalid_dsh_restart_request')
    }
    signal.throwIfAborted()
    try { return await service.reconcile(body.operationId) } catch (failure) { return error(failure) }
  } }]
}
