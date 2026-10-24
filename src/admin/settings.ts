import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { resolve } from 'node:path';

import { AdminRequestError, type AdminRoute } from './server.ts';

const MAX_CONFIGURATION_BYTES = 64 * 1024;
const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_PENDING = 16;
const DEFAULT_MAX_BODY_BYTES = 28 * 1024 * 1024;
const DEFAULT_MAX_RECORDS = 10_000;

export interface GatewaySettingsValues {
  readonly budgetEnabled: boolean;
  readonly maxSendUses: number | null;
  readonly grantTtlMs: number | null;
  readonly timeoutMs: number;
  readonly maxPending: number;
  readonly maxBodyBytes: number;
  readonly maxRecords: number;
}

export interface AdminSettingsValues {
  readonly host: string;
  readonly port: number;
}

export interface SettingsSnapshot {
  readonly gateway: {
    readonly revision: string;
    readonly values: GatewaySettingsValues;
  };
  readonly admin: {
    readonly revision: string;
    readonly values: AdminSettingsValues;
  };
  readonly capabilities: {
    readonly applyGateway: boolean;
    readonly applyAdmin: boolean;
  };
}

export interface SettingsRouteOptions {
  readonly adminConfigurationFilename: string;
  readonly gatewayConfigurationFilename: string;
  readonly apply?: (target: 'gateway' | 'admin', revision: string) => unknown | Promise<unknown>;
}

interface ConfigurationDocument {
  readonly revision: string;
  readonly values: Record<string, unknown>;
}

const writeTails = new Map<string, Promise<void>>();

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

