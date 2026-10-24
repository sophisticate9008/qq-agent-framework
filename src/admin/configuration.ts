import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { dirname, isAbsolute, normalize, resolve, sep, win32 } from 'node:path';

import { AdminRequestError, type AdminRoute } from './server.ts';
import { withConfigurationWriteLock } from './configuration-lock.ts';
import { createAdminOriginPolicy, isLoopbackAddress, validatePublicOrigin } from './public-origin.ts';
import { loadOneBotGatewayConfiguration } from '../host/onebot-gateway.ts';
import {
  CONFIGURATION_SCHEMA,
  configurationSchemaForSource,
  type ConfigurationField,
  type ConfigurationFieldDefinition,
  type ConfigurationGroup,
  type ConfigurationGroupDefinition,
  type ConfigurationSource
} from './configuration-schema.ts';

const MAX_CONFIGURATION_BYTES = 64 * 1024;
const MAX_CHANGES = 256;
const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface ConfigurationRouteOptions {
  readonly gatewayConfigurationFilename: string;
  readonly adminConfigurationFilename: string;
  readonly apply?: (
    source: ConfigurationSource,
    revision: string
  ) => unknown | Promise<unknown>;
}

interface ConfigurationDocument {
  readonly revision: string;
  readonly values: Record<string, unknown>;
}

interface SourceDescriptor {
  readonly source: ConfigurationSource;
  readonly filename: string;
  readonly maxBytes: number;
  readonly groups: readonly ConfigurationGroupDefinition[];
}

function requestError(statusCode: number, code: string): never {
  throw new AdminRequestError(statusCode, code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

function hasForbiddenKey(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (!isRecord(current)) continue;
    for (const [key, nested] of Object.entries(current)) {
      if (FORBIDDEN_KEYS.has(key)) return true;
      pending.push(nested);
    }
  }
  return false;
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function sameFile(
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number }
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readConfiguration(descriptor: SourceDescriptor): Promise<ConfigurationDocument> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(descriptor.filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || (before.mode & 0o077) !== 0 || before.size > descriptor.maxBytes) {
      requestError(500, 'configuration_file_invalid');
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    const pathname = await lstat(descriptor.filename);
    if (content.byteLength > descriptor.maxBytes || !sameFile(before, after) || !sameFile(after, pathname)
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      requestError(409, 'configuration_conflict');
    }
    let text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || hasForbiddenKey(parsed)) requestError(500, 'configuration_file_invalid');
    return { revision: sha256(content), values: parsed };
  } catch (error: unknown) {
    if (error instanceof AdminRequestError) throw error;
    requestError(500, 'configuration_file_invalid');
  } finally {
    await handle?.close().catch(() => undefined);
  }
  throw new AdminRequestError(500, 'configuration_file_invalid');
}

function ownValue(root: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function setValue(root: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let current = root;
  for (const segment of path.slice(0, -1)) {
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      const created: Record<string, unknown> = {};
      current[segment] = created;
      current = created;
      continue;
    }
    const nested = current[segment];
    if (!isRecord(nested) || hasForbiddenKey(nested)) requestError(500, 'configuration_file_invalid');
    current = nested;
  }
  const last = path.at(-1);
  if (last === undefined || FORBIDDEN_KEYS.has(last)) requestError(400, 'invalid_configuration');
  current[last] = value;
}

function deleteValue(root: Record<string, unknown>, path: readonly string[]): boolean {
  let current = root;
  for (const segment of path.slice(0, -1)) {
    const nested = current[segment];
    if (nested === undefined) return false;
    if (!isRecord(nested) || hasForbiddenKey(nested)) requestError(500, 'configuration_file_invalid');
    current = nested;
  }
  const last = path.at(-1);
  if (last === undefined || !Object.prototype.hasOwnProperty.call(current, last)) return false;
  delete current[last];
  return true;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right);
}

