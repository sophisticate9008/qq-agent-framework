import { asRecord } from './api.ts';

export type ChatToolsState = 'available' | 'declared' | 'not-connected' | 'unavailable';

export interface ChatTool {
  readonly name: string;
  readonly description: string | null;
}

export interface ChatToolsSnapshot {
  readonly state: ChatToolsState;
  readonly scope: 'session' | 'declaration' | null;
  readonly items: readonly ChatTool[];
  readonly limited: boolean;
  readonly missingReasons: readonly string[];
  readonly externalToolAuthorizationVerified: false;
}

export function parseChatTools(value: unknown): ChatToolsSnapshot | null {
  const root = asRecord(value);
  if (root.state !== 'available' && root.state !== 'declared' && root.state !== 'not-connected' && root.state !== 'unavailable'
    || root.scope !== null && root.scope !== 'session' && root.scope !== 'declaration'
    || root.state === 'available' && root.scope !== 'session'
    || typeof root.limited !== 'boolean' || root.externalToolAuthorizationVerified !== false
    || !Array.isArray(root.missingReasons) || root.missingReasons.length > 256
    || !root.missingReasons.every(reason => typeof reason === 'string' && reason.length <= 2000)
    || !Array.isArray(root.items) || root.items.length > 256
    || root.state === 'not-connected' && root.items.length !== 0) return null;
  const items: ChatTool[] = [];
  const names = new Set<string>();
  for (const value of root.items) {
    const item = asRecord(value);
    if (typeof item.name !== 'string' || item.name.trim() === '' || item.name.length > 256 || names.has(item.name)
      || item.description !== null && (typeof item.description !== 'string' || item.description.length > 2000)) return null;
    names.add(item.name); items.push({ name: item.name, description: item.description as string | null });
  }
  return { state: root.state, scope: root.scope, limited: root.limited, items,
    missingReasons: root.missingReasons as string[], externalToolAuthorizationVerified: false };
}

export function chatToolsStateLabel(state: ChatToolsState, scope: ChatToolsSnapshot['scope'], missingReasons: readonly string[] = []): string {
  if (state !== 'available' && missingReasons.includes('native_tool_scope_not_observed')) return '等待首次对话';
  if (state !== 'available' && missingReasons.includes('saved_scope_unobserved')) return '已记录待核对';
  if (state === 'declared' && scope !== 'declaration') return '已记录待核对';
  return { available: '当前会话可见', declared: '仅工具声明', 'not-connected': '聊天未启动', unavailable: '工具清单读取失败' }[state];
}

export function chatToolsEmptyMessage(snapshot: ChatToolsSnapshot): string {
  if (snapshot.state === 'available') return snapshot.missingReasons.includes('some_tool_scopes_unavailable')
    ? '已核对的会话没有可用工具；部分会话暂未加载。' : '当前会话没有可用工具。';
  if (snapshot.state === 'not-connected') return '启动聊天后可查看工具。';
  if (snapshot.missingReasons.includes('native_tool_scope_not_observed')) return '开始聊天后显示实际工具。';
  if (snapshot.missingReasons.includes('saved_scope_unobserved')) return '已记录的工具尚未实时核对，请刷新查看。';
  if (snapshot.state === 'declared') return '已有记录尚未实时核对，请刷新工具清单。';
  return '工具清单读取失败，请刷新重试。';
}

export function chatToolCategory(tool: ChatTool): { readonly id: string; readonly label: string } {
  const match = /^mcp__(.+?)__(.+)$/.exec(tool.name);
  return match ? { id: `mcp:${match[1]}`, label: `MCP · ${match[1]}` } : { id: 'other', label: '其他工具 / 未标来源' };
}

export function chatToolsCategories(snapshot: ChatToolsSnapshot): readonly { readonly id: string; readonly label: string; readonly count: number }[] {
  const categories = new Map<string, { id: string; label: string; count: number }>();
  for (const tool of snapshot.items) {
    const category = chatToolCategory(tool);
    const prior = categories.get(category.id);
    categories.set(category.id, { ...category, count: (prior?.count ?? 0) + 1 });
  }
  return [...categories.values()];
}

export function filterChatTools(snapshot: ChatToolsSnapshot, query: string, category = 'all'): readonly ChatTool[] {
  const normalized = query.normalize('NFKC').trim().toLocaleLowerCase();
  const items = category === 'all' ? snapshot.items : snapshot.items.filter(tool => chatToolCategory(tool).id === category);
  if (!normalized) return items;
  return items.filter(tool => `${tool.name} ${tool.description ?? '暂无说明'} ${chatToolsStateLabel(snapshot.state, snapshot.scope, snapshot.missingReasons)}`.normalize('NFKC').toLocaleLowerCase().includes(normalized));
}
