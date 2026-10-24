import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createConfigurationRoutes } from '../src/admin/configuration.ts';
import { AdminRequestError, type AdminRoute } from '../src/admin/server.ts';

interface Fixture {
  readonly directory: string;
  readonly legacyRoot: string;
  readonly bridge: string;
  readonly gateway: string;
  readonly admin: string;
}

function fixture(context: test.TestContext): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'qq-configuration-'));
  const legacyRoot = join(directory, 'legacy');
  mkdirSync(legacyRoot, { mode: 0o700 });
  const bridge = join(legacyRoot, 'config.json');
  const gateway = join(directory, 'gateway.json');
  const admin = join(directory, 'admin.json');
  writeFileSync(bridge, `${JSON.stringify({
    dsh: { baseUrl: 'http://127.0.0.1:3080', provider: 'fixture-provider', authToken: 'bridge-secret' },
    snowluma: { httpUrl: 'http://127.0.0.1:3000', accessToken: 'snow-secret' },
    social: { proactiveEnabled: false },
    socialV2: { proactive: { enabled: false }, tools: { slangQuery: false, slangSubmit: false } },
    slang: { enabled: false, autoResearch: false },
    pricing: {
      peakWindows: [[9, 12], [14, 18]],
      models: { 'fixture-model': { label: '测试模型', off: { cacheHit: 0.1, cacheMiss: 1, output: 4 } } }
    },
    webSearch: { apiKey: 'search-secret' },
    consoleToken: 'console-secret',
    privateExtension: { keep: true, credential: 'unlisted-secret' }
  }, null, 2)}\n`, { mode: 0o600 });
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
    legacyRoot: 'legacy',
    serviceManager: 'bin/service-manager'
  }, null, 2)}\n`, { mode: 0o600 });
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, legacyRoot, bridge, gateway, admin };
}

function routes(files: Fixture, apply?: Parameters<typeof createConfigurationRoutes>[0]['apply']): readonly AdminRoute[] {
  return createConfigurationRoutes({
    legacyRoot: files.legacyRoot,
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

test('configuration GET uses raw revisions, null inheritance and secret redaction', async context => {
  const files = fixture(context);
  const result = object(await invoke(routes(files), 'GET', '/api/configuration'));
  assert.deepEqual(result.capabilities, { apply: false });
  const groups = array(result.groups).map(object);
  assert(groups.length > 10);
  for (const group of groups) {
    const filename = group.source === 'bridge' ? files.bridge : group.source === 'gateway' ? files.gateway : files.admin;
    assert.equal(group.revision, hash(filename));
  }
  const bridgeFields = fieldMap(result, 'bridge');
  assert.equal(bridgeFields.get('social.proactiveEnabled')?.value, false);
  assert.equal(bridgeFields.get('socialV2.proactive.enabled')?.value, false);
  assert.equal(bridgeFields.get('slang.enabled')?.value, false);
  assert.equal(bridgeFields.get('social.enabled')?.value, null);
  assert.match(String(bridgeFields.get('social.enabled')?.description), /默认设置/);
  assert.equal(bridgeFields.get('pricing.peakWindows')?.type, 'textarea');
  assert.equal(bridgeFields.get('pricing.peakWindows')?.format, 'time-windows');
  assert.equal(typeof bridgeFields.get('pricing.peakWindows')?.value, 'string');
  assert.equal(bridgeFields.get('pricing.models')?.type, 'textarea');
  assert.equal(bridgeFields.get('pricing.models')?.format, 'model-prices');
  assert.equal(typeof bridgeFields.get('pricing.models')?.value, 'string');
  assert.deepEqual(bridgeFields.get('dsh.authToken'), {
    id: 'dsh.authToken',
    label: 'DSH 访问令牌',
    description: bridgeFields.get('dsh.authToken')?.description,
    type: 'secret',
    value: null,
    configured: true
  });
  assert.equal(bridgeFields.get('snowluma.httpUrl')?.editable, false);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /bridge-secret|snow-secret|search-secret|console-secret|unlisted-secret/);
  const adminFields = fieldMap(result, 'admin');
  assert.deepEqual(adminFields.get('legacyRoot'), {
    id: 'legacyRoot',
    label: 'QQ 桥接项目目录',
    description: adminFields.get('legacyRoot')?.description,
    type: 'text',
    value: 'legacy',
    editable: false
  });
  assert.equal(adminFields.get('serviceManager')?.value, 'bin/service-manager');
  assert.equal(adminFields.get('serviceManager')?.editable, false);
  const visibleCopy = array(result.groups).map(object).flatMap(group => [
    group.title, group.description, group.applyLabel,
    ...array(group.fields).map(object).flatMap(field => [field.label, field.description])
  ]).filter(value => typeof value === 'string').join('\n');
  assert.doesNotMatch(visibleCopy, /\b(?:JSON|scope|bearer|query|fragment|settings)\b|旧桥组件/i);
});

test('catalog covers legacy feature controls and avoids dedicated settings and access fields', async context => {
  const files = fixture(context);
  const result = object(await invoke(routes(files), 'GET', '/api/configuration'));
  const bridge = fieldMap(result, 'bridge');
  const required = [
    'dsh.provider', 'dsh.model', 'dsh.conversationContext', 'pricing.models', 'webSearch.provider',
    'ackMessage', 'localPolicy.delegation', 'security.interceptNotify', 'social.enabled',
    'allowAllWhenEmpty',
    'social.proactiveEnabled', 'socialV2.enabled', 'socialV2.autoReplyCheckEnabled',
    'socialV2.wake.preSleepWaitEnabled', 'socialV2.send.maxSendPerHour', 'socialV2.wait.unfinishedQuietMs',
    'socialV2.context.deduplicateWakePolicy', 'socialV2.proactive.enabled', 'socialV2.sticker.collect.enabled',
    'socialV2.voice.enabled', 'socialV2.media.maxBytes', 'socialV2.feedback.notifyOwnerOnError',
    'slang.enabled', 'slang.autoResearch'
  ];
  for (const id of required) assert(bridge.has(id), `missing ${id}`);
  for (const tool of [
    'getPrompt', 'getUnread', 'getRecent', 'socialState', 'sendGroup', 'sendPrivate', 'reply', 'sendBurst',
    'sendMessage', 'waitMessages', 'feedback', 'getMyRecent', 'getMessageDetail', 'getActiveMembers',
    'setWakeConfig', 'markRead', 'memory', 'slangQuery', 'slangSubmit', 'getImages', 'getForwardMsg',
    'sendPoke', 'listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote',
    'collectSticker', 'getSelfImage', 'sendVoice'
  ]) assert(bridge.has(`socialV2.tools.${tool}`), `missing tool ${tool}`);
  for (const excluded of ['ownerQQ', 'allow.private', 'allow.groups', 'deny.private', 'deny.groups']) {
    assert.equal(bridge.has(excluded), false);
  }
  const gateway = fieldMap(result, 'gateway');
  for (const excluded of [
    'allowedConversations', 'authorizationVersion', 'budgetEnabled', 'maxSendUses', 'grantTtlMs',
    'timeoutMs', 'maxPending', 'maxBodyBytes', 'maxRecords'
  ]) assert.equal(gateway.has(excluded), false);
  const admin = fieldMap(result, 'admin');
  assert.equal(admin.has('host'), false);
  assert.equal(admin.has('port'), false);
  assert.equal(admin.get('legacyRoot')?.editable, false);
  assert.equal(admin.get('serviceManager')?.editable, false);
});

test('saves preserve unrelated fields, redact secrets and keep files private', async context => {
  const files = fixture(context);
  let applyCalls = 0;
  const items = routes(files, () => { applyCalls += 1; });
  const before = object(await invoke(items, 'GET', '/api/configuration'));
  const bridgeRevision = String(array(before.groups).map(object).find(group => group.source === 'bridge')?.revision);
  const saved = object(await invoke(items, 'POST', '/api/configuration', {
    source: 'bridge',
    revision: bridgeRevision,
    changes: {
      'social.enabled': false,
      'social.contextWindow': 24,
      'dsh.authToken': '',
      'snowluma.accessToken': null,
      consoleToken: '   ',
      'webSearch.apiKey': 'replacement-secret',
      'pricing.peakWindows': '[[8,11],[13,17]]',
      'pricing.models': JSON.stringify({
        'updated-model': { label: '更新模型', off: { cacheHit: 0.2, cacheMiss: 2, cacheWrite: 2, output: 8 } }
      }),
      'socialV2.proactive.enabled': false
    }
  }));
  assert.equal(saved.ok, true);
  assert.equal(saved.applyRequired, true);
  assert.equal(applyCalls, 0);
  assert.equal(saved.revision, hash(files.bridge));
  assert.doesNotMatch(JSON.stringify(saved), /replacement-secret/);
  const configuration = json(files.bridge);
  assert.deepEqual(configuration.privateExtension, { keep: true, credential: 'unlisted-secret' });
  assert.equal(object(configuration.dsh).authToken, 'bridge-secret');
  assert.equal(object(configuration.snowluma).accessToken, 'snow-secret');
  assert.equal(configuration.consoleToken, 'console-secret');
  assert.equal(object(configuration.webSearch).apiKey, 'replacement-secret');
  assert.equal(object(configuration.social).enabled, false);
  assert.equal(object(configuration.social).contextWindow, 24);
  assert.deepEqual(object(configuration.pricing).peakWindows, [[8, 11], [13, 17]]);
  assert.deepEqual(object(object(configuration.pricing).models)['updated-model'], {
    label: '更新模型', off: { cacheHit: 0.2, cacheMiss: 2, cacheWrite: 2, output: 8 }
  });
  const afterSave = object(await invoke(items, 'GET', '/api/configuration'));
  assert.doesNotMatch(JSON.stringify(afterSave), /replacement-secret|bridge-secret|snow-secret|console-secret/);
  assert.equal(fieldMap(afterSave, 'bridge').get('webSearch.apiKey')?.configured, true);
  assert.equal(statSync(files.bridge).mode & 0o777, 0o600);

  const removed = object(await invoke(items, 'POST', '/api/configuration', {
    source: 'bridge', revision: saved.revision, changes: { 'social.contextWindow': null }
  }));
  assert.equal(Object.hasOwn(object(json(files.bridge).social), 'contextWindow'), false);
  assert.equal(removed.revision, hash(files.bridge));
});

test('saves reject stale writes, unknown fields, prototype keys and unsafe paths', async context => {
  const files = fixture(context);
  const items = routes(files);
  const snapshot = object(await invoke(items, 'GET', '/api/configuration'));
  const bridgeRevision = String(array(snapshot.groups).map(object).find(group => group.source === 'bridge')?.revision);
  const gatewayRevision = String(array(snapshot.groups).map(object).find(group => group.source === 'gateway')?.revision);
  await rejectsCode(invoke(items, 'POST', '/api/configuration', {
    source: 'bridge', revision: bridgeRevision, changes: { ownerQQ: '123456' }
  }), 400, 'configuration_field_forbidden');
  await rejectsCode(invoke(items, 'POST', '/api/configuration', JSON.parse(`{
    "source":"bridge","revision":"${bridgeRevision}","changes":{"__proto__":{"polluted":true}}
  }`) as Record<string, unknown>), 400, 'invalid_configuration');
  await rejectsCode(invoke(items, 'POST', '/api/configuration', JSON.parse(`{
    "source":"bridge","revision":"${bridgeRevision}","changes":{"pricing.models":"{\\"__proto__\\":{\\"polluted\\":true}}"}
  }`) as Record<string, unknown>), 400, 'invalid_configuration');
  await rejectsCode(invoke(items, 'POST', '/api/configuration', {
    source: 'gateway', revision: gatewayRevision, changes: { tokenFile: '../outside.token' }
  }), 400, 'invalid_configuration');
  await rejectsCode(invoke(items, 'POST', '/api/configuration', {
    source: 'bridge', revision: bridgeRevision, changes: { 'webSearch.baseURL': 'http://127.0.0.1/private' }
  }), 400, 'invalid_configuration');
  await rejectsCode(invoke(items, 'POST', '/api/configuration', {
    source: 'bridge', revision: bridgeRevision, changes: { 'dsh.baseUrl': 'https://user:secret@dsh.example.com' }
  }), 400, 'invalid_configuration');
  await rejectsCode(invoke(items, 'POST', '/api/configuration', {
    source: 'bridge', revision: bridgeRevision, changes: { 'snowluma.wsUrl': 'ws://gateway.example.com/socket' }
  }), 400, 'invalid_configuration');
  await rejectsCode(invoke(items, 'POST', '/api/configuration', {
    source: 'gateway', revision: gatewayRevision,
    changes: { upstreamEndpoint: 'http://127.0.0.1:3100/?token=secret' }
  }), 400, 'invalid_configuration');
  await rejectsCode(invoke(items, 'POST', '/api/configuration', {
    source: 'bridge', revision: bridgeRevision, changes: { 'pricing.peakWindows': '[[12,9]]' }
  }), 400, 'invalid_configuration');
  const first = object(await invoke(items, 'POST', '/api/configuration', {
    source: 'bridge', revision: bridgeRevision, changes: { sendDelayMs: 400 }
  }));
  await rejectsCode(invoke(items, 'POST', '/api/configuration', {
    source: 'bridge', revision: bridgeRevision, changes: { sendDelayMs: 500 }
  }), 409, 'configuration_conflict');
  assert.equal(first.revision, hash(files.bridge));
  assert.equal(json(files.bridge).sendDelayMs, 400);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);
});

test('cross-field and source validation reject configurations the services cannot safely apply', async context => {
  const files = fixture(context);
  const items = routes(files);
  let snapshot = object(await invoke(items, 'GET', '/api/configuration'));
  let fields = fieldMap(snapshot);
  assert.equal(fields.get('socialV2.media.maxBytes')?.min, 256 * 1024);
  assert.equal(fields.get('socialV2.media.maxBytes')?.max, 20 * 1024 * 1024);
  assert.equal(fields.get('socialV2.media.maxPixels')?.max, 64_000_000);
  assert.equal(fields.get('socialV2.media.maxCount')?.max, 8);
  let revisions = new Map(array(snapshot.groups).map(object).map(group => [String(group.source), String(group.revision)]));

  await rejectsCode(invoke(items, 'POST', '/api/configuration', {
    source: 'gateway', revision: revisions.get('gateway'), changes: { port: 3100 }
  }), 400, 'invalid_configuration');
  assert.equal(json(files.gateway).port, 3002);

  const bridgeConfiguration = json(files.bridge);
  delete object(bridgeConfiguration.dsh).authToken;
  writeFileSync(files.bridge, `${JSON.stringify(bridgeConfiguration, null, 2)}\n`, { mode: 0o600 });
  snapshot = object(await invoke(items, 'GET', '/api/configuration'));
  revisions = new Map(array(snapshot.groups).map(object).map(group => [String(group.source), String(group.revision)]));
  await rejectsCode(invoke(items, 'POST', '/api/configuration', {
    source: 'bridge', revision: revisions.get('bridge'), changes: { 'dsh.baseUrl': 'https://dsh.example.com' }
  }), 400, 'invalid_configuration');
  await rejectsCode(invoke(items, 'POST', '/api/configuration', {
    source: 'bridge', revision: revisions.get('bridge'),
    changes: { 'socialV2.wake.sleepMinMs': 120_000, 'socialV2.wake.sleepMaxMs': 60_000 }
  }), 400, 'invalid_configuration');
  await rejectsCode(invoke(items, 'POST', '/api/configuration', {
    source: 'bridge', revision: revisions.get('bridge'), changes: { 'pricing.holidays': ['2026-02-31'] }
  }), 400, 'invalid_configuration');

  const gatewayConfiguration = json(files.gateway);
  gatewayConfiguration.maxPending = 0;
  writeFileSync(files.gateway, `${JSON.stringify(gatewayConfiguration, null, 2)}\n`, { mode: 0o600 });
  const invalidRevision = hash(files.gateway);
  await rejectsCode(invoke(items, 'POST', '/api/configuration', {
    source: 'gateway', revision: invalidRevision, changes: { port: 3003 }
  }), 400, 'invalid_configuration');
  assert.equal(json(files.gateway).port, 3002);
});

test('read-only deployment paths cannot be changed into browser-supplied commands', async context => {
  const files = fixture(context);
  const items = routes(files);
  const snapshot = object(await invoke(items, 'GET', '/api/configuration'));
  const revision = String(array(snapshot.groups).map(object).find(group => group.source === 'admin')?.revision);
  await rejectsCode(invoke(items, 'POST', '/api/configuration', {
    source: 'admin', revision, changes: { serviceManager: '/bin/sh -c id' }
  }), 400, 'configuration_field_forbidden');
  await rejectsCode(invoke(items, 'POST', '/api/configuration', {
    source: 'admin', revision, changes: { legacyRoot: '../../tmp' }
  }), 400, 'configuration_field_forbidden');
  assert.equal(json(files.admin).serviceManager, 'bin/service-manager');
});

test('concurrent CAS allows one writer and gateway persona changes rotate authorization scope', async context => {
  const files = fixture(context);
  const items = routes(files);
  const snapshot = object(await invoke(items, 'GET', '/api/configuration'));
  const bridgeRevision = String(array(snapshot.groups).map(object).find(group => group.source === 'bridge')?.revision);
  const concurrent = await Promise.allSettled([
    invoke(items, 'POST', '/api/configuration', {
      source: 'bridge', revision: bridgeRevision, changes: { sendDelayMs: 410 }
    }),
    invoke(items, 'POST', '/api/configuration', {
      source: 'bridge', revision: bridgeRevision, changes: { sendDelayMs: 420 }
    })
  ]);
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = concurrent.find(result => result.status === 'rejected');
  assert(rejected?.status === 'rejected' && rejected.reason instanceof AdminRequestError);
  assert.equal(rejected.reason.code, 'configuration_conflict');

  const refreshed = object(await invoke(items, 'GET', '/api/configuration'));
  const gatewayRevision = String(array(refreshed.groups).map(object).find(group => group.source === 'gateway')?.revision);
  const beforeAuthorization = String(json(files.gateway).authorizationVersion);
  const saved = object(await invoke(items, 'POST', '/api/configuration', {
    source: 'gateway', revision: gatewayRevision, changes: { 'persona.version': '2.0.0' }
  }));
  assert.equal(saved.authorizationReauthorization, 'pending_until_apply');
  assert.notEqual(json(files.gateway).authorizationVersion, beforeAuthorization);
  assert.match(String(json(files.gateway).authorizationVersion), /^[a-f0-9-]{36}$/);
  assert.equal(object(json(files.gateway).persona).version, '2.0.0');
  assert.deepEqual(json(files.gateway).allowedConversations, ['group:123456']);
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
  const snapshot = object(await invoke(items, 'GET', '/api/configuration'));
  assert.deepEqual(snapshot.capabilities, { apply: true });
  const revisions = new Map(array(snapshot.groups).map(object).map(group => [String(group.source), String(group.revision)]));
  assert.deepEqual(await invoke(items, 'POST', '/api/configuration/apply', {
    source: 'gateway', revision: revisions.get('gateway')
  }), {
    ok: true, source: 'gateway', revision: revisions.get('gateway'), application: { applied: true }
  });
  assert.deepEqual(await invoke(items, 'POST', '/api/configuration/apply', {
    source: 'admin', revision: revisions.get('admin')
  }), {
    ok: true,
    source: 'admin',
    revision: revisions.get('admin'),
    application: { accepted: true, reconnectUrl: 'http://127.0.0.1:4321/' }
  });
  assert.equal(calls.length, 2);
  writeFileSync(files.gateway, `${JSON.stringify({ ...json(files.gateway), external: true })}\n`, { mode: 0o600 });
  await rejectsCode(invoke(items, 'POST', '/api/configuration/apply', {
    source: 'gateway', revision: revisions.get('gateway')
  }), 409, 'configuration_conflict');
  assert.equal(calls.length, 2);

  const unavailable = routes(files);
  await rejectsCode(invoke(unavailable, 'POST', '/api/configuration/apply', {
    source: 'admin', revision: hash(files.admin)
  }), 409, 'configuration_apply_unavailable');

  const noResult = routes(files, () => undefined);
  assert.deepEqual(await invoke(noResult, 'POST', '/api/configuration/apply', {
    source: 'admin', revision: hash(files.admin)
  }), { ok: true, source: 'admin', revision: hash(files.admin) });
});

test('legacy console token validation matches the actual bridge runtime without replacing invalid input', async context => {
  const files = fixture(context);
  const original = readFileSync(files.bridge, 'utf8');
  for (const token of ['short', 'with spaces in token', 'a'.repeat(129)]) {
    await rejectsCode(invoke(routes(files), 'POST', '/api/configuration', {
      source: 'bridge', revision: hash(files.bridge), changes: { consoleToken: token }
    }), 400, 'invalid_configuration');
    assert.equal(readFileSync(files.bridge, 'utf8'), original);
  }
});

test('private-file checks reject broad permissions and symlinks', async context => {
  const files = fixture(context);
  chmodSync(files.bridge, 0o644);
  await rejectsCode(invoke(routes(files), 'GET', '/api/configuration'), 500, 'configuration_file_invalid');
  chmodSync(files.bridge, 0o600);
  const target = join(files.directory, 'gateway-target.json');
  writeFileSync(target, readFileSync(files.gateway), { mode: 0o600 });
  rmSync(files.gateway);
  symlinkSync(target, files.gateway);
  assert(lstatSync(files.gateway).isSymbolicLink());
  await rejectsCode(invoke(routes(files), 'GET', '/api/configuration'), 500, 'configuration_file_invalid');
});

test('independent deployment hides absent migration paths and exposes bounded access-session settings', async context => {
  const files = fixture(context);
  const document = object(JSON.parse(readFileSync(files.admin, 'utf8')));
  delete document.legacyRoot;
  delete document.serviceManager;
  writeFileSync(files.admin, JSON.stringify(document), { mode: 0o600 });
  const items = createConfigurationRoutes({
    gatewayConfigurationFilename: files.gateway, adminConfigurationFilename: files.admin
  });
  const result = object(await invoke(items, 'GET', '/api/configuration'));
  const admin = fieldMap(result, 'admin');
  assert.equal(admin.has('legacyRoot'), false);
  assert.equal(admin.has('serviceManager'), false);
  assert(admin.has('accessSessionTtlMs'));
  assert(fieldMap(result, 'gateway').has('allowedConversations'));
  const authorizationBefore = object(JSON.parse(readFileSync(files.gateway, 'utf8'))).authorizationVersion;
  await invoke(items, 'POST', '/api/configuration', {
    source: 'gateway', revision: hash(files.gateway), changes: { allowedConversations: ['private:12345'] }
  });
  const gateway = object(JSON.parse(readFileSync(files.gateway, 'utf8')));
  assert.deepEqual(gateway.allowedConversations, ['private:12345']);
  assert.notEqual(gateway.authorizationVersion, authorizationBefore);
  for (const allowedConversations of [['private:0'], ['group:1', 'group:1'], ['anything']]) {
    await rejectsCode(invoke(items, 'POST', '/api/configuration', {
      source: 'gateway', revision: hash(files.gateway), changes: { allowedConversations }
    }), 400, 'invalid_configuration');
  }
  await invoke(items, 'POST', '/api/configuration', {
    source: 'admin', revision: hash(files.admin), changes: { accessSessionTtlMs: 86_400_000 }
  });
  assert.equal(object(JSON.parse(readFileSync(files.admin, 'utf8'))).accessSessionTtlMs, 86_400_000);
  for (const value of [299_999, 30 * 86_400_000 + 1]) {
    await rejectsCode(invoke(items, 'POST', '/api/configuration', {
      source: 'admin', revision: hash(files.admin), changes: { accessSessionTtlMs: value }
    }), 400, 'invalid_configuration');
  }
});
