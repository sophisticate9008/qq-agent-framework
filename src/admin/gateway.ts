import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { isIP, type AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';

import type { OneBotCompatGatewayMetrics, OneBotCompatPolicyMetric } from '../adapters/onebot-compat.ts';
import { assert, isRecord, reference, snapshot } from '../core/values.ts';
import {
  loadOneBotGatewayConfiguration,
  type OneBotGatewayConfiguration
} from '../host/onebot-gateway.ts';
import { createAdminServer, type AdminRoute } from './server.ts';
import { createAdminBootstrap } from './bootstrap.ts';
import { createSettingsRoutes } from './settings.ts';
import { createManagementOperations } from './operations.ts';
import { createLegacyAdminRoutes } from '../integrations/legacy-admin.ts';
import { createConfigurationRoutes } from './configuration.ts';

const FRAMEWORK_VERSION = '0.1.0';
const PROBE_TIMEOUT_MS = 2_500;
const MAX_RESPONSE_BYTES = 256 * 1024;

export interface GatewayAdminConfiguration {
  host: string;
  port: number;
  tokenFile: string;
  gatewayConfiguration: string;
  legacyRoot?: string;
  serviceManager?: string;
  accessSessionTtlMs?: number;
}

interface GatewayHealth {
  readonly ok: boolean;
  readonly mode: 'legacy-egress-compatibility' | null;
  readonly metrics: OneBotCompatGatewayMetrics | null;
  readonly error: string | null;
}

interface GatewayStatus {
  readonly verified: boolean;
  readonly online: boolean | null;
  readonly good: boolean | null;
  readonly error: string | null;
}

class GatewayProbeError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function privateText(filename: string, maxBytes: number): string {
  const metadata = lstatSync(filename);
  assert(metadata.isFile() && !metadata.isSymbolicLink() && (metadata.mode & 0o077) === 0
    && metadata.size <= maxBytes, 'GATEWAY_ADMIN_PRIVATE_FILE', 'A bounded private regular file is required.');
  return readFileSync(filename, 'utf8');
}

function adminToken(filename: string): string {
  const token = privateText(filename, 4_096).trim();
  assert(token.length >= 24 && !/[\r\n]/.test(token), 'GATEWAY_ADMIN_INVALID_TOKEN',
    'A private administrator token containing at least 24 characters is required.');
  return token;
}

function validHost(value: unknown): value is string {
  return value === 'localhost' || typeof value === 'string' && isIP(value) !== 0;
}

function configurationRevision(configuration: Readonly<GatewayAdminConfiguration>): string {
  return createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
}

function gatewayRevision(configuration: Readonly<OneBotGatewayConfiguration>): string {
  return createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
}

export function loadGatewayAdminConfiguration(filename: string): Readonly<GatewayAdminConfiguration> {
  const input: unknown = JSON.parse(privateText(filename, 64 * 1024));
  assert(isRecord(input)
    && Object.keys(input).every(key => ['host', 'port', 'tokenFile', 'gatewayConfiguration', 'legacyRoot', 'serviceManager', 'accessSessionTtlMs'].includes(key))
    && validHost(input.host)
    && Number.isSafeInteger(input.port) && Number(input.port) >= 0 && Number(input.port) <= 65_535
    && reference(input.tokenFile) && reference(input.gatewayConfiguration)
    && (input.legacyRoot === undefined || reference(input.legacyRoot))
    && (input.serviceManager === undefined || reference(input.serviceManager))
    && (input.accessSessionTtlMs === undefined || Number.isSafeInteger(input.accessSessionTtlMs)
      && Number(input.accessSessionTtlMs) >= 300_000 && Number(input.accessSessionTtlMs) <= 30 * 86_400_000),
  'GATEWAY_ADMIN_INVALID_CONFIG', 'Gateway administrator configuration contains invalid fields.');
  const base = dirname(resolve(filename));
  const configuration = snapshot({
    host: input.host,
    port: Number(input.port),
    tokenFile: resolve(base, input.tokenFile),
    gatewayConfiguration: resolve(base, input.gatewayConfiguration),
    ...(input.legacyRoot === undefined ? {} : { legacyRoot: resolve(base, input.legacyRoot) }),
    ...(input.serviceManager === undefined ? {} : { serviceManager: resolve(base, input.serviceManager) }),
    ...(input.accessSessionTtlMs === undefined ? {} : { accessSessionTtlMs: Number(input.accessSessionTtlMs) }),
  });
  if (existsSync(configuration.tokenFile)) adminToken(configuration.tokenFile);
  loadOneBotGatewayConfiguration(configuration.gatewayConfiguration);
  return configuration;
}

function connectHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
}