function isDisplayValue(field: ConfigurationFieldDefinition, value: unknown): boolean {
  if (field.presentation === 'json') return Array.isArray(value) || isRecord(value);
  if (field.type === 'boolean') return typeof value === 'boolean';
  if (field.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (field.type === 'list') return Array.isArray(value)
    && value.every(item => typeof item === 'string' || typeof item === 'number' && Number.isFinite(item));
  return typeof value === 'string';
}

function publicField(field: ConfigurationFieldDefinition, configuration: Record<string, unknown>): ConfigurationField {
  const raw = ownValue(configuration, field.path);
  const common = {
    id: field.id,
    label: field.label,
    description: field.description,
    type: field.type,
    ...(field.min === undefined ? {} : { min: field.min }),
    ...(field.max === undefined ? {} : { max: field.max }),
    ...(field.step === undefined ? {} : { step: field.step }),
    ...(field.unit === undefined ? {} : { unit: field.unit }),
    ...(field.options === undefined ? {} : { options: field.options }),
    ...(field.format === undefined ? {} : { format: field.format }),
    ...(field.editable === undefined ? {} : { editable: field.editable })
  };
  if (field.secret === true) {
    return Object.freeze({ ...common, value: null, configured: typeof raw === 'string' && raw.length > 0 });
  }
  let value: unknown = raw === undefined || !isDisplayValue(field, raw) ? null : raw;
  if (value !== null && field.presentation === 'json') {
    try {
      parseJsonPresentation(field, JSON.stringify(value));
      value = JSON.stringify(value, null, 2);
    } catch (error: unknown) {
      if (!(error instanceof AdminRequestError)) throw error;
      value = null;
    }
  }
  const credentialPath = field.id === 'tokenFile' || field.id === 'upstreamTokenFile';
  return Object.freeze({
    ...common,
    value,
    ...(credentialPath ? { configured: typeof raw === 'string' && raw.length > 0 } : {})
  });
}

function publicGroups(descriptor: SourceDescriptor, document: ConfigurationDocument): readonly ConfigurationGroup[] {
  return descriptor.groups.map(group => Object.freeze({
    id: group.id,
    title: group.title,
    description: group.description,
    category: group.category,
    source: group.source,
    revision: document.revision,
    fields: Object.freeze(group.fields.filter(field => !(descriptor.source === 'admin'
      && field.id === 'serviceManager'
      && ownValue(document.values, [field.id]) === undefined)).map(field => publicField(field, document.values))),
    ...(group.applyLabel === undefined ? {} : { applyLabel: group.applyLabel })
  }));
}

function parseRevision(value: unknown): string {
  if (typeof value !== 'string' || !REVISION_PATTERN.test(value)) requestError(400, 'invalid_configuration');
  return value;
}

function parseSource(value: unknown): ConfigurationSource {
  if (value !== 'gateway' && value !== 'admin') {
    requestError(400, 'invalid_configuration');
  }
  return value;
}

function requireEmptyQuery(query: URLSearchParams): void {
  if ([...query.keys()].length !== 0) requestError(400, 'invalid_query');
}

function validReference(value: string): boolean {
  return /^[\p{L}\p{N}][\p{L}\p{N}._:/@+-]{0,127}$/u.test(value) && !value.includes('..');
}

function validNormalizedPath(value: string): boolean {
  if (value === '') return true;
  if (value.includes('\0') || /[\r\n]/.test(value) || value.length > 1_024) return false;
  const windowsAbsolute = win32.isAbsolute(value);
  const nativeAbsolute = isAbsolute(value);
  if (!windowsAbsolute && !nativeAbsolute) {
    const segments = value.split(/[\\/]+/);
    return segments.every(segment => segment !== '..' && segment !== '')
      && normalize(value) !== '..' && !normalize(value).startsWith(`..${sep}`);
  }
  const normalized = windowsAbsolute ? win32.normalize(value) : normalize(value);
  return normalized === value || normalized.replace(/[\\/]+$/, '') === value.replace(/[\\/]+$/, '');
}

function loopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  if (isIP(host) !== 4) return false;
  return Number(host.split('.')[0]) === 127;
}

function validLoopbackUrl(value: string): boolean {
  if (value === '') return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'http:' && loopbackHostname(url.hostname)
    && !url.username && !url.password && !url.search && !url.hash;
}

function parseJsonPresentation(field: ConfigurationFieldDefinition, value: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    requestError(400, 'invalid_configuration');
  }
  if (hasForbiddenKey(parsed)) requestError(400, 'invalid_configuration');
  return parsed;
}

