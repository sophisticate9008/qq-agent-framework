import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';

import {
  gatewayAdminAddress,
  loadGatewayAdminConfiguration,
  startGatewayAdmin
} from '../src/admin/gateway.ts';
import {
  loadOneBotGatewayConfiguration,
  startOneBotGateway
} from '../src/host/onebot-gateway.ts';

const execute = promisify(execFile);
const ADMIN_TOKEN = 'gateway-admin-test-token-0123456789';
const GATEWAY_TOKEN = 'gateway-runtime-test-token-012345';
const UPSTREAM_SECRET = 'upstream-private-status-detail';

interface DeploymentFiles {
  readonly directory: string;
  readonly adminConfiguration: string;
  readonly adminToken: string;
  readonly gatewayConfiguration: string;
  readonly gatewayToken: string;
  readonly storeFilename: string;
}

function writePrivate(filename: string, value: string): void {
  writeFileSync(filename, value, { mode: 0o600 });
}

function createFiles(options: {
  readonly gatewayPort: number;
  readonly upstreamPort: number;
  readonly adminHost?: string;
  readonly adminPort?: number;
  readonly budgetEnabled?: boolean;
  readonly maxSendUses?: number;
  readonly grantTtlMs?: number | null;
}): DeploymentFiles {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-admin-'));
  const adminToken = join(directory, 'admin.token');
  const gatewayToken = join(directory, 'gateway.token');
  const gatewayConfiguration = join(directory, 'gateway.json');
  const adminConfiguration = join(directory, 'admin.json');
  const storeFilename = join(directory, 'gateway.sqlite');
  writePrivate(adminToken, ADMIN_TOKEN);
  writePrivate(gatewayToken, GATEWAY_TOKEN);
  writePrivate(gatewayConfiguration, JSON.stringify({
    port: options.gatewayPort,
    upstreamEndpoint: `http://127.0.0.1:${options.upstreamPort}`,
    tokenFile: './gateway.token',
    storeFilename: './gateway.sqlite',
    allowedConversations: ['private:123'],
    persona: { id: 'compatibility', version: '1.0.0' },
    grantTtlMs: options.grantTtlMs ?? null,
    ...(options.budgetEnabled === undefined ? {} : { budgetEnabled: options.budgetEnabled }),
    ...(options.maxSendUses === undefined ? {} : { maxSendUses: options.maxSendUses })
  }));
  writePrivate(adminConfiguration, JSON.stringify({
    host: options.adminHost ?? '127.0.0.1',
    port: options.adminPort ?? 0,
    tokenFile: './admin.token',
    gatewayConfiguration: './gateway.json'
  }));
  return { directory, adminConfiguration, adminToken, gatewayConfiguration, gatewayToken, storeFilename };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  assert(address !== null && typeof address !== 'string');
  await closeServer(server);
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close(error => error ? rejectPromise(error) : resolvePromise());
  });
}

async function canConnect(port: number): Promise<boolean> {
  return new Promise<boolean>(resolvePromise => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (result: boolean): void => {
      socket.destroy();
      resolvePromise(result);
    };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

function parseObject(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function startLiveGateway(context: TestContext, files: DeploymentFiles): Promise<{ readonly calls: () => number }> {
  let upstreamCalls = 0;
  const upstream = createServer((request, response) => {
    upstreamCalls += 1;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/get_status');
    assert.equal(request.headers.authorization, `Bearer ${GATEWAY_TOKEN}`);
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      status: 'ok',
      retcode: 0,
      data: { online: true, good: true, privateDetail: UPSTREAM_SECRET }
    }));
  });
  const upstreamConfiguration = loadOneBotGatewayConfiguration(files.gatewayConfiguration);
  const expectedPort = new URL(upstreamConfiguration.upstreamEndpoint).port;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    upstream.once('error', rejectPromise);
    upstream.listen(Number(expectedPort), '127.0.0.1', () => resolvePromise());
  });
  const gateway = await startOneBotGateway(upstreamConfiguration);
  context.after(async () => {
    await gateway.close();
    await closeServer(upstream);
  });
  return { calls: () => upstreamCalls };
}

