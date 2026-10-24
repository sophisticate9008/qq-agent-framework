import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assert, isRecord, reference, snapshot } from '../core/values.ts';
import { loadOneBotGatewayConfiguration } from '../host/onebot-gateway.ts';

export interface LegacyGatewayOptions { legacyRoot: string; runtimeDirectory: string; port?: number }
interface MigrationState {
  schema: 1;
  legacyRoot: string;
  originalEndpoint: string;
  gatewayEndpoint: string;
  gatewayConfiguration: string;
  tokenFile: string;
  active: boolean;
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function privateJson(filename: string): Record<string, unknown> {
  const metadata = lstatSync(filename);
  assert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 1024 * 1024 && (metadata.mode & 0o077) === 0,
    'LEGACY_PRIVATE_FILE', 'A bounded private regular file is required.');
  const value: unknown = JSON.parse(readFileSync(filename, 'utf8'));
  assert(isRecord(value), 'LEGACY_INVALID_CONFIG', 'A configuration object is required.');
  return value;
}

function legacyConfiguration(root: string) {
  const filename = join(root, 'config.json');
  const original = readFileSync(filename, 'utf8');
  const value: unknown = JSON.parse(original);
  assert(isRecord(value) && isRecord(value.snowluma) && typeof value.snowluma.httpUrl === 'string'
    && typeof value.snowluma.accessToken === 'string' && value.snowluma.accessToken.length >= 16
    && isRecord(value.allow) && Array.isArray(value.allow.private) && Array.isArray(value.allow.groups),
  'LEGACY_INVALID_CONFIG', 'Legacy bridge requires a fixed HTTP endpoint, authentication and explicit allowlists.');
  return { filename, original, value, connection: value.snowluma, allow: value.allow };
}

function writeJson(filename: string, value: unknown) {
  const temporary = `${filename}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, filename);
}

function stateFile(options: LegacyGatewayOptions): string { return join(resolve(options.runtimeDirectory), 'migration.json'); }

function migration(options: LegacyGatewayOptions): MigrationState {
  const state = privateJson(stateFile(options));
  assert(state.schema === 1 && state.legacyRoot === resolve(options.legacyRoot)
    && typeof state.originalEndpoint === 'string' && typeof state.gatewayEndpoint === 'string'
    && reference(state.gatewayConfiguration) && reference(state.tokenFile) && typeof state.active === 'boolean',
  'LEGACY_MIGRATION_STATE', 'Migration state does not match the requested deployment.');
  return state as unknown as MigrationState;
}

function summary(state: MigrationState) {
  return snapshot({ active: state.active, originalEndpoint: state.originalEndpoint, gatewayEndpoint: state.gatewayEndpoint,
    gatewayConfiguration: state.gatewayConfiguration });
}

export function prepareLegacyGateway(options: LegacyGatewayOptions) {
  const root = resolve(options.legacyRoot);
  const directory = resolve(options.runtimeDirectory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const current = legacyConfiguration(root);
  if (existsSync(stateFile(options))) {
    const state = migration(options);
    assert(current.connection.httpUrl === state.originalEndpoint || current.connection.httpUrl === state.gatewayEndpoint,
      'LEGACY_ENDPOINT_CHANGED', 'The legacy endpoint changed outside this migration.');
    assert(readFileSync(state.tokenFile, 'utf8').trim() === current.connection.accessToken,
      'LEGACY_TOKEN_CHANGED', 'The legacy token changed; reconcile credentials before migration.');
    if (!existsSync(state.gatewayConfiguration)) renameSync(`${state.gatewayConfiguration}.disabled`, state.gatewayConfiguration);
    loadOneBotGatewayConfiguration(state.gatewayConfiguration);
    return summary(state);
  }
  const port = options.port ?? 3131;
  assert(Number.isSafeInteger(port) && port > 0 && port <= 65535, 'LEGACY_INVALID_PORT', 'An explicit local listener port is required.');
  const upstream = new URL(String(current.connection.httpUrl));
  assert(upstream.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname)
    && !upstream.username && !upstream.password && !upstream.search && !upstream.hash && Number(upstream.port || '80') !== port,
  'LEGACY_INVALID_UPSTREAM', 'A distinct fixed loopback HTTP upstream is required.');
  const targets: string[] = [];
  for (const [kind, identifiers] of [['private', current.allow.private], ['group', current.allow.groups]] as const) {
    assert(Array.isArray(identifiers), 'LEGACY_INVALID_ALLOWLIST', 'Explicit legacy target arrays are required.');
    for (const identifier of identifiers) {
      assert((typeof identifier === 'string' || typeof identifier === 'number') && /^[1-9]\d{0,15}$/.test(String(identifier))
        && Number.isSafeInteger(Number(identifier)), 'LEGACY_INVALID_ALLOWLIST', 'Legacy targets must be safe positive identifiers.');
      targets.push(`${kind}:${identifier}`);
    }
  }
  assert(targets.length > 0 && new Set(targets).size <= 1000, 'LEGACY_INVALID_ALLOWLIST', 'A bounded nonempty target list is required.');
  const tokenFile = join(directory, 'gateway.token');
  const gatewayConfiguration = join(root, 'config/local/framework-gateway.json');
  assert(!existsSync(gatewayConfiguration) && !existsSync(tokenFile), 'LEGACY_PREPARE_CONFLICT', 'Existing deployment files will not be overwritten.');
  writeFileSync(join(directory, 'legacy-config-before.json'), current.original, { flag: 'wx', mode: 0o600 });
  writeFileSync(tokenFile, String(current.connection.accessToken) + '\n', { flag: 'wx', mode: 0o600 });
  const state: MigrationState = { schema: 1, legacyRoot: root, originalEndpoint: String(current.connection.httpUrl),
    gatewayEndpoint: `http://127.0.0.1:${port}`, gatewayConfiguration, tokenFile, active: false };
  writeJson(gatewayConfiguration, { port, upstreamEndpoint: state.originalEndpoint, tokenFile,
    storeFilename: join(directory, 'gateway.sqlite'), allowedConversations: [...new Set(targets)],
    persona: { id: 'legacy-qq-bridge', version: '1.0.0' }, timeoutMs: 12000, maxPending: 4,
    maxBodyBytes: 28 * 1024 * 1024, maxRecords: 10000, grantTtlMs: null,
    authorizationVersion: 'service-1' });
  loadOneBotGatewayConfiguration(gatewayConfiguration);
  writeJson(stateFile(options), state);
  return summary(state);
}

