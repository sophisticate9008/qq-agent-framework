export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) { super(code); this.code = code; this.status = status; }
}

export interface ApiClient {
  get(path: string, signal?: AbortSignal): Promise<unknown>;
  post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown>;
}

async function request(
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
  signal?: AbortSignal,
  authorization?: string
): Promise<unknown> {
  try {
    const response = await fetch(path, {
      method,
      headers: {
        ...(authorization === undefined ? {} : { authorization }),
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {})
      },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      credentials: 'same-origin',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(75_000)]) : AbortSignal.timeout(75_000),
    });
    const result: unknown = await response.json();
    if (!response.ok) throw new ApiError(isRecord(result) && typeof result.error === 'string' ? result.error : 'request_failed', response.status);
    return result;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(method === 'POST' ? 'operation_unknown' : 'service_unavailable', 504);
  }
}

export function createApiClient(): ApiClient {
  return { get: (path, signal) => request(path, 'GET', undefined, signal), post: (path, body, signal) => request(path, 'POST', body, signal) };
}

export function loginAccessSession(administratorToken: string, signal?: AbortSignal): Promise<unknown> {
  return request('/api/auth/login', 'POST', {}, signal, `Bearer ${administratorToken}`);
}

export function readAccessSession(signal?: AbortSignal): Promise<unknown> {
  return request('/api/auth/session', 'GET', undefined, signal);
}

export function logoutAccessSession(signal?: AbortSignal): Promise<unknown> {
  return request('/api/auth/logout', 'POST', {}, signal);
}

export function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function asRecord(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }

export function errorMessage(error: unknown): string {
  const code = error instanceof ApiError ? error.code : '';
  if (code === 'unauthorized') return '访问会话已失效，请重新登录。';
  if (code === 'protocol_connection_invalid') return '协议服务连接验证未通过，请检查地址与访问令牌。';
  if (code === 'managed_gateway_endpoint_changed') return '连接地址已在其他位置修改，请重新载入后应用。';
  if (code === 'management_operation_running') return '另一项设置正在应用，请稍后重试。';
  if (code === 'runtime_not_connected') return '聊天尚未运行，请在连接页完成设置并启动聊天。';
  if (code === 'request_too_large' || code === 'chat_document_too_large') return '配置内容超出大小限制，请减少条目或缩短正文后再保存。';
  if (code === 'configuration_write_busy' || code === 'native_chat_busy') return '另一项配置或聊天操作正在进行，请稍后重新检查状态。';
  if (code === 'persona_in_use_or_missing') return '方案引用的人设不存在，或该人设仍被方案使用，请先检查关联。';
  if (code === 'provider_model_in_use' || code === 'assistant_target_in_use') return '方案或助手仍在使用此提供方或模型，请在“模型使用者”中更换目标或解除助手引用。';
  if (code === 'reminder_unknown_requires_reconciliation') return '此提醒的发送结果未知，不能改写或重新启用；可明确停用或取消，并核对历史结果。';
  if (code === 'no_active_plan') return '请先创建并选择聊天方案。';
  if (code === 'local_dsh_connection_required') return '请先点击“自动连接本机 DSH”，再应用聊天设置。';
  if (code === 'local_dsh_deployment_not_found') return '未能识别本机 DSH 的配置位置，请确认服务正在运行；远程部署可展开手动设置。';
  if (code === 'local_dsh_model_settings_missing') return '未能从 DSH 识别所选模型的容量或推理设置；请在高级设置补充模型信息，不需要填写本机文件路径。';
  if (code === 'local_dsh_model_reasoning_unavailable') return '已识别模型容量，但没有找到明确的推理设置；请核对所选模型，或在高级设置补充模型信息。';
  if (code === 'local_dsh_reasoning_mapping_unsupported') return '已识别模型容量，但当前模型的推理设置格式尚不支持自动应用；不会猜测或改动你的聊天方案。';
  if (code === 'local_dsh_preparation_failed') return '未能准备聊天设置，尚未修改 DSH；请重新读取状态。';
  if (code === 'chat_storage_busy') return '另一项聊天配置正在写入，请稍后重新读取。';
  if (/conflict|stale|revision/.test(code)) return '设置已被其他窗口更新，请刷新后再保存。';
  if (/unknown/.test(code)) return '暂时无法确认操作结果，请刷新状态后查看。';
  if (/unavailable|connect|timeout/.test(code)) return '服务暂时未连接，请稍后重试。';
  if (/invalid|bounds|validation/.test(code)) return '请检查填写的内容和数值范围。';
  return '操作暂时未完成，请先检查当前状态。';
}
