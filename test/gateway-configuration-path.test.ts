import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCli } from '../scripts/cli.ts';
import { loadGatewayAdminConfiguration, startGatewayAdmin } from '../src/admin/gateway.ts';
import { loadOneBotGatewayConfiguration } from '../src/host/onebot-gateway.ts';
import { createAdminBootstrap } from '../src/admin/bootstrap.ts';
import { isConfigurationPath, resolveConfigurationPath } from '../src/host/configuration-path.ts';
import { reference } from '../src/core/values.ts';

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function fixture(context: TestContext, deep = false) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'gateway-path-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = deep ? join(root, 'private-configuration-'.repeat(3), 'application-data-'.repeat(4)) : root;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const admin = join(directory, 'admin.json');
  const gateway = join(directory, 'gateway.json');
  const token = join(directory, 'admin.token');
  const gatewayToken = join(directory, 'gateway.token');
  const store = join(directory, 'gateway.sqlite');
  const writeAdmin = (changes: Record<string, unknown> = {}) => writeFileSync(admin, JSON.stringify({
    host: '127.0.0.1', port: 0, tokenFile: './admin.token', gatewayConfiguration: './gateway.json', ...changes
  }), { mode: 0o600 });
  const writeGateway = (changes: Record<string, unknown> = {}) => writeFileSync(gateway, JSON.stringify({
    port: 0, upstreamEndpoint: 'http://127.0.0.1:9', tokenFile: './gateway.token', storeFilename: './gateway.sqlite',
    allowedConversations: [], persona: { id: 'fixture', version: '1' }, ...changes
  }), { mode: 0o600 });
  writeAdmin();
  writeGateway();
  writeFileSync(gatewayToken, 'synthetic-gateway-token-0123456789', { mode: 0o600 });
  return { root, directory, admin, gateway, token, gatewayToken, store, writeAdmin, writeGateway };
}

