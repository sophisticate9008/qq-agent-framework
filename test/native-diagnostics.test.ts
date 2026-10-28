import assert from 'node:assert/strict'
import test from 'node:test'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { digest } from '../src/host/data.ts'
import { projectNativeDiagnostics, readNativeDiagnosticHistory } from '../src/host/native-diagnostics.ts'
import { DEFAULT_CHAT_INPUT_CONFIGURATION, resolveChatInputConfiguration } from '../src/contracts/chat-input-configuration.ts'

const base = { conversationId: 'group:123', running: true, globalReasons: [], accessAllowed: true, authorized: true,
  input: resolveChatInputConfiguration(DEFAULT_CHAT_INPUT_CONFIGURATION, 'group:123'), historyState: 'present' as const, pendingInteractions: 0 }
test('conversation diagnosis exposes isolated execution despite healthy global status without mutating journals', () => {
  const store = createSqliteStore({ filename: ':memory:' })
  try {
    store.write('host.execution-conversations', digest('group:123'), { executionId: 'execution' })
    store.write('host.executions', 'execution', { schema: 1, isolated: true, status: 'unknown' })
    store.write('outbox', 'old', { conversationId: 'group:123', status: 'unknown', content: 'private message must not escape' })
    const before = store.list('outbox', { limit: 100 })
    const result = projectNativeDiagnostics({ ...base, history: readNativeDiagnosticHistory(store, 'group:123') })
    assert.equal(result.state, 'blocked')
    assert(result.checks.some(item => item.code === 'execution_isolated'))
    assert(result.checks.some(item => item.code === 'delivery_unconfirmed'))
    assert.equal(JSON.stringify(result).includes('private message'), false)
    assert.deepEqual(store.list('outbox', { limit: 100 }), before)
    assert.equal(projectNativeDiagnostics({ ...base, conversationId: 'group:999', history: readNativeDiagnosticHistory(store, 'group:999') }).state, 'ready')
  } finally { store.close() }
})
test('bounded history, missing input and unreadable storage are never called healthy', () => {
  const store = createSqliteStore({ filename: ':memory:' })
  try {
    for (let index = 0; index < 257; index++) store.write('outbox', String(index).padStart(4, '0'), { conversationId: 'group:999', status: 'confirmed' })
    const result = projectNativeDiagnostics({ ...base, history: readNativeDiagnosticHistory(store, 'group:123') })
    assert.equal(result.state, 'unknown'); assert.equal(result.coverage.history, 'partial')
    assert.equal(projectNativeDiagnostics({ ...base, history: null, historyState: 'unavailable' }).state, 'unknown')
    assert.equal(projectNativeDiagnostics({ ...base, history: null, input: null }).state, 'unknown')
  } finally { store.close() }
})
test('participation, per-conversation budgets and QQ-only pending answers give concrete next steps', () => {
  const result = projectNativeDiagnostics({ ...base, authorized: false, input: resolveChatInputConfiguration({ ...DEFAULT_CHAT_INPUT_CONFIGURATION,
    scopes: { ...DEFAULT_CHAT_INPUT_CONFIGURATION.scopes, exclude: ['group:123'] } }, 'group:123'), history: null, pendingInteractions: 1 })
  assert.equal(result.state, 'blocked')
  assert(!result.checks.some(item => item.code === 'input_excluded'))
  assert(result.checks.some(item => item.code === 'conversation_budget_unavailable'))
  assert(result.checks.some(item => item.code === 'qq_interaction_pending' && item.href === null && item.nextAction?.includes('QQ')))
})

test('normal work and delivery remain waiting while malformed evidence cannot become a healthy diagnosis', () => {
  const store = createSqliteStore({ filename: ':memory:' })
  try {
    store.write('outbox', 'sending', { conversationId: 'group:123', status: 'sending' })
    store.write('native-work.executions', 'work', { conversationId: 'group:123', status: 'running', delivery: 'not-requested' })
    const result = projectNativeDiagnostics({ ...base, history: readNativeDiagnosticHistory(store, 'group:123') })
    assert.equal(result.state, 'waiting')
    assert(result.checks.some(item => item.code === 'work_pending'))
    store.write('outbox', 'corrupt', { conversationId: 'group:123', status: 'unexpected-status' })
    assert.throws(() => readNativeDiagnosticHistory(store, 'group:123'), { code: 'DIAGNOSTIC_HISTORY_INVALID' })
  } finally { store.close() }
})
