import assert from 'node:assert/strict';
import test from 'node:test';
import { setupProgress } from '../web/lib/setup-progress.ts';
const revision = 'a'.repeat(64);
const input = { adapters: { adapters: Object.fromEntries(['onebotWs', 'onebotHttp', 'dshAgent'].map(id => [id, { enabled: true, endpoint: 'synthetic://local' }])) },
  plans: { revision, activePlanId: 'daily', plans: [{ id: 'daily', name: 'Daily', description: '', instructions: 'Reply', personaId: 'persona', provider: 'provider', model: 'chat', reasoningEffort: 'low' }] },
  personas: { personas: [{ id: 'persona' }] }, providers: { providers: [{ id: 'provider', enabled: true, models: [{ id: 'chat' }] }] },
  access: { owner: '123', allow: ['group:456'] }, runtime: { state: 'running', chatReady: true, protocolConnected: true, canStart: false,
    configurationIssues: [], missingReasons: [], lastError: null, revisions: Object.fromEntries(['plans', 'personas', 'access', 'adapters', 'providers', 'authorization', 'deployment', 'execution'].map(key => [key, revision])), activeRevisions: null } };

test('first setup reflects saved connections, selected model/persona, access and actual runtime separately', () => {
  assert(setupProgress(input).every(step => step.state === 'complete'));
  assert.equal(setupProgress({ ...input, runtime: { ...input.runtime, state: 'stopped', chatReady: false } })[3]?.state, 'pending');
  assert.equal(setupProgress({ ...input, access: { owner: null, allow: [] } })[2]?.state, 'pending');
  assert.equal(setupProgress({ ...input, providers: { providers: [] } })[1]?.state, 'pending');
});

test('missing read results remain unknown and never count as configured or authorized', () => {
  const steps = setupProgress({ adapters: undefined, plans: undefined, personas: undefined, providers: undefined, access: undefined, runtime: undefined });
  assert(steps.every(step => step.state === 'unknown'));
  assert.deepEqual(steps.map(step => step.id), ['connections', 'companion', 'access', 'start']);
});
