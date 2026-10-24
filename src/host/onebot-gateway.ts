import { timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync, lstatSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createOneBotCompatGateway } from '../adapters/onebot-compat.ts';
import { assert, errorCode, isRecord, reference, snapshot } from '../core/values.ts';
import { createSqliteStore } from '../storage/sqlite.ts';

export interface OneBotGatewayConfiguration {
  port: number;
  upstreamEndpoint: string;
  tokenFile: string;
  upstreamTokenFile?: string;
  storeFilename: string;
  allowedConversations: readonly string[];
  persona: Readonly<{ id: string; version: string }>;
  timeoutMs?: number;
  maxPending?: number;
  maxBodyBytes?: number;
  maxRecords?: number;
  budgetEnabled?: boolean;
  maxSendUses?: number;
  grantTtlMs?: number | null;
  authorizationVersion?: string;
}

function privateText(filename: string, maxBytes: number): string {
  const metadata = lstatSync(filename);
  assert(metadata.isFile() && !metadata.isSymbolicLink() && (metadata.mode & 0o077) === 0
    && metadata.size <= maxBytes, 'GATEWAY_PRIVATE_FILE', 'A bounded private regular file is required.');
  return readFileSync(filename, 'utf8');
}

export function loadOneBotGatewayConfiguration(filename: string): Readonly<OneBotGatewayConfiguration> {
  const input: unknown = JSON.parse(privateText(filename, 64 * 1024));
  assert(isRecord(input) && Object.keys(input).every(key => ['port', 'upstreamEndpoint', 'tokenFile', 'upstreamTokenFile',
    'storeFilename', 'allowedConversations', 'persona', 'timeoutMs', 'maxPending', 'maxBodyBytes', 'maxRecords',
    'budgetEnabled', 'maxSendUses', 'grantTtlMs', 'authorizationVersion'].includes(key)), 'GATEWAY_INVALID_CONFIG', 'Gateway configuration contains unknown fields.');
  assert(Number.isSafeInteger(input.port) && Number(input.port) >= 0 && Number(input.port) <= 65535
    && typeof input.upstreamEndpoint === 'string' && reference(input.tokenFile) && reference(input.storeFilename)
    && (input.upstreamTokenFile === undefined || reference(input.upstreamTokenFile))
    && Array.isArray(input.allowedConversations)
    && input.allowedConversations.length <= 1000 && input.allowedConversations.every(value => typeof value === 'string'
      && /^(?:group|private):[1-9]\d{0,15}$/.test(value))
    && new Set(input.allowedConversations).size === input.allowedConversations.length
    && isRecord(input.persona) && Object.keys(input.persona).length === 2
    && reference(input.persona.id) && reference(input.persona.version)
    && (input.budgetEnabled === undefined || typeof input.budgetEnabled === 'boolean')
    && (input.authorizationVersion === undefined || typeof input.authorizationVersion === 'string'
      && /^[a-zA-Z0-9._-]{1,64}$/.test(input.authorizationVersion)),
  'GATEWAY_INVALID_CONFIG', 'Gateway configuration requires explicit identity, targets and local credentials.');
  const upstream = new URL(input.upstreamEndpoint);
  assert(upstream.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(upstream.hostname)
    && !upstream.username && !upstream.password && !upstream.search && !upstream.hash,
  'GATEWAY_INVALID_CONFIG', 'The compatibility upstream must be a fixed loopback HTTP endpoint.');
  for (const [key, lower, upper] of [['timeoutMs', 10, 120000], ['maxPending', 1, 64],
    ['maxBodyBytes', 1024, 32 * 1024 * 1024], ['maxRecords', 100, 100000], ['maxSendUses', 1, Number.MAX_SAFE_INTEGER],
    ['grantTtlMs', 1000, 7 * 86400000]] as const) {
    assert(input[key] === undefined || key === 'grantTtlMs' && input[key] === null
      || Number.isSafeInteger(input[key]) && Number(input[key]) >= lower && Number(input[key]) <= upper,
      'GATEWAY_INVALID_CONFIG', 'Gateway limits must be finite and within supported bounds.');
  }
  const base = dirname(resolve(filename));
  return snapshot({ ...input, tokenFile: resolve(base, input.tokenFile), storeFilename: resolve(base, input.storeFilename),
    ...(input.upstreamTokenFile === undefined ? {} : { upstreamTokenFile: resolve(base, input.upstreamTokenFile) }) }) as unknown as Readonly<OneBotGatewayConfiguration>;
}

function credential(filename: string): string {
  const token = privateText(filename, 4096).trim();
  assert(token.length >= 16 && !/[\r\n]/.test(token), 'GATEWAY_INVALID_TOKEN', 'A private bounded authentication token is required.');
  return token;
}

export function gatewayAuthorization(token: string, header: string | undefined): boolean {
  const actual = Buffer.from(header ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function startOneBotGateway(configuration: Readonly<OneBotGatewayConfiguration>) {
  const token = credential(configuration.tokenFile);
  const upstreamToken = credential(configuration.upstreamTokenFile ?? configuration.tokenFile);
  const revision = createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
  let gateway: ReturnType<typeof createOneBotCompatGateway> | undefined;
  let store: ReturnType<typeof createSqliteStore> | undefined;
  let stopping: Promise<void> | undefined;
  const server = createServer((request, response) => {
    if (request.url === '/health') {
      const authorized = gatewayAuthorization(token, request.headers.authorization);
      response.writeHead(!authorized ? 401 : gateway ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(authorized ? { ok: Boolean(gateway), mode: 'onebot-egress',
        revision, pid: process.pid, metrics: gateway?.metrics() ?? null } : { ok: false }));
      return;
    }
    if (!gateway) { response.writeHead(503); response.end(); return; }
    void Promise.resolve(gateway.handle(request, response)).catch(error => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'failed', retcode: 1500, wording: errorCode(error, 'GATEWAY_FAILED') }));
    });
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = 128;
  try {
    await new Promise<void>((complete, fail) => {
      server.once('error', fail);
      server.listen(configuration.port, '127.0.0.1', () => { server.off('error', fail); complete(); });
    });
    const upstream = new URL(configuration.upstreamEndpoint);
    assert(upstream.port !== String((server.address() as AddressInfo).port), 'GATEWAY_UPSTREAM_LOOP', 'A gateway cannot proxy to its own port.');
    mkdirSync(dirname(configuration.storeFilename), { recursive: true, mode: 0o700 });
    store = createSqliteStore({ filename: configuration.storeFilename, maxRecords: configuration.maxRecords ?? 10000,
      maxValueBytes: (configuration.maxBodyBytes ?? 28 * 1024 * 1024) + 65536 });
    gateway = createOneBotCompatGateway({ ...configuration, token, upstreamToken, store,
      maxBodyBytes: configuration.maxBodyBytes ?? 28 * 1024 * 1024 });
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>(complete => { if (!server.listening) complete(); else server.close(() => complete()); });
    store?.close();
    throw error;
  }
  return Object.freeze({
    address: server.address() as AddressInfo,
    revision,
    metrics: () => gateway!.metrics(),
    close() {
      stopping ??= (async () => {
        const closed = new Promise<void>(complete => server.close(() => complete()));
        await gateway!.close();
        server.closeAllConnections();
        await closed;
        store!.close();
      })();
      return stopping;
    },
  });
}
