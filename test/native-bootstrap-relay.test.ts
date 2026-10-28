import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { assertRequiredEventOutcomes } from '../src/core/event-reports.ts';
import { createNativeChatGatewayFixture, nativeGatewayFixtureObject as object,
  nativeGatewayFixtureUntil as until, useRealCli } from './fixtures/native-chat-gateway.ts';

type Value = Record<string, unknown>;

test('default gateway child keeps ordinary finals silent and explicit replies scoped across extension preferences',
  { timeout: useRealCli ? 240000 : 40000 }, async context => {
    const privateRoot = new URL('../runtime/native-bootstrap-relay/', import.meta.url);
    await mkdir(privateRoot, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(new URL('fixture-', privateRoot).pathname);
    context.after(() => rm(directory, { recursive: true, force: true }));
    const extension = import.meta.url.endsWith('.js') ? '.js' : '.ts';
    const target = new URL(`./fixtures/native-bootstrap-example-driver${extension}`, import.meta.url);
    assert((await lstat(target)).isFile());
    const bootstrapFile = join(directory, 'operator.ts');
    await writeFile(bootstrapFile, `export { default } from ${JSON.stringify(target.href)};\n`, { mode: 0o600 });
    const fixture = await createNativeChatGatewayFixture(context, { bootstrapFile });
    const { api, save, runtime, start, base, profilePath, credentialsPath, calls, sends, sendActions } = fixture;
    const nativeDirectory = join(fixture.directory, 'runtime');
    await mkdir(nativeDirectory, { mode: 0o700 });
    const control = join(nativeDirectory, 'fixture-control.json');
    const log = join(nativeDirectory, 'fixture-evidence.jsonl');
    await writeFile(control, JSON.stringify({ mode: 'normal', relayImages: true }), { mode: 0o600 });
    await writeFile(join(nativeDirectory, 'extension-grants.json'), JSON.stringify({ grants: [] }), { mode: 0o600 });
    async function evidence(): Promise<Value[]> {
      const contents = await readFile(log, 'utf8');
      return contents.slice(0, contents.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => object(JSON.parse(line)));
    }
    let commandSequence = 0;
    async function command(value: Value) {
      const id = `relay-${++commandSequence}`;
      await writeFile(`${control}.next`, JSON.stringify({ ...value, id }), { mode: 0o600 });
      await rename(`${control}.next`, control);
      await until(async () => (await evidence()).some(row => row.id === id));
      return (await evidence()).find(row => row.id === id)!;
    }
    const snapshot = () => command({ op: 'relay-snapshot' });
    const count = async (event: string) => (await evidence()).filter(row => row.event === event).length;
    const outbox = async () => {
      const result = await api('/api/host/outbox');
      assert(Array.isArray(result.items));
      return result.items.map(object);
    };
    await fixture.launch();
    await save('personas', { personas: [{ id: 'example', name: 'Example', identity: 'Fixture identity.', style: 'Brief.' }] });
    await save('providers', { providers: [{ id: 'fixture', name: 'Fixture', type: 'openai', enabled: true,
      baseUrl: `${base}/never-model`, apiKey: 'synthetic-not-production', models: [{ id: 'fake', name: 'Fake' }] }] });
    await save('plans', { activePlanId: 'example', plans: [{ id: 'example', name: 'Example', description: '',
      instructions: 'Fixture instructions.', personaId: 'example', provider: 'fixture', model: 'fake', reasoningEffort: 'off' }] });
    await save('access', { allow: ['group:7001'], deny: [], owner: '42' });
    await save('adapters', { adapters: {
      onebotHttp: { enabled: true, endpoint: `${base}/onebot`, secret: 'onebot-http-only' },
      onebotWs: { enabled: true, endpoint: `${base.replace('http:', 'ws:')}/onebot-ws`, secret: 'onebot-ws-only' },
      dshAgent: { enabled: true, endpoint: `${base}/dsh`, auth: 'dsh-fixture-only' }
    } });
    await save('authorization', { version: 'relay-fixture', grants: [
      { conversationId: 'group:7001', submitUses: 20, sendUses: 20, expiresAt: null }
    ] });
    await save('deployment', { deployment: { target: { profilePath, credentialsPath, schemaVersion: '0.2.1-rc.2' },
      modelSettings: { contextWindow: 200000, maxTokens: 8000, reasoningEfforts: false }, namespace: 'fixture' } });
    const revisions = (await runtime()).revisions;
    const prepared = await api('/api/chat/deployment/prepare', { revisions });
    await api('/api/chat/deployment/apply', { revisions, targetRevision: prepared.targetRevision });
    await start();

    let turn = 0;
    async function ordinary(body: string, explicit: boolean) {
      const count = calls.filter(call => call.method === 'session/prompt').length;
      const sent = sends.length;
      turn++;
      fixture.inbound(800 + turn, { message_type: 'group', group_id: 7001, user_id: 42,
        time: Math.floor(Date.now() / 1000), message: [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: 'Fixture normal input' } }] });
      await until(() => calls.filter(call => call.method === 'session/prompt').length === count + 1);
      fixture.event('turn/start', { turn });
      if (explicit) { const sent = await fixture.reply(body); assert.equal(sent.status, 'confirmed', JSON.stringify(sent)); }
      fixture.event('assistant/message', { turn, message: { role: 'assistant', content: [{ type: 'text', text: body }] } });
      fixture.event('turn/end', { turn, reason: { kind: 'completed' } });
      await until(async () => {
        const journal = await api('/api/chat/executions');
        return Array.isArray(journal.items) && journal.items.filter(row => object(row).status === 'completed').length === turn;
      });
      assert.equal(sends.length, sent + Number(explicit));
    }
    await ordinary('最终正文保持静默', false);
    await ordinary('通过显式工具回复', true);
    assert.deepEqual(sends[0]?.message, [{ type: 'text', data: { text: '通过显式工具回复' } }]);
    await command({ op: 'relay-settings', conversationId: 'group:7002', format: 'forward' });
    await ordinary('其他会话的偏好不会触发发言或转发', false);
    await ordinary('同一会话的显式文本', true);
    assert(sends.every(send => send.group_id === 7001));
    assert.equal(await count('presentation-effect'), 0);
    assert.equal(await count('relay-render'), 0);
    assert.equal(sendActions.at(-1), '/onebot/send_group_msg');
    assert.equal(calls.filter(call => call.method === 'session/create').length, 1);
  });