export function gatewayAdminAddress(configuration: Readonly<GatewayAdminConfiguration>): string {
  assert(validHost(configuration.host)
    && Number.isSafeInteger(configuration.port) && configuration.port >= 0 && configuration.port <= 65_535,
  'GATEWAY_ADMIN_INVALID_CONFIG', 'Gateway administrator address is invalid.');
  const host = connectHost(configuration.host);
  return `http://${isIP(host) === 6 ? `[${host}]` : host}:${configuration.port}`;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function sanitizePolicyMetric(value: unknown): OneBotCompatPolicyMetric | null {
  if (!isRecord(value)
    || typeof value.conversationId !== 'string'
    || !/^(?:group|private):[1-9]\d{0,15}$/.test(value.conversationId)
    || !nonnegativeInteger(value.sendRemaining)
    || !nonnegativeInteger(value.forwardRemaining)
    || value.expiresAt !== null && !nonnegativeInteger(value.expiresAt)
    || typeof value.active !== 'boolean') return null;
  return snapshot({
    conversationId: value.conversationId,
    sendRemaining: value.sendRemaining,
    forwardRemaining: value.forwardRemaining,
    expiresAt: value.expiresAt,
    active: value.active
  });
}

function sanitizeMetrics(value: unknown): OneBotCompatGatewayMetrics | null {
  if (!isRecord(value) || typeof value.closed !== 'boolean'
    || !nonnegativeInteger(value.pending) || !nonnegativeInteger(value.maxPending)
    || !nonnegativeInteger(value.requests) || !nonnegativeInteger(value.reads)
    || !nonnegativeInteger(value.writes) || !nonnegativeInteger(value.rejected)
    || !nonnegativeInteger(value.unknown) || !nonnegativeInteger(value.recoveredUnknown)
    || !Array.isArray(value.policy) || value.policy.length > 1_000) return null;
  const policy: OneBotCompatPolicyMetric[] = [];
  for (const candidate of value.policy) {
    const metric = sanitizePolicyMetric(candidate);
    if (metric === null) return null;
    policy.push(metric);
  }
  return snapshot({
    closed: value.closed,
    pending: value.pending,
    maxPending: value.maxPending,
    requests: value.requests,
    reads: value.reads,
    writes: value.writes,
    rejected: value.rejected,
    unknown: value.unknown,
    recoveredUnknown: value.recoveredUnknown,
    policy
  });
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new GatewayProbeError('gateway_response_invalid');
    }
  }
  if (response.body === null) throw new GatewayProbeError('gateway_response_invalid');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new GatewayProbeError('gateway_response_invalid');
    }
    chunks.push(result.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')) as unknown;
  } catch {
    throw new GatewayProbeError('gateway_response_invalid');
  }
}

async function gatewayRequest(
  port: number,
  token: string,
  pathname: '/health' | '/get_status',
  signal: AbortSignal | undefined
): Promise<{ readonly status: number; readonly body: unknown }> {
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: pathname === '/health' ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        ...(pathname === '/get_status' ? { 'content-type': 'application/json' } : {})
      },
      ...(pathname === '/get_status' ? { body: '{}' } : {}),
      redirect: 'error',
      signal: combined
    });
  } catch {
    if (signal?.aborted) throw new GatewayProbeError('request_aborted');
    throw new GatewayProbeError(timeout.aborted ? 'gateway_timeout' : 'gateway_unavailable');
  }
  return { status: response.status, body: await boundedJson(response) };
}

