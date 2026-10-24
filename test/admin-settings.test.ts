import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { createSettingsRoutes } from '../src/admin/settings.ts';
import { AdminRequestError, type AdminRoute } from '../src/admin/server.ts';

interface Fixture {
  readonly directory: string;
  readonly admin: string;
  readonly gateway: string;
}

function fixture(context: TestContext): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'admin-settings-'));
  const gateway = join(directory, 'gateway.json');
  const admin = join(directory, 'admin.json');
  writeFileSync(gateway, JSON.stringify({
    port: 3131,
    upstreamEndpoint: 'http://127.0.0.1:3000',
    tokenFile: '/private/gateway.token',
    storeFilename: '/private/gateway.sqlite',
    allowedConversations: ['private:123456'],
    persona: { id: 'compatibility', version: '1' },
    budgetEnabled: true,
    maxSendUses: 7,
    grantTtlMs: 60_000,
    authorizationVersion: 'existing-budget',
    privateLegacy: { accessToken: 'must-not-leak', targetIds: ['123456'] }
  }), { mode: 0o600 });
  writeFileSync(admin, JSON.stringify({
    host: '127.0.0.1',
    port: 3210,
    tokenFile: '/private/admin.token',
    gatewayConfiguration: gateway,
    privateLegacy: { operatorToken: 'must-not-leak-either' }
  }), { mode: 0o600 });
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, admin, gateway };
}

function findRoute(routes: readonly AdminRoute[], method: 'GET' | 'POST', pathname: string): AdminRoute {
  const route = routes.find(candidate => candidate.method === method && candidate.pathname === pathname);
  assert(route);
  return route;
}

async function invoke(
  routes: readonly AdminRoute[],
  method: 'GET' | 'POST',
  pathname: string,
  body: Record<string, unknown> | null = null,
  query = new URLSearchParams()
): Promise<unknown> {
  return findRoute(routes, method, pathname).handle({ query, body, signal: new AbortController().signal });
}

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function json(filename: string): Record<string, unknown> {
  return object(JSON.parse(readFileSync(filename, 'utf8')) as unknown);
}

function hash(filename: string): string {
  return createHash('sha256').update(readFileSync(filename)).digest('hex');
}

async function rejectsCode(operation: Promise<unknown>, statusCode: number, code: string): Promise<void> {
  await assert.rejects(operation, error => error instanceof AdminRequestError
    && error.statusCode === statusCode && error.code === code);
}

test('settings GET exposes only controlled values, revisions, and apply capabilities', async context => {
  const files = fixture(context);
  const routes = createSettingsRoutes({
    adminConfigurationFilename: files.admin,
    gatewayConfigurationFilename: files.gateway
  });
  const result = object(await invoke(routes, 'GET', '/api/settings'));
  assert.deepEqual(result, {
    gateway: {
      revision: hash(files.gateway),
      values: {
        budgetEnabled: true,
        maxSendUses: 7,
        grantTtlMs: 60_000,
        timeoutMs: 60_000,
        maxPending: 16,
        maxBodyBytes: 28 * 1024 * 1024,
        maxRecords: 10_000
      }
    },
    admin: {
      revision: hash(files.admin),
      values: { host: '127.0.0.1', port: 3210 }
    },
    capabilities: { applyGateway: false, applyAdmin: false }
  });
  assert.doesNotMatch(JSON.stringify(result), /private|token|target|123456|configuration/i);
  await rejectsCode(invoke(routes, 'GET', '/api/settings', null, new URLSearchParams('path=/private')),
    400, 'invalid_query');
});

test('gateway saves preserve private fields and rotate authorization only for budget changes', async context => {
  const files = fixture(context);
  const routes = createSettingsRoutes({
    adminConfigurationFilename: files.admin,
    gatewayConfigurationFilename: files.gateway
  });
  const before = object(await invoke(routes, 'GET', '/api/settings'));
  const gateway = object(before.gateway);
  const values = object(gateway.values);
  const disabled = object(await invoke(routes, 'POST', '/api/settings/gateway', {
    revision: gateway.revision,
    values: { ...values, budgetEnabled: false }
  }));
  assert.equal(disabled.ok, true);
  assert.equal(disabled.restartRequired, true);
  assert.equal(disabled.budgetReauthorization, 'pending_until_apply');
  assert.equal(disabled.revision, hash(files.gateway));
  let saved = json(files.gateway);
  assert.equal(saved.budgetEnabled, false);
  assert.equal(saved.maxSendUses, 7);
  assert.equal(saved.grantTtlMs, 60_000);
  assert.match(String(saved.authorizationVersion), /^[a-f0-9-]{36}$/);
  assert.deepEqual(saved.privateLegacy, { accessToken: 'must-not-leak', targetIds: ['123456'] });
  assert.equal(statSync(files.gateway).mode & 0o777, 0o600);

  const authorizationVersion = saved.authorizationVersion;
  const limitsOnly = object(await invoke(routes, 'POST', '/api/settings/gateway', {
    revision: disabled.revision,
    values: { ...values, budgetEnabled: false, timeoutMs: 20_000 }
  }));
  assert.equal(Object.hasOwn(limitsOnly, 'budgetReauthorization'), false);
  saved = json(files.gateway);
  assert.equal(saved.authorizationVersion, authorizationVersion);
  assert.equal(saved.timeoutMs, 20_000);

  const removed = object(await invoke(routes, 'POST', '/api/settings/gateway', {
    revision: limitsOnly.revision,
    values: { ...values, budgetEnabled: false, maxSendUses: null, grantTtlMs: null, timeoutMs: 20_000 }
  }));
  assert.equal(removed.budgetReauthorization, 'pending_until_apply');
  saved = json(files.gateway);
  assert.equal(Object.hasOwn(saved, 'maxSendUses'), false);
  assert.equal(saved.grantTtlMs, null);
  assert.notEqual(saved.authorizationVersion, authorizationVersion);
});

