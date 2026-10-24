import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { LegacyAccess } from '../integrations/legacy-admin.ts';
import { loadOneBotGatewayConfiguration, type OneBotGatewayConfiguration } from '../host/onebot-gateway.ts';
import { AdminRequestError } from './server.ts';
import { isRecord } from '../core/values.ts';

type Source = 'gateway' | 'admin' | 'bridge';
const execute = promisify(execFile);

export interface ManagementOperationsOptions {
  adminConfigurationFilename: string;
  gatewayConfigurationFilename: string;
  serviceManager: string;
  legacyConfigurationFilename?: string;
  fetch?: typeof globalThis.fetch;
  operationTimeoutMs?: number;
}

function privateConfiguration(filename: string): { text: string; value: Record<string, unknown>; revision: string } {
  const metadata = lstatSync(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 || metadata.size > 1024 * 1024) {
    throw new AdminRequestError(500, 'management_configuration_invalid');
  }
  const text = readFileSync(filename, 'utf8');
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new AdminRequestError(500, 'management_configuration_invalid');
  return { text, value, revision: createHash('sha256').update(text).digest('hex') };
}

function replace(filename: string, expected: string, value: Record<string, unknown>): string {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const next = JSON.stringify(value, null, 2) + '\n';
  try {
    writeFileSync(temporary, next, { mode: 0o600, flag: 'wx' });
    if (readFileSync(filename, 'utf8') !== expected) throw new AdminRequestError(409, 'revision_conflict');
    renameSync(temporary, filename);
    return createHash('sha256').update(next).digest('hex');
  } finally { try { unlinkSync(temporary); } catch {} }
}

function requireRevision(filename: string, revision: string): void {
  if (privateConfiguration(filename).revision !== revision) throw new AdminRequestError(409, 'revision_conflict');
}

