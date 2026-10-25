import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { capabilityObject, capabilityUntil, createNativeCapabilityRuntimeFixture } from './fixtures/native-capability-runtime.ts';
import {
  nativeRuntimeCompatibilityDifferenceLabel,
  nativeRuntimeCompatibilityLabel,
  nativeRuntimeCompatibilityReasonLabel,
  nativeRuntimeCompatibilityRecoveryText,
  nativeRuntimeConfigurationBaselineLabel,
  nativeRuntimeBaselineUnavailableReasonLabel,
  parseNativeRuntimeCompatibility,
  parseNativeRuntimeConfigurationBaseline,
  type NativeRuntimeCompatibility,
  type NativeRuntimeConfigurationBaseline,
} from '../web/lib/native-runtime-compatibility.ts';

function compatibility(changes: Partial<NativeRuntimeCompatibility> = {}): NativeRuntimeCompatibility {
  return { schema: 1, state: 'blocked', hasPersistedSessions: true,
    reasons: ['persisted_session_configuration_conflict'], differences: ['contextLimits'],
    baseline: { state: 'missing', capturedAt: null },
    recovery: { mode: 'operator-original-values-required', automaticRestoreAvailable: false, forwardMigrationAvailable: false }, ...changes };
}

test('compatibility parser does not invent a DTO, empty history or captured time for missing data', () => {
  for (const value of [null, undefined, false, [], {}, { state: 'stopped' }, { configurationCompatibility: null },
    { configurationCompatibility: undefined }, { configurationCompatibility: {} }]) assert.equal(parseNativeRuntimeCompatibility(value), null);
  assert.match(nativeRuntimeCompatibilityLabel(null), /无法确认/);
  const unavailable = compatibility({ state: 'unavailable', hasPersistedSessions: null,
    reasons: ['persisted_configuration_unavailable'], differences: [], baseline: { state: 'invalid', capturedAt: null },
    recovery: { mode: 'storage-unavailable', automaticRestoreAvailable: false, forwardMigrationAvailable: false } });
  assert.deepEqual(parseNativeRuntimeCompatibility({ configurationCompatibility: unavailable }), unavailable);
});

test('compatibility parser projects only confirmed fields without returning originals, secrets or write capabilities', () => {
  const source = compatibility();
  const parsed = parseNativeRuntimeCompatibility({ token: 'synthetic-token', canStart: true, configurationCompatibility: {
    ...source, endpoint: 'http://private.invalid', originalInstructions: 'private instructions',
    baseline: { ...source.baseline, apiKey: 'synthetic-key', values: { identity: 'private persona' } },
    recovery: { ...source.recovery, restoreUrl: '/api/private-restore' },
  } });
  assert.deepEqual(parsed, source);
  for (const text of ['synthetic-token', 'private.invalid', 'private instructions', 'synthetic-key', 'private persona', 'private-restore']) {
    assert.equal(JSON.stringify(parsed).includes(text), false);
  }
});

test('all compatibility states remain distinct and do not imply model readiness or new permissions', () => {
  const samples = [
    compatibility({ state: 'no-history', hasPersistedSessions: false, reasons: [], differences: [],
      baseline: { state: 'not-required', capturedAt: null }, recovery: { mode: 'none', automaticRestoreAvailable: false, forwardMigrationAvailable: false } }),
    compatibility({ state: 'compatible', reasons: [], differences: [], baseline: { state: 'available', capturedAt: 1_792_880_000_000 },
      recovery: { mode: 'none', automaticRestoreAvailable: false, forwardMigrationAvailable: false } }),
    compatibility(),
    compatibility({ state: 'unavailable', hasPersistedSessions: null, reasons: ['persisted_configuration_unavailable'], differences: [],
      recovery: { mode: 'storage-unavailable', automaticRestoreAvailable: false, forwardMigrationAvailable: false } }),
  ];
  const labels = new Set<string>();
  for (const sample of samples) {
    const parsed = parseNativeRuntimeCompatibility({ configurationCompatibility: sample });
    assert.deepEqual(parsed, sample);
    assert(parsed);
    const label = nativeRuntimeCompatibilityLabel(parsed);
    assert.doesNotMatch(label, /模型已就绪|已授权|自动恢复|迁移成功/);
    labels.add(label);
  }
  assert.equal(labels.size, 4);
});

