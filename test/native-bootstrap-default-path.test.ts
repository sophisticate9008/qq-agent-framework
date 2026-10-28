import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createNativeChatGatewayFixture, nativeGatewayFixtureObject as object,
  nativeGatewayFixtureUntil as until, useRealCli } from './fixtures/native-chat-gateway.ts';

type Value = Record<string, unknown>;

test('default administrator CLI mounts source-approved work, scoped presentation and calendar triggers with safe lifecycle recovery',
  { timeout: useRealCli ? 240000 : 40000 }, async context => {
    const privateRoot = new URL('../runtime/native-bootstrap-default/', import.meta.url);
    await mkdir(privateRoot, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(new URL('fixture-', privateRoot).pathname);
    const bootstrapFile = join(directory, 'operator.ts');
    const extension = import.meta.url.endsWith('.js') ? '.js' : '.ts';
    const target = new URL(`./fixtures/native-bootstrap-example-driver${extension}`, import.meta.url);
    assert((await lstat(target)).isFile());
    const code = `export { default } from ${JSON.stringify(target.href)};\n`;
    await writeFile(bootstrapFile, code, { mode: 0o600 });
    const fixture = await createNativeChatGatewayFixture(context, { bootstrapFile });
    context.after(() => rm(directory, { recursive: true, force: true }));
    const { base, profilePath, credentialsPath, api, save, runtime, start, sends, sendActions, calls, onebots, inbound } = fixture;
    const nativeDirectory = join(fixture.directory, 'runtime');
    await mkdir(nativeDirectory, { mode: 0o700 });
    const control = join(nativeDirectory, 'fixture-control.json');
    const log = join(nativeDirectory, 'fixture-evidence.jsonl');
    async function command(value: Value) {
      await writeFile(`${control}.next`, JSON.stringify(value), { mode: 0o600 });
      await rename(`${control}.next`, control);
    }
    async function evidence(): Promise<Value[]> {
      return (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => object(JSON.parse(line)));
    }
    const stop = () => api('/api/chat/runtime/stop', {});
    await command({ mode: 'normal' });
    const capabilities = ['example.work.schedule', 'presentation.prepare', 'messaging.send', 'messaging.forward'];
    await writeFile(join(nativeDirectory, 'extension-grants.json'), JSON.stringify({ grants: [
      { id: 'fixture-extension-approval', featureId: 'operator-example', conversationId: 'group:7001', capabilities,
        maxUses: Object.fromEntries(capabilities.map(capability => [capability, 50])), expiresAt: null },
      { id: 'fixture-partial-approval', featureId: 'fixture-partial', conversationId: 'group:7001',
        capabilities: ['fixture.partial.prepare', 'messaging.send', 'messaging.forward'],
        maxUses: { 'fixture.partial.prepare': 5, 'messaging.send': 5, 'messaging.forward': 5 }, expiresAt: null },
      { id: 'fixture-late-approval', featureId: 'fixture-late', conversationId: 'group:7001',
        capabilities: ['messaging.send'], maxUses: { 'messaging.send': 5 }, expiresAt: null },
      { id: 'fixture-asset-approval', featureId: 'fixture-asset', conversationId: 'group:7001',
        capabilities: ['messaging.send'], maxUses: { 'messaging.send': 5 }, expiresAt: null }
    ] }), { mode: 0o600 });
    await fixture.launch();
    const initial = await runtime();
    assert.equal(object(initial.bootstrap).codeFingerprint, createHash('sha256').update(code).digest('hex'));
    assert.equal(object(initial.bootstrap).state, 'not-started');
    await save('personas', { personas: [{ id: 'example', name: 'Example', identity: 'Fixture identity.', style: 'Brief.' }] });
    await save('providers', { providers: [{ id: 'fixture', name: 'Fixture', type: 'openai', enabled: true, baseUrl: `${base}/never-model`,
      apiKey: 'synthetic-not-production', models: [{ id: 'fake', name: 'Fake' }] }] });
    await save('plans', { activePlanId: 'example', plans: [{ id: 'example', name: 'Example', description: '', instructions: 'Fixture instructions.',
      personaId: 'example', provider: 'fixture', model: 'fake', reasoningEffort: 'off' }] });
    await save('access', { allow: ['group:7001'], deny: [], owner: '42' });
    await save('adapters', { adapters: { onebotHttp: { enabled: true, endpoint: `${base}/onebot`, secret: 'onebot-http-only' },
      onebotWs: { enabled: true, endpoint: `${base.replace('http:', 'ws:')}/onebot-ws`, secret: 'onebot-ws-only' },
      dshAgent: { enabled: true, endpoint: `${base}/dsh`, auth: 'dsh-fixture-only' } } });
    await save('authorization', { version: 'fixture-1', grants: [{ conversationId: 'group:7001', submitUses: 5, sendUses: 5, expiresAt: null }] });
    await save('deployment', { deployment: { target: { profilePath, credentialsPath, schemaVersion: '0.2.1-rc.2' },
      modelSettings: { contextWindow: 200000, maxTokens: 8000, reasoningEfforts: false }, namespace: 'fixture' } });
    const revisions = (await runtime()).revisions;
    const prepared = await api('/api/chat/deployment/prepare', { revisions });
    await api('/api/chat/deployment/apply', { revisions, targetRevision: prepared.targetRevision });

    await writeFile(bootstrapFile, code + '\n');
    await start(503);
    assert.equal((await runtime()).lastError, 'NATIVE_BOOTSTRAP_CHANGED');
    assert.equal(sends.length, 0);
    await writeFile(bootstrapFile, code);
    const running = await start();
    assert.equal(running.chatReady, true);
    assert.equal(running.modelExecutionVerified, false);
    assert.equal(object(running.bootstrap).grantsCreatedByInstaller, false);
    const first = (await evidence()).find(row => row.event === 'manifest-only');
    assert(first);
    assert.equal(object(first.outcome).errorCode, 'POLICY_DENIED');
    assert.equal(first.grants, 2);
    inbound(501, { message_type: 'group', group_id: 7001, user_id: 42, time: Math.floor(Date.now() / 1000), message: [
      { type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: '/后台整理 同意: # 原会话后台文档' } }
    ] });
    await until(() => sends.some(send => JSON.stringify(send).includes('原会话后台文档')));
    assert(sends.every(send => send.group_id === 7001));
    const scopedMessage = (id: number, text: string) => inbound(id, { message_type: 'group', group_id: 7001, user_id: 42,
      time: Math.floor(Date.now() / 1000), message: [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: `/后台整理 同意: ${text}` } }] });
    const beforeCancelledWork = sends.length;
    scopedMessage(502, 'fixture-cancel-work');
    await until(async () => (await evidence()).some(row => row.event === 'cancel-work-started'));
    await command({ id: 'cancel-work', op: 'cancel-work' });
    await until(async () => (await evidence()).some(row => row.event === 'cancel-retry-denied'));
    assert.equal((await evidence()).find(row => row.event === 'cancel-retry-denied')?.code, 'TASK_RETRY_DENIED');
    scopedMessage(503, 'fixture-unknown-work');
    await until(async () => (await evidence()).some(row => row.event === 'unknown-work-started'));
    scopedMessage(503, 'fixture-unknown-work');
    await delay(60);
    assert.equal((await evidence()).filter(row => row.event === 'unknown-work-started').length, 1);
    assert.equal(sends.length, beforeCancelledWork);
    fixture.controls.onebotSendStatus = 'async';
    scopedMessage(504, 'fixture-delivery-unknown');
    await until(async () => {
      const outbox = await api('/api/host/outbox');
      return Array.isArray(outbox.items) && outbox.items.some(item => object(item).status === 'unknown');
    });
    fixture.controls.onebotSendStatus = 'ok';
    assert.equal(sends.filter(send => JSON.stringify(send).includes('fixture-delivery-unknown')).length, 1);
    await command({ id: 'partial', op: 'partial' });
    await until(async () => (await evidence()).some(row => row.event === 'command-confirmed' && row.id === 'partial'));
    assert(sends.some((send, index) => sendActions[index] === '/onebot/send_group_forward_msg' && JSON.stringify(send).includes('# short document')));
    assert((await evidence()).some(row => row.event === 'partial-selector'));
    await command({ id: 'asset-approved', op: 'asset-approved' });
    await until(async () => (await evidence()).some(row => row.event === 'command-confirmed' && row.id === 'asset-approved'));
    const beforeDeniedAssets = sends.length;
    for (const op of ['asset-path', 'asset-wrong-scope']) {
      await command({ id: op, op });
      await until(async () => (await evidence()).some(row => row.event === 'command-rejected' && row.id === op));
      assert.equal((await evidence()).find(row => row.event === 'command-rejected' && row.id === op)?.code, 'FIXTURE_ASSET_REJECTED');
    }
    assert.equal(sends.length, beforeDeniedAssets);
    await command({ id: 'preference', op: 'preference' });
    await until(async () => (await evidence()).some(row => row.event === 'command-confirmed' && row.id === 'preference'));
    assert(sends.some(send => JSON.stringify(send).includes('上下文偏好通知')));
    const beforeCalendar = sends.length;
    await command({ id: 'calendar', op: 'calendar' });
    await until(() => sends.length === beforeCalendar + 1);
    await until(async () => (await evidence()).some(row => row.event === 'calendar-occurrences'
      && Array.isArray(row.items) && row.items.some(item => object(item).status === 'completed')));
    const tasks = await api('/api/host/tasks');
    assert(Array.isArray(tasks.items) && tasks.items.some(item => object(item).kind === 'example.work' && object(item).status === 'completed'));
    assert.equal(tasks.items.filter(item => object(item).kind === 'example.work' && object(item).status === 'unknown').length, 3);
    assert(!calls.some(call => ['session/create', 'session/prompt'].includes(call.method)));

    await command({ id: 'late', op: 'late' });
    await until(async () => (await evidence()).some(row => row.event === 'late-handler-started'));
    await stop();
    await command({ mode: 'normal' });
    await start();
    await until(async () => (await evidence()).some(row => row.event === 'late-denied'));
    assert(!(await evidence()).some(row => row.event === 'late-unexpected-send'));
    assert(!sends.some(send => JSON.stringify(send).includes('old-instance-must-not-send')));
    const restarted = (await evidence()).filter(row => row.event === 'start-entered').at(-1);
    assert.equal(object(restarted?.used)['example.work.schedule'], 4);
    assert.equal((await evidence()).filter(row => row.event === 'unknown-work-started').length, 1);
    await stop();
    await fixture.shutdown();
    await command({ mode: 'normal' });
    await fixture.launch();
    await start();
    scopedMessage(504, 'fixture-delivery-unknown');
    await delay(80);
    assert.equal(sends.filter(send => JSON.stringify(send).includes('fixture-delivery-unknown')).length, 1);
    const reopenedOutbox = await api('/api/host/outbox');
    assert(Array.isArray(reopenedOutbox.items) && reopenedOutbox.items.some(item => object(item).status === 'unknown'));
    const reopenedTasks = await api('/api/host/tasks');
    assert(Array.isArray(reopenedTasks.items)
      && reopenedTasks.items.filter(item => object(item).kind === 'example.work' && object(item).status === 'unknown').length === 3);
    const reopened = (await evidence()).filter(row => row.event === 'start-entered').at(-1);
    assert.equal(object(reopened?.used)['example.work.schedule'], 4);
    assert.equal(reopened?.extensionGrantActive, true);
    await command({ id: 'revoke', op: 'revoke' });
    await until(async () => (await evidence()).some(row => row.event === 'command-rejected' && row.id === 'revoke'));
    const revoked = (await evidence()).find(row => row.event === 'command-rejected' && row.id === 'revoke');
    assert.equal(revoked?.code, 'POLICY_DENIED');
    const beforeFailedCalendar = sends.length;
    await command({ id: 'calendar-denied', op: 'calendar-next-day' });
    await until(async () => (await evidence()).some(row => row.event === 'calendar-occurrences' && Array.isArray(row.items)
      && row.items.some(item => object(item).status === 'failed' && object(item).errorCode === 'POLICY_DENIED')));
    assert.equal(sends.length, beforeFailedCalendar);
    await stop();

    await command({ mode: 'fail' });
    const beforeFailed = sends.length;
    await start(503);
    const failed = await runtime();
    assert.equal(failed.lastError, 'FIXTURE_START_FAILED');
    assert.equal(object(failed.bootstrap).state, 'stopped');
    assert.equal(failed.chatReady, false);
    assert.equal(failed.runtimeConnected, false);
    assert.equal(failed.frameworkTools, null);
    assert(Array.isArray(failed.packages) && failed.packages.every(item => object(item).state === 'stopped'));
    assert.equal(failed.protocolConnected, true);
    assert.equal(onebots.size, 1);
    await delay(30);
    assert.equal(sends.length, beforeFailed);
    await command({ mode: 'abort' });
    const starting = start(503);
    await until(async () => (await evidence()).some(row => row.event === 'start-entered' && row.mode === 'abort'));
    await api('/api/chat/runtime/stop', {}, 503);
    await starting;
    assert((await evidence()).some(row => row.event === 'start-aborted'));
    assert((await evidence()).filter(row => row.event === 'stopped').every(row => row.signalAborted === true));
    const finalCount = sends.length;
    await command({ id: 'after-stop', op: 'calendar' });
    await delay(50);
    assert.equal(sends.length, finalCount);
    const final = await runtime();
    assert.equal(object(final.bootstrap).state, 'unknown');
    assert.equal(object(final.bootstrap).unsettledLifecycle, true);
    assert.equal(final.canStart, false);
    assert((await lstat(join(nativeDirectory, '.native-chat-runtime.lock'))).isFile());
    await fixture.shutdown(1);
    context.diagnostic('Default administrator CLI coverage: source-approved work; cancelled and unknown tasks are not replayed; durable outbox UNKNOWN survives child exit and SQLite reopen; forward-only selection and scoped resource checks; contextual preferences and calendar required outcomes; late sends denied after restart; failed start cleanup; aborted start retains UNKNOWN and lease.');
  });
