import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createConfigurationRoutes } from '../src/admin/configuration.ts';
import { AdminRequestError, type AdminRoute } from '../src/admin/server.ts';

interface Fixture {
  readonly directory: string;
  readonly gateway: string;
  readonly admin: string;
}

function fixture(context: test.TestContext): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'qq-configuration-'));
  const gateway = join(directory, 'gateway.json');
  const admin = join(directory, 'admin.json');
  writeFileSync(gateway, `${JSON.stringify({
    port: 3002,
    upstreamEndpoint: 'http://127.0.0.1:3100',
    tokenFile: 'gateway.token',
    upstreamTokenFile: 'upstream.token',
    storeFilename: 'state/gateway.sqlite',
    allowedConversations: ['group:123456'],
    persona: { id: 'fixture', version: '1.0.0' },
    timeoutMs: 15_000,
    maxPending: 16,
    maxBodyBytes: 28 * 1024 * 1024,
    maxRecords: 10_000,
    budgetEnabled: true,
    maxSendUses: 7,
    grantTtlMs: 60_000,
    authorizationVersion: 'existing-scope'
  }, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(admin, `${JSON.stringify({
    host: '127.0.0.1',
    port: 3210,
    tokenFile: 'admin.token',
    gatewayConfiguration: 'gateway.json',
    serviceManager: 'bin/service-manager'
  }, null, 2)}\n`, { mode: 0o600 });
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, gateway, admin };
}

function routes(files: Fixture, apply?: Parameters<typeof createConfigurationRoutes>[0]['apply']): readonly AdminRoute[] {
  return createConfigurationRoutes({
    gatewayConfigurationFilename: files.gateway,
    adminConfigurationFilename: files.admin,
    ...(apply === undefined ? {} : { apply })
  });
}

function findRoute(items: readonly AdminRoute[], method: 'GET' | 'POST', pathname: string): AdminRoute {
  const route = items.find(candidate => candidate.method === method && candidate.pathname === pathname);
  assert(route);
  return route;
}

async function invoke(
  items: readonly AdminRoute[],
  method: 'GET' | 'POST',
  pathname: string,
  body: Record<string, unknown> | null = null,
  query = new URLSearchParams()
): Promise<unknown> {
  return findRoute(items, method, pathname).handle({ query, body, signal: new AbortController().signal });
}

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  assert(Array.isArray(value));
  return value;
}

function json(filename: string): Record<string, unknown> {
  return object(JSON.parse(readFileSync(filename, 'utf8')) as unknown);
}

function hash(filename: string): string {
  return createHash('sha256').update(readFileSync(filename)).digest('hex');
}

function fieldMap(snapshot: Record<string, unknown>, source?: string): Map<string, Record<string, unknown>> {
  const fields = new Map<string, Record<string, unknown>>();
  for (const groupValue of array(snapshot.groups)) {
    const group = object(groupValue);
    if (source !== undefined && group.source !== source) continue;
    for (const fieldValue of array(group.fields)) {
      const field = object(fieldValue);
      fields.set(String(field.id), field);
    }
  }
  return fields;
}

async function rejectsCode(operation: Promise<unknown>, statusCode: number, code: string): Promise<void> {
  await assert.rejects(operation, error => error instanceof AdminRequestError
    && error.statusCode === statusCode && error.code === code);
}

test('configuration GET exposes only gateway and admin sources with raw revisions', async context => {
  const files = fixture(context);
  const result = object(await invoke(routes(files), 'GET', '/api/configuration'));
  assert.deepEqual(result.capabilities, { apply: false });
  const groups = array(result.groups).map(object);
  assert.deepEqual(new Set(groups.map(group => group.source)), new Set(['gateway', 'admin']));
  for (const group of groups) {
    assert.equal(group.revision, hash(group.source === 'gateway' ? files.gateway : files.admin));
  }
  const gateway = fieldMap(result, 'gateway');
  assert(gateway.has('allowedConversations'));
  assert(gateway.has('upstreamEndpoint'));
  assert.equal(gateway.has('authorizationVersion'), false);
  assert.equal(gateway.has('budgetEnabled'), false);
  const admin = fieldMap(result, 'admin');
  assert.equal(admin.has('host'), false);
  assert.equal(admin.has('port'), false);
  assert.equal(admin.get('serviceManager')?.editable, false);
});

test('saves preserve unrelated fields, rotate authorization, and keep files private', async context => {
  const files = fixture(context);
  const items = routes(files);
  const beforeAuthorization = json(files.gateway).authorizationVersion;
  const saved = object(await invoke(items, 'POST', '/api/configuration', {
    source: 'gateway', revision: hash(files.gateway),
    changes: { allowedConversations: ['private:12345'], 'persona.version': '2.0.0' }
  }));
  assert.equal(saved.ok, true);
  assert.equal(saved.applyRequired, true);
  assert.equal(saved.authorizationReauthorization, 'pending_until_apply');
  const configuration = json(files.gateway);
  assert.equal(configuration.budgetEnabled, true);
  assert.equal(configuration.maxSendUses, 7);
  assert.equal(configuration.grantTtlMs, 60_000);
  assert.equal(configuration.maxPending, 16);
  assert.deepEqual(configuration.allowedConversations, ['private:12345']);
  assert.equal(object(configuration.persona).version, '2.0.0');
  assert.notEqual(configuration.authorizationVersion, beforeAuthorization);
  assert.match(String(configuration.authorizationVersion), /^[a-f0-9-]{36}$/);
  assert.equal(statSync(files.gateway).mode & 0o777, 0o600);
});

test('public HTTPS proxy settings are visible and saved together only for an explicit loopback listener', async context => {
  const files = fixture(context);
  const items = routes(files);
  const result = object(await invoke(items, 'GET', '/api/configuration'));
  const fields = fieldMap(result, 'admin');
  assert.equal(fields.get('publicOrigin')?.type, 'text');
  assert.equal(fields.get('trustedLoopbackProxy')?.type, 'boolean');
  for (const changes of [
    { publicOrigin: 'https://console.example.test' },
    { trustedLoopbackProxy: true },
    { publicOrigin: 'http://console.example.test', trustedLoopbackProxy: true },
    { publicOrigin: 'https://console.example.test/path', trustedLoopbackProxy: true }
  ]) await rejectsCode(invoke(items, 'POST', '/api/configuration', {
    source: 'admin', revision: hash(files.admin), changes
  }), 400, 'invalid_configuration');
  await invoke(items, 'POST', '/api/configuration', {
    source: 'admin', revision: hash(files.admin), changes: { publicOrigin: 'https://console.example.test', trustedLoopbackProxy: true }
  });
  assert.equal(json(files.admin).publicOrigin, 'https://console.example.test');
  assert.equal(json(files.admin).trustedLoopbackProxy, true);
  writeFileSync(files.admin, `${JSON.stringify({ ...json(files.admin), host: '0.0.0.0' })}\n`, { mode: 0o600 });
  await rejectsCode(invoke(items, 'POST', '/api/configuration', {
    source: 'admin', revision: hash(files.admin), changes: { publicOrigin: 'https://other.example.test', trustedLoopbackProxy: true }
  }), 400, 'invalid_configuration');
});

test('saves reject removed sources, unknown fields, prototype keys, unsafe paths, URLs, and stale writes', async context => {
  const files = fixture(context);
  const items = routes(files);
  const gatewayRevision = hash(files.gateway);
  await rejectsCode(invoke(items, 'POST', '/api/configuration', {
    source: 'bridge', revision: gatewayRevision, changes: {}
  }), 400, 'invalid_configuration');
  await rejectsCode(invoke(items, 'POST', '/api/configuration', {
    source: 'gateway', revision: gatewayRevision, changes: { unknownField: true }
  }), 400, 'configuration_field_forbidden');
  await rejectsCode(invoke(items, 'POST', '/api/configuration', JSON.parse(`{
    "source":"gateway","revision":"${gatewayRevision}","changes":{"__proto__":{"polluted":true}}
  }`) as Record<string, unknown>), 400, 'invalid_configuration');
  await rejectsCode(invoke(items, 'POST', '/api/configuration', {
    source: 'gateway', revision: gatewayRevision, changes: { tokenFile: '../outside.token' }
  }), 400, 'invalid_configuration');
  await rejectsCode(invoke(items, 'POST', '/api/configuration', {
    source: 'gateway', revision: gatewayRevision,
    changes: { upstreamEndpoint: 'http://127.0.0.1:3100/?token=secret' }
  }), 400, 'invalid_configuration');
  const first = object(await invoke(items, 'POST', '/api/configuration', {
    source: 'gateway', revision: gatewayRevision, changes: { port: 3003 }
  }));
  await rejectsCode(invoke(items, 'POST', '/api/configuration', {
    source: 'gateway', revision: gatewayRevision, changes: { port: 3004 }
  }), 409, 'configuration_conflict');
  assert.equal(first.revision, hash(files.gateway));
  assert.equal(json(files.gateway).port, 3003);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);
});

test('cross-field and source validation reject configurations the gateway cannot apply', async context => {
  const files = fixture(context);
  const items = routes(files);
  await rejectsCode(invoke(items, 'POST', '/api/configuration', {
    source: 'gateway', revision: hash(files.gateway), changes: { port: 3100 }
  }), 400, 'invalid_configuration');
  assert.equal(json(files.gateway).port, 3002);

  const invalid = json(files.gateway);
  invalid.maxPending = 0;
  writeFileSync(files.gateway, `${JSON.stringify(invalid, null, 2)}\n`, { mode: 0o600 });
  await rejectsCode(invoke(items, 'POST', '/api/configuration', {
    source: 'gateway', revision: hash(files.gateway), changes: { port: 3003 }
  }), 400, 'invalid_configuration');
  assert.equal(json(files.gateway).port, 3002);
});

test('read-only deployment paths cannot be changed into browser-supplied commands', async context => {
  const files = fixture(context);
  const items = routes(files);
  await rejectsCode(invoke(items, 'POST', '/api/configuration', {
    source: 'admin', revision: hash(files.admin), changes: { serviceManager: '/bin/sh -c id' }
  }), 400, 'configuration_field_forbidden');
  assert.equal(json(files.admin).serviceManager, 'bin/service-manager');
});

test('concurrent CAS allows one gateway writer', async context => {
  const files = fixture(context);
  const items = routes(files);
  const gatewayRevision = hash(files.gateway);
  const concurrent = await Promise.allSettled([
    invoke(items, 'POST', '/api/configuration', {
      source: 'gateway', revision: gatewayRevision, changes: { 'persona.version': '2.0.0' }
    }),
    invoke(items, 'POST', '/api/configuration', {
      source: 'gateway', revision: gatewayRevision, changes: { 'persona.version': '3.0.0' }
    })
  ]);
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = concurrent.find(result => result.status === 'rejected');
  assert(rejected?.status === 'rejected' && rejected.reason instanceof AdminRequestError);
  assert.equal(rejected.reason.code, 'configuration_conflict');
});

test('apply checks CAS and preserves callback application result', async context => {
  const files = fixture(context);
  const calls: Array<{ source: string; revision: string }> = [];
  const items = routes(files, (source, revision) => {
    calls.push({ source, revision });
    return source === 'admin'
      ? { accepted: true, reconnectUrl: 'http://127.0.0.1:4321/' }
      : { applied: true };
  });
  assert.deepEqual(await invoke(items, 'POST', '/api/configuration/apply', {
    source: 'gateway', revision: hash(files.gateway)
  }), {
    ok: true, source: 'gateway', revision: hash(files.gateway), application: { applied: true }
  });
  assert.deepEqual(await invoke(items, 'POST', '/api/configuration/apply', {
    source: 'admin', revision: hash(files.admin)
  }), {
    ok: true, source: 'admin', revision: hash(files.admin),
    application: { accepted: true, reconnectUrl: 'http://127.0.0.1:4321/' }
  });
  assert.equal(calls.length, 2);
  const stale = hash(files.gateway);
  writeFileSync(files.gateway, `${JSON.stringify({ ...json(files.gateway), external: true })}\n`, { mode: 0o600 });
  await rejectsCode(invoke(items, 'POST', '/api/configuration/apply', {
    source: 'gateway', revision: stale
  }), 409, 'configuration_conflict');
  assert.equal(calls.length, 2);

  await rejectsCode(invoke(routes(files), 'POST', '/api/configuration/apply', {
    source: 'admin', revision: hash(files.admin)
  }), 409, 'configuration_apply_unavailable');
});

test('private-file checks reject broad permissions and symlinks', async context => {
  const files = fixture(context);
  chmodSync(files.gateway, 0o644);
  await rejectsCode(invoke(routes(files), 'GET', '/api/configuration'), 500, 'configuration_file_invalid');
  chmodSync(files.gateway, 0o600);
  const target = join(files.directory, 'gateway-target.json');
  writeFileSync(target, readFileSync(files.gateway), { mode: 0o600 });
  rmSync(files.gateway);
  symlinkSync(target, files.gateway);
  assert(lstatSync(files.gateway).isSymbolicLink());
  await rejectsCode(invoke(routes(files), 'GET', '/api/configuration'), 500, 'configuration_file_invalid');
});

test('native configuration exposes bounded access-session and gateway authorization settings', async context => {
  const files = fixture(context);
  const items = routes(files);
  const result = object(await invoke(items, 'GET', '/api/configuration'));
  const admin = fieldMap(result, 'admin');
  assert(admin.has('accessSessionTtlMs'));
  assert(fieldMap(result, 'gateway').has('allowedConversations'));
  for (const allowedConversations of [['private:0'], ['group:1', 'group:1'], ['anything']]) {
    await rejectsCode(invoke(items, 'POST', '/api/configuration', {
      source: 'gateway', revision: hash(files.gateway), changes: { allowedConversations }
    }), 400, 'invalid_configuration');
  }
  await invoke(items, 'POST', '/api/configuration', {
    source: 'admin', revision: hash(files.admin), changes: { accessSessionTtlMs: 86_400_000 }
  });
  assert.equal(json(files.admin).accessSessionTtlMs, 86_400_000);
  for (const value of [299_999, 30 * 86_400_000 + 1]) {
    await rejectsCode(invoke(items, 'POST', '/api/configuration', {
      source: 'admin', revision: hash(files.admin), changes: { accessSessionTtlMs: value }
    }), 400, 'invalid_configuration');
  }
});
