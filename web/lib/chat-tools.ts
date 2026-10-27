import { parseNativeToolInventory, type NativeToolInventory } from '../../src/contracts/native-tool-inventory.ts';
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

export function chatToolCategory(_tool: ChatTool): { readonly id: string; readonly label: string } {
  return { id: 'unknown', label: '来源待核对' };
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

/** Resource readers use null for malformed public responses. */
export function parseToolInventory(value: unknown): NativeToolInventory | null {
  try { return parseNativeToolInventory(value); } catch { return null; }
}

type InventoryTool = NativeToolInventory['items'][number];
type InventorySource = NativeToolInventory['sources'][number];

export interface InventoryToolCategory {
  readonly id: string;
  readonly kind: 'framework' | 'dsh' | 'extension' | 'unknown';
  readonly label: string;
  readonly ownerId: string | null;
}

export interface PresentedInventoryTool {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: InventoryToolCategory;
  readonly registrationSource?: InventoryTool['registrationSource'];
  readonly registration: InventoryTool['registration'];
  readonly loadedInSession: boolean | null;
  readonly registrations: readonly InventoryTool[];
}

/** Name syntax is only a technical clue; it never determines ownership or transport. */
export function toolNameNamespace(name: string): string | null {
  return /^mcp__(.+?)__.+$/.exec(name)?.[1] ?? null;
}

export function registrationTransportLabel(source: InventoryTool['registrationSource']): string {
  return source?.transport === 'mcp' ? 'MCP' : source?.transport === 'native' ? '原生接入' : '未报告';
}

export function registrationOriginLabel(source: InventoryTool['registrationSource']): string {
  return source?.origin === 'framework-builtin' ? '框架内置注入'
    : source?.origin === 'extension' ? '扩展注入'
      : source?.origin === 'dsh-builtin' ? 'DSH 自带' : '来源未标明';
}

export function inventoryToolCategory(tool: InventoryTool, source: InventorySource | undefined): InventoryToolCategory {
  const registration = tool.registrationSource;
  if (registration?.origin === 'framework-builtin' || !registration && source?.kind === 'framework') {
    return { id: 'framework', kind: 'framework', label: '框架工具', ownerId: registration?.ownerId ?? null };
  }
  if (registration?.origin === 'dsh-builtin') {
    return { id: `dsh:${registration.ownerId}`, kind: 'dsh', label: registration.ownerName, ownerId: registration.ownerId };
  }
  if (registration?.origin === 'extension') {
    return { id: `extension:${registration.ownerId}`, kind: 'extension', label: registration.ownerName, ownerId: registration.ownerId };
  }
  return { id: 'unknown', kind: 'unknown', label: '来源待核对', ownerId: null };
}

/** Registration scopes preserve evidence; only explicit registration metadata classifies providers. */
export function presentToolInventory(snapshot: NativeToolInventory | null): {
  readonly items: readonly PresentedInventoryTool[];
  readonly categories: readonly (InventoryToolCategory & { readonly count: number })[];
} {
  const sources = new Map(snapshot?.sources.map(source => [source.id, source]) ?? []);
  const groups = new Map<string, { category: InventoryToolCategory; registrations: InventoryTool[] }>();
  for (const tool of snapshot?.items ?? []) {
    const category = inventoryToolCategory(tool, sources.get(tool.sourceId));
    // Keep conflicting owner metadata and distinct transports in separate evidence groups.
    const key = JSON.stringify([category.id, tool.name, tool.description, tool.registrationSource ?? null]);
    const prior = groups.get(key);
    if (prior) prior.registrations.push(tool);
    else groups.set(key, { category, registrations: [tool] });
  }
  const items: PresentedInventoryTool[] = [];
  const categories = new Map<string, InventoryToolCategory & { count: number }>();
  for (const [id, group] of groups) {
    const first = group.registrations[0];
    if (!first) continue;
    const loaded = first.loadedInSession;
    items.push({ id, name: first.name, description: first.description, category: group.category,
      ...(first.registrationSource ? { registrationSource: first.registrationSource } : {}),
      registration: group.registrations.some(tool => tool.registration === 'registered') ? 'registered' : 'declared',
      loadedInSession: group.registrations.every(tool => tool.loadedInSession === loaded) ? loaded : null,
      registrations: group.registrations });
    const prior = categories.get(group.category.id);
    categories.set(group.category.id, { ...group.category, count: (prior?.count ?? 0) + 1 });
  }
  const rank = (category: InventoryToolCategory) => category.kind === 'framework' ? 0 : category.kind === 'dsh' ? 1 : category.kind === 'extension' ? 2 : 3;
  return { items, categories: [...categories.values()].sort((left, right) => rank(left) - rank(right) || left.label.localeCompare(right.label)) };
}

/** Preserve registration evidence, but never mix another ownership category into this view. */
export function inventorySubset(snapshot: NativeToolInventory | null, include: (tool: InventoryTool) => boolean): NativeToolInventory | null {
  if (!snapshot) return null;
  const items = snapshot.items.filter(include);
  const sourceIds = new Set(items.map(tool => tool.sourceId));
  return { ...snapshot, items, sources: snapshot.sources.filter(source => sourceIds.has(source.id)) };
}

export interface ExtensionToolClaim {
  readonly id: string;
  readonly name?: string;
  readonly toolNames: readonly string[];
}

export interface ExtensionToolConflict {
  readonly name: string;
  readonly owners: readonly string[];
  readonly framework: boolean;
  readonly dsh?: boolean;
}

interface RegisteredExtension {
  readonly id: string;
  readonly name: string;
  readonly tools: PresentedInventoryTool[];
}

/** Explicit registration ownership takes priority; exact local tool declarations fill only missing ownership. */
export function groupExtensionTools(snapshot: NativeToolInventory | null, extensions: readonly ExtensionToolClaim[]) {
  const presented = presentToolInventory(snapshot).items;
  const frameworkNames = new Set(presented.filter(tool => tool.category.kind === 'framework').map(tool => tool.name));
  const dshNames = new Set(presented.filter(tool => tool.category.kind === 'dsh').map(tool => tool.name));
  const claims = new Map<string, Set<string>>();
  const registeredOwners = new Map<string, Set<string>>();
  const names = new Map(extensions.map(extension => [extension.id, extension.name ?? extension.id]));
  for (const extension of extensions) for (const name of extension.toolNames) {
    const owners = claims.get(name) ?? new Set<string>();
    owners.add(extension.id);
    claims.set(name, owners);
  }
  for (const tool of presented) if (tool.category.kind === 'extension' && tool.category.ownerId) {
    const owners = registeredOwners.get(tool.name) ?? new Set<string>();
    owners.add(tool.category.ownerId);
    registeredOwners.set(tool.name, owners);
    if (!names.has(tool.category.ownerId)) names.set(tool.category.ownerId, tool.category.label);
  }
  const ownership = new Map<string, string>();
  const conflicts: ExtensionToolConflict[] = [];
  for (const name of new Set([...claims.keys(), ...registeredOwners.keys()])) {
    const owners = new Set([...(claims.get(name) ?? []), ...(registeredOwners.get(name) ?? [])]);
    const framework = frameworkNames.has(name);
    const dsh = dshNames.has(name);
    const owner = [...owners][0];
    if (framework || dsh || owners.size > 1) conflicts.push({ name, owners: [...owners], framework, dsh });
    else if (owner !== undefined && claims.has(name)) ownership.set(name, owner);
  }
  const toolsByExtension = new Map<string, PresentedInventoryTool[]>();
  const registeredExtensions = new Map<string, RegisteredExtension>();
  for (const tool of presented) {
    if (tool.category.kind === 'framework' || tool.category.kind === 'dsh') continue;
    const owner = tool.category.kind === 'extension' ? tool.category.ownerId : ownership.get(tool.name);
    if (!owner) continue;
    const category: InventoryToolCategory = { id: `extension:${owner}`, kind: 'extension', label: names.get(owner) ?? owner, ownerId: owner };
    const ownedTool = tool.category.kind === 'extension' ? tool : { ...tool, category };
    const tools = toolsByExtension.get(owner) ?? [];
    tools.push(ownedTool);
    toolsByExtension.set(owner, tools);
    const extension: RegisteredExtension = registeredExtensions.get(owner) ?? { id: owner, name: names.get(owner) ?? owner, tools: [] };
    extension.tools.push(ownedTool);
    registeredExtensions.set(owner, extension);
  }
  const sources = new Map(snapshot?.sources.map(source => [source.id, source]) ?? []);
  return {
    toolsByExtension, registeredExtensions: [...registeredExtensions.values()], conflicts,
    frameworkInventory: inventorySubset(snapshot, tool => inventoryToolCategory(tool, sources.get(tool.sourceId)).kind === 'framework'),
    dshInventory: inventorySubset(snapshot, tool => inventoryToolCategory(tool, sources.get(tool.sourceId)).kind === 'dsh'),
    unknownInventory: inventorySubset(snapshot, tool => inventoryToolCategory(tool, sources.get(tool.sourceId)).kind === 'unknown' && !ownership.has(tool.name)),
  };
}
