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
  if (code === 'unauthorized') return '访问令牌不正确，请重新连接。';
  if (code === 'protocol_connection_invalid') return '协议服务连接验证未通过，请检查地址与访问令牌。';
  if (code === 'protocol_credentials_mismatch') return '消息网关和聊天服务使用的访问令牌不一致，请先核对配置。';
  if (code === 'managed_gateway_endpoint_changed') return '连接地址已在其他位置修改，请重新载入后应用。';
  if (code === 'management_operation_running') return '另一项设置正在应用，请稍后重试。';
  if (/conflict|stale|revision/.test(code)) return '设置已被其他窗口更新，请刷新后再保存。';
  if (/unknown/.test(code)) return '暂时无法确认操作结果，请刷新状态后查看。';
  if (/unavailable|connect|timeout/.test(code)) return '服务暂时未连接，请稍后重试。';
  if (/invalid|bounds|validation/.test(code)) return '请检查填写的内容和数值范围。';
  return '操作暂时未完成，请先检查当前状态。';
}