function validateList(field: ConfigurationFieldDefinition, value: unknown): void {
  if (!Array.isArray(value) || value.length > (field.maxItems ?? 100)) requestError(400, 'invalid_configuration');
  if (!value.every(item => typeof item === 'string' && item.length > 0
    && item.length <= (field.itemMaxLength ?? 128) && !/[\0\r\n]/.test(item))) {
    requestError(400, 'invalid_configuration');
  }
  if (field.id === 'allowedConversations' && (!value.every(item => typeof item === 'string'
    && /^(?:group|private):[1-9]\d{0,15}$/.test(item)) || new Set(value).size !== value.length)) {
    requestError(400, 'invalid_configuration');
  }
}

function normalizeFieldValue(field: ConfigurationFieldDefinition, input: unknown): unknown {
  if (field.type === 'boolean') {
    if (typeof input !== 'boolean') requestError(400, 'invalid_configuration');
    return input;
  }
  if (field.type === 'number') {
    if (typeof input !== 'number' || !Number.isFinite(input)
      || field.integer !== false && !Number.isSafeInteger(input)
      || field.min !== undefined && input < field.min || field.max !== undefined && input > field.max) {
      requestError(400, 'invalid_configuration');
    }
    return input;
  }
  if (field.type === 'list') {
    validateList(field, input);
    return input;
  }
  if (typeof input !== 'string' || input.length > (field.maxLength ?? 8_000)
    || input.includes('\0') || field.type !== 'textarea' && /[\r\n]/.test(input)) {
    requestError(400, 'invalid_configuration');
  }
  if (field.presentation === 'json') return parseJsonPresentation(field, input);
  if (field.type === 'select' && !field.options?.some(option => option.value === input)) {
    requestError(400, 'invalid_configuration');
  }
  if (field.allowUnset === false && input.length === 0) requestError(400, 'invalid_configuration');
  if (field.validation === 'public-origin') {
    try { validatePublicOrigin(input); } catch { requestError(400, 'invalid_configuration'); }
  }
  if (field.validation === 'reference' && !validReference(input)
    || field.validation === 'optional-path' && !validNormalizedPath(input)
    || field.validation === 'loopback-http-url' && !validLoopbackUrl(input)) {
    requestError(400, 'invalid_configuration');
  }
  return input;
}

function validateRelations(source: ConfigurationSource, configuration: Record<string, unknown>): void {
  if (source === 'admin') {
    try {
      createAdminOriginPolicy({ publicOrigin: configuration.publicOrigin as string | undefined,
        trustedLoopbackProxy: configuration.trustedLoopbackProxy as boolean | undefined });
      if (configuration.trustedLoopbackProxy === true && (typeof configuration.host !== 'string'
        || !isLoopbackAddress(configuration.host))) requestError(400, 'invalid_configuration');
    } catch { requestError(400, 'invalid_configuration'); }
  }
  if (source === 'gateway') {
    const port = ownValue(configuration, ['port']);
    const endpoint = ownValue(configuration, ['upstreamEndpoint']);
    if (typeof port === 'number' && typeof endpoint === 'string') {
      let upstream: URL;
      try {
        upstream = new URL(endpoint);
      } catch {
        requestError(400, 'invalid_configuration');
      }
      const upstreamPort = upstream.port === '' ? 80 : Number(upstream.port);
      if (port === upstreamPort) requestError(400, 'invalid_configuration');
    }
  }
}

function validateSourceCandidate(descriptor: SourceDescriptor, filename: string): void {
  if (descriptor.source !== 'gateway') return;
  try {
    loadOneBotGatewayConfiguration(filename);
  } catch {
    requestError(400, 'invalid_configuration');
  }
}

