import { createNativeAccounts } from '../host/native-accounts.ts';
import { createNativeAccountRoutes } from './native-accounts.ts';
import { createNativeAccountRuntimeBundle, createNativeAccountDispatchRoutes, type NativeAccountRuntimeBundle } from './native-account-runtime.ts';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import type { Server } from 'node:http';
import { isIP, type AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';

import type { OneBotCompatGatewayMetrics, OneBotCompatPolicyMetric } from '../adapters/onebot-compat.ts';
import { assert, isRecord, snapshot } from '../core/values.ts';
import { isConfigurationPath, resolveConfigurationPath } from '../host/configuration-path.ts';
import {
  loadOneBotGatewayConfiguration,
  type OneBotGatewayConfiguration
} from '../host/onebot-gateway.ts';
import { createAdminServer, AdminRequestError, type AdminRoute } from './server.ts';
import { createAdminBootstrap } from './bootstrap.ts';
import type { LoadedNativeBootstrap } from '../host/native-bootstrap.ts';
import { createSettingsRoutes } from './settings.ts';
import { createManagementOperations } from './operations.ts';
import { createConfigurationRoutes } from './configuration.ts';
import { createNativeRuntimeRoutes, createNativeRuntimeApplicationPorts, withNativeChatControl, restoreNativeChatRunningIntent, applyNativeAccessRuntime } from './runtime.ts';
import { nativeApplicationService } from './native-application.ts';
import { nativeApplicationRequiresReconciliation } from '../contracts/native-application.ts';
import { createNativeDshRestartRoutes } from './native-dsh-restart.ts';
import { createNativeDshRestartService } from '../host/native-dsh-restart.ts';
import { createLocalDshMaintenance } from '../host/local-dsh-maintenance.ts';
import { nativeRuntimeIsQuiescent } from '../contracts/native-runtime-quiescence.ts';
import { createNativeDshRestartStorage } from '../storage/native-dsh-restart.ts';
import { prepareNativeChatAuthorization, readNativeChatConfiguration, readNativeAdapterConfiguration,
  createNativeAccessPersistence } from './native-configuration-repository.ts';
import { createNativeChatRuntime, type NativeChatRuntime } from '../host/native-chat-runtime.ts';
import { createAccessService } from '../host/access-service.ts';
import { ACCESS_COMMAND_REPLIES, createAccessCommandHandler, parseAccessCommand } from '../features/access-commands.ts';
import type { NativeChatDeploymentRuntimeInput } from '../host/native-chat-configuration.ts';
import { checkedNativeDeploymentRuntime } from '../host/native-deployment-runtime.ts';
import { createNativeDshDeploymentRuntime } from '../adapters/dsh-profile-deployment.ts';
import { isLoopbackAddress, validatePublicOrigin } from './public-origin.ts';
import { createNativeCapabilityApprovalResolver, createNativeCapabilityManagement } from './native-capabilities.ts';
import { NativeConfigurationRepository } from './native-configuration-repository.ts';
import { createNativeAssistantTarget } from '../host/native-assistant-target.ts';
import { FrameworkError } from '../core/values.ts';
import { createNativePackageConfigurationRegistry } from '../host/native-package-configuration.ts';
import { readNativeRuntimeProjection } from '../host/native-runtime-projection.ts';

const FRAMEWORK_VERSION = '0.1.0';
const PROBE_TIMEOUT_MS = 2_500;
const MAX_RESPONSE_BYTES = 256 * 1024;

export interface GatewayAdminConfiguration {
  host: string;
  port: number;
  tokenFile: string;
  gatewayConfiguration: string;
  serviceManager?: string;
  accessSessionTtlMs?: number;
  publicOrigin?: string;
  trustedLoopbackProxy?: boolean;
}

interface GatewayHealth {
  readonly ok: boolean;
  readonly mode: 'onebot-egress' | null;
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
  filename = resolveConfigurationPath(filename);
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

function validProxyConfiguration(value: { publicOrigin?: unknown; trustedLoopbackProxy?: unknown; host?: unknown }): boolean {
  try {
    const origin = validatePublicOrigin(value.publicOrigin ?? '');
    const proxy = value.trustedLoopbackProxy ?? false;
    return typeof proxy === 'boolean' && proxy === (origin !== '')
      && (!proxy || typeof value.host === 'string' && isLoopbackAddress(value.host));
  } catch { return false; }
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
    && Object.keys(input).every(key => ['host', 'port', 'tokenFile', 'gatewayConfiguration', 'serviceManager', 'accessSessionTtlMs',
      'publicOrigin', 'trustedLoopbackProxy'].includes(key))
    && validHost(input.host)
    && Number.isSafeInteger(input.port) && Number(input.port) >= 0 && Number(input.port) <= 65_535
    && isConfigurationPath(input.tokenFile) && isConfigurationPath(input.gatewayConfiguration)
    && (input.serviceManager === undefined || isConfigurationPath(input.serviceManager)) && validProxyConfiguration(input)
    && (input.accessSessionTtlMs === undefined || Number.isSafeInteger(input.accessSessionTtlMs)
      && Number(input.accessSessionTtlMs) >= 300_000 && Number(input.accessSessionTtlMs) <= 30 * 86_400_000),
  'GATEWAY_ADMIN_INVALID_CONFIG', 'Gateway administrator configuration contains invalid fields.');
  const base = dirname(resolve(filename));
  const configuration = snapshot({
    host: input.host,
    port: Number(input.port),
    tokenFile: resolveConfigurationPath(input.tokenFile, base),
    gatewayConfiguration: resolveConfigurationPath(input.gatewayConfiguration, base),
    ...(input.serviceManager === undefined ? {} : { serviceManager: resolveConfigurationPath(input.serviceManager, base) }),
    ...(input.accessSessionTtlMs === undefined ? {} : { accessSessionTtlMs: Number(input.accessSessionTtlMs) }),
    ...(input.publicOrigin === undefined ? {} : { publicOrigin: String(input.publicOrigin) }),
    ...(input.trustedLoopbackProxy === undefined ? {} : { trustedLoopbackProxy: Boolean(input.trustedLoopbackProxy) }),
  });
  if (existsSync(configuration.tokenFile)) adminToken(configuration.tokenFile);
  loadOneBotGatewayConfiguration(configuration.gatewayConfiguration);
  return configuration;
}

function connectHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
}