test('loads only private explicit configuration and formats reachable addresses', async context => {
  const files = createFiles({ gatewayPort: await availablePort(), upstreamPort: await availablePort() });
  context.after(() => rmSync(files.directory, { recursive: true, force: true }));
  const configuration = loadGatewayAdminConfiguration(files.adminConfiguration);
  assert(Object.isFrozen(configuration));
  assert.equal(configuration.tokenFile, files.adminToken);
  assert.equal(configuration.gatewayConfiguration, files.gatewayConfiguration);
  assert.equal(gatewayAdminAddress({ ...configuration, host: '0.0.0.0', port: 3210 }), 'http://127.0.0.1:3210');
  assert.equal(gatewayAdminAddress({ ...configuration, host: '::', port: 3210 }), 'http://127.0.0.1:3210');
  assert.equal(gatewayAdminAddress({ ...configuration, host: '::1', port: 3210 }), 'http://[::1]:3210');
  assert.equal(gatewayAdminAddress({ ...configuration, host: 'localhost', port: 3210 }), 'http://localhost:3210');

  for (const accessSessionTtlMs of [300_000, 7 * 86_400_000, 30 * 86_400_000]) {
    writePrivate(files.adminConfiguration, JSON.stringify({ ...configuration, accessSessionTtlMs }));
    assert.equal(loadGatewayAdminConfiguration(files.adminConfiguration).accessSessionTtlMs, accessSessionTtlMs);
  }
  for (const accessSessionTtlMs of [0, 299_999, 30 * 86_400_000 + 1, 300_000.5, '604800000']) {
    writePrivate(files.adminConfiguration, JSON.stringify({ ...configuration, accessSessionTtlMs }));
    assert.throws(() => loadGatewayAdminConfiguration(files.adminConfiguration), { code: 'GATEWAY_ADMIN_INVALID_CONFIG' });
  }

  for (const host of ['192.0.2.20', '2001:db8::20', 'localhost']) {
    writePrivate(files.adminConfiguration, JSON.stringify({
      host,
      port: 3210,
      tokenFile: './admin.token',
      gatewayConfiguration: './gateway.json'
    }));
    assert.equal(loadGatewayAdminConfiguration(files.adminConfiguration).host, host);
  }
  writePrivate(files.adminConfiguration, JSON.stringify({
    host: 'all-interfaces',
    port: 3210,
    tokenFile: './admin.token',
    gatewayConfiguration: './gateway.json'
  }));
  assert.throws(() => loadGatewayAdminConfiguration(files.adminConfiguration), { code: 'GATEWAY_ADMIN_INVALID_CONFIG' });

  writePrivate(files.adminConfiguration, JSON.stringify({
    host: '127.0.0.1',
    port: 3210,
    tokenFile: './admin.token',
    gatewayConfiguration: './gateway.json',
    legacyRoot: '/root/qq-bridge'
  }));
  assert.throws(() => loadGatewayAdminConfiguration(files.adminConfiguration), { code: 'GATEWAY_ADMIN_INVALID_CONFIG' });

  writePrivate(files.adminConfiguration, JSON.stringify({
    host: '127.0.0.1',
    port: 3210,
    tokenFile: './admin.token',
    gatewayConfiguration: './gateway.json'
  }));
  chmodSync(files.adminToken, 0o640);
  assert.throws(() => loadGatewayAdminConfiguration(files.adminConfiguration), { code: 'GATEWAY_ADMIN_PRIVATE_FILE' });
  chmodSync(files.adminToken, 0o600);
  const linked = join(files.directory, 'linked-admin.json');
  symlinkSync(files.adminConfiguration, linked);
  assert.throws(() => loadGatewayAdminConfiguration(linked), { code: 'GATEWAY_ADMIN_PRIVATE_FILE' });
});