function revision(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function sameFile(
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number }
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readConfiguration(filename: string): Promise<ConfigurationDocument> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || (before.mode & 0o077) !== 0 || before.size > MAX_CONFIGURATION_BYTES) {
      requestError(500, 'settings_file_invalid');
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    const pathname = await lstat(filename);
    if (content.byteLength > MAX_CONFIGURATION_BYTES || !sameFile(before, after) || !sameFile(after, pathname)
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      requestError(409, 'settings_conflict');
    }
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content));
    if (!isRecord(parsed)) requestError(500, 'settings_file_invalid');
    return { revision: revision(content), values: parsed };
  } catch (error: unknown) {
    if (error instanceof AdminRequestError) throw error;
    throw new AdminRequestError(500, 'settings_file_invalid');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function boundedInteger(value: unknown, lower: number, upper: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= lower && value <= upper;
}

function gatewayValues(configuration: Record<string, unknown>): GatewaySettingsValues {
  const budgetEnabled = configuration.budgetEnabled ?? true;
  const maxSendUses = configuration.maxSendUses ?? null;
  const grantTtlMs = configuration.grantTtlMs ?? null;
  const timeoutMs = configuration.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxPending = configuration.maxPending ?? DEFAULT_MAX_PENDING;
  const maxBodyBytes = configuration.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxRecords = configuration.maxRecords ?? DEFAULT_MAX_RECORDS;
  if (typeof budgetEnabled !== 'boolean'
    || maxSendUses !== null && !boundedInteger(maxSendUses, 1, Number.MAX_SAFE_INTEGER)
    || grantTtlMs !== null && !boundedInteger(grantTtlMs, 1_000, 7 * 86_400_000)
    || !boundedInteger(timeoutMs, 10, 120_000)
    || !boundedInteger(maxPending, 1, 64)
    || !boundedInteger(maxBodyBytes, 1_024, 32 * 1_024 * 1_024)
    || !boundedInteger(maxRecords, 100, 100_000)) {
    requestError(500, 'settings_file_invalid');
  }
  return Object.freeze({
    budgetEnabled,
    maxSendUses,
    grantTtlMs,
    timeoutMs,
    maxPending,
    maxBodyBytes,
    maxRecords
  });
}

function validHost(value: unknown): value is string {
  return value === 'localhost' || typeof value === 'string' && isIP(value) !== 0;
}

function adminValues(configuration: Record<string, unknown>): AdminSettingsValues {
  if (!validHost(configuration.host) || !boundedInteger(configuration.port, 1, 65_535)) {
    requestError(500, 'settings_file_invalid');
  }
  return Object.freeze({ host: configuration.host, port: configuration.port });
}

function parseRevision(value: unknown): string {
  if (typeof value !== 'string' || !REVISION_PATTERN.test(value)) requestError(400, 'invalid_settings');
  return value;
}

function parseGatewayRequest(body: Record<string, unknown> | null): {
  readonly revision: string;
  readonly values: GatewaySettingsValues;
} {
  if (!isRecord(body) || !hasExactKeys(body, ['revision', 'values']) || !isRecord(body.values)
    || !hasExactKeys(body.values, [
      'budgetEnabled', 'maxSendUses', 'grantTtlMs', 'timeoutMs', 'maxPending', 'maxBodyBytes', 'maxRecords'
    ])) requestError(400, 'invalid_settings');
  const values = body.values;
  if (typeof values.budgetEnabled !== 'boolean'
    || values.maxSendUses !== null && !boundedInteger(values.maxSendUses, 1, Number.MAX_SAFE_INTEGER)
    || values.grantTtlMs !== null && !boundedInteger(values.grantTtlMs, 1_000, 7 * 86_400_000)
    || !boundedInteger(values.timeoutMs, 10, 120_000)
    || !boundedInteger(values.maxPending, 1, 64)
    || !boundedInteger(values.maxBodyBytes, 1_024, 32 * 1_024 * 1_024)
    || !boundedInteger(values.maxRecords, 100, 100_000)) requestError(400, 'invalid_settings');
  return {
    revision: parseRevision(body.revision),
    values: Object.freeze({
      budgetEnabled: values.budgetEnabled,
      maxSendUses: values.maxSendUses,
      grantTtlMs: values.grantTtlMs,
      timeoutMs: values.timeoutMs,
      maxPending: values.maxPending,
      maxBodyBytes: values.maxBodyBytes,
      maxRecords: values.maxRecords
    })
  };
}

function parseAdminRequest(body: Record<string, unknown> | null): {
  readonly revision: string;
  readonly values: AdminSettingsValues;
} {
  if (!isRecord(body) || !hasExactKeys(body, ['revision', 'values']) || !isRecord(body.values)
    || !hasExactKeys(body.values, ['host', 'port']) || !validHost(body.values.host)
    || !boundedInteger(body.values.port, 1, 65_535)) requestError(400, 'invalid_settings');
  return {
    revision: parseRevision(body.revision),
    values: Object.freeze({ host: body.values.host, port: body.values.port })
  };
}

function parseApplyRequest(body: Record<string, unknown> | null): {
  readonly target: 'gateway' | 'admin';
  readonly revision: string;
} {
  if (!isRecord(body) || !hasExactKeys(body, ['target', 'revision'])
    || body.target !== 'gateway' && body.target !== 'admin') requestError(400, 'invalid_settings');
  return { target: body.target, revision: parseRevision(body.revision) };
}

function unchangedBudget(left: GatewaySettingsValues, right: GatewaySettingsValues): boolean {
  return left.budgetEnabled === right.budgetEnabled
    && left.maxSendUses === right.maxSendUses
    && left.grantTtlMs === right.grantTtlMs;
}

async function serializeWrite<Value>(filename: string, operation: () => Promise<Value>): Promise<Value> {
  const previous = writeTails.get(filename) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>(resolvePromise => { release = resolvePromise; });
  const tail = previous.catch(() => undefined).then(() => current);
  writeTails.set(filename, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release?.();
    if (writeTails.get(filename) === tail) writeTails.delete(filename);
  }
}

async function replaceConfiguration(
  filename: string,
  expectedRevision: string,
  update: (configuration: Record<string, unknown>) => void
): Promise<string> {
  return serializeWrite(filename, async () => {
    const current = await readConfiguration(filename);
    if (current.revision !== expectedRevision) requestError(409, 'settings_conflict');
    update(current.values);
    let content: Buffer;
    try {
      content = Buffer.from(`${JSON.stringify(current.values)}\n`);
    } catch {
      requestError(500, 'settings_write_failed');
    }
    if (content.byteLength > MAX_CONFIGURATION_BYTES) requestError(413, 'settings_file_too_large');
    const temporary = `${filename}.settings-${process.pid}-${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handle = undefined;
      const latest = await readConfiguration(filename);
      if (latest.revision !== expectedRevision) requestError(409, 'settings_conflict');
      await rename(temporary, filename);
      return revision(content);
    } catch (error: unknown) {
      if (error instanceof AdminRequestError) throw error;
      requestError(500, 'settings_write_failed');
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  });
}

function requireEmptyQuery(query: URLSearchParams): void {
  if ([...query.keys()].length !== 0) requestError(400, 'invalid_query');
}

export async function readSettings(options: SettingsRouteOptions): Promise<SettingsSnapshot> {
  const [gateway, admin] = await Promise.all([
    readConfiguration(resolve(options.gatewayConfigurationFilename)),
    readConfiguration(resolve(options.adminConfigurationFilename))
  ]);
  const applyAvailable = typeof options.apply === 'function';
  return Object.freeze({
    gateway: Object.freeze({ revision: gateway.revision, values: gatewayValues(gateway.values) }),
    admin: Object.freeze({ revision: admin.revision, values: adminValues(admin.values) }),
    capabilities: Object.freeze({ applyGateway: applyAvailable, applyAdmin: applyAvailable })
  });
}

export function createSettingsRoutes(options: SettingsRouteOptions): readonly AdminRoute[] {
  if (!isRecord(options) || typeof options.adminConfigurationFilename !== 'string'
    || options.adminConfigurationFilename.length === 0 || typeof options.gatewayConfigurationFilename !== 'string'
    || options.gatewayConfigurationFilename.length === 0
    || options.apply !== undefined && typeof options.apply !== 'function') {
    throw new TypeError('Settings routes require configuration filenames and an optional apply callback.');
  }
  const adminConfigurationFilename = resolve(options.adminConfigurationFilename);
  const gatewayConfigurationFilename = resolve(options.gatewayConfigurationFilename);
  if (adminConfigurationFilename === gatewayConfigurationFilename) {
    throw new TypeError('Settings configuration files must be distinct.');
  }
  const normalized: SettingsRouteOptions = {
    adminConfigurationFilename,
    gatewayConfigurationFilename,
    ...(options.apply === undefined ? {} : { apply: options.apply })
  };

  const routes: AdminRoute[] = [
    {
      method: 'GET',
      pathname: '/api/settings',
      async handle({ query }) {
        requireEmptyQuery(query);
        return readSettings(normalized);
      }
    },
    {
      method: 'POST',
      pathname: '/api/settings/gateway',
      async handle({ query, body }) {
        requireEmptyQuery(query);
        const request = parseGatewayRequest(body);
        let budgetChanged = false;
        const nextRevision = await replaceConfiguration(gatewayConfigurationFilename, request.revision, configuration => {
          const previous = gatewayValues(configuration);
          budgetChanged = !unchangedBudget(previous, request.values);
          configuration.budgetEnabled = request.values.budgetEnabled;
          if (request.values.maxSendUses === null) delete configuration.maxSendUses;
          else configuration.maxSendUses = request.values.maxSendUses;
          configuration.grantTtlMs = request.values.grantTtlMs;
          configuration.timeoutMs = request.values.timeoutMs;
          configuration.maxPending = request.values.maxPending;
          configuration.maxBodyBytes = request.values.maxBodyBytes;
          configuration.maxRecords = request.values.maxRecords;
          if (budgetChanged) configuration.authorizationVersion = randomUUID();
        });
        return {
          ok: true,
          revision: nextRevision,
          restartRequired: true,
          ...(budgetChanged ? { budgetReauthorization: 'pending_until_apply' as const } : {})
        };
      }
    },
    {
      method: 'POST',
      pathname: '/api/settings/admin',
      async handle({ query, body }) {
        requireEmptyQuery(query);
        const request = parseAdminRequest(body);
        const nextRevision = await replaceConfiguration(adminConfigurationFilename, request.revision, configuration => {
          configuration.host = request.values.host;
          configuration.port = request.values.port;
        });
        return { ok: true, revision: nextRevision, restartRequired: true };
      }
    },
    {
      method: 'POST',
      pathname: '/api/settings/apply',
      async handle({ query, body }) {
        requireEmptyQuery(query);
        const request = parseApplyRequest(body);
        if (normalized.apply === undefined) requestError(409, 'settings_apply_unavailable');
        const filename = request.target === 'gateway' ? gatewayConfigurationFilename : adminConfigurationFilename;
        const current = await readConfiguration(filename);
        if (current.revision !== request.revision) requestError(409, 'settings_conflict');
        let application: unknown;
        try {
          application = await normalized.apply(request.target, request.revision);
        } catch (error: unknown) {
          if (error instanceof AdminRequestError) throw error;
          requestError(500, 'settings_apply_failed');
        }
        return { ok: true, target: request.target, revision: request.revision,
          ...(application === undefined ? {} : { application }) };
      }
    }
  ];
  return Object.freeze(routes.map(route => Object.freeze(route)));
}
