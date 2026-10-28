import { parseSimulationSessionResetRequest } from '../contracts/simulation-sessions.ts'
import { errorCode } from '../core/values.ts'
import { createSimulationSessionManagement } from '../host/simulation-sessions.ts'
import { AdminRequestError, type AdminRoute } from './server.ts'

export function createSimulationSessionRoutes(sourceDirectory: string): readonly AdminRoute[] {
  const service = createSimulationSessionManagement({ sourceDirectory })
  return [{ method: 'GET', pathname: '/api/chat/simulations/sessions', maxResponseBytes: 4_194_304,
    async handle({ query, signal }) {
      if (query.size !== 0) throw new AdminRequestError(400, 'invalid_simulation_session_query')
      try { return await service.list(signal) }
      catch {
        if (signal.aborted) throw new AdminRequestError(499, 'request_aborted')
        throw new AdminRequestError(503, 'simulation_sessions_unavailable')
      }
    },
  }, { method: 'POST', pathname: '/api/chat/simulations/sessions/reset', maxRequestBytes: 4096,
    async handle({ query, body, signal }) {
      const target = parseSimulationSessionResetRequest(body)
      if (query.size !== 0 || !target) throw new AdminRequestError(400, 'invalid_simulation_session_reset')
      try { return await service.reset(target, signal) }
      catch (error) {
        if (signal.aborted) throw new AdminRequestError(499, 'request_aborted')
        const code = errorCode(error, 'SIMULATION_SESSION_RESET_UNAVAILABLE')
        throw new AdminRequestError(/INVALID_TARGET/.test(code) ? 400 : /NOT_FOUND/.test(code) ? 404
          : /BUSY|CONFLICT|NOT_STOPPED|EXECUTION_UNSETTLED/.test(code) ? 409
          : /UNKNOWN/.test(code) ? 504 : 503, code.toLowerCase())
      }
    },
  }]
}