test('binds 0.0.0.0 and serves an authenticated real read-only gateway snapshot', async context => {
  const gatewayPort = await availablePort();
  const upstreamPort = await availablePort();
  const files = createFiles({ gatewayPort, upstreamPort, adminHost: '0.0.0.0' });
  context.after(() => rmSync(files.directory, { recursive: true, force: true }));
  const upstream = await startLiveGateway(context, files);
  const service = await startGatewayAdmin(loadGatewayAdminConfiguration(files.adminConfiguration));
  context.after(() => service.close());
  assert.equal(service.address.address, '0.0.0.0');
  assert.equal(upstream.calls(), 0);
  const origin = `http://127.0.0.1:${service.address.port}`;

  assert.equal((await fetch(`${origin}/api/snapshot`)).status, 401);
  assert.equal((await fetch(`${origin}/api/gateway/health`)).status, 401);
  const headers = { authorization: `Bearer ${ADMIN_TOKEN}` };
  const healthResponse = await fetch(`${origin}/api/gateway/health`, { headers });
  assert.equal(healthResponse.status, 200);
  const health = parseObject(await healthResponse.json());
  assert.equal(health.ok, true);
  assert.equal(health.mode, 'gateway-live');
  assert.equal(health.revision, service.revision);
  assert.equal(health.gatewayMode, 'onebot-egress');

  const firstResponse = await fetch(`${origin}/api/snapshot`, { headers });
  assert.equal(firstResponse.status, 200);
  const first = parseObject(await firstResponse.json());
  assert.equal(first.mode, 'gateway-live');
  assert.notEqual(parseObject(first.overview).mode, 'demo');
  assert.equal(parseObject(first.overview).status, 'healthy');
  assert.equal(parseObject(first.overview).budgetEnabled, '开启');
  assert(Array.isArray(first.features));
  assert(first.features.some(value => parseObject(value).id === 'onebot-get-status'));
  assert.equal(upstream.calls(), 1);

  const secondResponse = await fetch(`${origin}/api/snapshot`, { headers });
  const secondText = await secondResponse.text();
  const second = parseObject(JSON.parse(secondText) as unknown);
  const policy = parseObject(second.policy);
  const policyConfiguration = parseObject(policy.configuration);
  assert.equal(policyConfiguration.budgetEnabled, true);
  assert.deepEqual(policyConfiguration.configured, { maxSendUses: null, grantTtlMs: null });
  assert.deepEqual(policyConfiguration.effective, {
    sendUses: '未设置日常次数限制',
    grantExpiry: '无到期日'
  });
  assert(Array.isArray(policy.grants));
  assert.equal(parseObject(policy.grants[0]).sendRemaining, '未设置日常次数限制');
  assert.equal(parseObject(second.context).session, undefined);
  assert.deepEqual(second.integrations, { nativeRuntimeResources: true, nativeChatRuntime: false });
  assert.equal(parseObject(parseObject(second.context).provenance).agentRuntime, 'not-connected');
  assert.equal(parseObject(parseObject(second.context).configuration).gatewayMode, 'onebot-egress');
  assert.match(secondText, /current-gateway-process-only/);
  assert.doesNotMatch(secondText, /legacy|qq-bridge|bypasses-this-gateway/i);
  for (const secret of [ADMIN_TOKEN, GATEWAY_TOKEN, UPSTREAM_SECRET, files.adminToken, files.gatewayToken, files.storeFilename]) {
    assert(!secondText.includes(secret));
  }

  const nativeFeatures = await fetch(`${origin}/api/chat/features`, { headers });
  assert.equal(nativeFeatures.status, 200);
  assert.deepEqual(parseObject(await nativeFeatures.json()), {
    runtimeConnected: false,
    editableResources: true,
    capabilities: [
      { id: 'chat-plans', installed: false },
      { id: 'personas', installed: false },
      { id: 'model-settings', installed: false },
      { id: 'access-policy', installed: false }
    ],
    features: []
  });
  assert.equal(existsSync(join(files.directory, 'runtime')), true);

  const postHeaders = {
    ...headers,
    origin,
    'content-type': 'application/json'
  };
  assert.equal((await fetch(`${origin}/api/demo/events`, { method: 'POST', headers: postHeaders, body: '{}' })).status, 404);
  assert.equal((await fetch(`${origin}/api/gateway/dispatch`, { method: 'POST', headers: postHeaders, body: '{}' })).status, 404);
  assert.equal((await fetch(`${origin}/api/snapshot`, { method: 'POST', headers: postHeaders, body: '{}' })).status, 405);
  await service.close();
  await service.close();
});

