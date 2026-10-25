export interface OneBotConnectionSnapshot {
  readonly state: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';
  readonly selfId: string | null;
  readonly lastError: string | null;
  readonly received: number;
  readonly dropped: number;
  readonly chatReady: boolean;
}

type DiagnosticCategory = 'processing' | 'authentication' | 'identity' | 'configuration' | 'transport' | 'lifecycle' | 'unknown';
export interface OneBotConnectionDiagnostic {
  readonly category: DiagnosticCategory;
  readonly tone: 'warning' | 'error' | 'neutral';
  readonly title: string;
  readonly message: string;
  readonly code: string | null;
}

function describeError(code: string): { readonly category: DiagnosticCategory; readonly detail: string } {
  switch (code) {
    case 'onebot_ws_callback_failed': return { category: 'processing', detail: '曾有入站事件处理失败。请查看目标会话诊断与执行记录，核对未完成处理的消息。' };
    case 'onebot_ws_callback_timeout': return { category: 'processing', detail: '曾有入站事件处理超时。请查看目标会话诊断与执行记录，核对处理期限和未完成消息。' };
    case 'onebot_ws_auth_rejected': return { category: 'authentication', detail: '协议端拒绝了 WebSocket 鉴权，请核对协议端 WebSocket 服务的专用密钥。' };
    case 'onebot_ws_login_rejected':
    case 'onebot_ws_invalid_identity':
    case 'onebot_ws_login_unverified': return { category: 'identity', detail: '协议账号身份尚未通过核验，请检查协议端登录状态和实际机器人账号。' };
    case 'onebot_ws_invalid_options':
    case 'onebot_ws_invalid_endpoint':
    case 'onebot_ws_not_enabled': return { category: 'configuration', detail: 'WebSocket 接入配置尚未满足连接条件，请核对已保存的启用设置和服务地址。' };
    case 'onebot_ws_connect_timeout': return { category: 'transport', detail: 'WebSocket 建连超时，请核对协议服务是否运行、地址是否可达。' };
    case 'onebot_ws_upgrade_rejected': return { category: 'transport', detail: '协议端拒绝了 WebSocket 握手，请核对 WebSocket 服务地址与协议配置。' };
    case 'onebot_ws_pong_timeout': return { category: 'transport', detail: 'WebSocket 心跳超时，请核对协议服务和网络状态。' };
    case 'onebot_ws_payload_too_large': return { category: 'transport', detail: '协议事件超过接收大小限制，请检查协议端事件大小和连接记录。' };
    case 'onebot_ws_connection_failed': return { category: 'transport', detail: 'WebSocket 连接失败或中断，请核对协议服务与网络状态。' };
    case 'onebot_ws_closed':
    case 'onebot_ws_aborted': return { category: 'lifecycle', detail: '最近记录了连接关闭或取消。当前连接状态以上方状态为准。' };
    default: return { category: 'unknown', detail: '最近记录了尚未分类的异常，请读取最新状态并查看管理日志。' };
  }
}

export function presentOneBotConnection(connection: OneBotConnectionSnapshot) {
  const statusLabel = { disconnected: 'WebSocket 未连接', connecting: 'WebSocket 正在连接', connected: 'WebSocket 已连接',
    reconnecting: 'WebSocket 正在重新连接', error: 'WebSocket 连接异常' }[connection.state];
  const statusTone = connection.state === 'connected' ? 'success' as const : connection.state === 'error' ? 'warning' as const : 'neutral' as const;
  let diagnostic: OneBotConnectionDiagnostic | null = null;
  if (connection.lastError?.trim()) {
    const { category, detail } = describeError(connection.lastError);
    const code = /^[a-z][a-z0-9_]{0,95}$/.test(connection.lastError) ? connection.lastError : null;
    if (category === 'processing') {
      diagnostic = { category, code, tone: 'warning', title: '最近入站处理异常',
        message: `${connection.state === 'connected' ? '当前 WebSocket 保持连接。' : ''}${detail}` };
    } else if (connection.state === 'connected') {
      diagnostic = { category, code, tone: 'neutral', title: '历史连接诊断',
        message: '当前 WebSocket 已连接，最近一次异常记录保留供核对。可读取最新状态或查看管理日志，核对后续处理结果。' };
    } else {
      diagnostic = { category, code, tone: category === 'lifecycle' ? 'neutral' : 'error',
        title: category === 'authentication' ? 'WebSocket 鉴权未通过' : category === 'identity' ? '协议账号待核验' : category === 'lifecycle' ? '连接关闭记录' : 'WebSocket 连接诊断', message: detail };
    }
  }
  return { statusLabel, statusTone, diagnostic };
}