test('compatibility DTO rejects invalid versions, unknown enum values, duplicated arrays and unsafe timestamps', () => {
  const source = compatibility();
  const invalid: readonly Record<string, unknown>[] = [
    { schema: 2 }, { state: 'ready' }, { state: undefined }, { hasPersistedSessions: 0 }, { hasPersistedSessions: undefined },
    { reasons: null }, { reasons: ['unknown-reason'] }, { reasons: ['persisted_session_configuration_conflict', 'persisted_session_configuration_conflict'] },
    { differences: ['unknown-difference'] }, { differences: ['contextLimits', 'contextLimits'] }, { differences: undefined },
    { baseline: { state: 'available' } }, { baseline: { state: 'guessed', capturedAt: null } },
    ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', undefined].map(capturedAt => ({ baseline: { state: 'available', capturedAt } })),
    { recovery: { ...source.recovery, mode: 'auto-restore' } },
    { recovery: { ...source.recovery, automaticRestoreAvailable: true } },
    { recovery: { ...source.recovery, forwardMigrationAvailable: true } },
    { recovery: { mode: 'none', automaticRestoreAvailable: false } },
  ];
  for (const changed of invalid) assert.equal(parseNativeRuntimeCompatibility({ configurationCompatibility: { ...source, ...changed } }), null, JSON.stringify(changed));
});

function baseline(): Extract<NativeRuntimeConfigurationBaseline, { state: 'available' }> {
  return { schema: 1, state: 'available', capturedAt: 1_792_880_000_000, values: {
    definition: { planId: 'daily', personaId: 'independent', instructions: 'Original operator instructions.',
      persona: { identity: 'Independent identity.', style: 'Concise.' },
      model: { provider: 'synthetic', name: 'model', reasoningEffort: 'off' },
      contextLimits: { group: 100_000, private: 120_000 }, capabilitySelection: null },
    persona: { id: 'independent', name: 'Independent', identity: 'Independent identity.', style: 'Concise.' },
    endpoint: 'http://127.0.0.1:3001/dsh',
    bindings: [{ agentPreset: 'private-preset', conversationKind: 'private', externalProvider: null, definitionFingerprint: 'a'.repeat(64) }],
  } };
}

test('baseline parser preserves complete operator originals and distinguishes explicit null from omitted optional fields', () => {
  const source = baseline();
  assert.deepEqual(parseNativeRuntimeConfigurationBaseline(source), source);
  const { contextLimits: _limits, capabilitySelection: _selection, ...legacyDefinition } = source.values.definition;
  const legacy = { ...source, values: { ...source.values, definition: legacyDefinition } };
  const parsed = parseNativeRuntimeConfigurationBaseline(legacy);
  assert.deepEqual(parsed, legacy);
  assert(parsed?.state === 'available');
  assert.equal(Object.hasOwn(parsed.values.definition, 'contextLimits'), false);
  assert.equal(Object.hasOwn(parsed.values.definition, 'capabilitySelection'), false);
  const selected = { ...source, values: { ...source.values, definition: { ...source.values.definition,
    capabilitySelection: { schema: 1, presetId: 'operator-work', revision: 'b'.repeat(64) } } } };
  assert.deepEqual(parseNativeRuntimeConfigurationBaseline(selected), selected);
});

test('missing, invalid and unavailable baselines carry no guessed values or time', () => {
  for (const state of ['missing', 'invalid', 'unavailable'] as const) {
    const source = { schema: 1, state, capturedAt: null, values: null };
    const parsed = parseNativeRuntimeConfigurationBaseline(source);
    assert.deepEqual(parsed, source);
    assert(parsed);
    assert.match(nativeRuntimeConfigurationBaselineLabel(parsed), /原值|恢复值/);
    assert.equal(parseNativeRuntimeConfigurationBaseline({ ...source, values: baseline().values }), null);
    assert.equal(parseNativeRuntimeConfigurationBaseline({ ...source, capturedAt: 1 }), null);
  }
  for (const value of [undefined, null, {}, { schema: 1, state: 'compatible', capturedAt: null, values: null },
    { ...baseline(), values: null }, { ...baseline(), capturedAt: null }, { ...baseline(), capturedAt: 0 }]) {
    assert.equal(parseNativeRuntimeConfigurationBaseline(value), null);
  }
  assert.match(nativeRuntimeConfigurationBaselineLabel(null), /无法提供恢复值/);
});

