import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { loadOneBotGatewayConfiguration, startOneBotGateway } from '../src/host/onebot-gateway.ts';

const execute = promisify(execFile);
const token = 'local-gateway-fixture-token-0123456789';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'framework-gateway-'));
  const filename = join(directory, 'gateway.json');
  writeFileSync(join(directory, 'token'), token, { mode: 0o600 });
  const data = { port: 0, upstreamEndpoint: 'http://127.0.0.1:1', tokenFile: './token', storeFilename: './gateway.sqlite',
    allowedConversations: ['private:123'], persona: { id: 'compatibility', version: '1.0.0' } };
  writeFileSync(filename, JSON.stringify(data), { mode: 0o600 });
  return { directory, filename, data };
}

test('gateway configuration requires private bounded files, loopback upstream and explicit target limits', context => {
  const source = fixture();
  context.after(() => rmSync(source.directory, { recursive: true, force: true }));
  const config = loadOneBotGatewayConfiguration(source.filename);
  assert.equal(config.tokenFile, join(source.directory, 'token'));
  assert(Object.isFrozen(config));
  assert(Object.isFrozen(config.allowedConversations));
  for (const patch of [{ upstreamEndpoint: 'http://example.com' }, { timeoutMs: 0 }, { unexpected: true },
    { allowedConversations: ['private:123', 'private:123'] }, { maxBodyBytes: 64 * 1024 * 1024 },
    { budgetEnabled: 'false' }]) {
    writeFileSync(source.filename, JSON.stringify({ ...source.data, ...patch }));
    assert.throws(() => loadOneBotGatewayConfiguration(source.filename));
  }
  writeFileSync(source.filename, JSON.stringify({ ...source.data, budgetEnabled: false,
    maxSendUses: 2, grantTtlMs: 1000 }));
  const disabled = loadOneBotGatewayConfiguration(source.filename);
  assert.equal(disabled.budgetEnabled, false);
  assert.equal(disabled.maxSendUses, 2);
  assert.equal(disabled.grantTtlMs, 1000);
  writeFileSync(source.filename, JSON.stringify(source.data));
  chmodSync(source.filename, 0o644);
  assert.throws(() => loadOneBotGatewayConfiguration(source.filename), { code: 'GATEWAY_PRIVATE_FILE' });
});

test('gateway runtime authenticates health, forwards a read and closes idempotently', async context => {
  const source = fixture();
  const upstream = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.equal(request.url, '/get_status');
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { online: true, good: true } }));
  });
  await new Promise<void>(complete => upstream.listen(0, '127.0.0.1', complete));
  const config = { ...loadOneBotGatewayConfiguration(source.filename), upstreamEndpoint: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` };
  const service = await startOneBotGateway(config);
  context.after(async () => { await service.close(); await new Promise<void>(complete => upstream.close(() => complete())); rmSync(source.directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${service.address.port}`;
  assert.equal(service.address.address, '127.0.0.1');
  assert.equal((await fetch(`${base}/health`)).status, 401);
  const health = await (await fetch(`${base}/health`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(health.mode, 'legacy-egress-compatibility');
  assert.equal(health.revision, service.revision);
  const result = await (await fetch(`${base}/get_status`, { method: 'POST', headers: { authorization: `Bearer ${token}`,
    'content-type': 'application/json' }, body: '{}' })).json();
  assert.equal(result.data.online, true);
  await service.close();
  await service.close();
});

test('gateway runtime rejects a duplicate listener without disturbing the active instance', async context => {
  const source = fixture();
  const config = loadOneBotGatewayConfiguration(source.filename);
  const service = await startOneBotGateway(config);
  context.after(async () => { await service.close(); rmSync(source.directory, { recursive: true, force: true }); });
  await assert.rejects(startOneBotGateway({ ...config, port: service.address.port }), { code: 'EADDRINUSE' });
  const result = await fetch(`http://127.0.0.1:${service.address.port}/health`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(result.status, 200);
});

test('gateway CLI health rejects a stale configuration revision', async context => {
  const source = fixture();
  const config = loadOneBotGatewayConfiguration(source.filename);
  const service = await startOneBotGateway(config);
  context.after(async () => { await service.close(); rmSync(source.directory, { recursive: true, force: true }); });
  writeFileSync(source.filename, JSON.stringify({ ...source.data, port: service.address.port }));
  const extension = import.meta.url.endsWith('.js') ? 'js' : 'ts';
  const script = new URL(`../scripts/onebot-gateway.${extension}`, import.meta.url);
  await assert.rejects(execute(process.execPath, [script.pathname, '--config', source.filename, '--health']), error => {
    assert(error instanceof Error && 'stderr' in error && typeof error.stderr === 'string');
    assert.equal(error.stderr.trim(), 'GATEWAY_START_FAILED');
    assert(!error.stderr.includes(token));
    return true;
  });
});
