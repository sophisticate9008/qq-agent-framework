export function isCatalogIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

export const catalogIdentifierDescription = '内部标识只能使用字母、数字、冒号、点、下划线和短横线，且必须以字母或数字开头，不能超过 128 个字符。';
