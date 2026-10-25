const capabilityNames = new Map<string, string>([
  ['chat-plans', '聊天方案'], ['personas', '人设'], ['model-settings', '模型设置'], ['access-policy', '访问范围'],
  ['agent.submit', '提交聊天请求'], ['agent.cancel', '请求停止任务'], ['agent.tools.delegate', '委派含工具的会话'], ['model.respond', '调用模型'],
  ['messaging.send', '发送消息'], ['messaging.forward', '合并转发'], ['presentation.prepare', '整理消息表达'],
]);
const featureStates = new Map<string, string>([
  ['installed', '已登记'], ['active', '运行中'], ['running', '运行中'], ['starting', '正在启动'],
  ['stopped', '已停止'], ['stopping', '正在停止'], ['disabled', '未启用'], ['paused', '已暂停'],
  ['failed', '发生故障'], ['error', '发生故障'], ['unknown', '状态待确认'],
]);

export function capabilityLabel(id: string): string {
  return capabilityNames.get(id) ?? '扩展能力';
}

export function readDeclaredCapabilities(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > 4096) return null;
  const capabilities: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length > 100
      || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(entry) || seen.has(entry)) return null;
    seen.add(entry);
    capabilities.push(entry);
  }
  return Object.freeze(capabilities);
}

export function featureLabel(id: string, name?: string): string {
  if (id === 'agent-relay') return '聊天消息转接';
  const label = name?.trim();
  return label && label !== id ? label : '扩展功能';
}

export function chatReadinessLabel(ready: boolean | null): string {
  return ready === null ? '聊天就绪状态待确认' : ready ? '聊天当前已就绪' : '聊天当前未就绪';
}

export function featureStatusLabel(status: string): string {
  return featureStates.get(status) ?? '状态待确认';
}
