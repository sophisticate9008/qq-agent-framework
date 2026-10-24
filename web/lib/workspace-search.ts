import { asRecord, isRecord } from './api.ts';
import { resolveConfigurationVisibility, type VisibilityGroup } from './configuration-visibility.ts';
import type { PageId } from './types.ts';
import { usageSectionLabels } from './usage-details.ts';

export interface WorkspaceSearchTarget {
  readonly page: PageId;
  readonly title: string;
  readonly sectionTitle?: string;
  readonly kind: 'page' | 'section' | 'field';
}

export interface WorkspaceSearchVisibleEntry {
  readonly title: string;
  readonly sectionTitle: string;
  readonly kind: 'section' | 'field';
}

export interface WorkspaceSearchSources {
  readonly configuration: unknown;
  readonly legacyMode: unknown;
  readonly settings: unknown;
  readonly currentPage?: PageId;
  readonly visibleEntries?: readonly WorkspaceSearchVisibleEntry[];
}

export interface WorkspaceSearchGroup {
  readonly page: PageId;
  readonly title: string;
  readonly targets: readonly WorkspaceSearchTarget[];
}

interface SearchConfigurationGroup extends VisibilityGroup {
  readonly category: Exclude<PageId, 'overview'>;
}

const pageDefinitions: readonly { readonly id: PageId; readonly title: string }[] = [
  { id: 'overview', title: '概览' },
  { id: 'sessions', title: '会话管理' },
  { id: 'usage', title: '用量统计' },
  { id: 'persona', title: '人设与形象' },
  { id: 'features', title: '功能与触发' },
  { id: 'access', title: '访问范围' },
  { id: 'model', title: '模型与回复' },
  { id: 'settings', title: '运行设置' },
];

const pageIds = new Set<PageId>(pageDefinitions.map(page => page.id));
const configurationCategories = new Set<Exclude<PageId, 'overview'>>([
  'persona',
  'features',
  'access',
  'model',
  'settings',
]);

export const workspacePageTargets: readonly WorkspaceSearchTarget[] = Object.freeze(
  pageDefinitions.map(page => Object.freeze({ page: page.id, title: page.title, kind: 'page' as const }))
);

export function workspacePageTitle(page: PageId): string {
  return pageDefinitions.find(definition => definition.id === page)?.title ?? page;
}

function parseConfiguration(configuration: unknown): {
  readonly groups: readonly SearchConfigurationGroup[];
  readonly booleanValues: Readonly<Record<string, boolean>>;
} {
  const root = asRecord(configuration);
  if (!Array.isArray(root.groups)) throw new Error('invalid_workspace_search_configuration');

  const groups: SearchConfigurationGroup[] = [];
  const booleanValues: Record<string, boolean> = {};
  for (const candidate of root.groups) {
    if (!isRecord(candidate)
      || typeof candidate.id !== 'string'
      || typeof candidate.title !== 'string'
      || typeof candidate.category !== 'string'
      || !configurationCategories.has(candidate.category as Exclude<PageId, 'overview'>)
      || !Array.isArray(candidate.fields)) continue;

    const fields: { id: string; label: string }[] = [];
    for (const field of candidate.fields) {
      if (!isRecord(field) || typeof field.id !== 'string' || typeof field.label !== 'string') continue;
      fields.push({ id: field.id, label: field.label });
      if (typeof field.value === 'boolean') booleanValues[field.id] = field.value;
    }
    groups.push({
      id: candidate.id,
      title: candidate.title,
      category: candidate.category as Exclude<PageId, 'overview'>,
      fields,
    });
  }
  return { groups, booleanValues };
}

function parseActiveMode(response: unknown): string | null {
  const mode = asRecord(response).mode;
  if (typeof mode !== 'string') return null;
  return mode;
}

function settingsTargets(response: unknown): readonly WorkspaceSearchTarget[] {
  const root = asRecord(response);
  const gateway = asRecord(root.gateway);
  const admin = asRecord(root.admin);
  const gatewayValues = asRecord(gateway.values);
  const adminValues = asRecord(admin.values);
  if (typeof gatewayValues.budgetEnabled !== 'boolean'
    || Object.keys(adminValues).length === 0) {
    return [];
  }

  const targets: WorkspaceSearchTarget[] = [
    { page: 'settings', title: '运营预算', sectionTitle: '运营预算', kind: 'section' },
    { page: 'settings', title: '启用发送预算', sectionTitle: '运营预算', kind: 'field' },
    { page: 'settings', title: '技术约束', sectionTitle: '技术约束', kind: 'section' },
    { page: 'settings', title: '请求超时', sectionTitle: '技术约束', kind: 'field' },
    { page: 'settings', title: '并发请求上限', sectionTitle: '技术约束', kind: 'field' },
    { page: 'settings', title: '单次请求体上限', sectionTitle: '技术约束', kind: 'field' },
    { page: 'settings', title: '持久记录上限', sectionTitle: '技术约束', kind: 'field' },
    { page: 'settings', title: '管理端监听', sectionTitle: '管理端监听', kind: 'section' },
    { page: 'settings', title: '监听地址', sectionTitle: '管理端监听', kind: 'field' },
    { page: 'settings', title: '监听端口', sectionTitle: '管理端监听', kind: 'field' },
  ];
  if (gatewayValues.budgetEnabled) {
    targets.splice(2, 0,
      { page: 'settings', title: '每次授权最多发送', sectionTitle: '运营预算', kind: 'field' },
      { page: 'settings', title: '授权有效时间', sectionTitle: '运营预算', kind: 'field' });
  }
  return targets;
}

