import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { activateLegacyGateway, prepareLegacyGateway, rollbackLegacyGateway } from '../src/integrations/legacy-gateway.ts';
import { loadOneBotGatewayConfiguration } from '../src/host/onebot-gateway.ts';

const token = 'legacy-test-token-01234567890123456789';
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'framework-migration-'));
  const legacyRoot = join(directory, 'legacy');
  const runtimeDirectory = join(directory, 'runtime');
  mkdirSync(join(legacyRoot, 'config/local'), { recursive: true, mode: 0o700 });
  const original = { snowluma: { httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001', accessToken: token },
    allow: { private: [123], groups: [456] }, socialV2: { proactive: { enabled: false } }, localPolicy: { delegation: true } };
  const filename = join(legacyRoot, 'config.json');
  writeFileSync(filename, JSON.stringify(original), { mode: 0o600 });
  return { directory, legacyRoot, runtimeDirectory, filename, original };
}

test('legacy preparation only writes private migration assets and leaves live config unchanged', context => {
  const source = fixture();
  context.after(() => rmSync(source.directory, { recursive: true, force: true }));
  const receipt = prepareLegacyGateway(source);
  assert.equal(receipt.active, false);
  assert.deepEqual(JSON.parse(readFileSync(source.filename, 'utf8')), source.original);
  const config = loadOneBotGatewayConfiguration(receipt.gatewayConfiguration);
  assert.deepEqual(config.allowedConversations, ['private:123', 'group:456']);
  assert.equal(config.upstreamEndpoint, source.original.snowluma.httpUrl);
  assert.equal(statSync(config.tokenFile).mode & 0o777, 0o600);
  assert.equal(statSync(join(source.runtimeDirectory, 'legacy-config-before.json')).mode & 0o777, 0o600);
  assert.deepEqual(prepareLegacyGateway(source), receipt);
});

test('legacy activation checks exact healthy gateway, patches one endpoint and rollback preserves new edits', async context => {
  const source = fixture();
  const server = createServer((request, response) => {
    assert.equal(request.url, '/health');
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    const config = loadOneBotGatewayConfiguration(join(source.legacyRoot, 'config/local/framework-gateway.json'));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, revision: createHash('sha256').update(JSON.stringify(config)).digest('hex') }));
  });
  await new Promise<void>(complete => server.listen(0, '127.0.0.1', complete));
  context.after(async () => { await new Promise<void>(complete => server.close(() => complete())); rmSync(source.directory, { recursive: true, force: true }); });
  const options = { ...source, port: (server.address() as AddressInfo).port };
  const prepared = prepareLegacyGateway(options);
  const edited = { ...source.original, unrelated: 'another session edit' };
  writeFileSync(source.filename, JSON.stringify(edited));
  assert.equal((await activateLegacyGateway(options)).active, true);
  const active = JSON.parse(readFileSync(source.filename, 'utf8'));
  assert.deepEqual(active, { ...edited, snowluma: { ...edited.snowluma, httpUrl: prepared.gatewayEndpoint } });
  writeFileSync(source.filename, JSON.stringify({ ...active, newer: 'do not revert' }));
  assert.equal(rollbackLegacyGateway(options).active, false);
  const rolledBack = JSON.parse(readFileSync(source.filename, 'utf8'));
  assert.deepEqual(rolledBack, { ...edited, newer: 'do not revert' });
  assert(!existsSync(prepared.gatewayConfiguration));
  assert(existsSync(`${prepared.gatewayConfiguration}.disabled`));
  assert.equal(rollbackLegacyGateway(options).active, false);
  assert.equal(prepareLegacyGateway(options).active, false);
  assert(existsSync(prepared.gatewayConfiguration));
});

test('legacy activation rejects a different healthy process without modifying the bridge', async context => {
  const source = fixture();
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ok":true,"revision":"wrong"}'); });
  await new Promise<void>(complete => server.listen(0, '127.0.0.1', complete));
  context.after(async () => { await new Promise<void>(complete => server.close(() => complete())); rmSync(source.directory, { recursive: true, force: true }); });
  const options = { ...source, port: (server.address() as AddressInfo).port };
  prepareLegacyGateway(options);
  await assert.rejects(activateLegacyGateway(options), { code: 'LEGACY_GATEWAY_NOT_READY' });
  assert.deepEqual(JSON.parse(readFileSync(source.filename, 'utf8')), source.original);
});

test('legacy rollback refuses to overwrite a separately changed endpoint', context => {
  const source = fixture();
  context.after(() => rmSync(source.directory, { recursive: true, force: true }));
  prepareLegacyGateway(source);
  const changed = { ...source.original, snowluma: { ...source.original.snowluma, httpUrl: 'http://127.0.0.1:3999' } };
  writeFileSync(source.filename, JSON.stringify(changed));
  assert.throws(() => rollbackLegacyGateway(source), { code: 'LEGACY_ENDPOINT_CHANGED' });
  assert.deepEqual(JSON.parse(readFileSync(source.filename, 'utf8')), changed);
});

test('legacy preparation refuses changed credentials instead of overwriting the prepared token', context => {
  const source = fixture();
  context.after(() => rmSync(source.directory, { recursive: true, force: true }));
  prepareLegacyGateway(source);
  writeFileSync(source.filename, JSON.stringify({ ...source.original, snowluma: { ...source.original.snowluma, accessToken: token + '-new' } }));
  assert.throws(() => prepareLegacyGateway(source), { code: 'LEGACY_TOKEN_CHANGED' });
  assert.equal(readFileSync(join(source.runtimeDirectory, 'gateway.token'), 'utf8').trim(), token);
});
