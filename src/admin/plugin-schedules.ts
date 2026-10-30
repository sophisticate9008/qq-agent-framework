import { parsePluginScheduleDetail, parsePluginScheduleHistorySnapshot, parsePluginScheduleManagementRequest,
  parsePluginScheduleManagementResponse, parsePluginScheduleSnapshot,
  type PluginScheduleDetail, type PluginScheduleHistorySnapshot, type PluginScheduleItem,
  type PluginScheduleManagementRequest, type PluginScheduleReadOptions, type PluginScheduleSnapshot } from '../contracts/plugin-schedules.ts';
import { reference, errorCode } from '../core/values.ts';
import { AdminRequestError, type AdminRoute } from './server.ts';

export interface PluginScheduleManagementPort {
  readPluginSchedules(query: PluginScheduleReadOptions): PluginScheduleSnapshot;
  readPluginScheduleHistory(query: PluginScheduleReadOptions): PluginScheduleHistorySnapshot;
  readPluginScheduleDetail(owner: string, id: string, occurrenceId: string | undefined, signal: AbortSignal): Promise<PluginScheduleDetail>;
  managePluginSchedule(request: PluginScheduleManagementRequest, signal: AbortSignal): Promise<PluginScheduleItem>;
}

export function createPluginScheduleRoutes(options: { readonly runtime: PluginScheduleManagementPort }): readonly AdminRoute[] {
  function queryPage(query: URLSearchParams): PluginScheduleReadOptions {
    const allowed = ['owner', 'id', 'limit', 'after'];
    if ([...query.keys()].some(key => !allowed.includes(key) || query.getAll(key).length !== 1))
      throw new AdminRequestError(400, 'invalid_plugin_schedule_query');
    const owner = query.get('owner'), id = query.get('id'), after = query.get('after'), rawLimit = query.get('limit');
    if (owner !== null && !reference(owner) || id !== null && (!reference(id) || owner === null)
      || after !== null && !reference(after) || rawLimit !== null && !/^[1-9]\d{0,2}$/.test(rawLimit))
      throw new AdminRequestError(400, 'invalid_plugin_schedule_query');
    const limit = rawLimit === null ? 100 : Number(rawLimit);
    if (limit > 200) throw new AdminRequestError(400, 'invalid_plugin_schedule_query');
    return { limit, ...(owner === null ? {} : { owner }), ...(id === null ? {} : { id }), ...(after === null ? {} : { after }) };
  }
  function failed(error: unknown, signal: AbortSignal): never {
    if (error instanceof AdminRequestError) throw error;
    if (signal.aborted) throw new AdminRequestError(499, 'request_aborted');
    const code = errorCode(error, 'PLUGIN_SCHEDULER_UNAVAILABLE');
    throw new AdminRequestError(/INVALID/.test(code) ? 400 : /NOT_FOUND/.test(code) ? 404
      : /CONFLICT|BUSY|SKIP_UNAVAILABLE|RUN_UNAVAILABLE|MANAGEMENT_UNAVAILABLE/.test(code) ? 409 : /UNKNOWN/.test(code) ? 504 : 503, code.toLowerCase());
  }
  return [{ method: 'GET', pathname: '/api/chat/schedules', maxResponseBytes: 2 * 1024 * 1024,
    handle({ query, signal }) {
      const input = queryPage(query);
      try {
        const result = parsePluginScheduleSnapshot(options.runtime.readPluginSchedules(input));
        if (!result) throw new AdminRequestError(503, 'plugin_schedules_invalid_state');
        return result;
      } catch (error) { failed(error, signal); }
    },
  }, { method: 'GET', pathname: '/api/chat/schedules/history', maxResponseBytes: 2 * 1024 * 1024,
    handle({ query, signal }) {
      const input = queryPage(query);
      try {
        const result = parsePluginScheduleHistorySnapshot(options.runtime.readPluginScheduleHistory(input));
        if (!result) throw new AdminRequestError(503, 'plugin_schedules_invalid_state');
        return result;
      } catch (error) { failed(error, signal); }
    },
  }, { method: 'GET', pathname: '/api/chat/schedules/detail', maxResponseBytes: 2 * 1024 * 1024,
    async handle({ query, signal }) {
      const allowed = ['owner', 'id', 'occurrenceId'];
      const owner = query.get('owner'), id = query.get('id'), occurrenceId = query.get('occurrenceId');
      if ([...query.keys()].some(key => !allowed.includes(key) || query.getAll(key).length !== 1)
        || !reference(owner) || !reference(id) || occurrenceId !== null && !reference(occurrenceId))
        throw new AdminRequestError(400, 'invalid_plugin_schedule_query');
      try {
        const result = parsePluginScheduleDetail(await options.runtime.readPluginScheduleDetail(owner, id, occurrenceId ?? undefined, signal));
        if (!result) throw new AdminRequestError(503, 'plugin_schedules_invalid_state');
        return result;
      } catch (error) { failed(error, signal); }
    },
  }, { method: 'POST', pathname: '/api/chat/schedules', maxRequestBytes: 8192, maxResponseBytes: 32_768,
    async handle({ query, body, signal }) {
      const input = parsePluginScheduleManagementRequest(body);
      if (query.size || !input) throw new AdminRequestError(400, 'invalid_plugin_schedule_operation');
      try {
        const item = await options.runtime.managePluginSchedule(input, signal);
        const result = parsePluginScheduleManagementResponse({ schema: 1, ok: true, action: input.action, item });
        if (!result) throw new AdminRequestError(504, 'plugin_schedule_operation_unknown');
        return result;
      } catch (error) { failed(error, signal); }
    },
  }];
}