function targetKey(target: WorkspaceSearchTarget): string {
  return `${target.page}\u0000${target.kind}\u0000${target.sectionTitle ?? ''}\u0000${target.title}`;
}

function uniqueTargets(targets: readonly WorkspaceSearchTarget[]): readonly WorkspaceSearchTarget[] {
  const seen = new Set<string>();
  return targets.filter(target => {
    const key = targetKey(target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function applyCurrentPageVisibility(
  targets: readonly WorkspaceSearchTarget[],
  currentPage: PageId,
  visibleEntries: readonly WorkspaceSearchVisibleEntry[]
): readonly WorkspaceSearchTarget[] {
  const retained = targets.filter(target => target.page !== currentPage || target.kind === 'page');
  const visible = visibleEntries
    .filter(entry => entry.title.trim() !== '' && entry.sectionTitle.trim() !== '')
    .map(entry => ({
      page: currentPage,
      title: entry.title.trim(),
      sectionTitle: entry.sectionTitle.trim(),
      kind: entry.kind,
    } satisfies WorkspaceSearchTarget));
  return uniqueTargets([...retained, ...visible]);
}

export function buildWorkspaceSearchTargets(sources: WorkspaceSearchSources): readonly WorkspaceSearchTarget[] {
  const { groups, booleanValues } = parseConfiguration(sources.configuration);
  const activeMode = parseActiveMode(sources.legacyMode);
  const visibility = resolveConfigurationVisibility(groups, { activeMode, values: booleanValues });
  const configurationTargets: WorkspaceSearchTarget[] = [];

  for (const group of groups) {
    const groupVisibility = visibility.get(group.id);
    if (!groupVisibility?.visible) continue;
    configurationTargets.push({
      page: group.category,
      title: group.title,
      sectionTitle: group.title,
      kind: 'section',
    });
    for (const field of group.fields) {
      if (!groupVisibility.fieldIds.has(field.id)) continue;
      configurationTargets.push({
        page: group.category,
        title: field.label,
        sectionTitle: group.title,
        kind: 'field',
      });
    }
  }

  let targets = uniqueTargets([
    ...workspacePageTargets,
    ...configurationTargets,
    ...settingsTargets(sources.settings),
    ...(activeMode === null ? [] : Object.values(usageSectionLabels).map(title => ({
      page: 'usage' as const, title, sectionTitle: title, kind: 'section' as const,
    }))),
  ]);
  if (sources.currentPage && sources.visibleEntries) {
    targets = applyCurrentPageVisibility(targets, sources.currentPage, sources.visibleEntries);
  }
  return targets;
}

export function normalizeWorkspaceSearchQuery(query: string): readonly string[] {
  return query.normalize('NFKC').trim().toLocaleLowerCase('zh-CN').split(/\s+/).filter(Boolean);
}

function searchableText(target: WorkspaceSearchTarget): string {
  const aliases = target.kind === 'page' && target.page === 'usage' ? 'token tokens 费用 花费 用量'
    : target.kind === 'page' && target.page === 'sessions' ? 'session sessions 群聊 私聊 会话' : '';
  return [workspacePageTitle(target.page), target.sectionTitle, target.title, aliases]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN');
}

export function searchWorkspaceTargets(
  targets: readonly WorkspaceSearchTarget[],
  query: string
): readonly WorkspaceSearchTarget[] {
  const words = normalizeWorkspaceSearchQuery(query);
  if (words.length === 0) return workspacePageTargets;

  return targets.filter(target => {
    const text = searchableText(target);
    return words.every(word => text.includes(word));
  });
}

export function groupWorkspaceSearchTargets(
  targets: readonly WorkspaceSearchTarget[]
): readonly WorkspaceSearchGroup[] {
  return pageDefinitions.flatMap(page => {
    const pageTargets = targets.filter(target => target.page === page.id);
    return pageTargets.length > 0 ? [{ page: page.id, title: page.title, targets: pageTargets }] : [];
  });
}

export function workspaceSearchPath(target: WorkspaceSearchTarget): string {
  if (target.kind === 'page') return `${workspacePageTitle(target.page)} · 页面快捷入口`;
  if (target.kind === 'section') return `${workspacePageTitle(target.page)} · ${target.title}`;
  return `${workspacePageTitle(target.page)} · ${target.sectionTitle ?? '设置'} · ${target.title}`;
}

export function isPageId(value: unknown): value is PageId {
  return typeof value === 'string' && pageIds.has(value as PageId);
}
