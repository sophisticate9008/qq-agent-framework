import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createAdminBootstrap } from '../src/admin/bootstrap.ts';
import { createAdminServer } from '../src/admin/server.ts';
import { createManagementOperations } from '../src/admin/operations.ts';

function privateJson(filename: string, value: unknown): void { writeFileSync(filename, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }
function revision(filename: string): string { return createHash('sha256').update(readFileSync(filename)).digest('hex'); }
function gatewayConfiguration(directory: string, port: number): Record<string, unknown> {
  return {
    port,
    upstreamEndpoint: 'http://127.0.0.1:3000',
    tokenFile: join(directory, 'gateway.token'),
    upstreamTokenFile: join(directory, 'upstream.token'),
    storeFilename: join(directory, 'gateway.sqlite'),
    allowedConversations: ['group:100'],
    persona: { id: 'test', version: '1' },
  };
}
function successfulProtocolFetch(): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify({ retcode: 0, data: { online: true } })));
}
function recordedOperations(filename: string): unknown[] {
  if (!existsSync(filename)) return [];
  const content = readFileSync(filename, 'utf8').trim();
  return content === '' ? [] : content.split('\n').map(value => JSON.parse(value));
}

test('web initialization creates a private token once, enforces same origin and enables protected API afterward', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'management-first-visit-'));
  const tokenFile = join(directory, 'administrator.token');
  const bootstrap = createAdminBootstrap({ tokenFile });
  const server = createAdminServer({ token: bootstrap.token, setup: { status: bootstrap.status, initialize: bootstrap.initialize },
    snapshot: () => ({ overview: { status: 'ready' } }) });
  await new Promise<void>(complete => server.listen(0, '127.0.0.1', complete));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  context.after(async () => { server.closeAllConnections(); await new Promise<void>(complete => server.close(() => complete())); rmSync(directory, { recursive: true, force: true }); });
  const before = await fetch(`${origin}/api/setup`).then(response => response.json());
  assert.equal(before.canInitialize, true);
  assert.equal((await fetch(`${origin}/api/snapshot`, { headers: { authorization: 'Bearer ' } })).status, 401);
  const post = (body: unknown, site = origin) => fetch(`${origin}/api/setup`, { method: 'POST',
    headers: { origin: site, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({}, 'http://untrusted.invalid')).status, 403);
  assert.equal((await post({ tokenFile: '/different/file' })).status, 400);
  const initialized = await post({});
  assert.equal(initialized.status, 200);
  const body = await initialized.text();
  const token = readFileSync(tokenFile, 'utf8').trim();
  assert.equal(body.includes(token), false);
  assert.equal(JSON.parse(body).tokenFile, tokenFile);
  const first = revision(tokenFile);
  assert.equal((await post({})).status, 200);
  assert.equal(revision(tokenFile), first);
  assert.equal((await fetch(`${origin}/api/snapshot`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
  rmSync(tokenFile);
  const missing = await post({}).then(response => response.json());
  assert.equal(missing.initialized, true);
  assert.equal(missing.canInitialize, false);
  assert.equal(missing.error, 'token_missing');
  assert.equal((await fetch(`${origin}/api/snapshot`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
});

test('managed apply checks revision and updates access before restarting only the gateway', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'management-apply-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const gateway = join(directory, 'gateway.json');
  const admin = join(directory, 'admin.json');
  const manager = join(directory, 'service-manager.ts');
  const recordFile = join(directory, 'operations.log');
  writeFileSync(join(directory, 'protocol.token'), 'controlled-protocol-token-value', { mode: 0o600 });
  writeFileSync(manager, `#!/usr/bin/env node\nimport {appendFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(recordFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`, { mode: 0o700 });
  chmodSync(manager, 0o700);
  privateJson(gateway, { port: 3123, upstreamEndpoint: 'http://127.0.0.1:3000', tokenFile: join(directory, 'protocol.token'),
    storeFilename: join(directory, 'gateway.sqlite'), allowedConversations: ['group:100'], persona: { id: 'test', version: '1' },
    budgetEnabled: false, maxSendUses: 23, authorizationVersion: 'before' });
  privateJson(admin, { host: '127.0.0.1', port: 3210 });
  const operations = createManagementOperations({ adminConfigurationFilename: admin, gatewayConfigurationFilename: gateway, serviceManager: manager,
    fetch: async () => new Response(JSON.stringify({ retcode: 0, data: { online: true } })) });
  await assert.rejects(operations.apply('gateway', 'wrong-revision'), { code: 'revision_conflict' });
  await operations.synchronizeAccess({ allow: { groups: [100, 200], private: [300] }, deny: { groups: [200], private: [] }, ownerQQ: 300 }, new AbortController().signal);
  const updated = JSON.parse(readFileSync(gateway, 'utf8'));
  assert.deepEqual(updated.allowedConversations, ['group:100', 'private:300']);
  assert.equal(updated.maxSendUses, 23);
  assert.notEqual(updated.authorizationVersion, 'before');
  assert.deepEqual(readFileSync(recordFile, 'utf8').trim().split('\n').map(value => JSON.parse(value)), [['restart', 'framework-gateway']]);
  await operations.synchronizeAccess({ allow: { groups: [], private: [] }, deny: { groups: [], private: [] }, ownerQQ: null }, new AbortController().signal);
  assert.deepEqual(JSON.parse(readFileSync(gateway, 'utf8')).allowedConversations, []);
  assert.deepEqual(await operations.apply('gateway', revision(gateway)), { applied: true });
});

test('gateway port changes only update the managed bridge endpoint and restart the gateway and bridge', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'management-port-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const gateway = join(directory, 'gateway.json');
  const bridge = join(directory, 'bridge.json');
  const admin = join(directory, 'admin.json');
  const manager = join(directory, 'service-manager.ts');
  const recordFile = join(directory, 'operations.log');
  const gatewayToken = 'controlled-gateway-token-value';
  const upstreamToken = 'controlled-upstream-token-value';
  writeFileSync(join(directory, 'gateway.token'), gatewayToken, { mode: 0o600 });
  writeFileSync(join(directory, 'upstream.token'), upstreamToken, { mode: 0o600 });
  privateJson(gateway, gatewayConfiguration(directory, 4123));
  privateJson(admin, { host: '127.0.0.1', port: 3210 });
  const originalBridge = {
    snowluma: { httpUrl: 'http://127.0.0.1:3123', wsUrl: 'ws://127.0.0.1:3001', accessToken: gatewayToken },
    dsh: { provider: 'fixture' },
    untouched: { enabled: true },
  };
  privateJson(bridge, originalBridge);
  writeFileSync(manager, `#!/usr/bin/env node\nimport {appendFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(recordFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`, { mode: 0o700 });
  chmodSync(manager, 0o700);
  const fetchCalls: Array<{ url: string; authorization: string | null }> = [];
  const operations = createManagementOperations({ adminConfigurationFilename: admin, gatewayConfigurationFilename: gateway,
    legacyConfigurationFilename: bridge, serviceManager: manager,
    fetch: async (input, init) => {
      fetchCalls.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
      return successfulProtocolFetch();
    },
  });
  assert.deepEqual(await operations.apply('gateway', revision(gateway)), { applied: true });
  assert.deepEqual(JSON.parse(readFileSync(bridge, 'utf8')), {
    ...originalBridge,
    snowluma: { ...originalBridge.snowluma, httpUrl: 'http://127.0.0.1:4123' },
  });
  assert.deepEqual(recordedOperations(recordFile), [
    ['restart', 'framework-gateway'],
    ['restart', 'bridge'],
  ]);
  assert.deepEqual(fetchCalls, [{
    url: 'http://127.0.0.1:3000/get_status', authorization: `Bearer ${upstreamToken}`,
  }]);
});

test('gateway apply rejects token mismatch and port zero before any restart', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'management-preflight-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const gateway = join(directory, 'gateway.json');
  const bridge = join(directory, 'bridge.json');
  const admin = join(directory, 'admin.json');
  const manager = join(directory, 'service-manager.ts');
  const recordFile = join(directory, 'operations.log');
  const gatewayToken = 'controlled-gateway-token-value';
  writeFileSync(join(directory, 'gateway.token'), gatewayToken, { mode: 0o600 });
  writeFileSync(join(directory, 'upstream.token'), 'controlled-upstream-token-value', { mode: 0o600 });
  privateJson(admin, { host: '127.0.0.1', port: 3210 });
  privateJson(gateway, gatewayConfiguration(directory, 4123));
  privateJson(bridge, { snowluma: { httpUrl: 'http://127.0.0.1:3123', accessToken: 'different-token-value' } });
  writeFileSync(manager, `#!/usr/bin/env node\nimport {appendFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(recordFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`, { mode: 0o700 });
  chmodSync(manager, 0o700);
  const mismatched = createManagementOperations({ adminConfigurationFilename: admin, gatewayConfigurationFilename: gateway,
    legacyConfigurationFilename: bridge, serviceManager: manager, fetch: successfulProtocolFetch });
  await assert.rejects(mismatched.apply('gateway', revision(gateway)), { code: 'protocol_credentials_mismatch' });
  assert.deepEqual(recordedOperations(recordFile), []);
  privateJson(gateway, gatewayConfiguration(directory, 0));
  privateJson(bridge, { snowluma: { httpUrl: 'http://127.0.0.1:3123', accessToken: gatewayToken } });
  const zeroPort = createManagementOperations({ adminConfigurationFilename: admin, gatewayConfigurationFilename: gateway,
    legacyConfigurationFilename: bridge, serviceManager: manager, fetch: successfulProtocolFetch });
  await assert.rejects(zeroPort.apply('gateway', revision(gateway)), { code: 'managed_gateway_port_required' });
  assert.deepEqual(recordedOperations(recordFile), []);
});

test('gateway apply rejects a source revision changed during upstream preflight without restarting', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'management-source-cas-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const gateway = join(directory, 'gateway.json');
  const admin = join(directory, 'admin.json');
  const manager = join(directory, 'service-manager.ts');
  const recordFile = join(directory, 'operations.log');
  writeFileSync(join(directory, 'gateway.token'), 'controlled-gateway-token-value', { mode: 0o600 });
  writeFileSync(join(directory, 'upstream.token'), 'controlled-upstream-token-value', { mode: 0o600 });
  privateJson(gateway, gatewayConfiguration(directory, 4123));
  privateJson(admin, { host: '127.0.0.1', port: 3210 });
  writeFileSync(manager, `#!/usr/bin/env node\nimport {appendFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(recordFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`, { mode: 0o700 });
  chmodSync(manager, 0o700);
  const expectedRevision = revision(gateway);
  const operations = createManagementOperations({ adminConfigurationFilename: admin, gatewayConfigurationFilename: gateway,
    serviceManager: manager,
    fetch: async () => {
      const concurrent = JSON.parse(readFileSync(gateway, 'utf8')) as Record<string, unknown>;
      concurrent.maxPending = 7;
      privateJson(gateway, concurrent);
      return successfulProtocolFetch();
    },
  });
  await assert.rejects(operations.apply('gateway', expectedRevision), { code: 'revision_conflict' });
  assert.equal(JSON.parse(readFileSync(gateway, 'utf8')).maxPending, 7);
  assert.deepEqual(recordedOperations(recordFile), []);
});

test('bridge CAS conflict after gateway restart preserves the concurrent edit and reports partial state as unknown', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'management-bridge-cas-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const gateway = join(directory, 'gateway.json');
  const bridge = join(directory, 'bridge.json');
  const admin = join(directory, 'admin.json');
  const manager = join(directory, 'service-manager.ts');
  const recordFile = join(directory, 'operations.log');
  const gatewayToken = 'controlled-gateway-token-value';
  writeFileSync(join(directory, 'gateway.token'), gatewayToken, { mode: 0o600 });
  writeFileSync(join(directory, 'upstream.token'), 'controlled-upstream-token-value', { mode: 0o600 });
  privateJson(gateway, gatewayConfiguration(directory, 4123));
  privateJson(admin, { host: '127.0.0.1', port: 3210 });
  privateJson(bridge, { snowluma: { httpUrl: 'http://127.0.0.1:3123', accessToken: gatewayToken }, concurrentEdit: false });
  writeFileSync(manager, `#!/usr/bin/env node\nimport {appendFileSync, readFileSync, writeFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(recordFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nif (process.argv[3] === 'framework-gateway') {\n  const configuration = JSON.parse(readFileSync(${JSON.stringify(bridge)}, 'utf8'));\n  configuration.concurrentEdit = true;\n  writeFileSync(${JSON.stringify(bridge)}, JSON.stringify(configuration, null, 2) + '\\n');\n}\n`, { mode: 0o700 });
  chmodSync(manager, 0o700);
  const operations = createManagementOperations({ adminConfigurationFilename: admin, gatewayConfigurationFilename: gateway,
    legacyConfigurationFilename: bridge, serviceManager: manager, fetch: successfulProtocolFetch });
  await assert.rejects(operations.apply('gateway', revision(gateway)), { code: 'management_operation_unknown' });
  const currentBridge = JSON.parse(readFileSync(bridge, 'utf8'));
  assert.equal(currentBridge.concurrentEdit, true);
  assert.equal(currentBridge.snowluma.httpUrl, 'http://127.0.0.1:3123');
  assert.deepEqual(recordedOperations(recordFile), [['restart', 'framework-gateway']]);
});

