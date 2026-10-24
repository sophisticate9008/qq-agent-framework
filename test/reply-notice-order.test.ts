import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createContextStore } from '../src/core/context.ts';
import { createBridgeHost } from '../src/host/bridge.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';
import type { AgentAdapter, AgentEvent, InboundMessage } from '../src/host/types.ts';
import type { SendRequest } from '../src/core/types.ts';

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert(predicate(), 'The expected response state did not arrive.');
}

test('a queued timeout notice is suppressed when the earlier queued reply has already arrived', { timeout: 10000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reply-notice-order-'));
  const store = createSqliteStore({ filename: join(directory, 'state.sqlite') });
  const context = createContextStore();
  const persona = context.registerPersona({ id: 'fixture', version: '1.0.0', name: 'Fixture', identity: {}, style: {} });
  let onEvent!: (event: AgentEvent) => void | Promise<void>;
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sent: SendRequest[] = [];
  const agent: AgentAdapter = {
    async createSession() { return { sessionId: 'fixture-session' }; },
    async submit() { return { status: 'accepted' }; },
    async follow(request) { onEvent = request.onEvent; return () => {}; },
  };
  const host = createBridgeHost({ store, context, persona, agent, replyTimeoutMs: 300, authorizeIncoming: () => true,
    transport: { send(request) { sent.push(request); return { status: 'confirmed', messageId: `receipt:${sent.length}` }; } } });
  host.engine.install({ id: 'order-gate', version: '1.0.0', apiVersion: 1, capabilities: [], subscriptions: ['message.received'],
    setup(services) { services.on('message.received', async (_execution, event) => {
      if (event.id === 'blocking') { enter(); await gate; }
    }); } });
  host.policy.grant({ id: 'fixture-grant', featureId: 'agent-relay', conversationId: 'room:1',
    capabilities: ['agent.submit', 'messaging.send'], maxUses: { 'agent.submit': 10, 'messaging.send': 10 } });
  const message = (id: string): InboundMessage => ({ id, conversationId: 'room:1', userId: 'user:1',
    receivedAt: Date.now(), directed: true, isSelf: false, content: [{ type: 'text', text: 'fixture' }] });
  let blocking: Promise<unknown> | undefined;
  try {
    assert.equal((await host.receive(message('first'))).status, 'accepted');
    blocking = host.receive(message('blocking'));
    await entered;
    await onEvent({ id: 'answer', sessionId: 'fixture-session', type: 'message', content: [{ type: 'text', text: 'actual reply' }] });
    await waitFor(() => host.engine.metrics().queues.pendingEvents >= 2);
    await waitFor(() => host.replies.get('room:1')?.status === 'timed-out');
    release();
    await blocking;
    await waitFor(() => host.metrics().pendingIngress === 0 && host.replies.metrics().activeNotices === 0);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].content, [{ type: 'text', text: 'actual reply' }]);
    assert.equal(host.replies.get('room:1')?.status, 'responded-late');
  } finally { release(); await blocking; await host.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