export function gatewayAdminAddress(configuration: Readonly<GatewayAdminConfiguration>): string {
  assert(validHost(configuration.host) && validProxyConfiguration(configuration)
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
    || value.sendRemaining !== null && !nonnegativeInteger(value.sendRemaining)
    || value.forwardRemaining !== null && !nonnegativeInteger(value.forwardRemaining)
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
      || response.body.mode !== 'onebot-egress'
      || response.body.revision !== gatewayRevision(configuration)) {
      return { ok: false, mode: null, metrics: null, error: 'gateway_revision_mismatch' };
    }
    const metrics = sanitizeMetrics(response.body.metrics);
    if (metrics === null) return { ok: false, mode: null, metrics: null, error: 'gateway_metrics_invalid' };
    return { ok: true, mode: 'onebot-egress', metrics, error: null };
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
    sendRemaining: !budgetEnabled || configuration.maxSendUses === undefined || metric.sendRemaining === null
      ? '未设置日常次数限制' : metric.sendRemaining,
    forwardRemaining: !budgetEnabled || configuration.maxSendUses === undefined || metric.forwardRemaining === null
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
  configurable: boolean
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
      id: 'onebot-egress-gateway',
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
    integrations: { nativeRuntimeResources: true, nativeChatRuntime: false },
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
      metricsScope: 'current-gateway-process-only'
    },
    features,
    context: {
      persona: configuration.persona,
      configuration: {
        gatewayMode: health.mode,
        managementMode: configurable ? 'controlled-configuration' : 'read-only'
      },
      preferences: null,
      provenance: {
        agentRuntime: 'not-connected',
        session: 'not-observed-by-gateway-admin'
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
      scope: 'current-gateway-process-only'
    }],
    audit: metrics === null ? [] : [{
      kind: 'gateway-request-metrics',
      requests: metrics.requests,
      reads: metrics.reads,
      rejected: metrics.rejected,
      scope: 'current-gateway-process-only'
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

export async function startGatewayAdmin(configuration: Readonly<GatewayAdminConfiguration>, options: {
  configurationFilename?: string;
  deploymentRuntime?: NativeChatDeploymentRuntimeInput;
  bootstrap?: LoadedNativeBootstrap;
} = {}) {
  assert(validHost(configuration.host)
    && Number.isSafeInteger(configuration.port) && configuration.port >= 0 && configuration.port <= 65_535
    && isConfigurationPath(configuration.tokenFile) && isConfigurationPath(resolve(configuration.tokenFile))
    && isConfigurationPath(configuration.gatewayConfiguration) && isConfigurationPath(resolve(configuration.gatewayConfiguration)),
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
    const gateway = liveSnapshot(revision, current.configuration, health, status, options.configurationFilename !== undefined);
    const adopted = (await accounts.read()).legacy.adoptedBy !== null;
    const projection = await readNativeRuntimeProjection(adopted ? undefined : chatRuntime);
    const native = adopted ? { ...projection, missingReasons: ['native_legacy_account_adopted'] } : projection;
    return { ...gateway,
      integrations: { nativeRuntimeResources: true, nativeChatRuntime: native.chatReady },
      runtimeProjection: native,
      overview: { ...gateway.overview, nativeChatRuntimeState: native.state, chatReady: native.chatReady,
        nativeChatMissingReasons: native.missingReasons },
      features: [...gateway.features.map(feature => ({ ...feature, source: 'gateway', coverage: 'current-gateway-probes' })),
        ...native.features.map(feature => ({ ...feature, source: native.source, coverage: native.coverage }))]
    };
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
    serviceManager: configuration.serviceManager
  }) : undefined;
  const directory = join(dirname(configuration.tokenFile), 'runtime');
  const deploymentRuntime = checkedNativeDeploymentRuntime(options.deploymentRuntime ?? createNativeDshDeploymentRuntime({
    resolveCapabilityApproval: createNativeCapabilityApprovalResolver(directory)
  }));
  let chatRuntime: NativeChatRuntime;
  const repository = new NativeConfigurationRepository(directory);
  const packageConfigurationRegistry = createNativePackageConfigurationRegistry({ directory, contributions: options.bootstrap?.packageConfigurations });
  const assistantTarget = createNativeAssistantTarget({ directory,
    loadConfiguration: () => readNativeChatConfiguration(directory), loadAssistant: () => repository.readAssistant(),
    async authorizeApply(signal) {
      signal.throwIfAborted();
      if (!(await chatRuntime.status()).canApplyDeployment) throw new FrameworkError('ASSISTANT_DEPLOYMENT_REQUIRES_STOPPED', 'Stop chat before applying an assistant deployment.');
    } });
  const accessService = createAccessService({ ...createNativeAccessPersistence(directory),
    async publish(saved, previous, signal) {
      await applyNativeAccessRuntime(directory, chatRuntime, previous.revision, saved.revision, signal);
    } });
  const accessCommand = createAccessCommandHandler({ readAccess: signal => accessService.read(signal),
    change: (request, signal) => accessService.change(request, signal) });
  chatRuntime = createNativeChatRuntime({ directory, packageConfigurationRegistry, bootstrap: options.bootstrap,
    resolveWorkTarget: signal => assistantTarget.resolve(signal),
    controlCommands: [{ id: 'access-management', replyTexts: ACCESS_COMMAND_REPLIES,
      matches: message => parseAccessCommand(message) !== null,
      handle: context => accessCommand(context.message, context.reply, context.signal) }],
    prepareAuthorization: () => prepareNativeChatAuthorization(directory),
    loadConfiguration: () => readNativeChatConfiguration(directory),
    resolveDeployment: configuration => deploymentRuntime.reconcile(configuration)
  });
  const accountBundles = new Map<string, NativeAccountRuntimeBundle>();
  const accounts = createNativeAccounts({ directory, protocols: [{ id: 'onebot', validateAccountId: id => /^[1-9][0-9]{0,31}$/.test(id), create(account) {
    const bundle = createNativeAccountRuntimeBundle({ ...account, bootstrap: options.bootstrap, deploymentRuntime: options.deploymentRuntime });
    accountBundles.set(account.directory, bundle);
    return bundle;
  } }], legacy: {
    isStopped: () => chatRuntime.activity().state === 'stopped',
    close: () => chatRuntime.close(),
    async verifyIdentity(scope, signal) {
      assert(scope.protocolId === 'onebot', 'ACCOUNT_PROTOCOL_UNAVAILABLE', 'The legacy runtime uses the OneBot protocol.');
      const proof = await chatRuntime.verifyProtocolIdentity(scope.accountId, signal);
      return { verified: proof.verified, accountScope: scope, evidence: proof.evidence };
    }
  } });
  const adapterRuntime = chatRuntime.adapterRuntime;
  const localDsh = createLocalDshMaintenance(configuration.serviceManager);
  const lifecycle = createNativeRuntimeApplicationPorts({ directory, runtime: chatRuntime, deploymentRuntime });
  async function assertDshExclusive(current: Awaited<ReturnType<NativeConfigurationRepository['read']>>, signal: AbortSignal) {
    const application = nativeApplicationService(chatRuntime);
    const operation = await application?.read();
    const awaitingApply = operation?.phase === 'apply' && (operation.state === 'unknown'
      || operation.state === 'blocked' && operation.reasons.includes('pending_reload'));
    assert(!operation || !nativeApplicationRequiresReconciliation(operation) || awaitingApply,
      'DSH_RESTART_APPLICATION_BUSY', 'An application phase still requires reconciliation.');
    for (const [accountDirectory, bundle] of accountBundles) {
      signal.throwIfAborted();
      const accountConfiguration = await new NativeConfigurationRepository(accountDirectory).read();
      const otherAdapter = accountConfiguration.adapters.dshAgent;
      const currentAdapter = current.adapters.dshAgent;
      const otherCredentials = otherAdapter.localCredentialsPath ? await realpath(otherAdapter.localCredentialsPath).catch(() => null) : null;
      const currentCredentials = currentAdapter.localCredentialsPath ? await realpath(currentAdapter.localCredentialsPath).catch(() => null) : null;
      const sameCredentials = otherCredentials !== null && otherCredentials === currentCredentials;
      if (sameCredentials || new URL(otherAdapter.endpoint).href === new URL(currentAdapter.endpoint).href) {
        assert(await bundle.quiescent(), 'DSH_RESTART_SHARED_RUNTIME_ACTIVE', 'Another account is using this DSH service.');
      }
    }
  }
  const dshRestart = createNativeDshRestartService({ directory, signal: chatRuntime.applicationSignal(), ports: {
    configuration: () => repository.read(), status: () => chatRuntime.status(), inspect: localDsh.inspect,
    assertExclusive: assertDshExclusive,
    stop: async signal => { signal.throwIfAborted(); await lifecycle.stop(true); signal.throwIfAborted(); },
    restart: (current, signal) => withNativeChatControl(directory, async () => {
      assert(nativeRuntimeIsQuiescent(await chatRuntime.status()), 'DSH_RESTART_NOT_QUIESCENT', 'Chat resources have not drained.');
      await assertDshExclusive(current, signal);
      await localDsh.restart(current, signal);
    }),
    verify: localDsh.verify,
    async restore(revisions, wasRunning, signal) {
      signal.throwIfAborted();
      const application = nativeApplicationService(chatRuntime);
      const operation = await application?.read();
      if (application && operation && nativeApplicationRequiresReconciliation(operation)) {
        const continued = await application.reconcile(operation.id);
        if (continued.state === 'running') await application.drain();
        assert((await application.read(operation.id))?.state === 'completed', 'DSH_RESTART_APPLICATION_REQUIRES_REVIEW', 'The original application still needs reconciliation.');
      } else if (wasRunning) await lifecycle.start(revisions, signal);
      signal.throwIfAborted();
    }
  } });
  const maintenanceGuard = (route: AdminRoute): AdminRoute => ({ ...route, async handle(request) {
    if (route.method === 'POST' && !route.pathname.startsWith('/api/chat/dsh/restart') && await dshRestart.unresolved()
      && !(route.pathname === '/api/chat/runtime/stop' && !dshRestart.busy())) {
      throw new AdminRequestError(409, dshRestart.busy() ? 'dsh_restart_busy' : 'dsh_restart_reconciliation_required');
    }
    return route.handle(request);
  } });
  const routes: AdminRoute[] = [
    healthRoute,
    ...createNativeAccountRoutes(accounts).map(maintenanceGuard),
    ...createNativeAccountDispatchRoutes({ accounts, async bundle(id) {
      const accountDirectory = await accounts.accountDirectory(id);
      await accounts.runtime(id);
      const bundle = accountBundles.get(accountDirectory);
      assert(bundle, 'ACCOUNT_RUNTIME_UNAVAILABLE', 'The account runtime is unavailable.');
      return bundle;
    } }).map(maintenanceGuard),
    ...[...createNativeRuntimeRoutes({ directory, adapterRuntime, chatRuntime, deploymentRuntime, assistantTarget, packageConfigurationRegistry,
      interactions: () => chatRuntime.interactions(), tools: signal => chatRuntime.tools(signal) }),
    ...createNativeDshRestartRoutes(dshRestart),
    ...createNativeCapabilityManagement({ directory, deploymentRuntime,
      canApplyDeployment: async () => (await chatRuntime.status()).canApplyDeployment }).routes].map(route => ({ ...route,
      async handle(request: Parameters<AdminRoute['handle']>[0]) {
        if ((await accounts.read()).legacy.adoptedBy !== null) throw new AdminRequestError(409, 'native_legacy_account_adopted');
        return maintenanceGuard(route).handle(request);
      }
    }))
  ];
  if (options.configurationFilename) {
    const filenames = { adminConfigurationFilename: options.configurationFilename, gatewayConfigurationFilename: configuration.gatewayConfiguration };
    routes.push(...createSettingsRoutes({ ...filenames,
      ...(operations === undefined ? {} : { apply: operations.apply }),
    }).map(maintenanceGuard));
    routes.push(...createConfigurationRoutes({ ...filenames,
      ...(operations === undefined ? {} : { apply: operations.apply }),
    }).map(maintenanceGuard));
  }
  const server = createAdminServer({ token: () => bootstrap.token(), snapshot: snapshotHandler, routes, handlerTimeoutMs: 70_000,
    ...(configuration.accessSessionTtlMs === undefined ? {} : { accessSessionTtlMs: configuration.accessSessionTtlMs }),
    ...(configuration.publicOrigin === undefined ? {} : { publicOrigin: configuration.publicOrigin }),
    ...(configuration.trustedLoopbackProxy === undefined ? {} : { trustedLoopbackProxy: configuration.trustedLoopbackProxy }),
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
    await Promise.allSettled([accounts.close(), chatRuntime.close()]);
    server.closeAllConnections();
    await closeServer(server);
    throw error;
  }
  const startupController = new AbortController();
  const startupSignal = AbortSignal.any([startupController.signal, AbortSignal.timeout(45_000)]);
  const startup = (async () => {
    const maintenance = await createNativeDshRestartStorage(directory).read();
    if (maintenance.value.records.some(record => record.operation.state === 'running' || record.operation.state === 'unknown')) return;
    const registered = await accounts.read();
    if (registered.legacy.adoptedBy === null) {
      await readNativeAdapterConfiguration(directory)
        .then(adapters => chatRuntime.synchronizeProtocol(adapters,
          AbortSignal.any([startupSignal, AbortSignal.timeout(10_000)])))
        .catch(() => undefined);
      await restoreNativeChatRunningIntent(directory, chatRuntime, startupSignal).catch(() => undefined);
    }
    for (const account of registered.accounts) {
      startupSignal.throwIfAborted();
      if (account.adoption !== 'ready') continue;
      try {
        const accountDirectory = await accounts.accountDirectory(account.id);
        const intent = await new NativeConfigurationRepository(accountDirectory).readRunningIntent();
        if (!intent.value.desiredRunning) continue;
        await accounts.runtime(account.id);
        const bundle = accountBundles.get(accountDirectory);
        assert(bundle, 'ACCOUNT_RUNTIME_UNAVAILABLE', 'The account runtime is unavailable.');
        await bundle.restore(startupSignal);
      } catch { /* Each account retains its own failed/unknown evidence; another account may still recover. */ }
    }
  })().catch(() => undefined);
  const address = server.address();
  assert(address !== null && typeof address !== 'string', 'GATEWAY_ADMIN_LISTEN_FAILED',
    'No gateway administrator listener was created.');
  let stopping: Promise<void> | undefined;
  return Object.freeze({
    address: address as AddressInfo,
    revision,
    close() {
      stopping ??= (async () => {
        startupController.abort();
        try {
          const results = await Promise.allSettled([accounts.close(), chatRuntime.close(), dshRestart.drain()]);
          const failed = results.find(result => result.status === 'rejected');
          if (failed?.status === 'rejected') throw failed.reason;
        } finally {
          await startup;
          await closeServer(server);
        }
      })();
      return stopping;
    }
  });
}