test('gateway and bridge restarts share one bounded budget and partial application is unknown', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'management-timeout-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const gateway = join(directory, 'gateway.json');
  const bridge = join(directory, 'bridge.json');
  const admin = join(directory, 'admin.json');
  const manager = join(directory, 'service-manager.ts');
  const recordFile = join(directory, 'operations.log');
  const gatewayToken = 'controlled-gateway-token-value';
  writeFileSync(join(directory, 'gateway.token'), gatewayToken, { mode: 0o600 });
  writeFileSync(join(directory, 'upstream.token'), 'controlled-upstream-token-value', { mode: 0o600 });
  privateJson(gateway, gatewayConfiguration(directory, 4123));
  privateJson(admin, { host: '127.0.0.1', port: 3210 });
  privateJson(bridge, { snowluma: { httpUrl: 'http://127.0.0.1:3123', accessToken: gatewayToken }, preserved: true });
  writeFileSync(manager, `#!/usr/bin/env node\nimport {appendFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(recordFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nif (process.argv[3] === 'bridge') setTimeout(() => {}, 10000);\n`, { mode: 0o700 });
  chmodSync(manager, 0o700);
  const operations = createManagementOperations({ adminConfigurationFilename: admin, gatewayConfigurationFilename: gateway,
    legacyConfigurationFilename: bridge, serviceManager: manager, fetch: successfulProtocolFetch, operationTimeoutMs: 1_500 });
  const startedAt = Date.now();
  await assert.rejects(operations.apply('gateway', revision(gateway)), { code: 'management_operation_unknown' });
  assert(Date.now() - startedAt < 5_000);
  assert.deepEqual(recordedOperations(recordFile), [
    ['restart', 'framework-gateway'],
    ['restart', 'bridge'],
  ]);
  const currentBridge = JSON.parse(readFileSync(bridge, 'utf8'));
  assert.equal(currentBridge.snowluma.httpUrl, 'http://127.0.0.1:4123');
  assert.equal(currentBridge.preserved, true);
});

test('admin listener changes report accepted before the detached self-restart', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'management-admin-restart-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const admin = join(directory, 'admin.json');
  const manager = join(directory, 'service-manager.ts');
  const recordFile = join(directory, 'operations.log');
  privateJson(admin, { host: '0.0.0.0', port: 4321 });
  writeFileSync(manager, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(recordFile)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
  const operations = createManagementOperations({ adminConfigurationFilename: admin, gatewayConfigurationFilename: join(directory, 'gateway.json'), serviceManager: manager });
  assert.deepEqual(await operations.apply('admin', revision(admin)), { accepted: true, reconnect: true, port: 4321 });
  let result: string | undefined;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { try { result = readFileSync(recordFile, 'utf8'); break; } catch { await delay(30); } }
  assert(result);
  assert.deepEqual(JSON.parse(result), ['restart', 'framework-admin']);
});
