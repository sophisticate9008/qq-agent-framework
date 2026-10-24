export interface VisibilityField {
  readonly id: string;
  readonly label: string;
  readonly dependsOn?: readonly string[];
}

export interface VisibilityGroup {
  readonly id: string;
  readonly title: string;
  readonly fields: readonly VisibilityField[];
  readonly dependsOn?: readonly string[];
}

export interface ConfigurationVisibilityOptions {
  readonly values: Readonly<Record<string, unknown>>;
  readonly dirtyFieldIds?: ReadonlySet<string>;
  readonly showInactive?: boolean;
}

export interface GroupVisibility {
  readonly visible: boolean;
  readonly fieldIds: ReadonlySet<string>;
  readonly inactiveDirtyFieldIds: ReadonlySet<string>;
}

export function resolveConfigurationVisibility(
  groups: readonly VisibilityGroup[],
  options: ConfigurationVisibilityOptions
): ReadonlyMap<string, GroupVisibility> {
  const dirtyFieldIds = options.dirtyFieldIds ?? new Set<string>();
  const result = new Map<string, GroupVisibility>();

  for (const group of groups) {
    const groupEnabled = (group.dependsOn ?? []).every(parentId => options.values[parentId] === true);
    const fieldIds = new Set<string>();
    const inactiveDirtyFieldIds = new Set<string>();

    for (const field of group.fields) {
      const normallyVisible = groupEnabled && (field.dependsOn ?? []).every(parentId => options.values[parentId] === true);
      const dirty = dirtyFieldIds.has(field.id);
      if (normallyVisible || options.showInactive === true || dirty) fieldIds.add(field.id);
      if (dirty && !normallyVisible) inactiveDirtyFieldIds.add(field.id);
    }

    result.set(group.id, {
      visible: fieldIds.size > 0,
      fieldIds,
      inactiveDirtyFieldIds
    });
  }

  return result;
}

export function configurationSearchMatch(
  group: VisibilityGroup,
  visibleFieldIds: ReadonlySet<string>,
  normalizedQuery: string
): ReadonlySet<string> | null | undefined {
  if (visibleFieldIds.size === 0) return undefined;
  if (!normalizedQuery || group.title.toLocaleLowerCase('zh-CN').includes(normalizedQuery)) return null;
  const fieldIds = new Set(group.fields
    .filter(field => visibleFieldIds.has(field.id) && field.label.toLocaleLowerCase('zh-CN').includes(normalizedQuery))
    .map(field => field.id));
  return fieldIds.size > 0 ? fieldIds : undefined;
}