test('snapshot distinguishes configured budgets from their enabled effective policy', async context => {
  for (const budgetEnabled of [false, true]) {
    const files = createFiles({
      gatewayPort: await availablePort(),
      upstreamPort: await availablePort(),
      budgetEnabled,
      maxSendUses: 7,
      grantTtlMs: 60_000
    });
    context.after(() => rmSync(files.directory, { recursive: true, force: true }));
    await startLiveGateway(context, files);
    const service = await startGatewayAdmin(loadGatewayAdminConfiguration(files.adminConfiguration));
    context.after(() => service.close());
    const response = await fetch(`http://127.0.0.1:${service.address.port}/api/snapshot`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    });
    assert.equal(response.status, 200);
    const body = parseObject(await response.json());
    assert.equal(parseObject(body.overview).budgetEnabled, budgetEnabled ? '开启' : '关闭，保留配置');
    const policy = parseObject(body.policy);
    const configuration = parseObject(policy.configuration);
    assert.equal(configuration.budgetEnabled, budgetEnabled);
    assert.deepEqual(configuration.configured, { maxSendUses: 7, grantTtlMs: 60_000 });
    assert.deepEqual(configuration.effective, budgetEnabled ? {
      sendUses: 7,
      grantExpiry: 60_000
    } : {
      sendUses: '未设置日常次数限制',
      grantExpiry: '无到期日'
    });
    assert(Array.isArray(policy.grants));
    const grant = parseObject(policy.grants[0]);
    assert.equal(grant.sendRemaining, budgetEnabled ? 7 : '未设置日常次数限制');
    assert.equal(grant.forwardRemaining, budgetEnabled ? 7 : '未设置日常次数限制');
    if (budgetEnabled) assert.equal(typeof grant.expiresAt, 'number');
    else assert.equal(grant.expiresAt, '无到期日');
  }
});

test('keeps an active instance intact on port conflict and closes idempotently', async context => {
  const gatewayPort = await availablePort();
  const upstreamPort = await availablePort();
  const adminPort = await availablePort();
  const files = createFiles({ gatewayPort, upstreamPort, adminPort });
  context.after(() => rmSync(files.directory, { recursive: true, force: true }));
  await startLiveGateway(context, files);
  const configuration = loadGatewayAdminConfiguration(files.adminConfiguration);
  const first = await startGatewayAdmin(configuration);
  context.after(() => first.close());
  await assert.rejects(startGatewayAdmin(configuration), { code: 'EADDRINUSE' });
  const response = await fetch(`http://127.0.0.1:${adminPort}/api/gateway/health`, {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
  });
  assert.equal(response.status, 200);
  assert.equal(parseObject(await response.json()).ok, true);
  await first.close();
  await first.close();
});