test('baseline projection drops credentials, target paths, grants and nested unapproved fields without dropping original text', () => {
  const source = baseline();
  const parsed = parseNativeRuntimeConfigurationBaseline({ ...source, apiKey: 'never-return-key', values: { ...source.values,
    target: { credentialsPath: '/private/credentials.yaml' }, authorization: { grants: ['never-return-grant'] },
    definition: { ...source.values.definition, model: { ...source.values.definition.model, apiKey: 'never-return-model-key' },
      persona: { ...source.values.definition.persona, secret: 'never-return-secret' },
      contextLimits: { ...source.values.definition.contextLimits, hmac: 'never-return-hmac' } },
    persona: { ...source.values.persona, auth: 'never-return-auth' },
    bindings: source.values.bindings.map(binding => ({ ...binding, definition: { token: 'never-return-token' } })),
  } });
  assert.deepEqual(parsed, source);
  for (const text of ['never-return-', '/private/credentials.yaml', 'authorization']) assert.equal(JSON.stringify(parsed).includes(text), false);
});

test('baseline rejects incomplete definitions, hashes masquerading as originals and malformed descriptors', () => {
  const source = baseline();
  const values = source.values;
  const invalidValues: readonly unknown[] = [null, {}, 'a'.repeat(64), { ...values, definition: 'a'.repeat(64) },
    { ...values, definition: { ...values.definition, instructions: undefined } },
    { ...values, definition: { ...values.definition, contextLimits: { group: 1 } } },
    { ...values, definition: { ...values.definition, contextLimits: { group: 0, private: 1 } } },
    { ...values, definition: { ...values.definition, capabilitySelection: undefined } },
    { ...values, definition: { ...values.definition, capabilitySelection: { schema: 1, presetId: 'work', revision: 'hash' } } },
    { ...values, definition: { ...values.definition, model: { ...values.definition.model, reasoningEffort: 'auto' } } },
    { ...values, persona: { id: 'independent', name: 'Name', identity: 'Identity' } },
    { ...values, persona: { ...values.persona, id: 'different-persona' } },
    { ...values, persona: { ...values.persona, style: 'Conflicting style.' } },
    { ...values, bindings: null }, { ...values, bindings: [{ agentPreset: 'private-preset' }] },
    ...[{ conversationKind: 'all' }, { externalProvider: undefined }, { definitionFingerprint: 'hash' }].map(change => ({
      ...values, bindings: [{ ...values.bindings[0], ...change }],
    })),
  ];
  for (const changed of invalidValues) assert.equal(parseNativeRuntimeConfigurationBaseline({ ...source, values: changed }), null);
});

test('baseline endpoint validation rejects secrets, non-loopback HTTP and malformed addresses without normalizing originals', () => {
  const source = baseline();
  for (const endpoint of ['', 'http://remote.invalid/dsh', 'http://127.000.0.1/dsh', 'ftp://127.0.0.1',
    'https://owner:secret@example.invalid/dsh', 'https://@example.invalid/dsh', 'https://example.invalid/dsh?token=secret',
    'https://example.invalid/dsh#secret', 'https://example.invalid/\nsecret']) {
    assert.equal(parseNativeRuntimeConfigurationBaseline({ ...source, values: { ...source.values, endpoint } }), null, endpoint);
  }
  for (const endpoint of ['http://127.0.0.1:3001/dsh/', 'http://localhost/dsh', 'http://[::1]/dsh', 'https://example.invalid/dsh']) {
    const parsed = parseNativeRuntimeConfigurationBaseline({ ...source, values: { ...source.values, endpoint } });
    assert(parsed?.state === 'available');
    assert.equal(parsed.values.endpoint, endpoint);
  }
});

test('baseline enforces full value byte and binding limits without producing truncated recovery data', () => {
  const source = baseline();
  const bindings = Array.from({ length: 128 }, (_, index) => ({ ...source.values.bindings[0], agentPreset: `preset-${index}` }));
  const maximum = { ...source, values: { ...source.values, bindings } };
  assert.equal(parseNativeRuntimeConfigurationBaseline(maximum)?.state, 'available');
  assert.equal(parseNativeRuntimeConfigurationBaseline({ ...source, values: { ...source.values, bindings: [...bindings, bindings[0]] } }), null);
  const largePersona = { ...source.values.persona, identity: `A${'\u0000'.repeat(15_999)}`, style: `A${'\u0000'.repeat(15_999)}` };
  const oversized = { ...source, values: { ...source.values, persona: largePersona, definition: { ...source.values.definition,
    instructions: `A${'\u0000'.repeat(31_999)}`, persona: { identity: largePersona.identity, style: largePersona.style } } } };
  assert(new TextEncoder().encode(JSON.stringify(oversized.values)).byteLength > 512 * 1_024);
  assert.equal(parseNativeRuntimeConfigurationBaseline(oversized), null);
});