test('saves reject stale and concurrent revisions without overwriting unrelated changes', async context => {
  const files = fixture(context);
  const routes = createSettingsRoutes({
    adminConfigurationFilename: files.admin,
    gatewayConfigurationFilename: files.gateway
  });
  const first = object(await invoke(routes, 'GET', '/api/settings'));
  const admin = object(first.admin);
  const original = json(files.admin);
  writeFileSync(files.admin, JSON.stringify({ ...original, externalChange: 'preserve-me' }), { mode: 0o600 });
  await rejectsCode(invoke(routes, 'POST', '/api/settings/admin', {
    revision: admin.revision,
    values: { host: 'localhost', port: 4000 }
  }), 409, 'settings_conflict');
  assert.equal(json(files.admin).externalChange, 'preserve-me');

  const fresh = object(object(await invoke(routes, 'GET', '/api/settings')).admin);
  const results = await Promise.allSettled([
    invoke(routes, 'POST', '/api/settings/admin', {
      revision: fresh.revision,
      values: { host: '127.0.0.1', port: 4100 }
    }),
    invoke(routes, 'POST', '/api/settings/admin', {
      revision: fresh.revision,
      values: { host: '127.0.0.1', port: 4200 }
    })
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejection = results.find(result => result.status === 'rejected');
  assert(rejection?.status === 'rejected');
  assert(rejection.reason instanceof AdminRequestError);
  assert.equal(rejection.reason.code, 'settings_conflict');
  assert.equal(json(files.admin).externalChange, 'preserve-me');
});

test('settings reject extra keys, invalid values, unsafe permissions, and symlinks', async context => {
  const files = fixture(context);
  const routes = createSettingsRoutes({
    adminConfigurationFilename: files.admin,
    gatewayConfigurationFilename: files.gateway
  });
  const current = object(object(await invoke(routes, 'GET', '/api/settings')).gateway);
  const values = object(current.values);
  for (const invalid of [
    { ...values, timeoutMs: Number.POSITIVE_INFINITY },
    { ...values, maxPending: 0 },
    { ...values, maxBodyBytes: 1_023 },
    { ...values, grantTtlMs: 999 },
    { ...values, extra: true }
  ]) {
    await rejectsCode(invoke(routes, 'POST', '/api/settings/gateway', {
      revision: current.revision,
      values: invalid
    }), 400, 'invalid_settings');
  }
  await rejectsCode(invoke(routes, 'POST', '/api/settings/admin', {
    revision: object(object(await invoke(routes, 'GET', '/api/settings')).admin).revision,
    values: { host: 'https://127.0.0.1', port: 0 }
  }), 400, 'invalid_settings');

  chmodSync(files.gateway, 0o644);
  await rejectsCode(invoke(routes, 'GET', '/api/settings'), 500, 'settings_file_invalid');
  chmodSync(files.gateway, 0o600);
  const target = join(files.directory, 'gateway-target.json');
  writeFileSync(target, readFileSync(files.gateway), { mode: 0o600 });
  rmSync(files.gateway);
  symlinkSync(target, files.gateway);
  assert(lstatSync(files.gateway).isSymbolicLink());
  await rejectsCode(invoke(routes, 'GET', '/api/settings'), 500, 'settings_file_invalid');
});

test('apply requires availability and the current file revision before invoking callback', async context => {
  const files = fixture(context);
  const unavailable = createSettingsRoutes({
    adminConfigurationFilename: files.admin,
    gatewayConfigurationFilename: files.gateway
  });
  await rejectsCode(invoke(unavailable, 'POST', '/api/settings/apply', {
    target: 'gateway',
    revision: hash(files.gateway)
  }), 409, 'settings_apply_unavailable');

  const calls: Array<{ target: 'gateway' | 'admin'; revision: string }> = [];
  const routes = createSettingsRoutes({
    adminConfigurationFilename: files.admin,
    gatewayConfigurationFilename: files.gateway,
    apply(target, revision) { calls.push({ target, revision }); }
  });
  const gatewayRevision = hash(files.gateway);
  assert.deepEqual(await invoke(routes, 'POST', '/api/settings/apply', {
    target: 'gateway', revision: gatewayRevision
  }), { ok: true, target: 'gateway', revision: gatewayRevision });
  assert.deepEqual(calls, [{ target: 'gateway', revision: gatewayRevision }]);

  const configuration = json(files.gateway);
  writeFileSync(files.gateway, JSON.stringify({ ...configuration, timeoutMs: 10_001 }), { mode: 0o600 });
  await rejectsCode(invoke(routes, 'POST', '/api/settings/apply', {
    target: 'gateway', revision: gatewayRevision
  }), 409, 'settings_conflict');
  assert.equal(calls.length, 1);
});