export async function activateLegacyGateway(options: LegacyGatewayOptions) {
  const state = migration(options);
  const config = loadOneBotGatewayConfiguration(state.gatewayConfiguration);
  assert(`http://127.0.0.1:${config.port}` === state.gatewayEndpoint && config.upstreamEndpoint === state.originalEndpoint,
    'LEGACY_GATEWAY_CHANGED', 'The gateway target no longer matches this migration.');
  const response = await fetch(`${state.gatewayEndpoint}/health`, { headers: {
    authorization: `Bearer ${readFileSync(state.tokenFile, 'utf8').trim()}` }, redirect: 'error', signal: AbortSignal.timeout(2500) });
  const health: unknown = await response.json();
  assert(response.ok && isRecord(health) && health.ok === true && health.revision === hash(JSON.stringify(config)),
    'LEGACY_GATEWAY_NOT_READY', 'The exact prepared gateway configuration must be healthy before activation.');
  const current = legacyConfiguration(state.legacyRoot);
  assert(current.connection.httpUrl === state.originalEndpoint || current.connection.httpUrl === state.gatewayEndpoint,
    'LEGACY_ENDPOINT_CHANGED', 'The legacy endpoint changed outside this migration.');
  assert(current.connection.accessToken === readFileSync(state.tokenFile, 'utf8').trim(),
    'LEGACY_TOKEN_CHANGED', 'The legacy token changed before activation.');
  current.connection.httpUrl = state.gatewayEndpoint;
  assert(readFileSync(current.filename, 'utf8') === current.original, 'LEGACY_CONFIG_CHANGED', 'Legacy configuration changed concurrently.');
  writeJson(current.filename, current.value);
  state.active = true;
  writeJson(stateFile(options), state);
  return summary(state);
}

export function rollbackLegacyGateway(options: LegacyGatewayOptions) {
  const state = migration(options);
  const current = legacyConfiguration(state.legacyRoot);
  assert(current.connection.httpUrl === state.gatewayEndpoint || current.connection.httpUrl === state.originalEndpoint,
    'LEGACY_ENDPOINT_CHANGED', 'Refusing to overwrite an unrelated legacy endpoint.');
  current.connection.httpUrl = state.originalEndpoint;
  assert(readFileSync(current.filename, 'utf8') === current.original, 'LEGACY_CONFIG_CHANGED', 'Legacy configuration changed concurrently.');
  writeJson(current.filename, current.value);
  state.active = false;
  writeJson(stateFile(options), state);
  if (existsSync(state.gatewayConfiguration)) renameSync(state.gatewayConfiguration, `${state.gatewayConfiguration}.disabled`);
  return summary(state);
}