test('summary constraints do not turn invalid baselines or unavailable storage into an executable recovery', () => {
  const source = compatibility();
  for (const changed of [
    { state: 'blocked', reasons: [] }, { state: 'compatible' }, { state: 'no-history' },
    { state: 'unavailable', reasons: [] }, { hasPersistedSessions: null },
    { state: 'no-history', reasons: [], recovery: { ...source.recovery, mode: 'none' } },
    { state: 'compatible', reasons: [], hasPersistedSessions: false, recovery: { ...source.recovery, mode: 'none' } },
    { state: 'unavailable', reasons: ['persisted_configuration_unavailable'], recovery: { ...source.recovery, mode: 'none' } },
    { baseline: { state: 'missing', capturedAt: 1 } },
    { baseline: { state: 'available', capturedAt: null } },
    { baseline: { state: 'available', capturedAt: 1 } },
    { recovery: { ...source.recovery, mode: 'restore-original-values' } },
  ]) assert.equal(parseNativeRuntimeCompatibility({ configurationCompatibility: { ...source, ...changed } }), null);
  assert.match(nativeRuntimeCompatibilityRecoveryText(source), /不要根据指纹|猜测/);
  const recoverable = compatibility({ baseline: { state: 'available', capturedAt: 1 },
    recovery: { mode: 'restore-original-values', automaticRestoreAvailable: false, forwardMigrationAvailable: false } });
  assert.deepEqual(parseNativeRuntimeCompatibility({ configurationCompatibility: recoverable }), recoverable);
  assert.match(nativeRuntimeCompatibilityRecoveryText(recoverable), /仅供操作者核对/);
  assert.match(nativeRuntimeCompatibilityRecoveryText(recoverable), /不会自动应用或重建会话/);
});

test('baseline publication reasons remain explicit and old responses do not acquire guessed reasons', () => {
  for (const unavailableReason of ['not-recorded', 'invalid-record', 'sensitive-content', 'value-too-large', 'record-limit', 'storage-unavailable'] as const) {
    const summary = compatibility({ baseline: { state: 'missing', capturedAt: null, unavailableReason } });
    assert.deepEqual(parseNativeRuntimeCompatibility({ configurationCompatibility: summary }), summary);
    const unavailable = { schema: 1, state: 'missing', capturedAt: null, values: null, unavailableReason };
    assert.deepEqual(parseNativeRuntimeConfigurationBaseline(unavailable), unavailable);
    assert(nativeRuntimeBaselineUnavailableReasonLabel(unavailableReason).length > 0);
  }
  const oldSummary = parseNativeRuntimeCompatibility({ configurationCompatibility: compatibility() });
  const oldBaseline = parseNativeRuntimeConfigurationBaseline({ schema: 1, state: 'missing', capturedAt: null, values: null });
  assert(oldSummary && oldBaseline);
  assert.equal(Object.hasOwn(oldSummary.baseline, 'unavailableReason'), false);
  assert.equal(Object.hasOwn(oldBaseline, 'unavailableReason'), false);
  assert.match(nativeRuntimeBaselineUnavailableReasonLabel(undefined), /未提供.*不能.*猜测/);
  assert.match(nativeRuntimeBaselineUnavailableReasonLabel('not-recorded'), /不表示没有会话或历史/);
  const available = { ...baseline(), unavailableReason: null };
  assert.deepEqual(parseNativeRuntimeConfigurationBaseline(available), available);
  for (const unavailableReason of ['unknown-publication-reason', '', true, 0, undefined]) {
    const summary = compatibility({ baseline: { state: 'missing', capturedAt: null } });
    assert.equal(parseNativeRuntimeCompatibility({ configurationCompatibility: { ...summary,
      baseline: { ...summary.baseline, unavailableReason } } }), null);
    assert.equal(parseNativeRuntimeConfigurationBaseline({ schema: 1, state: 'missing', capturedAt: null, values: null, unavailableReason }), null);
  }
  assert.equal(parseNativeRuntimeConfigurationBaseline({ ...baseline(), unavailableReason: 'sensitive-content' }), null);
});

test('compatibility projection detaches mutable input arrays and nested status records', () => {
  const source = { ...compatibility(), reasons: ['persisted_session_configuration_conflict'], differences: ['contextLimits'] };
  const parsed = parseNativeRuntimeCompatibility({ configurationCompatibility: source });
  assert(parsed);
  source.reasons.push('persisted_persona_identity_conflict');
  source.differences.push('endpoint');
  source.baseline = { state: 'available', capturedAt: 123 };
  assert.deepEqual(parsed.reasons, ['persisted_session_configuration_conflict']);
  assert.deepEqual(parsed.differences, ['contextLimits']);
  assert.deepEqual(parsed.baseline, { state: 'missing', capturedAt: null });
});