test('CLI address is offline-safe while listening and health use the configured instance revision', async context => {
  const gatewayPort = await availablePort();
  const upstreamPort = await availablePort();
  const adminPort = await availablePort();
  const files = createFiles({ gatewayPort, upstreamPort, adminHost: '0.0.0.0', adminPort });
  context.after(() => rmSync(files.directory, { recursive: true, force: true }));
  const extension = import.meta.url.endsWith('.js') ? 'js' : 'ts';
  const script = new URL(`../scripts/gateway-admin.${extension}`, import.meta.url);

  const address = await execute(process.execPath, [script.pathname, '--config', files.adminConfiguration, '--address']);
  assert.equal(address.stdout.trim(), `http://127.0.0.1:${adminPort}`);
  assert(!address.stdout.includes(ADMIN_TOKEN));
  assert.equal(await canConnect(adminPort), false);
  assert.equal(existsSync(files.storeFilename), false);

  await startLiveGateway(context, files);
  const service = await startGatewayAdmin(loadGatewayAdminConfiguration(files.adminConfiguration));
  context.after(() => service.close());
  const listening = await execute(process.execPath, [script.pathname, '--config', files.adminConfiguration, '--listening']);
  assert.equal(listening.stdout, '');
  const healthy = await execute(process.execPath, [script.pathname, '--config', files.adminConfiguration, '--health']);
  assert.equal(healthy.stdout.trim(), 'Framework gateway administrator ready.');
  assert(!healthy.stdout.includes(ADMIN_TOKEN));

  writePrivate(files.adminConfiguration, JSON.stringify({
    host: '127.0.0.1',
    port: adminPort,
    tokenFile: './admin.token',
    gatewayConfiguration: './gateway.json'
  }));
  await assert.rejects(
    execute(process.execPath, [script.pathname, '--config', files.adminConfiguration, '--health']),
    error => {
      assert(error instanceof Error && 'stderr' in error && typeof error.stderr === 'string');
      assert.equal(error.stderr.trim().split(/\r?\n/).at(-1), 'GATEWAY_ADMIN_START_FAILED');
      assert(!error.stderr.includes(ADMIN_TOKEN));
      assert(!error.stderr.includes(GATEWAY_TOKEN));
      return true;
    }
  );
});