async function probeHealth(
  configuration: Readonly<OneBotGatewayConfiguration>,
  token: string,
  signal?: AbortSignal
): Promise<GatewayHealth> {
  try {
    const response = await gatewayRequest(configuration.port, token, '/health', signal);
    if (response.status !== 200 || !isRecord(response.body)) {
      return { ok: false, mode: null, metrics: null, error: 'gateway_not_ready' };
    }
    if (response.body.ok !== true
      || response.body.mode !== 'legacy-egress-compatibility'
      || response.body.revision !== gatewayRevision(configuration)) {
      return { ok: false, mode: null, metrics: null, error: 'gateway_revision_mismatch' };
    }
    const metrics = sanitizeMetrics(response.body.metrics);
    if (metrics === null) return { ok: false, mode: null, metrics: null, error: 'gateway_metrics_invalid' };
    return { ok: true, mode: 'legacy-egress-compatibility', metrics, error: null };
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    return {
      ok: false,
      mode: null,
      metrics: null,
      error: error instanceof GatewayProbeError ? error.code : 'gateway_unavailable'
    };
  }
}

async function probeStatus(
  configuration: Readonly<OneBotGatewayConfiguration>,
  token: string,
  signal?: AbortSignal
): Promise<GatewayStatus> {
  try {
    const response = await gatewayRequest(configuration.port, token, '/get_status', signal);
    if (response.status !== 200 || !isRecord(response.body) || response.body.retcode !== 0
      || !isRecord(response.body.data) || typeof response.body.data.online !== 'boolean'
      || typeof response.body.data.good !== 'boolean') {
      return { verified: false, online: null, good: null, error: 'get_status_unavailable' };
    }
    return {
      verified: true,
      online: response.body.data.online,
      good: response.body.data.good,
      error: null
    };
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    return {
      verified: false,
      online: null,
      good: null,
      error: error instanceof GatewayProbeError ? error.code : 'get_status_unavailable'
    };
  }
}

function policyConfiguration(configuration: Readonly<OneBotGatewayConfiguration>) {
  const budgetEnabled = configuration.budgetEnabled !== false;
  return snapshot({
    persona: configuration.persona,
    allowedConversations: configuration.allowedConversations,
    authorizationVersion: configuration.authorizationVersion ?? '1',
    budgetEnabled,
    configured: {
      maxSendUses: configuration.maxSendUses ?? null,
      grantTtlMs: configuration.grantTtlMs ?? null
    },
    effective: {
      sendUses: !budgetEnabled || configuration.maxSendUses === undefined
        ? '未设置日常次数限制' : configuration.maxSendUses,
      grantExpiry: !budgetEnabled || configuration.grantTtlMs === undefined || configuration.grantTtlMs === null
        ? '无到期日' : configuration.grantTtlMs
    },
    limits: {
      timeoutMs: configuration.timeoutMs ?? 60_000,
      maxPending: configuration.maxPending ?? 16,
      maxBodyBytes: configuration.maxBodyBytes ?? 28 * 1024 * 1024,
      maxRecords: configuration.maxRecords ?? 10_000
    }
  });
}

function policyGrants(
  configuration: Readonly<OneBotGatewayConfiguration>,
  metrics: OneBotCompatGatewayMetrics | null
) {
  if (metrics === null) return [];
  const budgetEnabled = configuration.budgetEnabled !== false;
  return metrics.policy.map(metric => ({
    conversationId: metric.conversationId,
    sendRemaining: !budgetEnabled || configuration.maxSendUses === undefined
      ? '未设置日常次数限制' : metric.sendRemaining,
    forwardRemaining: !budgetEnabled || configuration.maxSendUses === undefined
      ? '未设置日常次数限制' : metric.forwardRemaining,
    expiresAt: !budgetEnabled || configuration.grantTtlMs === undefined || configuration.grantTtlMs === null
      ? '无到期日' : metric.expiresAt,
    active: metric.active
  }));
}

