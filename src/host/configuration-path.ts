import { isAbsolute, resolve } from 'node:path';

const MAX_CONFIGURATION_PATH_BYTES = 4096;

export function isConfigurationPath(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_CONFIGURATION_PATH_BYTES
    && !/[\x00-\x1f\x7f]/.test(value)
    && (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || isAbsolute(value));
}

export function resolveConfigurationPath(value: string, base = process.cwd()): string {
  if (!isConfigurationPath(value)) throw new TypeError('A bounded local configuration file path is required.');
  const absolute = resolve(base, value);
  if (!isConfigurationPath(absolute)) throw new TypeError('The resolved configuration file path exceeds its byte limit.');
  return absolute;
}