test('gateway mounts explicit WS protocol controls, verifies login, drops incoming chat and drains connections on close', async context => {
  const files = createFiles({ gatewayPort: await availablePort(), upstreamPort: await availablePort() });
  context.after(() => rmSync(files.directory, { recursive: true, force: true }));
  const sockets = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolvePromise => sockets.once('listening', () => resolvePromise()));
  context.after(async () => {
    for (const client of sockets.clients) client.terminate();
    await new Promise<void>(resolvePromise => sockets.close(() => resolvePromise()));
  });
  const address = sockets.address();
  assert(address !== null && typeof address !== 'string');
  let connections = 0;
  const requests: Record<string, unknown>[] = [];
  let loginRequested: (() => void) | undefined;
  const requested = new Promise<void>(resolvePromise => { loginRequested = resolvePromise; });
  let respondLogin: (() => void) | undefined;
  let autoLogin = false;
  sockets.on('connection', (socket, request) => {
    connections += 1;
    assert.equal(request.headers.authorization, 'Bearer fixture-ws-secret');
    socket.on('message', raw => {
      const message = parseObject(JSON.parse(raw.toString()) as unknown);
      requests.push(message);
      assert.equal(message.action, 'get_login_info');
      assert.deepEqual(message.params, {});
      const respond = (): void => {
        socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: message.echo, data: { user_id: 123, nickname: 'Fixture' } }));
        socket.send(JSON.stringify({ post_type: 'message', message_type: 'private', self_id: 123,
          user_id: 456, message_id: 1, message: [{ type: 'text', data: { text: 'private-incoming-fixture' } }] }));
      };
      respondLogin = respond;
      loginRequested?.();
      if (autoLogin) respond();
    });
  });
  const service = await startGatewayAdmin(loadGatewayAdminConfiguration(files.adminConfiguration));
  context.after(() => service.close());
  const origin = `http://127.0.0.1:${service.address.port}`;
  const headers = { authorization: `Bearer ${ADMIN_TOKEN}` };
  const postHeaders = { ...headers, origin, 'content-type': 'application/json' };
  async function getAdapters(): Promise<Record<string, unknown>> {
    const response = await fetch(`${origin}/api/chat/adapters`, { headers });
    assert.equal(response.status, 200);
    return parseObject(await response.json());
  }
  async function post(action: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`${origin}/api/chat/adapters${action}`, { method: 'POST', headers: postHeaders, body: JSON.stringify(body) });
  }
  const initial = await getAdapters();
  assert.deepEqual(initial.status, { assembled: true, running: false, applyAvailable: true });
  assert.deepEqual(initial.connection, { state: 'disconnected', selfId: null, lastError: null, received: 0, dropped: 0, chatReady: false });
  assert.equal(connections, 0);
  assert.equal((await fetch(`${origin}/api/chat/adapters/connect`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ revision: initial.revision })
  })).status, 401);
  const savedResponse = await post('', { revision: initial.revision, adapters: {
    onebotHttp: { enabled: true, endpoint: 'https://existing-http.example.test', secret: 'existing-http-private-key' },
    onebotWs: { enabled: true, endpoint: `ws://127.0.0.1:${address.port}`, secret: 'fixture-ws-secret' }
  } });
  assert.equal(savedResponse.status, 200);
  const saved = parseObject(await savedResponse.json());
  assert.equal(connections, 0);
  assert.equal(parseObject(saved.status).running, false);
  const filename = join(files.directory, 'runtime', 'chat-adapters.json');
  const original = readFileSync(filename);
  const metadata = statSync(filename);
  const connecting = post('/connect', { revision: saved.revision });
  await requested;
  const pending = await getAdapters();
  assert.equal(parseObject(pending.status).running, false);
  assert.equal(parseObject(pending.connection).state, 'connecting');
  respondLogin?.();
  const connectedResponse = await connecting;
  assert.equal(connectedResponse.status, 200);
  const connected = parseObject(await connectedResponse.json());
  assert.deepEqual(connected.status, { assembled: true, running: true, applyAvailable: true });
  assert.equal(parseObject(connected.connection).selfId, '123');
  assert.equal(parseObject(connected.connection).chatReady, false);
  const statusResponse = await fetch(`${origin}/api/chat/status`, { headers });
  const nativeStatus = parseObject(await statusResponse.json());
  assert.equal(nativeStatus.runtimeConnected, false);
  assert.equal(nativeStatus.chatReady, false);
  assert.equal(nativeStatus.protocolConnected, true);
  const counted = await getAdapters();
  assert.equal(parseObject(counted.connection).received, 1);
  assert.equal(parseObject(counted.connection).dropped, 0);
  assert.equal(parseObject(nativeStatus.ingress).droppedWhileStopped, 1);
  const stoppedResponse = await post('/disconnect', {});
  assert.equal(stoppedResponse.status, 200);
  const stopped = parseObject(await stoppedResponse.json());
  assert.equal(parseObject(stopped.status).running, false);
  assert.equal(parseObject(stopped.connection).state, 'disconnected');
  assert.deepEqual(readFileSync(filename), original);
  assert.equal(statSync(filename).ino, metadata.ino);
  assert.equal(statSync(filename).mtimeMs, metadata.mtimeMs);
  assert.doesNotMatch(JSON.stringify([connected, counted, stopped]), /fixture-ws-secret|existing-http-private-key|private-incoming-fixture/);
  autoLogin = true;
  const restarted = await post('/connect', { revision: saved.revision });
  assert.equal(restarted.status, 200);
  const active = [...sockets.clients].filter(client => client.readyState === client.OPEN);
  assert.equal(active.length, 1);
  const closed = new Promise<void>(resolvePromise => active[0]!.once('close', () => resolvePromise()));
  await service.close();
  await closed;
  assert.equal(connections, 2);
  assert(requests.every(request => request.action === 'get_login_info'));
});
