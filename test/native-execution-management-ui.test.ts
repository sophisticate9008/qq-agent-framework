import assert from 'node:assert/strict';
import test from 'node:test';
import { parseExecutionReconciliation } from '../web/lib/execution-management.ts';
import { parseNativeConversationDiagnostics } from '../src/contracts/native-diagnostics.ts';
import { projectNativeDiagnostics } from '../src/host/native-diagnostics.ts';
import { parseModelCapabilities } from '../web/lib/model-capabilities.ts';
import { recommendChatCapacity } from '../src/contracts/chat-capacity.ts';
test('execution reconciliation projects proof only for the selected execution and rejects contradictory release', () => {
  const id = 'a'.repeat(64); const input = { state: 'released', execution: { id, isolated: false, private: 'never-project' }, missingReasons: [], automaticReplayAvailable: false, restartRequired: true };
  assert.deepEqual(parseExecutionReconciliation(input, id), { state: 'released', executionId: id, isolated: false, missingReasons: [], restartRequired: true });
  assert.equal(parseExecutionReconciliation(input, 'b'.repeat(64)), null); assert.equal(parseExecutionReconciliation({ ...input, execution: { id, isolated: true } }, id), null);
  assert.equal(parseExecutionReconciliation({ ...input, automaticReplayAvailable: true }, id), null);
});
test('conversation diagnostics preserve partial history and actual input facts, rejecting mismatched aggregate and injected links', () => {
  const value = projectNativeDiagnostics({ conversationId: 'group:123', running: true, globalReasons: [], accessAllowed: true, authorized: true, input: null, history: { checks: [], partial: true }, historyState: 'present', pendingInteractions: 0, now: 1000 });
  const parsed = parseNativeConversationDiagnostics(value); assert(parsed); assert.equal(parsed.coverage.history, 'partial'); assert.equal(parsed.state, 'unknown'); assert.equal(parsed.input, null);
  assert.equal(parseNativeConversationDiagnostics({ ...value, state: 'ready' }), null);
  assert.equal(parseNativeConversationDiagnostics({ ...value, checks: [{ ...value.checks[0], href: 'javascript:alert(1)' }] }), null);
});
test('model capabilities retain real capacity recommendations and reject invented or inconsistent budgets', () => {
  const capacity = recommendChatCapacity({ contextWindow: 262144, maxTokens: 32768 }); assert(capacity);
  const base = { provider: 'fixture', model: 'model', state: 'available', reasoningEfforts: ['high'], missingReasons: [], capacity };
  assert.deepEqual(parseModelCapabilities(base)?.capacity, capacity);
  assert.equal(parseModelCapabilities({ ...base, capacity: { ...capacity, recommended: { group: 1, private: 2 } } }), null);
  assert.equal(parseModelCapabilities({ ...base, state: 'unavailable', reasoningEfforts: [] }), null);
  const { capacity: _capacity, ...without } = base; assert.equal(parseModelCapabilities(without)?.capacity, undefined);
});
test('media diagnostics preserve byte-read and chain availability separately from failed reads and never accept arbitrary content fields', async () => {
  const { parseNativeMediaDiagnostics } = await import('../src/contracts/native-media-diagnostics.ts');
  const value = { schema: 1, conversationId: 'group:123', observedAt: 1000, running: true, coverage: 'partial', capabilities: { image: true, audio: false, file: true, forward: true, quote: true }, quote: { messageId: 'quoted', at: 900, status: 'rejected', code: 'QUOTED_CONTEXT_SCOPE_MISMATCH' }, items: [{ assetId: `media-${'a'.repeat(64)}`, kind: 'image', messageId: 'message', registeredAt: 100, expiresAt: 2000, contentRead: false, bytesRead: true, readingAvailable: true, missingReasons: [], lastRead: { at: 900, status: 'unknown', code: 'native_media_read_unknown' } }] };
  const parsed = parseNativeMediaDiagnostics(value); assert(parsed); assert.equal(parsed.items[0]?.bytesRead, true); assert.equal(parsed.items[0]?.contentRead, false); assert.equal(parsed.quote?.status, 'rejected'); assert.equal(parsed.coverage, 'partial');
  assert.equal(parseNativeMediaDiagnostics({ ...value, items: [{ ...value.items[0], content: 'private-body' }] }), null);
  assert.equal(parseNativeMediaDiagnostics({ ...value, quote: { ...value.quote, code: 'https://private.invalid' } }), null);
});
test('diagnostics context remains unknown without actual binding evidence and rejects guessed impossible windows', () => {
  const value = projectNativeDiagnostics({ conversationId: 'private:123', running: true, globalReasons: [], accessAllowed: true, authorized: true, input: null, history: null, historyState: 'absent', pendingInteractions: 0, now: 1000 });
  assert.equal(parseNativeConversationDiagnostics({ ...value, context: null })?.context, null);
  const context = { source: 'active-session', limit: 262144, headroomTokens: null, modelWindow: null, maxOutput: null };
  assert.deepEqual(parseNativeConversationDiagnostics({ ...value, context })?.context, context);
  assert.equal(parseNativeConversationDiagnostics({ ...value, context: { ...context, modelWindow: 128000 } }), null);
});
