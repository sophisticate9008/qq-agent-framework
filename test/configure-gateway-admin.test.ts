import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configureGatewayAdmin } from '../scripts/configure-gateway-admin.ts';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-admin-setup-'));
  const gatewayConfigurationFilename = join(directory, 'gateway.json');
  writeFileSync(gatewayConfigurationFilename, JSON.stringify({ port: 3131, upstreamEndpoint: 'http://127.0.0.1:3000',
    tokenFile: join(directory, 'gateway.token'), storeFilename: join(directory, 'gateway.sqlite'),
    allowedConversations: ['private:1'], persona: { id: 'test', version: '1' } }), { mode: 0o600 });
  return { directory, gatewayConfigurationFilename, configurationFilename: join(directory, 'admin.json') };
}

test('admin setup defaults to loopback and creates private configuration and independent token without disclosing it', () => {
  const values = fixture();
  try {
    const result = configureGatewayAdmin(values);
    assert.equal(result.host, '127.0.0.1');
    assert.equal(result.tokenCreated, true);
    assert.equal(statSync(result.configuration).mode & 0o077, 0);
    assert.equal(statSync(result.tokenFile).mode & 0o077, 0);
    const token = readFileSync(result.tokenFile, 'utf8').trim();
    assert.equal(token.length, 64);
    assert.equal(JSON.stringify(result).includes(token), false);
    const before = readFileSync(result.configuration, 'utf8');
    assert.throws(() => configureGatewayAdmin({ ...values, host: '0.0.0.0', port: 9876 }));
    assert.equal(readFileSync(result.configuration, 'utf8'), before);
    assert.equal(readFileSync(result.tokenFile, 'utf8').trim(), token);
  } finally { rmSync(values.directory, { recursive: true, force: true }); }
});

test('admin setup supports configurable listener, port and preexisting private token', () => {
  const values = fixture();
  try {
    const tokenFilename = join(values.directory, 'chosen.token');
    writeFileSync(tokenFilename, 'administrator-existing-token-value\n', { mode: 0o600 });
    const result = configureGatewayAdmin({ ...values, tokenFilename, host: '0.0.0.0', port: 9876 });
    assert.equal(result.host, '0.0.0.0');
    assert.equal(result.port, 9876);
    assert.equal(result.tokenCreated, false);
    assert.equal(JSON.parse(readFileSync(result.configuration, 'utf8')).tokenFile, tokenFilename);
  } finally { rmSync(values.directory, { recursive: true, force: true }); }
});

test('admin setup rejects invalid host, port, conflicting paths and nonprivate token', () => {
  const values = fixture();
  try {
    for (const host of ['http://0.0.0.0', 'network.invalid', '0.0.0.0:3210']) assert.throws(() => configureGatewayAdmin({ ...values, host }));
    for (const port of [0, -1, 65536, 1.5]) assert.throws(() => configureGatewayAdmin({ ...values, port }));
    assert.throws(() => configureGatewayAdmin({ ...values, tokenFilename: values.configurationFilename }));
    const tokenFilename = join(values.directory, 'unsafe.token');
    writeFileSync(tokenFilename, 'administrator-existing-token-value', { mode: 0o644 });
    assert.throws(() => configureGatewayAdmin({ ...values, tokenFilename }));
  } finally { rmSync(values.directory, { recursive: true, force: true }); }
});
