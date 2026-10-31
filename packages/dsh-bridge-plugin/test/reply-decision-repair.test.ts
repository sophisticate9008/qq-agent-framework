import assert from 'node:assert/strict'
import test from 'node:test'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { createReplyDecisionRepair, type ReplyDecisionAgent } from '../dist/reply-decision-repair.js'

function fixture(participation = 'direct', wakes: readonly { reason: string }[] = [], conversationId = 'group:fixture') {
  const steering: UserMessage[] = []
  const agent: ReplyDecisionAgent = { id: 'session', session: { id: 'session' }, status: 'running', steer(message) { steering.push(message) } }
  let leased = true
  const repair = createReplyDecisionRepair({ current: current => current === agent, hasReplyLease: () => leased })
  const source = createUserMessage({ source: { kind: 'user', rpcId: 'real-request' }, content: [{ type: 'text', text: '会话事实：\n'
    + JSON.stringify({ senderId: 'member', conversationId, participation, groupWake: wakes }) + '当前消息：\nPRIVATE-BODY-OMITTED' }] })
  repair.claimed(agent, source, 7)
  return { agent, repair, steering, source, revoke() { leased = false } }
}

test('one short same-turn repair preserves the original source and waits for a genuine send or silent decision', () => {
  const { agent, repair, steering, source } = fixture()
  const signal = new AbortController().signal
  let terminalEvents = 0
  repair.assistant(agent, 7, [{ type: 'text', text: 'A bare final that was never sent' }])
  repair.stopping(agent, 7, signal)
  assert.equal(steering.length, 1)
  assert.equal(terminalEvents, 0, 'the SDK checks steering before committing turn/end')
  const reminder = steering[0]!
  assert.equal(reminder.source.kind, 'qbf-reply-decision-repair')
  assert('requestId' in reminder.source)
  assert.equal(reminder.source.requestId, 'real-request')
  assert(!('rpcId' in reminder.source), 'repair input cannot mint a user RPC claim')
  assert(!JSON.stringify(reminder).includes('PRIVATE-BODY-OMITTED'))
  assert(JSON.stringify(reminder).length < 1200)
  repair.claimed(agent, reminder, 7)
  repair.attempted(agent, { requestId: 'real-request', userMessageId: source.id, turn: 7 })
  repair.assistant(agent, 7, [{ type: 'text', text: 'Now the tool has decided delivery' }])
  repair.stopping(agent, 7, signal)
  assert.equal(steering.length, 1)
  terminalEvents++
  assert.equal(terminalEvents, 1)
})

test('bare final gets at most one reminder even when the model omits the tool again', () => {
  const { agent, repair, steering } = fixture('continuation', [{ reason: 'reply' }])
  repair.assistant(agent, 7, [{ type: 'text', text: 'Bare answer' }])
  repair.stopping(agent, 7, new AbortController().signal)
  repair.assistant(agent, 7, [{ type: 'text', text: 'Another bare answer' }])
  repair.stopping(agent, 7, new AbortController().signal)
  assert.equal(steering.length, 1)
})

test('ordinary observations, work feedback, explicit silence, attempted sends and unavailable leases never add a request', () => {
  for (const mode of ['observation', 'work-feedback', 'silent', 'attempted', 'tool-call', 'revoked', 'aborted', 'wrong-turn']) {
    const { agent, repair, steering, source, revoke } = fixture(mode === 'observation' ? 'continuation' : 'direct')
    if (mode === 'work-feedback') repair.claimed(agent, createUserMessage({ source: { kind: 'user', rpcId: 'work-feedback' },
      content: [{ type: 'text', text: 'Host work feedback is not a QQ message' }] }), 7)
    repair.assistant(agent, 7, [{ type: 'text', text: mode === 'silent'
      ? '{"schema":"qbf.reply/1","action":"silent","reason":"user-requested"}' : mode === 'empty' ? '  ' : 'Bare answer' },
      ...(mode === 'tool-call' ? [{ type: 'tool-call', name: 'qbf_reply' }] : [])])
    if (mode === 'attempted') repair.attempted(agent, { requestId: 'real-request', userMessageId: source.id, turn: 7 })
    if (mode === 'revoked') revoke()
    const controller = new AbortController()
    if (mode === 'aborted') controller.abort()
    repair.stopping(agent, mode === 'wrong-turn' ? 8 : 7, controller.signal)
    assert.equal(steering.length, 0, mode)
  }
})

