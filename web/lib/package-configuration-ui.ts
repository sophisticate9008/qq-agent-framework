import { isPackageConfigurationValue, type PackageConfigurationValue, type PackageConfigurationField, type PackageConfigurationDescriptor } from '../../src/contracts/package-configuration.ts';
export type PackageFieldDraft = boolean | string;
export function packageFieldValue(value: PackageConfigurationValue, path: readonly string[]): PackageConfigurationValue | undefined {
  let current: PackageConfigurationValue | undefined = value;
  for (const part of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || !Object.hasOwn(current, part)) return undefined;
    current = (current as Readonly<Record<string, PackageConfigurationValue>>)[part];
  }
  return current;
}
export function packageFieldDraft(field: PackageConfigurationField, configuration: PackageConfigurationValue): PackageFieldDraft | null {
  const value = packageFieldValue(configuration, field.path);
  return field.kind === 'boolean' ? typeof value === 'boolean' ? value : null
    : field.kind === 'choice' ? typeof value === 'string' && field.options.some(option => option.value === value) ? value : null
    : field.kind === 'integer' || field.kind === 'number' ? typeof value === 'number' && Number.isFinite(value) && (field.kind !== 'integer' || Number.isSafeInteger(value)) ? String(value) : null
      : Array.isArray(value) && value.every(item => typeof item === 'string') ? value.join('\n') : null;
}
export function packageConfigurationDraft(descriptor: PackageConfigurationDescriptor, configuration: PackageConfigurationValue): Readonly<Record<string, PackageFieldDraft>> | null {
  const result: Record<string, PackageFieldDraft> = {};
  for (const field of descriptor.fields) { const value = packageFieldDraft(field, configuration); if (value === null) return null; result[field.id] = value; }
  return result;
}
export function packageConfigurationChanges(descriptor: PackageConfigurationDescriptor, configuration: PackageConfigurationValue, drafts: Readonly<Record<string, PackageFieldDraft>>): PackageConfigurationValue {
  const cloned: unknown = structuredClone(configuration); if (!isPackageConfigurationValue(cloned)) throw new Error('配置内容未通过核验');
  for (const field of descriptor.fields) {
    const draft = drafts[field.id]; let value: PackageConfigurationValue;
    if (field.kind === 'boolean') { if (typeof draft !== 'boolean') throw new Error(`${field.label}需要明确选择`); value = draft; }
    else if (field.kind === 'choice') { if (typeof draft !== 'string' || !field.options.some(option => option.value === draft)) throw new Error(`${field.label}需要选择有效选项`); value = draft; }
    else if (field.kind === 'integer' || field.kind === 'number') { if (typeof draft !== 'string' || !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(draft) || !Number.isFinite(Number(draft)) || field.kind === 'integer' && !Number.isSafeInteger(Number(draft)) || Number(draft) < field.minimum || Number(draft) > field.maximum) throw new Error(`${field.label}需要 ${field.minimum} 到 ${field.maximum} 的${field.kind === 'integer' ? '整数' : '数字'}`); value = Number(draft); }
    else { if (typeof draft !== 'string') throw new Error(`${field.label}需要填写列表`); const values = draft.split('\n').map(item => item.trim()).filter(Boolean); if (values.length > field.maximumEntries || values.some(item => item.length > field.maximumLength)) throw new Error(`${field.label}超出列表数量或单项长度限制`); value = values; }
    let target: PackageConfigurationValue = cloned;
    for (const part of field.path.slice(0, -1)) { const next = packageFieldValue(target, [part]); if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('配置字段路径已变化，请重新读取'); target = next; }
    const key = field.path.at(-1); if (!key || !target || typeof target !== 'object' || Array.isArray(target) || !Object.hasOwn(target, key)) throw new Error('配置字段路径不存在，请重新读取');
    (target as Record<string, PackageConfigurationValue>)[key] = value;
  }
  return cloned;
}