export function createManagementOperations(options: ManagementOperationsOptions) {
  const files: Readonly<Record<Source, string | undefined>> = {
    gateway: resolve(options.gatewayConfigurationFilename),
    admin: resolve(options.adminConfigurationFilename),
    bridge: options.legacyConfigurationFilename === undefined ? undefined : resolve(options.legacyConfigurationFilename),
  };
  const manager = resolve(options.serviceManager);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const operationTimeoutMs = options.operationTimeoutMs ?? 65_000;
  if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 10 || operationTimeoutMs > 65_000) {
    throw new AdminRequestError(500, 'management_configuration_invalid');
  }
  let linkedEndpoint: string | undefined;
  let bridgeRestartPending = false;
  if (files.bridge) {
    const original = privateConfiguration(files.bridge).value;
    if (isRecord(original.snowluma)) {
      if (typeof original.snowluma.httpUrl === 'string') linkedEndpoint = original.snowluma.httpUrl;
    }
  }
  let busy = false;

  async function validateProtocol(configuration: Readonly<OneBotGatewayConfiguration>, signal: AbortSignal): Promise<void> {
    const token = readFileSync(configuration.upstreamTokenFile ?? configuration.tokenFile, 'utf8').trim();
    try {
      const url = new URL(configuration.upstreamEndpoint);
      url.pathname = `${url.pathname.replace(/\/$/, '')}/get_status`;
      const response = await fetchImplementation(url, { method: 'POST', headers: { authorization: `Bearer ${token}`,
        'content-type': 'application/json' }, body: '{}', redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
      const body: unknown = await response.json();
      if (!response.ok || !isRecord(body) || body.retcode !== 0) throw new Error('invalid_protocol');
    } catch {
      if (signal.aborted) throw new AdminRequestError(504, 'management_operation_unknown');
      throw new AdminRequestError(400, 'protocol_connection_invalid');
    }
  }

  async function restartComponent(component: string, signal: AbortSignal, deadline: number): Promise<void> {
    const remaining = deadline - Date.now();
    if (signal.aborted || remaining <= 0) throw new AdminRequestError(504, 'management_operation_unknown');
    await execute(manager, ['restart', component], {
      timeout: Math.min(60_000, remaining), maxBuffer: 64 * 1024, signal,
    });
  }

  async function restart(source: Source, revision: string): Promise<Record<string, unknown>> {
    const filename = files[source];
    if (!filename) throw new AdminRequestError(409, 'settings_apply_unavailable');
    requireRevision(filename, revision);
    if (busy) throw new AdminRequestError(409, 'management_operation_running');
    busy = true;
    if (source === 'admin') {
      const configuration = privateConfiguration(filename).value;
      const host = configuration.host;
      const port = configuration.port;
      const address = typeof host === 'string' && !['0.0.0.0', '::'].includes(host)
        ? `http://${host.includes(':') ? `[${host}]` : host}:${port}` : null;
      const timer = setTimeout(() => {
        try {
          const child = spawn(manager, ['restart', 'framework-admin'], { detached: true, stdio: 'ignore' });
          child.once('error', () => { busy = false; });
          child.unref();
        } catch { busy = false; }
      }, 300);
      timer.unref();
      return { accepted: true, reconnect: true, ...(address === null ? { port } : { reconnectUrl: address }) };
    }
    let applicationStarted = false;
    try {
      const deadline = Date.now() + operationTimeoutMs;
      const operationSignal = AbortSignal.timeout(operationTimeoutMs);
      const gateway = loadOneBotGatewayConfiguration(files.gateway!);
      const gatewayRevision = privateConfiguration(files.gateway!).revision;
      if (source === 'gateway' && gateway.port === 0) {
        throw new AdminRequestError(400, 'managed_gateway_port_required');
      }
      const bridge = files.bridge === undefined ? undefined : privateConfiguration(files.bridge);
      if (bridge !== undefined) {
        const incomingToken = readFileSync(gateway.tokenFile, 'utf8').trim();
        if (!isRecord(bridge.value.snowluma) || bridge.value.snowluma.accessToken !== incomingToken) {
          throw new AdminRequestError(400, 'protocol_credentials_mismatch');
        }
      }
      const nextEndpoint = source === 'gateway' && linkedEndpoint !== undefined
        ? `http://127.0.0.1:${gateway.port}` : undefined;
      const updateBridge = bridge !== undefined && nextEndpoint !== undefined && nextEndpoint !== linkedEndpoint;
      if ((updateBridge || bridgeRestartPending)
        && (!isRecord(bridge?.value.snowluma) || bridge.value.snowluma.httpUrl !== linkedEndpoint)) {
        throw new AdminRequestError(409, 'managed_gateway_endpoint_changed');
      }
      await validateProtocol(gateway, operationSignal);
      requireRevision(filename, revision);
      requireRevision(files.gateway!, gatewayRevision);
      if (bridge !== undefined) requireRevision(files.bridge!, bridge.revision);
      applicationStarted = true;
      await restartComponent(source === 'gateway' ? 'framework-gateway' : 'bridge', operationSignal, deadline);
      requireRevision(filename, revision);
      requireRevision(files.gateway!, gatewayRevision);
      if (bridge !== undefined) requireRevision(files.bridge!, bridge.revision);
      let bridgeRevision = bridge?.revision;
      if (updateBridge && bridge !== undefined && nextEndpoint !== undefined && isRecord(bridge.value.snowluma)) {
        bridge.value.snowluma.httpUrl = nextEndpoint;
        bridgeRevision = replace(files.bridge!, bridge.text, bridge.value);
        linkedEndpoint = nextEndpoint;
        bridgeRestartPending = true;
      }
      if (source === 'gateway' && bridgeRestartPending && bridgeRevision !== undefined) {
        await restartComponent('bridge', operationSignal, deadline);
        requireRevision(filename, revision);
        requireRevision(files.gateway!, gatewayRevision);
        requireRevision(files.bridge!, bridgeRevision);
        bridgeRestartPending = false;
      }
      requireRevision(filename, revision);
      return { applied: true };
    } catch (error) {
      if (applicationStarted) throw new AdminRequestError(504, 'management_operation_unknown');
      if (error instanceof AdminRequestError) throw error;
      throw new AdminRequestError(504, 'management_operation_unknown');
    } finally { busy = false; }
  }

  async function synchronizeAccess(access: LegacyAccess, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new AdminRequestError(409, 'operation_aborted');
    if (busy) throw new AdminRequestError(409, 'management_operation_running');
    const filename = files.gateway!;
    const original = privateConfiguration(filename);
    const deniedGroups = new Set(access.deny.groups);
    const deniedPrivate = new Set(access.deny.private);
    const targets = [
      ...access.allow.groups.filter(value => !deniedGroups.has(value)).map(value => `group:${value}`),
      ...access.allow.private.filter(value => !deniedPrivate.has(value)).map(value => `private:${value}`),
    ].sort();
    const previous = Array.isArray(original.value.allowedConversations)
      ? [...original.value.allowedConversations].sort() : [];
    if (JSON.stringify(previous) === JSON.stringify(targets)) return;
    original.value.allowedConversations = targets;
    original.value.authorizationVersion = randomUUID();
    const revision = replace(filename, original.text, original.value);
    loadOneBotGatewayConfiguration(filename);
    await restart('gateway', revision);
  }

  return Object.freeze({ apply: restart, synchronizeAccess });
}