function liveSnapshot(
  revision: string,
  configuration: Readonly<OneBotGatewayConfiguration>,
  health: GatewayHealth,
  status: GatewayStatus,
  configurable: boolean,
  chatManagement: boolean
) {
  const metrics = health.metrics;
  const operationalMetrics = metrics === null ? null : {
    closed: metrics.closed,
    pending: metrics.pending,
    maxPending: metrics.maxPending,
    requests: metrics.requests,
    reads: metrics.reads,
    writes: metrics.writes,
    rejected: metrics.rejected,
    unknown: metrics.unknown,
    recoveredUnknown: metrics.recoveredUnknown
  };
  const runtimeStatus = !health.ok ? 'unavailable'
    : !status.verified || status.online !== true || status.good !== true ? 'degraded' : 'healthy';
  const features = [];
  if (health.ok) {
    features.push({
      id: 'onebot-compatibility-gateway',
      version: configuration.authorizationVersion ?? '1',
      status: 'active',
      capabilities: ['gateway.health.read']
    });
  }
  if (status.verified) {
    features.push({
      id: 'onebot-get-status',
      version: '11',
      status: 'active',
      capabilities: ['onebot.get_status.read']
    });
  }
  return snapshot({
    mode: 'gateway-live',
    revision,
    integrations: { chatManagement },
    overview: {
      name: 'QQ Agent Framework Gateway Admin',
      mode: 'gateway-live',
      version: FRAMEWORK_VERSION,
      status: runtimeStatus,
      gatewayHealthy: health.ok,
      gatewayMode: health.mode,
      gatewayConfigurationCurrent: health.ok,
      online: status.online,
      good: status.good,
      budgetEnabled: configuration.budgetEnabled === false ? '关闭，保留配置' : '开启',
      error: health.error ?? status.error,
      metrics: operationalMetrics,
      metricsScope: 'current-gateway-process-only',
      legacyWebSocketTraffic: 'not-observed'
    },
    features,
    context: {
      persona: configuration.persona,
      configuration: {
        gatewayMode: 'legacy-egress-compatibility',
        managementMode: configurable ? 'controlled-configuration' : 'read-only'
      },
      preferences: null,
      provenance: {
        agentRuntime: chatManagement ? 'external-chat-service-configured' : 'not-connected',
        session: 'not-observed-by-gateway-admin',
        legacyWebSocketTraffic: 'bypasses-this-gateway'
      }
    },
    policy: {
      paused: false,
      source: 'gateway-configuration',
      configuration: policyConfiguration(configuration),
      grants: policyGrants(configuration, metrics)
    },
    outbox: metrics === null ? [] : [{
      kind: 'gateway-outbox-metrics',
      writes: metrics.writes,
      pending: metrics.pending,
      unknown: metrics.unknown,
      recoveredUnknown: metrics.recoveredUnknown,
      scope: 'current-gateway-process-only',
      legacyWebSocketTraffic: 'not-observed'
    }],
    audit: metrics === null ? [] : [{
      kind: 'gateway-request-metrics',
      requests: metrics.requests,
      reads: metrics.reads,
      rejected: metrics.rejected,
      scope: 'current-gateway-process-only',
      legacyWebSocketTraffic: 'not-observed'
    }]
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  const closed = new Promise<void>((resolvePromise, rejectPromise) => {
    server.close(error => error ? rejectPromise(error) : resolvePromise());
  });
  server.closeIdleConnections();
  server.closeAllConnections();
  await closed;
}

export async function startGatewayAdmin(configuration: Readonly<GatewayAdminConfiguration>, options: { configurationFilename?: string } = {}) {
  assert(validHost(configuration.host)
    && Number.isSafeInteger(configuration.port) && configuration.port >= 0 && configuration.port <= 65_535
    && reference(configuration.tokenFile) && reference(configuration.gatewayConfiguration),
  'GATEWAY_ADMIN_INVALID_CONFIG', 'Gateway administrator configuration is invalid.');
  const bootstrap = createAdminBootstrap({ tokenFile: configuration.tokenFile });
  function currentGateway() {
    const current = loadOneBotGatewayConfiguration(configuration.gatewayConfiguration);
    const token = privateText(current.tokenFile, 4_096).trim();
    assert(token.length >= 16 && !/[\r\n]/.test(token), 'GATEWAY_ADMIN_INVALID_GATEWAY_TOKEN', 'A private gateway token is required.');
    return { configuration: current, token };
  }
  currentGateway();
  const revision = configurationRevision(configuration);
  const snapshotHandler = async (signal?: AbortSignal) => {
    const current = currentGateway();
    const health = await probeHealth(current.configuration, current.token, signal);
    const status = health.ok
      ? await probeStatus(current.configuration, current.token, signal)
      : { verified: false, online: null, good: null, error: health.error };
    return liveSnapshot(revision, current.configuration, health, status, options.configurationFilename !== undefined,
      configuration.legacyRoot !== undefined);
  };
  const healthRoute: AdminRoute = {
    method: 'GET',
    pathname: '/api/gateway/health',
    async handle({ signal }) {
      const current = currentGateway();
      const health = await probeHealth(current.configuration, current.token, signal);
      return snapshot({
        ok: health.ok,
        mode: 'gateway-live',
        revision,
        gatewayMode: health.mode,
        error: health.error
      });
    }
  };
  const operations = options.configurationFilename && configuration.serviceManager ? createManagementOperations({
    adminConfigurationFilename: options.configurationFilename,
    gatewayConfigurationFilename: configuration.gatewayConfiguration,
    serviceManager: configuration.serviceManager,
    ...(configuration.legacyRoot === undefined ? {} : { legacyConfigurationFilename: join(configuration.legacyRoot, 'config.json') }),
  }) : undefined;
  const routes: AdminRoute[] = [healthRoute];
  if (options.configurationFilename) {
    const filenames = { adminConfigurationFilename: options.configurationFilename, gatewayConfigurationFilename: configuration.gatewayConfiguration };
    routes.push(...createSettingsRoutes({ ...filenames,
      ...(operations === undefined ? {} : { apply: operations.apply }),
    }));
    routes.push(...createConfigurationRoutes({ ...filenames,
      ...(configuration.legacyRoot === undefined ? {} : { legacyRoot: configuration.legacyRoot }),
      ...(operations === undefined ? {} : { apply: operations.apply }),
    }));
  }
  if (configuration.legacyRoot) routes.push(...createLegacyAdminRoutes({ legacyRoot: configuration.legacyRoot,
    ...(operations === undefined ? {} : { beforeAccessSave: operations.synchronizeAccess }),
  }));
  const server = createAdminServer({ token: () => bootstrap.token(), snapshot: snapshotHandler, routes, handlerTimeoutMs: 70_000,
    ...(configuration.accessSessionTtlMs === undefined ? {} : { accessSessionTtlMs: configuration.accessSessionTtlMs }),
    setup: {
      status: () => ({ ...bootstrap.status(), revision }),
      initialize: () => ({ ...bootstrap.initialize(), revision }),
    },
  });
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const fail = (error: Error): void => rejectPromise(error);
      server.once('error', fail);
      server.listen(configuration.port, configuration.host, () => {
        server.off('error', fail);
        resolvePromise();
      });
    });
  } catch (error: unknown) {
    server.closeAllConnections();
    await closeServer(server);
    throw error;
  }
  const address = server.address();
  assert(address !== null && typeof address !== 'string', 'GATEWAY_ADMIN_LISTEN_FAILED',
    'No gateway administrator listener was created.');
  let stopping: Promise<void> | undefined;
  return Object.freeze({
    address: address as AddressInfo,
    revision,
    close() {
      stopping ??= closeServer(server);
      return stopping;
    }
  });
}