test('known compatibility reason and difference labels give bounded explanations rather than recovery guesses', () => {
  assert.match(nativeRuntimeCompatibilityReasonLabel('persisted_session_configuration_conflict'), /已有绑定/);
  assert.match(nativeRuntimeCompatibilityReasonLabel('persisted_persona_identity_conflict'), /身份记录/);
  assert.match(nativeRuntimeCompatibilityReasonLabel('persisted_configuration_unavailable'), /不能确认/);
  assert.match(nativeRuntimeCompatibilityReasonLabel('current_configuration_unavailable'), /比较/);
  assert.equal(nativeRuntimeCompatibilityDifferenceLabel('contextLimits'), '群聊／私聊上下文上限');
  assert.equal(nativeRuntimeCompatibilityDifferenceLabel('endpoint'), 'DSH 连接地址');
  assert.equal(nativeRuntimeCompatibilityDifferenceLabel('persona.name'), '人设名称');
});

test('default authenticated native handlers emit DTOs accepted by the shared parser before and after a persisted-session conflict', { timeout: 30_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'native-compatibility-ui-'));
  const previousEvidence = process.env.QQ_CAPABILITY_DEFAULT_EVIDENCE;
  process.env.QQ_CAPABILITY_DEFAULT_EVIDENCE = directory;
  let fixture: Awaited<ReturnType<typeof createNativeCapabilityRuntimeFixture>>;
  try { fixture = await createNativeCapabilityRuntimeFixture(context); }
  finally {
    if (previousEvidence === undefined) delete process.env.QQ_CAPABILITY_DEFAULT_EVIDENCE;
    else process.env.QQ_CAPABILITY_DEFAULT_EVIDENCE = previousEvidence;
    context.after(async () => { await rm(directory, { recursive: true, force: true }); });
  }
  await fixture.login();
  const missing = await fixture.api('/api/chat/runtime/baseline');
  assert.equal(parseNativeRuntimeConfigurationBaseline(missing)?.state, 'missing');
  await fixture.configure(false);
  assert.equal((await fixture.apply()).state, 'verified');
  const running = await fixture.start();
  assert.deepEqual(parseNativeRuntimeCompatibility(running), running.configurationCompatibility);
  const original = await fixture.api('/api/chat/runtime/baseline');
  const parsedOriginal = parseNativeRuntimeConfigurationBaseline(original);
  assert.deepEqual(parsedOriginal, original);
  assert(parsedOriginal?.state === 'available');
  assert.equal(parsedOriginal.values.definition.contextLimits?.group, 100_000);
  fixture.inbound(1);
  await capabilityUntil(() => fixture.calls.some(call => call.method === 'session/prompt'), 'Default handler did not submit the synthetic turn');
  fixture.event('turn/start', { turn: 1 });
  fixture.event('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic DTO final.' }] } });
  fixture.event('turn/end', { turn: 1, reason: { kind: 'completed' } });
  await capabilityUntil(() => fixture.sends.length === 1, 'Default native final was not sent');
  await fixture.api('/api/chat/runtime/stop', {});
  const catalog = await fixture.api('/api/chat/plans');
  assert(Array.isArray(catalog.plans));
  await fixture.save('plans', { activePlanId: catalog.activePlanId, plans: catalog.plans.map(raw => ({ ...capabilityObject(raw),
    contextLimits: { group: 110_000, private: 120_000 } })) });
  assert.equal((await fixture.apply()).state, 'verified');
  const blocked = await fixture.status();
  const parsedBlocked = parseNativeRuntimeCompatibility(blocked);
  assert.deepEqual(parsedBlocked, blocked.configurationCompatibility);
  assert.equal(parsedBlocked?.state, 'blocked');
  assert.equal(blocked.canStart, false);
  assert(parsedBlocked?.differences.includes('contextLimits'));
  assert.equal(parsedBlocked.recovery.automaticRestoreAvailable, false);
  assert.deepEqual(parseNativeRuntimeConfigurationBaseline(await fixture.api('/api/chat/runtime/baseline')), parsedOriginal);
  await fixture.save('plans', { activePlanId: null, plans: catalog.plans });
  const missingCurrent = parseNativeRuntimeCompatibility(await fixture.status());
  assert.equal(missingCurrent?.state, 'blocked');
  assert.deepEqual(missingCurrent?.reasons, ['current_configuration_unavailable']);
  assert.equal(missingCurrent.recovery.mode, 'restore-original-values');
  assert.equal(fixture.controls.creates, 1);
  assert.deepEqual(fixture.errors, []);
});
