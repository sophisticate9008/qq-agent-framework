import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoApplication } from '../src/app.ts';
import { startDemo } from '../src/demo.ts';

const request = { id: 'app-one', type: 'message.received', conversationId: 'demo:room',
  data: { text: '你好', directed: true, isSelf: false } };

test('demo assembly uses real core and both features while remaining isolated', async () => {
  const app = createDemoApplication();
  try {
    const before = app.snapshot();
    assert.equal(before.overview.mode, 'demo');
    assert.equal(before.overview.realQQ, false);
    assert.equal(before.features.length, 2);
    await app.dispatchDemo(request);
    await app.dispatchDemo(request);
    await app.dispatchDemo({ type: 'trigger.fired', conversationId: 'demo:room', data: { kind: 'reminder', text: '站起来走走' } });
    const after = app.snapshot();
    assert.equal(after.outbox.length, 2);
    assert(after.outbox.every(entry => entry.status === 'confirmed'));
    const reply = after.outbox[0].content[0];
    const reminder = after.outbox[1].content[0];
    assert(reply.type === 'text' && reminder.type === 'text');
    assert.match(reply.text, /^\[演示\]/);
    assert.match(reminder.text, /轻轻提醒/);
    assert.deepEqual(after.context.persona, before.context.persona);
  } finally { await app.stop(); }
});

test('demo ingress cannot add authorization, arbitrary conversations or custom code', async () => {
  const app = createDemoApplication();
  try {
    for (const invalid of [
      { ...request, conversationId: 'group:123' },
      { ...request, authorized: true },
      { ...request, type: 'plugin.install' },
      { ...request, data: { ...request.data, grant: { capability: 'messaging.send' } } },
      { ...request, data: { ...request.data, text: 'x'.repeat(2001) } },
    ]) assert.throws(() => app.dispatchDemo(invalid), { code: 'INVALID_DEMO_EVENT' });
    assert.equal(app.snapshot().outbox.length, 0);
  } finally { await app.stop(); }
});

test('localhost UI reaches real demo assembly through authenticated API', async () => {
  const token = 'fixture-only-administrator-token';
  const demo = await startDemo({ token, port: 0 });
  const origin = `http://127.0.0.1:${demo.address.port}`;
  try {
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>工作台 · QQ Agent<\/title>/);
    assert.equal((await fetch(`${origin}/api/snapshot`)).status, 401);
    const response = await fetch(`${origin}/api/demo/events`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, origin, 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.equal(report.outcomes[0].status, 'completed');
    const snapshot = await (await fetch(`${origin}/api/snapshot`, { headers: { authorization: `Bearer ${token}` } })).json();
    assert.equal(snapshot.outbox.length, 1);
  } finally { await demo.stop(); }
});

test('demo cannot bind a public interface or start without a token', async () => {
  await assert.rejects(startDemo({ host: '0.0.0.0', port: 0 }), { code: 'LOOPBACK_REQUIRED' });
  await assert.rejects(startDemo({ port: 0 }));
});
