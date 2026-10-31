import type { PageIcon } from './page-icons.ts';
import type { PageSearchLocator } from './page-index.ts';

interface ShortcutDefinition {
  readonly order: number;
  readonly description: string;
  readonly label?: string;
  readonly icon?: PageIcon;
}

interface AliasDefinition {
  readonly id: string;
  readonly target: PageSearchLocator;
  readonly shortcut?: ShortcutDefinition;
}

interface PageDefinition {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly icon: PageIcon;
  readonly navigation: { readonly label: string; readonly order: number } | { readonly group: string };
  readonly subpageLabel?: string;
  readonly searchAliases?: string;
  readonly configurationCategory?: boolean;
  readonly aliases?: readonly AliasDefinition[];
  readonly shortcut?: ShortcutDefinition;
}

// Page identity, rendering, navigation, search and overview entries share this registration.
const definitions = [
  { id: 'overview', label: '连接与概览', description: '伙伴的运行近况和常用入口', icon: 'LayoutDashboard',
    navigation: { label: '连接与概览', order: 0 } },
  { id: 'sessions', label: '会话与执行记录', description: '查看群聊与私聊的会话关联、统计和记录', icon: 'MessagesSquare',
    navigation: { label: '会话与日志', order: 5 }, searchAliases: 'session sessions 群聊 私聊 会话 助手 独立工作 工作记录',
    shortcut: { order: 5, description: '原生宿主接入后查看会话' } },
  { id: 'stickers', configurationCategory: true, label: '表情库', description: '管理账号收藏和额外表情，设置自动收藏概率', icon: 'Sparkles',
    navigation: { label: '表情库', order: 6.5 }, searchAliases: '表情 收藏 贴纸 额外存储 标签 sticker stickers' },
  { id: 'schedules', label: '任务与日程', description: '查看插件日程、暂停状态与实际执行记录', icon: 'CalendarClock',
    navigation: { label: '任务与日程', order: 6 }, searchAliases: '任务 日程 定时 计划 调度 待执行 执行记录 暂停 恢复 插件 schedule schedules' },
  { id: 'usage', label: '用量统计', description: '查看真实 token 用量与按价目表估算的费用', icon: 'Activity',
    navigation: { label: '用量统计', order: 7 }, searchAliases: 'token tokens 费用 花费 用量',
    shortcut: { order: 6, description: '原生宿主接入后查看用量' } },
  { id: 'persona', configurationCategory: true, label: '人设与唤醒', description: '管理伙伴的人设、表达和唤醒方式', icon: 'UserRound',
    navigation: { label: '人设编辑', order: 2 }, subpageLabel: '人设', searchAliases: '人设库', shortcut: { order: 2, description: '管理身份、表达与唤醒方式' } },
  { id: 'features', configurationCategory: true, label: '功能与扩展', description: '查看 MCP 与本地注册工具、扩展包和框架服务', icon: 'Sparkles',
    navigation: { label: '功能与扩展', order: 8 }, searchAliases: 'MCP 工具 插件 本地工具 扩展包 框架服务', shortcut: { order: 3, description: '查看工具清单与本地扩展包' } },
  { id: 'security', configurationCategory: true, label: '访问与设置', description: '管理访问控制、聊天处理和管理服务', icon: 'ShieldCheck',
    navigation: { label: '访问与设置', order: 9 }, searchAliases: 'access settings 访问范围 运行设置 群聊 私聊 白名单 拒绝名单 主人 超时 容量 监听 安全',
    aliases: [
      { id: 'access', target: { title: '访问范围', sectionId: 'security-access', kind: 'section' },
        shortcut: { order: 4, label: '访问范围', description: '管理原生聊天授权主体' } },
      { id: 'settings', target: { title: '运行设置', sectionId: 'security-settings', kind: 'section' },
        shortcut: { order: 7, label: '运行设置', description: '管理端、网关与显示偏好', icon: 'SlidersHorizontal' } },
    ] },
  { id: 'model', configurationCategory: true, label: '聊天方案', description: '管理聊天方案与后台助手设置', icon: 'Bot',
    navigation: { label: '聊天方案', order: 3 }, searchAliases: '模型 回复 prompt 方案 指令 群聊上下文 私聊上下文',
    shortcut: { order: 0, description: '创建、编辑并选择启用方案' } },
  { id: 'providers', label: '模型服务', description: '集中管理服务类型、连接凭据和可选模型', icon: 'Monitor',
    navigation: { label: '模型服务', order: 4 }, searchAliases: '模型提供方 模型 提供方 provider providers OpenAI Anthropic API key 服务商 密钥 模型昵称' },
  { id: 'adapters', label: '连接', description: '接入 QQ 协议、DSH 与外部服务', icon: 'Waves',
    navigation: { label: '连接设置', order: 1 }, searchAliases: 'adapter adapters 适配器 OneBot WebSocket WS WSS HTTP webhook DSH 协议 接入 服务地址 连接凭据 收消息 发消息 启动聊天',
    shortcut: { order: 1, label: '连接', description: '消息、聊天引擎与图片连接', icon: 'Cable' } },
] as const satisfies readonly PageDefinition[];

type AliasId<Entry> = Entry extends { readonly aliases: readonly (infer Alias)[] }
  ? Alias extends { readonly id: infer Id extends string } ? Id : never : never;
export type CanonicalPageId = typeof definitions[number]['id'];
export type PageId = CanonicalPageId | AliasId<typeof definitions[number]>;
export const pageRegistry: readonly (PageDefinition & { readonly id: CanonicalPageId })[] = definitions;

export function pageDefinition(id: PageId) {
  return pageRegistry.find(page => page.id === id || page.aliases?.some(alias => alias.id === id))!;
}

export function registeredPageId(value: unknown): value is PageId {
  return typeof value === 'string' && pageRegistry.some(page => page.id === value || page.aliases?.some(alias => alias.id === value));
}

export function registeredPageAlias(id: PageId) {
  return pageDefinition(id).aliases?.find(alias => alias.id === id);
}

export const pageNavigationGroups = pageRegistry.flatMap(page => 'group' in page.navigation ? [] : [{
  id: page.id, label: page.navigation.label, icon: page.icon, order: page.navigation.order,
  pages: pageRegistry.filter(candidate => candidate.id === page.id
    || 'group' in candidate.navigation && candidate.navigation.group === page.id).map(candidate => candidate.id),
}]).sort((left, right) => left.order - right.order);

export const overviewPageShortcuts = pageRegistry.flatMap(page => [
  ...(page.shortcut ? [{ ...page.shortcut, id: page.id as PageId, label: page.shortcut.label ?? page.label, icon: page.shortcut.icon ?? page.icon }] : []),
  ...(page.aliases ?? []).flatMap(alias => alias.shortcut ? [{ ...alias.shortcut, id: alias.id as PageId,
    label: alias.shortcut.label ?? alias.target.title, icon: alias.shortcut.icon ?? page.icon }] : []),
]).sort((left, right) => left.order - right.order);
