import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { assertRequiredEventOutcomes } from '../src/core/event-reports.ts';
import { createNativeChatGatewayFixture, nativeGatewayFixtureObject as object,
  nativeGatewayFixtureUntil as until, useRealCli } from './fixtures/native-chat-gateway.ts';

type Value = Record<string, unknown>;

test('default gateway child prepares standard DSH text using trusted scoped preferences and independent grants',
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
    async function answer(body: string, expected: 'completed' | 'failed', extra: Value = {}, beforeFinal?: () => Promise<unknown>) {
      const before = await snapshot();
      assert(Array.isArray(before.inbox));
      const previousIds = before.inbox.map(row => object(row).eventId);
      const prompts = calls.filter(call => call.method === 'session/prompt').length;
      fixture.inbound(800 + ++turn, { message_type: 'group', group_id: 7001, user_id: 42,
        time: Math.floor(Date.now() / 1000), message: [{ type: 'at', data: { qq: '999' } },
          { type: 'text', data: { text: `Fixture normal request ${turn}` } }] });
      await until(() => calls.filter(call => call.method === 'session/prompt').length === prompts + 1);
      await until(() => fixture.streams.length > 0);
      await beforeFinal?.();
      fixture.event('turn/start', { turn });
      fixture.event('assistant/message', { turn, step: 1, ...extra, message: { id: `relay-final-${turn}`,
        source: { kind: 'model', ...fixture.selected.get(fixture.streams.at(-1)!.sessionId) },
        content: [{ type: 'text', text: body }, { type: 'reasoning', text: 'internal-reasoning-never-forward' }] } });
      fixture.event('turn/end', { turn, reason: { kind: 'completed' } });
      let finished: Value | undefined;
      let audit: Value | undefined;
      await until(async () => {
        const current = await snapshot();
        assert(Array.isArray(current.inbox) && Array.isArray(current.audit));
        finished = current.inbox.map(object).find(row => !previousIds.includes(row.eventId) && row.status !== 'processing');
        audit = current.audit.map(object).find(row => row.eventId === finished?.eventId);
        return finished !== undefined && audit !== undefined;
      });
      assert(finished && audit);
      assert.equal(audit.status, expected);
      assert.equal(finished.status, expected === 'completed' ? 'accepted' : 'rejected');
      if (audit.status === 'completed') assertRequiredEventOutcomes({ eventId: String(audit.eventId), conversationId: String(audit.conversationId),
        outcomes: [{ featureId: String(audit.featureId), status: audit.status }] }, ['agent-relay']);
      else assert.equal(finished.errorCode, 'POLICY_DENIED');
      context.diagnostic(`${turn}: ${body}: ${audit.status}${finished.errorCode ? `/${finished.errorCode}` : ''}`);
    }

    await answer('# 普通聊天原文', 'completed');
    assert.deepEqual(sends.at(-1)?.message, [{ type: 'text', data: { text: '# 普通聊天原文' } }]);
    assert.equal(await count('presentation-effect'), 0);
    await command({ op: 'relay-settings', conversationId: 'group:7002', format: 'forward' });
    const spoof = { conversationId: 'group:7002', scope: { persona: { id: 'spoof', version: '999' }, sessionId: 'spoof', generation: 999 },
      outputFormat: 'document', markdown: 'raw-private-document-never-forward', replyPresentation: 'forward' };
    await answer('仍是原会话普通文本', 'completed', spoof);
    assert.equal(await count('presentation-effect'), 0);
    assert(sends.every(send => send.group_id === 7001));

    await command({ op: 'relay-settings', configuration: true, format: 'forward' });
    const beforeDenied = sends.length;
    const beforeOutbox = (await outbox()).length;
    await answer('# 配置不是扩展准备授权', 'failed');
    assert.equal(await count('presentation-effect'), 0);
    assert.equal(sends.length, beforeDenied);
    await command({ op: 'relay-grant', grantId: 'relay-prepare-only', capabilities: ['presentation.prepare'] });
    await answer('# 扩展准备后的白名单转发', 'completed');
    assert.equal(await count('presentation-effect'), 1);
    assert(sends.length > beforeDenied);
    assert((await outbox()).length > beforeOutbox);
    await command({ op: 'relay-grant', grantId: 'relay-forward-only', capabilities: ['messaging.forward'] });
    await answer('# 标准文本整理\n\n- 第一项\n- 第二项', 'completed', spoof);
    assert.equal(sendActions.at(-1), '/onebot/send_group_forward_msg');
    assert.match(JSON.stringify(sends.at(-1)), /标准文本整理/);
    assert.match(JSON.stringify(sends.at(-1)), /可信扩展示例/);
    const effect = (await evidence()).filter(row => row.event === 'presentation-effect').at(-1)!;
    const scope = object(effect.scope);
    assert.equal(scope.conversationId, 'group:7001');
    assert.equal(scope.featureId, 'agent-relay');
    const actualPersona = (await evidence()).find(row => row.event === 'created')?.persona;
    assert.equal(`${object(scope.persona).id}@${object(scope.persona).version}`, actualPersona);
    assert.notEqual(object(scope.persona).version, '999');
    assert.equal(scope.sessionId, fixture.streams.at(-1)!.sessionId);
    assert.equal(scope.generation, 1);
    const effectsBeforePlain = await count('presentation-effect');
    await command({ op: 'relay-settings', format: 'text' });
    await answer('偏好恢复普通原文', 'completed');
    assert.equal(await count('presentation-effect'), effectsBeforePlain);
    assert.equal(sendActions.at(-1), '/onebot/send_group_msg');

    await command({ op: 'relay-settings', format: 'markdown-image' });
    await command({ op: 'relay-revoke', grantId: 'relay-prepare-only' });
    await answer('# 图片偏好不能创建权限', 'failed');
    assert.equal(await count('relay-render'), 0);
    assert.equal(await count('presentation-effect'), effectsBeforePlain);
    await command({ op: 'relay-grant', grantId: 'relay-image-prepare', capabilities: ['presentation.prepare'] });
    await answer('# 已授权受控图片', 'completed');
    assert.equal(await count('relay-render'), 1);
    assert.equal(await count('relay-publish'), 1);
    const image = sends.at(-1)!;
    assert(Array.isArray(image.message) && image.message.some(raw => object(raw).type === 'image'));
    const published = (await evidence()).find(row => row.event === 'relay-publish')!;
    assert.equal(published.conversationId, 'group:7001');
    assert.deepEqual(object(published.scope).persona, scope.persona);
    const sentBeforeSendRevoke = sends.length;
    const outboxBeforeSendRevoke = (await outbox()).length;
    await answer('# 准备不等于发送授权', 'failed', {}, () => command({ op: 'relay-revoke', native: true }));
    assert.equal(await count('relay-render'), 2);
    assert.equal(sends.length, sentBeforeSendRevoke);
    assert.equal((await outbox()).length, outboxBeforeSendRevoke);
    assert((await outbox()).every(row => row.status === 'confirmed'));
    const wire = JSON.stringify(sends);
    assert(!wire.includes('internal-reasoning-never-forward') && !wire.includes('raw-private-document-never-forward') && !wire.includes('spoof'));
    assert((await evidence()).filter(row => row.event === 'relay-input').every(row => Array.isArray(row.agentDataKeys)
      && !row.agentDataKeys.includes('outputFormat') && !row.agentDataKeys.includes('markdown') && !row.agentDataKeys.includes('scope')));
    await api('/api/chat/runtime/stop', {});
    context.diagnostic('Image renderer/publisher are trusted local fakes; this checks policy and scoped delivery, not browser layout or QQ decoding.');
  });
