import { randomUUID } from 'node:crypto';
import { createEngine } from './core/engine.ts';
import { createContextStore, createFeatureState } from './core/context.ts';
import { createPolicy } from './core/policy.ts';
import { assert, isRecord, snapshot } from './core/values.ts';
import type { Clock, JsonObject } from './core/types.ts';
import { createDemoModel, createDemoTransport } from './adapters/demo.ts';
import { conversationFeature } from './features/conversation.ts';
import { reminderFeature } from './features/reminder.ts';

export function createDemoApplication({ clock = Date.now }: { clock?: Clock } = {}) {
  const context = createContextStore({ clock });
  const state = createFeatureState();
  const policy = createPolicy({ clock });
  const transport = createDemoTransport();
  const persona = context.registerPersona({ id: 'harbor', version: '1.0.0', name: '潮汐',
    identity: { role: '虚构的演示角色', anchors: ['此定义不包含工具、权限或任务状态'] },
    style: { tone: '自然、简洁' } });
  context.setConfiguration({ scope: { kind: 'global' }, source: 'operator',
    values: { reminderPrefix: '提醒：', reminderDefaultText: '该处理提醒事项了。' } });
  context.setPreferences({ id: 'demo-room', scope: { kind: 'conversation', id: 'demo:room' },
    source: 'confirmed-user', values: { responseStyle: '简短', reminderPrefix: '轻轻提醒：' } });
  const engine = createEngine({ context, state, policy, transport, model: createDemoModel(), persona, clock });
  for (const feature of [conversationFeature, reminderFeature]) {
    engine.install(feature);
    policy.grant({ id: `demo-${feature.id}`, featureId: feature.id, conversationId: 'demo:room',
      capabilities: feature.capabilities,
      maxUses: Object.fromEntries(feature.capabilities.map(capability => [capability, 100])) });
  }

  function describe() {
    const runtime = engine.describe();
    const messages = new Map(transport.describe().map(message => [message.idempotencyKey, message]));
    return snapshot({
      overview: { name: 'QQ Agent Framework', mode: 'demo', version: '1.0.0', status: runtime.status,
        realQQ: false, paidModels: false, persistent: false, conversationId: 'demo:room',
        activeFeatures: runtime.features.filter(feature => feature.status === 'active').length },
      features: runtime.features,
      context: context.resolve({ persona, conversationId: 'demo:room' }),
      policy: policy.describe(),
      state: state.describe(),
      outbox: runtime.outbox.map(entry => ({ ...entry, content: messages.get(entry.id)?.content ?? [] })),
      audit: runtime.audit,
    });
  }

  function dispatchDemo(input: unknown) {
    const body = snapshot(input);
    assert(isRecord(body)
      && Object.keys(body).every(key => ['id', 'type', 'conversationId', 'data'].includes(key)),
    'INVALID_DEMO_EVENT', 'Only explicit demo event fields are accepted.');
    assert(body.conversationId === 'demo:room' && typeof body.type === 'string'
      && ['message.received', 'trigger.fired'].includes(body.type),
      'INVALID_DEMO_EVENT', 'Only the isolated demo conversation is available.');
    const data = body.data;
    assert(isRecord(data) && typeof data.text === 'string'
      && data.text.trim().length > 0 && data.text.length <= 2000, 'INVALID_DEMO_EVENT', 'A bounded demo text is required.');
    const allowed = body.type === 'message.received' ? ['text', 'directed', 'isSelf'] : ['text', 'kind'];
    assert(Object.keys(data).every(key => allowed.includes(key)), 'INVALID_DEMO_EVENT', 'Demo data contains unsupported fields.');
    if (body.type === 'message.received') {
      assert(typeof data.directed === 'boolean' && typeof data.isSelf === 'boolean',
        'INVALID_DEMO_EVENT', 'Directed and self-message flags are required.');
    } else assert(data.kind === 'reminder', 'INVALID_DEMO_EVENT', 'Only manual reminders are available.');
    return engine.emit({ id: body.id ?? randomUUID(), type: body.type,
      conversationId: 'demo:room', userId: 'demo:user', data: data as JsonObject });
  }

  return Object.freeze({ snapshot: describe, dispatchDemo, stop: () => engine.stop() });
}