async function firstSetupAndLogin(configuration: ReturnType<typeof loadGatewayAdminConfiguration>) {
  const service = await startGatewayAdmin(configuration);
  try {
    const origin = `http://127.0.0.1:${service.address.port}`;
    assert.equal((await fetch(`${origin}/api/chat/plans`)).status, 401);
    assert.equal((await fetch(`${origin}/api/setup`)).status, 200);
    const foreign = await fetch(`${origin}/api/setup`, { method: 'POST', headers: { origin: 'http://foreign.test', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(foreign.status, 403);
    assert.equal(existsSync(configuration.tokenFile), false);
    const setup = await fetch(`${origin}/api/setup`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(setup.status, 200);
    const initialized = object(await setup.json());
    assert.equal(initialized.initialized, true);
    assert.equal(initialized.canInitialize, false);
    assert.equal(statSync(configuration.tokenFile).mode & 0o777, 0o600);
    assert.equal(statSync(`${configuration.tokenFile}.initialized`).mode & 0o777, 0o600);
    const token = readFileSync(configuration.tokenFile, 'utf8').trim();
    const login = await fetch(`${origin}/api/auth/login`, { method: 'POST',
      headers: { origin, 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}' });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert(cookie);
    assert.equal((await fetch(`${origin}/api/auth/session`, { headers: { cookie } })).status, 200);
    const response = await fetch(`${origin}/api/chat/plans`, { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.deepEqual(object(await response.json()).plans, []);
    assert.equal((await fetch(`${origin}/api/chat/plans`, { headers: { authorization: 'Bearer wrong-synthetic-token' } })).status, 401);
  } finally { await service.close(); }
}

for (const deep of [false, true]) test(`relative configuration paths support actual setup/login in ${deep ? 'deep' : 'short'} private directory`, async context => {
  const data = fixture(context, deep);
  const configuration = loadGatewayAdminConfiguration(data.admin);
  assert.equal(configuration.tokenFile, data.token);
  assert.equal(configuration.gatewayConfiguration, data.gateway);
  if (deep) {
    assert(data.token.length > 160);
    assert(data.gateway.length > 160);
  }
  await firstSetupAndLogin(configuration);
  assert.equal(existsSync(data.store), false);
});

test('real CLI init default private files remain usable for deep-directory administrator setup without a build', async context => {
  const data = fixture(context, true);
  const filename = join(data.directory, 'new-install', 'admin', 'config.json');
  const errors: string[] = [];
  const result = await runCli(['init', '--config', filename], {
    cwd: data.directory, env: {}, stdout: () => undefined, stderr: value => errors.push(value)
  });
  assert.equal(result, 0, errors.join('\n'));
  const configuration = loadGatewayAdminConfiguration(filename);
  assert(configuration.gatewayConfiguration.length > 160);
  assert.equal(statSync(join(data.directory, 'new-install', 'admin')).mode & 0o777, 0o700);
  assert.equal(existsSync(configuration.tokenFile), false);
  await firstSetupAndLogin({ ...configuration, port: 0 });
});

test('configuration files and token files remain private regular non-symlink files', async context => {
  const data = fixture(context);
  const original = readFileSync(data.admin);
  for (const path of [data.admin, data.gateway]) {
    chmodSync(path, 0o644);
    assert.throws(() => loadGatewayAdminConfiguration(data.admin));
    chmodSync(path, 0o600);
  }
  chmodSync(data.gatewayToken, 0o644);
  await assert.rejects(startGatewayAdmin(loadGatewayAdminConfiguration(data.admin)));
  chmodSync(data.gatewayToken, 0o600);
  const alias = join(data.directory, 'alias.json');
  symlinkSync(data.admin, alias);
  assert.throws(() => loadGatewayAdminConfiguration(alias));
  const tokenAlias = join(data.directory, 'alias.token');
  symlinkSync(data.gatewayToken, tokenAlias);
  data.writeAdmin({ tokenFile: './alias.token' });
  assert.throws(() => loadGatewayAdminConfiguration(data.admin));
  data.writeAdmin();
  assert.deepEqual(readFileSync(data.admin), original);
  const linkedDirectory = join(data.root, 'linked-directory');
  const actualDirectory = join(data.root, 'actual-directory');
  mkdirSync(actualDirectory, { mode: 0o700 });
  symlinkSync(actualDirectory, linkedDirectory);
  const configuration = loadGatewayAdminConfiguration(data.admin);
  for (const directory of [linkedDirectory, actualDirectory]) {
    if (directory === actualDirectory) chmodSync(directory, 0o755);
    const tokenFile = join(directory, 'admin.token');
    assert.throws(() => createAdminBootstrap({ tokenFile }).status(), { code: 'ADMIN_BOOTSTRAP_DIRECTORY_SECURITY' });
    const service = await startGatewayAdmin({ ...configuration, tokenFile });
    try {
      const origin = `http://127.0.0.1:${service.address.port}`;
      const response = await fetch(`${origin}/api/setup`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 500);
      assert.equal(object(await response.json()).error, 'internal_error');
      assert.equal(existsSync(tokenFile), false);
    } finally { await service.close(); }
    if (directory === actualDirectory) chmodSync(directory, 0o700);
  }
});

test('explicit long absolute configuration filesystem fields are valid independently of business identifiers', async context => {
  const data = fixture(context, true);
  data.writeAdmin({ tokenFile: data.token, gatewayConfiguration: data.gateway });
  data.writeGateway({ tokenFile: data.gatewayToken, upstreamTokenFile: data.gatewayToken, storeFilename: data.store });
  const gateway = loadOneBotGatewayConfiguration(data.gateway);
  assert.equal(gateway.tokenFile, data.gatewayToken);
  assert.equal(gateway.upstreamTokenFile, data.gatewayToken);
  assert.equal(gateway.storeFilename, data.store);
  await firstSetupAndLogin(loadGatewayAdminConfiguration(data.admin));
});

test('configuration path validation bounds UTF-8 bytes before and after resolution without changing reference identifiers', context => {
  const data = fixture(context);
  assert.equal(isConfigurationPath('/' + '界'.repeat(1365)), true);
  for (const value of ['', ' ', 'x\0y', 'x\ny', 'x\ry', 'x\ty', 'x\u007fy', 'x'.repeat(4097),
    '/' + '界'.repeat(1366), 'file:///tmp/admin.token', 'https://foreign.test/admin.token', null, 5]) {
    assert.equal(isConfigurationPath(value), false);
  }
  assert.equal(resolveConfigurationPath('../admin.json', join(data.directory, 'nested')), data.admin);
  assert.throws(() => resolveConfigurationPath('child.token', '/' + 'x'.repeat(4090)));
  assert.equal(reference('a'.repeat(161)), false);
  data.writeGateway({ persona: { id: 'a'.repeat(161), version: '1' } });
  assert.throws(() => loadOneBotGatewayConfiguration(data.gateway), { code: 'GATEWAY_INVALID_CONFIG' });
});

test('all filesystem configuration fields reject controls, overlong bytes and URLs while OneBot URL restrictions stay intact', context => {
  const data = fixture(context);
  for (const value of ['x\0y', 'x\ny', 'x\u007fy', '界'.repeat(1400), 'file:///tmp/a', 'https://foreign.test/a']) {
    for (const key of ['tokenFile', 'gatewayConfiguration', 'serviceManager']) {
      data.writeAdmin({ [key]: value });
      assert.throws(() => loadGatewayAdminConfiguration(data.admin));
    }
    data.writeAdmin();
    for (const key of ['tokenFile', 'storeFilename', 'upstreamTokenFile']) {
      data.writeGateway({ [key]: value });
      assert.throws(() => loadOneBotGatewayConfiguration(data.gateway));
    }
    data.writeGateway();
  }
  for (const upstreamEndpoint of ['https://127.0.0.1:9', 'http://foreign.test', 'http://user:password@127.0.0.1:9',
    'http://127.0.0.1:9?key=synthetic', 'http://127.0.0.1:9#fragment']) {
    data.writeGateway({ upstreamEndpoint });
    assert.throws(() => loadOneBotGatewayConfiguration(data.gateway), { code: 'GATEWAY_INVALID_CONFIG' });
  }
});