async function atomicReplace(
  descriptor: SourceDescriptor,
  expectedRevision: string,
  update: (configuration: Record<string, unknown>) => { readonly changed: boolean; readonly authorizationChanged: boolean }
): Promise<{ readonly revision: string; readonly authorizationChanged: boolean }> {
  return withConfigurationWriteLock(descriptor.filename, async () => {
    const current = await readConfiguration(descriptor);
    if (current.revision !== expectedRevision) requestError(409, 'configuration_conflict');
    const result = update(current.values);
    if (!result.changed) return { revision: current.revision, authorizationChanged: false };
    validateRelations(descriptor.source, current.values);
    let content: Buffer;
    try {
      content = Buffer.from(`${JSON.stringify(current.values, null, 2)}\n`);
    } catch {
      requestError(500, 'configuration_write_failed');
    }
    if (content.byteLength > descriptor.maxBytes) requestError(413, 'configuration_file_too_large');
    const temporary = `${descriptor.filename}.configuration-${process.pid}-${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let renamed = false;
    try {
      handle = await open(temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handle = undefined;
      validateSourceCandidate(descriptor, temporary);
      const latest = await readConfiguration(descriptor);
      if (latest.revision !== expectedRevision) requestError(409, 'configuration_conflict');
      await rename(temporary, descriptor.filename);
      renamed = true;
      let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        directoryHandle = await open(dirname(descriptor.filename), constants.O_RDONLY);
        await directoryHandle.sync();
      } finally {
        await directoryHandle?.close().catch(() => undefined);
      }
      const written = await readConfiguration(descriptor);
      if (written.revision !== sha256(content)) requestError(500, 'configuration_write_unknown');
      return { revision: sha256(content), authorizationChanged: result.authorizationChanged };
    } catch (error: unknown) {
      if (renamed) requestError(500, 'configuration_write_unknown');
      if (error instanceof AdminRequestError) throw error;
      requestError(500, 'configuration_write_failed');
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  });
}

function definitionsFor(descriptor: SourceDescriptor): ReadonlyMap<string, ConfigurationFieldDefinition> {
  const definitions = new Map<string, ConfigurationFieldDefinition>();
  for (const field of descriptor.groups.flatMap(group => group.fields)) {
    if (field.path.length === 0 || field.id !== field.path.join('.')
      || field.path.some(segment => segment.length === 0 || FORBIDDEN_KEYS.has(segment))
      || definitions.has(field.id)) {
      throw new TypeError('Configuration schema contains duplicate or unsafe field paths.');
    }
    definitions.set(field.id, field);
  }
  return definitions;
}

function parseSaveRequest(
  body: Record<string, unknown> | null,
  descriptors: ReadonlyMap<ConfigurationSource, SourceDescriptor>
): { readonly descriptor: SourceDescriptor; readonly revision: string; readonly changes: Record<string, unknown> } {
  if (!isRecord(body) || hasForbiddenKey(body) || !hasExactKeys(body, ['source', 'revision', 'changes'])
    || !isRecord(body.changes) || Object.keys(body.changes).length > MAX_CHANGES) {
    requestError(400, 'invalid_configuration');
  }
  const source = parseSource(body.source);
  const descriptor = descriptors.get(source);
  if (descriptor === undefined) requestError(400, 'configuration_source_unavailable');
  return { descriptor, revision: parseRevision(body.revision), changes: body.changes };
}

function parseApplyRequest(
  body: Record<string, unknown> | null,
  descriptors: ReadonlyMap<ConfigurationSource, SourceDescriptor>
): { readonly descriptor: SourceDescriptor; readonly revision: string } {
  if (!isRecord(body) || hasForbiddenKey(body) || !hasExactKeys(body, ['source', 'revision'])) {
    requestError(400, 'invalid_configuration');
  }
  const source = parseSource(body.source);
  const descriptor = descriptors.get(source);
  if (descriptor === undefined) requestError(400, 'configuration_source_unavailable');
  return { descriptor, revision: parseRevision(body.revision) };
}

function sourceDescriptors(options: ConfigurationRouteOptions): readonly SourceDescriptor[] {
  const gatewayConfigurationFilename = resolve(options.gatewayConfigurationFilename);
  const adminConfigurationFilename = resolve(options.adminConfigurationFilename);
  const descriptors: SourceDescriptor[] = [{
    source: 'gateway', filename: gatewayConfigurationFilename, maxBytes: MAX_CONFIGURATION_BYTES,
    groups: configurationSchemaForSource('gateway')
  }];
  descriptors.push({
    source: 'admin', filename: adminConfigurationFilename, maxBytes: MAX_CONFIGURATION_BYTES,
    groups: configurationSchemaForSource('admin')
  });
  if (new Set(descriptors.map(descriptor => descriptor.filename)).size !== descriptors.length) {
    throw new TypeError('Configuration source files must be distinct.');
  }
  return Object.freeze(descriptors.map(descriptor => Object.freeze(descriptor)));
}

export function createConfigurationRoutes(options: ConfigurationRouteOptions): readonly AdminRoute[] {
  if (!isRecord(options)
    || typeof options.gatewayConfigurationFilename !== 'string' || options.gatewayConfigurationFilename.length === 0
    || typeof options.adminConfigurationFilename !== 'string' || options.adminConfigurationFilename.length === 0
    || options.apply !== undefined && typeof options.apply !== 'function') {
    throw new TypeError('Configuration routes require source filenames and an optional apply callback.');
  }
  const descriptorList = sourceDescriptors(options);
  for (const descriptor of descriptorList) definitionsFor(descriptor);
  const descriptors = new Map(descriptorList.map(descriptor => [descriptor.source, descriptor] as const));

  const routes: AdminRoute[] = [
    {
      method: 'GET',
      pathname: '/api/configuration',
      async handle({ query }) {
        requireEmptyQuery(query);
        const documents = await Promise.all(descriptorList.map(descriptor => readConfiguration(descriptor)));
        return Object.freeze({
          groups: Object.freeze(descriptorList.flatMap((descriptor, index) => publicGroups(descriptor, documents[index]!))),
          capabilities: Object.freeze({ apply: options.apply !== undefined })
        });
      }
    },
    {
      method: 'POST',
      pathname: '/api/configuration',
      async handle({ query, body }) {
        requireEmptyQuery(query);
        const request = parseSaveRequest(body, descriptors);
        const definitions = definitionsFor(request.descriptor);
        for (const fieldId of Object.keys(request.changes)) {
          const definition = definitions.get(fieldId);
          if (definition === undefined || definition.editable === false) requestError(400, 'configuration_field_forbidden');
        }
        const saved = await atomicReplace(request.descriptor, request.revision, configuration => {
          let changed = false;
          let authorizationChanged = false;
          for (const [fieldId, input] of Object.entries(request.changes)) {
            const definition = definitions.get(fieldId)!;
            if (definition.secret === true && (input === null || typeof input === 'string' && input.trim() === '')) continue;
            if (input === null) {
              if (definition.allowUnset === false) requestError(400, 'invalid_configuration');
              changed = deleteValue(configuration, definition.path) || changed;
              continue;
            }
            const value = normalizeFieldValue(definition, input);
            const previous = ownValue(configuration, definition.path);
            if (valuesEqual(previous, value)) continue;
            setValue(configuration, definition.path, value);
            changed = true;
            if (definition.rotatesAuthorization === true) authorizationChanged = true;
          }
          if (request.descriptor.source === 'gateway' && authorizationChanged) {
            setValue(configuration, ['authorizationVersion'], randomUUID());
          }
          return { changed, authorizationChanged };
        });
        return Object.freeze({
          ok: true,
          source: request.descriptor.source,
          revision: saved.revision,
          applyRequired: true,
          ...(saved.authorizationChanged ? { authorizationReauthorization: 'pending_until_apply' as const } : {})
        });
      }
    },
    {
      method: 'POST',
      pathname: '/api/configuration/apply',
      async handle({ query, body }) {
        requireEmptyQuery(query);
        const request = parseApplyRequest(body, descriptors);
        if (options.apply === undefined) requestError(409, 'configuration_apply_unavailable');
        const current = await readConfiguration(request.descriptor);
        if (current.revision !== request.revision) requestError(409, 'configuration_conflict');
        let application: unknown;
        try {
          application = await options.apply(request.descriptor.source, request.revision);
        } catch (error: unknown) {
          if (error instanceof AdminRequestError) throw error;
          requestError(500, 'configuration_apply_failed');
        }
        return Object.freeze({
          ok: true,
          source: request.descriptor.source,
          revision: request.revision,
          ...(application === undefined ? {} : { application })
        });
      }
    }
  ];
  return Object.freeze(routes.map(route => Object.freeze(route)));
}

export { CONFIGURATION_SCHEMA };
