import { asRecord, isRecord } from './api.ts';
import { resolveConfigurationVisibility, type VisibilityGroup } from './configuration-visibility.ts';
import type { PageId } from './types.ts';
import { pageDefinition, pageRegistry, registeredPageId } from './page-registry.ts';
import { canonicalPageId } from './page-navigation.ts';
import { nativeFormSearchTargets } from './native-form-metadata.ts';
import { usageSectionLabels } from './usage-details.ts';

export interface WorkspaceSearchTarget {
  readonly page: PageId;
  readonly title: string;
  readonly sectionTitle?: string;
  readonly sectionId?: string;
  readonly fallbackSectionId?: string;
  readonly availability?: 'available' | 'requires-setup' | 'unknown';
  readonly unavailableMessage?: string;
  readonly kind: 'page' | 'section' | 'field';
}

export interface WorkspaceSearchVisibleEntry {
  readonly sectionId?: string;
  readonly title: string;
  readonly sectionTitle: string;
  readonly kind: 'section' | 'field';
}

export interface WorkspaceSearchSources {
  readonly configuration: unknown;
  readonly runtimeStatus?: unknown;
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

const pageDefinitions = pageRegistry.map(page => ({ id: page.id, title: page.label }));
const configurationCategories = new Set<string>(pageRegistry.filter(page => page.configurationCategory)
  .flatMap(page => [page.id, ...(page.aliases ?? []).map(alias => alias.id)]));

export const workspacePageTargets: readonly WorkspaceSearchTarget[] = Object.freeze(
  pageDefinitions.map(page => Object.freeze({ page: page.id, title: page.title, kind: 'page' as const }))
);

export function workspacePageTitle(page: PageId): string {
  return pageDefinition(page).label;
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

function targetKey(target: WorkspaceSearchTarget): string {
  return `${target.page}\u0000${target.kind}\u0000${target.sectionId ?? target.sectionTitle ?? ''}\u0000${target.title}`;
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
  currentPage = canonicalPageId(currentPage);
  const native = nativeFormSearchTargets();
  const retained = targets.filter(target => target.page !== currentPage || target.kind === 'page' || target.sectionId)
    .map(target => target.page === currentPage && target.sectionId ? {
      ...target,
      availability: visibleEntries.some(entry => entry.kind === target.kind && (entry.kind === 'section' || entry.title === target.title)
        && entry.sectionId === target.sectionId) ? 'available' as const : 'requires-setup' as const,
    } : target);
  const visible = visibleEntries
    .filter(entry => entry.title.trim() !== '' && entry.sectionTitle.trim() !== '')
    .filter(entry => !native.some(target => target.page === currentPage && target.sectionId === entry.sectionId
      && (entry.kind === 'section' || target.kind === entry.kind && target.title === entry.title)))
    .map(entry => ({
      page: currentPage,
      title: entry.title.trim(),
      sectionTitle: native.find(target => target.page === currentPage && target.sectionId === entry.sectionId)?.sectionTitle
        ?? entry.sectionTitle.trim(),
      sectionId: entry.sectionId,
      kind: entry.kind,
    } satisfies WorkspaceSearchTarget));
  return uniqueTargets([...retained, ...visible]);
}

export function buildWorkspaceSearchTargets(sources: WorkspaceSearchSources): readonly WorkspaceSearchTarget[] {
  const { groups, booleanValues } = parseConfiguration(sources.configuration);
  const runtimeConnected = asRecord(sources.runtimeStatus).runtimeConnected === true;
  const visibility = resolveConfigurationVisibility(groups, { values: booleanValues });
  const configurationTargets: WorkspaceSearchTarget[] = [];

  for (const group of groups) {
    if (group.id === 'gateway-targets' || group.category === 'settings' && group.id.startsWith('gateway-')) continue;
    const groupVisibility = visibility.get(group.id);
    if (!groupVisibility?.visible) continue;
    configurationTargets.push({
      page: canonicalPageId(group.category),
      title: group.title,
      sectionTitle: group.title,
      kind: 'section',
    });
    for (const field of group.fields) {
      if (!groupVisibility.fieldIds.has(field.id)) continue;
      configurationTargets.push({
        page: canonicalPageId(group.category),
        title: field.label,
        sectionTitle: group.title,
        kind: 'field',
      });
    }
  }

  let targets = uniqueTargets([
    ...workspacePageTargets,
    ...configurationTargets,
    ...nativeFormSearchTargets(),
    { page: 'security', title: '访问范围', sectionTitle: '访问范围', sectionId: 'security-access', kind: 'section' },
    { page: 'security', title: '运行设置', sectionTitle: '运行设置', sectionId: 'security-settings', kind: 'section' },
    { page: 'overview', title: '最近活动（100 条）', sectionTitle: '最近活动（100 条）', sectionId: 'recent-activity', kind: 'section' },
    { page: 'sessions', title: '待处理提问与工具审批', sectionTitle: '待处理提问与工具审批', sectionId: 'chat-interactions', kind: 'section' },
    { page: 'schedules', title: '待执行', sectionTitle: '待执行', sectionId: 'schedule-upcoming', kind: 'section' },
    { page: 'schedules', title: '执行记录', sectionTitle: '执行记录', sectionId: 'schedule-history', kind: 'section' },
    { page: 'features', title: '框架注入 DSH', sectionTitle: '框架注入 DSH', sectionId: 'chat-tools', kind: 'section' },
    { page: 'features', title: '扩展注入 DSH', sectionTitle: '扩展注入 DSH', sectionId: 'extension-dsh-tools', kind: 'section' },
    { page: 'features', title: 'DSH 自带工具', sectionTitle: 'DSH 自带工具', sectionId: 'dsh-builtin-tools', kind: 'section' },
    { page: 'features', title: '本地扩展包', sectionTitle: '本地扩展包', sectionId: 'local-extensions', kind: 'section' },
    { page: 'features', title: '框架服务', sectionTitle: '框架服务', sectionId: 'framework-services', kind: 'section' },
    { page: 'persona', title: '人设库', sectionTitle: '人设库', kind: 'section' },
    { page: 'adapters', title: '聊天运行', sectionTitle: '聊天运行', kind: 'section' },
    ...(runtimeConnected ? Object.values(usageSectionLabels).map(title => ({
      page: 'usage' as const, title, sectionTitle: title, kind: 'section' as const,
    })) : []),
  ]);
  if (sources.currentPage && sources.visibleEntries) {
    targets = applyCurrentPageVisibility(targets, canonicalPageId(sources.currentPage), sources.visibleEntries);
  }
  return targets;
}

export function normalizeWorkspaceSearchQuery(query: string): readonly string[] {
  return query.normalize('NFKC').trim().toLocaleLowerCase('zh-CN').split(/\s+/).filter(Boolean);
}

function searchableText(target: WorkspaceSearchTarget): string {
  const aliases = target.kind === 'page' ? pageDefinition(target.page).searchAliases ?? '' : '';
  return (target.kind === 'field' ? [target.title] : [workspacePageTitle(target.page), target.sectionTitle, target.title, aliases])
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
    const pageTargets = targets.filter(target => canonicalPageId(target.page) === page.id)
      .map(target => ({ ...target, page: page.id }));
    return pageTargets.length > 0 ? [{ page: page.id, title: page.title, targets: pageTargets }] : [];
  });
}

export function workspaceSearchPath(target: WorkspaceSearchTarget): string {
  if (target.kind === 'page') return `${workspacePageTitle(target.page)} · 页面快捷入口`;
  if (target.kind === 'section') return `${workspacePageTitle(target.page)} · ${target.title}`;
  return `${workspacePageTitle(target.page)} · ${target.sectionTitle ?? '设置'} · ${target.title}`;
}

export function isPageId(value: unknown): value is PageId {
  return registeredPageId(value);
}

export function isWorkspaceSearchShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat
    || event.key.toLocaleLowerCase() !== 'k' || (!event.ctrlKey && !event.metaKey) || event.altKey) return false;
  return !(event.target instanceof Element && event.target.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]'
  ));
}