test('sticker selection and collection attempts suppress repair for native and projected call arguments', () => {
  for (const block of [
    { name: 'qbf_sticker_send', arguments: '{}' },
    { name: 'qbf_sticker_manage', arguments: '{"action":"add"}' },
    { name: 'qbf_sticker_manage', arguments: { action: 'add' } },
    { name: 'qbf_sticker_manage', input: { action: 'add' } },
  ]) {
    const { agent, repair, steering } = fixture()
    repair.assistant(agent, 7, [{ type: 'tool-call', ...block }])
    repair.assistant(agent, 7, [{ type: 'text', text: 'A receipt must not turn into a reply' }])
    repair.stopping(agent, 7, new AbortController().signal)
    assert.equal(steering.length, 0, JSON.stringify(block))
  }
  for (const action of ['annotate', 'describe', 'delete']) {
    const { agent, repair, steering } = fixture()
    repair.assistant(agent, 7, [{ type: 'tool-call', name: 'qbf_sticker_manage', arguments: JSON.stringify({ action }) }])
    repair.assistant(agent, 7, [{ type: 'text', text: 'A normal workflow omitted its decision' }])
    repair.stopping(agent, 7, new AbortController().signal)
    assert.equal(steering.length, 1, action)
  }
})


test('private and real direct calls get one reminder for observation silence or an empty completion', () => {
  for (const source of [
    { participation: 'direct', wakes: [], conversationId: 'group:fixture' },
    { participation: 'continuation', wakes: [{ reason: 'direct' }], conversationId: 'group:fixture' },
    { participation: 'direct', wakes: [], conversationId: 'private:fixture' },
  ]) {
    for (const reason of ['not-addressed', 'no-useful-addition', 'empty']) {
      const { agent, repair, steering } = fixture(source.participation, source.wakes, source.conversationId)
      const signal = new AbortController().signal
      repair.assistant(agent, 7, [{ type: 'text', text: reason === 'empty' ? ' ' : JSON.stringify({ schema: 'qbf.reply/1', action: 'silent', reason }) }])
      repair.stopping(agent, 7, signal)
      assert.equal(steering.length, 1, JSON.stringify({ source, reason }))
      assert.match(JSON.stringify(steering[0]), /不能按群聊旁观/)
      repair.stopping(agent, 7, signal)
      assert.equal(steering.length, 1, 'never loops or manufactures a QQ delivery')
    }
    for (const reason of ['user-requested', 'already-answered']) {
      const { agent, repair, steering } = fixture(source.participation, source.wakes, source.conversationId)
      repair.assistant(agent, 7, [{ type: 'text', text: JSON.stringify({ schema: 'qbf.reply/1', action: 'silent', reason }) }])
      repair.stopping(agent, 7, new AbortController().signal)
      assert.equal(steering.length, 0, reason)
    }
  }
})

test('nickname wakes and ordinary group observation do not become mandatory direct calls', () => {
  for (const participation of ['nickname', 'probability', 'continuation', 'ambient']) {
    const { agent, repair, steering } = fixture(participation)
    repair.assistant(agent, 7, [{ type: 'text', text: '{"schema":"qbf.reply/1","action":"silent","reason":"no-useful-addition"}' }])
    repair.stopping(agent, 7, new AbortController().signal)
    assert.equal(steering.length, 0, participation)
  }
})


test('a contact signal consumed into unread facts still gets a bounded direct-processing reminder', () => {
  const { agent, repair, steering } = fixture()
  const message = createUserMessage({ source: { kind: 'user', rpcId: 'unread-request' }, content: [{ type: 'text',
    text: '会话事实：\n' + JSON.stringify({ senderId: 'member', conversationId: 'group:fixture', participation: 'direct',
      groupWake: [], recent: [{ id: 'unread', actor: 'member', text: '之前未处理的问题' }] }) }] })
  repair.claimed(agent, message, 8)
  repair.assistant(agent, 8, [])
  repair.stopping(agent, 8, new AbortController().signal)
  assert.equal(steering.length, 1)
  assert.match(JSON.stringify(steering[0]), /unread-request/)
  assert(!JSON.stringify(steering[0]).includes('之前未处理的问题'), 'no duplicated private message body')
})
