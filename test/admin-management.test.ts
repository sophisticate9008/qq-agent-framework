import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { createAdminBootstrap } from '../src/admin/bootstrap.ts';
import { createManagementOperations } from '../src/admin/operations.ts';
import { createAdminServer } from '../src/admin/server.ts';

function privateJson(filename: string, value: unknown): void {
  writeFileSync(filename, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

function revision(filename: string): string {
  return createHash('sha256').update(readFileSync(filename)).digest('hex');
}

function gatewayConfiguration(directory: string, port: number): Record<string, unknown> {
  return {
    port,
    upstreamEndpoint: 'http://127.0.0.1:3000',
    tokenFile: join(directory, 'gateway.token'),
    upstreamTokenFile: join(directory, 'upstream.token'),
    storeFilename: join(directory, 'gateway.sqlite'),
    allowedConversations: ['group:100'],
    persona: { id: 'test', version: '1' }
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

function managerScript(filename: string, recordFile: string, extra = ''): void {
  writeFileSync(filename, `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(recordFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');
${extra}
`, { mode: 0o700 });
  chmodSync(filename, 0o700);
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
  context.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(complete => server.close(() => complete()));
    rmSync(directory, { recursive: true, force: true });
  });
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
});

test('gateway apply validates the current revision and restarts only framework-gateway', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'management-apply-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const gateway = join(directory, 'gateway.json');
  const admin = join(directory, 'admin.json');
  const manager = join(directory, 'service-manager.ts');
  const recordFile = join(directory, 'operations.log');
  writeFileSync(join(directory, 'gateway.token'), 'controlled-gateway-token-value', { mode: 0o600 });
  writeFileSync(join(directory, 'upstream.token'), 'controlled-upstream-token-value', { mode: 0o600 });
  privateJson(gateway, gatewayConfiguration(directory, 4123));
  privateJson(admin, { host: '127.0.0.1', port: 3210 });
  managerScript(manager, recordFile);
  const fetchCalls: Array<{ url: string; authorization: string | null }> = [];
  const operations = createManagementOperations({
    adminConfigurationFilename: admin,
    gatewayConfigurationFilename: gateway,
    serviceManager: manager,
    fetch: async (input, init) => {
      fetchCalls.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
      return successfulProtocolFetch();
    }
  });
  await assert.rejects(operations.apply('gateway', 'wrong-revision'), { code: 'revision_conflict' });
  assert.deepEqual(await operations.apply('gateway', revision(gateway)), { applied: true });
  assert.deepEqual(recordedOperations(recordFile), [['restart', 'framework-gateway']]);
  assert.deepEqual(fetchCalls, [{
    url: 'http://127.0.0.1:3000/get_status',
    authorization: 'Bearer controlled-upstream-token-value'
  }]);
});

test('gateway apply rejects port zero before invoking the service manager', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'management-preflight-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const gateway = join(directory, 'gateway.json');
  const admin = join(directory, 'admin.json');
  const manager = join(directory, 'service-manager.ts');
  const recordFile = join(directory, 'operations.log');
  writeFileSync(join(directory, 'gateway.token'), 'controlled-gateway-token-value', { mode: 0o600 });
  writeFileSync(join(directory, 'upstream.token'), 'controlled-upstream-token-value', { mode: 0o600 });
  privateJson(gateway, gatewayConfiguration(directory, 0));
  privateJson(admin, { host: '127.0.0.1', port: 3210 });
  managerScript(manager, recordFile);
  const operations = createManagementOperations({ adminConfigurationFilename: admin, gatewayConfigurationFilename: gateway,
    serviceManager: manager, fetch: successfulProtocolFetch });
  await assert.rejects(operations.apply('gateway', revision(gateway)), { code: 'managed_gateway_port_required' });
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
  managerScript(manager, recordFile);
  const expectedRevision = revision(gateway);
  const operations = createManagementOperations({ adminConfigurationFilename: admin, gatewayConfigurationFilename: gateway,
    serviceManager: manager,
    fetch: async () => {
      const concurrent = JSON.parse(readFileSync(gateway, 'utf8')) as Record<string, unknown>;
      concurrent.maxPending = 7;
      privateJson(gateway, concurrent);
      return successfulProtocolFetch();
    }
  });
  await assert.rejects(operations.apply('gateway', expectedRevision), { code: 'revision_conflict' });
  assert.equal(JSON.parse(readFileSync(gateway, 'utf8')).maxPending, 7);
  assert.deepEqual(recordedOperations(recordFile), []);
});

test('gateway restart timeout is bounded and reports the operation as unknown', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'management-timeout-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const gateway = join(directory, 'gateway.json');
  const admin = join(directory, 'admin.json');
  const manager = join(directory, 'service-manager.ts');
  const recordFile = join(directory, 'operations.log');
  writeFileSync(join(directory, 'gateway.token'), 'controlled-gateway-token-value', { mode: 0o600 });
  writeFileSync(join(directory, 'upstream.token'), 'controlled-upstream-token-value', { mode: 0o600 });
  privateJson(gateway, gatewayConfiguration(directory, 4123));
  privateJson(admin, { host: '127.0.0.1', port: 3210 });
  managerScript(manager, recordFile, 'setTimeout(() => {}, 10000);');
  const operations = createManagementOperations({ adminConfigurationFilename: admin, gatewayConfigurationFilename: gateway,
    serviceManager: manager, fetch: successfulProtocolFetch, operationTimeoutMs: 1_500 });
  const startedAt = Date.now();
  await assert.rejects(operations.apply('gateway', revision(gateway)), { code: 'management_operation_unknown' });
  assert(Date.now() - startedAt < 5_000);
  assert.deepEqual(recordedOperations(recordFile), [['restart', 'framework-gateway']]);
});

test('admin listener changes report accepted before the detached framework-admin restart', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'management-admin-restart-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const admin = join(directory, 'admin.json');
  const manager = join(directory, 'service-manager.ts');
  const recordFile = join(directory, 'operations.log');
  privateJson(admin, { host: '0.0.0.0', port: 4321 });
  writeFileSync(manager, `#!/usr/bin/env node
import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify(process.argv.slice(2)));
`, { mode: 0o700 });
  const operations = createManagementOperations({ adminConfigurationFilename: admin,
    gatewayConfigurationFilename: join(directory, 'gateway.json'), serviceManager: manager });
  assert.deepEqual(await operations.apply('admin', revision(admin)), { accepted: true, reconnect: true, port: 4321 });
  let result: string | undefined;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { result = readFileSync(recordFile, 'utf8'); break; } catch { await delay(30); }
  }
  assert(result);
  assert.deepEqual(JSON.parse(result), ['restart', 'framework-admin']);
});
