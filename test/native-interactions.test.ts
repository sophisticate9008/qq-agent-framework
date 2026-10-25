import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeInteractions } from '../src/host/native-interactions.ts';
import { createNativeInteractionMessages } from '../src/host/native-interaction-messages.ts';
import type { InboundMessage } from '../src/host/types.ts';

test('QQ approval retains a bounded redacted reason and deadline and accepts only its actual owner reply', async context => {
  const controller = new AbortController();
  context.after(() => controller.abort());
  const binding = { sessionId: 'parent-session', conversationId: 'private:123', generation: 1, expiresAt: Date.now() + 10_000 };
  const interactions = createNativeInteractions({ state: () => 'running', sensitiveValues: () => ['private-test-credential'] });
  let responses = 0;
  interactions.mount({ epoch: 'epoch', signal: controller.signal, resolveSession: () => binding,
    guard: async () => {}, port: { async respondInteraction() { responses++; return { ok: true, value: null }; } } });
  interactions.observe({ type: 'approval/requested', sessionId: binding.sessionId, eventId: 'event', clientId: 'client',
    toolName: 'workspace.write', reason: '创建报告，需要写入。credential=private-test-credential Bearer another-secret' }, 'epoch');
  const entry = interactions.snapshot().items[0];
  assert(entry.summary.includes('创建报告'));
  assert(!entry.summary.includes('private-test-credential'));
  assert(!entry.summary.includes('another-secret'));
  const sent: string[] = [];
  const messages = createNativeInteractionMessages({ interactions, owner: () => '123',
    async send(_scope, text) { sent.push(text); return { status: 'confirmed', messageId: `notice-${sent.length}` }; } });
  await messages.notify(entry, controller.signal);
  assert.match(sent[0], /创建报告/);
  assert.match(sent[0], /秒内回复/);
  function reply(userId: string): InboundMessage { return { id: `reply-${userId}`, conversationId: binding.conversationId,
    userId, receivedAt: Date.now(), isSelf: false, directed: true, content: [{ type: 'text', text: '同意' }] }; }
  assert.equal(await messages.receive(reply('789'), controller.signal), true);
  assert.equal(responses, 0);
  assert.equal(interactions.snapshot().items[0].status, 'pending');
  assert.equal(await messages.receive(reply('123'), controller.signal), true);
  assert.equal(responses, 1);
  assert.equal(interactions.snapshot().items[0].status, 'approved');
  await messages.receive(reply('123'), controller.signal);
  assert.equal(responses, 1);
});

test('a child interaction binding is invalidated when its parent generation changes', async context => {
  const controller = new AbortController();
  context.after(() => controller.abort());
  let generation = 1;
  let responses = 0;
  const interactions = createNativeInteractions({ state: () => 'running' });
  interactions.mount({ epoch: 'epoch', signal: controller.signal,
    resolveSession: sessionId => ({ sessionId, conversationId: 'group:456', generation }), guard: async () => {},
    port: { async respondInteraction() { responses++; return { ok: true, value: null }; } } });
  interactions.observe({ type: 'question/requested', sessionId: 'verified-child', eventId: 'question', clientId: 'client',
    questions: [{ id: 'scope', question: '需要处理哪个目录？' }] }, 'epoch');
  const entry = interactions.snapshot().items[0];
  generation = 2;
  assert.equal(interactions.snapshot().items[0].status, 'expired');
  await assert.rejects(interactions.respond({ id: entry.id, revision: entry.revision, action: 'reply', reply: 'reports' }, controller.signal));
  assert.equal(responses, 0);
});
