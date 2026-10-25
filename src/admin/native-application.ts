import { NATIVE_APPLICATION_PATH, isNativeApplicationId, parseNativeApplicationRequest } from '../contracts/native-application.ts';
import { errorCode } from '../core/values.ts';
import { createNativeApplicationCoordinator, type NativeApplicationPorts } from '../host/native-application.ts';
import type { NativeChatRuntime } from '../host/native-chat-runtime.ts';
import { createNativeApplicationStorage } from '../storage/native-application.ts';
import { AdminRequestError, type AdminRoute } from './server.ts';

const services = new WeakMap<NativeChatRuntime, ReturnType<typeof createNativeApplicationCoordinator>>();
export function createNativeApplicationRoutes(options: {
  readonly directory: string;
  readonly runtime: NativeChatRuntime;
  readonly ports: NativeApplicationPorts;
}): AdminRoute[] {
  let service = services.get(options.runtime);
  if (!service) {
    service = createNativeApplicationCoordinator({ storage: createNativeApplicationStorage(options.directory),
      ports: options.ports, signal: options.runtime.applicationSignal() });
    services.set(options.runtime, service);
  }
  const coordinator = service;
  return [{ method: 'GET', pathname: NATIVE_APPLICATION_PATH, async handle({ query }) {
    if (options.runtime.isClosed()) throw new AdminRequestError(503, 'application_closed');
    const id = query.get('id');
    if ([...query.keys()].some(key => key !== 'id') || query.getAll('id').length > 1
      || id !== null && !isNativeApplicationId(id)) throw new AdminRequestError(400, 'invalid_application_query');
    return { schema: 1, operation: await coordinator.read(id ?? undefined) };
  } }, { method: 'POST', pathname: NATIVE_APPLICATION_PATH, async handle({ query, body, signal }) {
    if ([...query.keys()].length > 0) throw new AdminRequestError(400, 'invalid_application_query');
    const request = parseNativeApplicationRequest(body);
    if (!request) throw new AdminRequestError(400, 'invalid_application_request');
    signal.throwIfAborted();
    try { return { schema: 1, operation: await coordinator.create(request) }; }
    catch (error) {
      const code = errorCode(error, 'APPLICATION_UNAVAILABLE');
      if (['APPLICATION_BUSY', 'APPLICATION_ID_CONFLICT', 'APPLICATION_CONFIGURATION_CHANGED',
        'APPLICATION_RECONCILIATION_REQUIRED', 'APPLICATION_HISTORY_FULL'].includes(code)) {
        throw new AdminRequestError(409, code.toLowerCase());
      }
      throw new AdminRequestError(503, 'application_unavailable');
    }
  } }, { method: 'POST', pathname: `${NATIVE_APPLICATION_PATH}/reconcile`, async handle({ query, body, signal }) {
    if (query.size !== 0 || !body || Object.keys(body).length !== 1 || !isNativeApplicationId(body.operationId)) {
      throw new AdminRequestError(400, 'invalid_application_request');
    }
    signal.throwIfAborted();
    try { return { schema: 1, operation: await coordinator.reconcile(body.operationId) }; }
    catch (error) {
      const code = errorCode(error, 'APPLICATION_UNAVAILABLE');
      throw new AdminRequestError(code === 'APPLICATION_BUSY' ? 409 : 503,
        code === 'APPLICATION_BUSY' ? 'application_busy' : 'application_reconciliation_unavailable');
    }
  } }];
}
