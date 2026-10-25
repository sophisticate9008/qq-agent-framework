import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { ACCESS_COMMAND_REPLIES, createAccessCommandHandler, parseAccessCommand } from '../src/features/access-commands.ts'
import type { MessageContent, DeliveryReceipt } from '../src/core/types.ts'
import type { NativeChatAccess } from '../src/host/native-chat-configuration.ts'
import type { InboundMessage } from '../src/host/types.ts'

function message(content: string | readonly MessageContent[], changes: Partial<InboundMessage> = {}): InboundMessage {
  return { id: 'message-1', conversationId: 'group:30001', userId: '10001', receivedAt: 1234,
    content: typeof content === 'string' ? [{ type: 'text', text: content }] : content, directed: false, isSelf: false, ...changes }
}

const document = Object.freeze({ revision: 'access-v1', value: Object.freeze({ owner: '10001',
  allow: Object.freeze(['private:20001']), deny: Object.freeze(['group:40001']) }) satisfies NativeChatAccess })
type ChangeRequest = Parameters<Parameters<typeof createAccessCommandHandler>[0]['change']>[0]
const signal = new AbortController().signal

function fixture(options: { owner?: string | null; state?: 'applied' | 'unchanged'; error?: string; receipt?: DeliveryReceipt } = {}) {
  const calls: ChangeRequest[] = []
  const texts: string[] = []
  let reads = 0
  const current = { ...document, value: { ...document.value, owner: options.owner === undefined ? '10001' : options.owner } }
  const handler = createAccessCommandHandler({
    async readAccess(receivedSignal) { assert.equal(receivedSignal, signal); reads++; return current },
    async change(request, receivedSignal) {
      assert.equal(receivedSignal, signal)
      calls.push(request)
      if (options.error) throw Object.assign(new Error('RAW-ERROR-CANARY'), { code: options.error,
        ...(options.error === 'APPLIED_RELOAD_REQUIRED' ? { saved: current, sourceId: request.sourceId } : {}) })
      return { state: options.state ?? 'applied', document: current, sourceId: request.sourceId }
    },
  })
  const reply = async (text: string): Promise<DeliveryReceipt> => {
    assert(ACCESS_COMMAND_REPLIES.includes(text))
    texts.push(text)
    return options.receipt ?? { status: 'confirmed', messageId: 'reply-1' }
  }
  return { calls, texts, handler, reply, reads: () => reads }
}

test('group commands only target the actual current group', () => {
  assert.deepEqual(parseAccessCommand(message('/添加群白名单')), { kind: 'group', operation: 'add', targetId: '30001' })
  assert.deepEqual(parseAccessCommand(message('  /取消群白名单  ')), { kind: 'group', operation: 'remove', targetId: '30001' })
  for (const conversationId of ['private:30001', 'group:0', 'group:001', 'unknown']) {
    assert.equal(parseAccessCommand(message('/添加群白名单', { conversationId }))?.targetId, null)
  }
  assert.equal(parseAccessCommand(message('/添加群白名单 40001'))?.targetId, null)
})

test('private targets accept one numeric account with matching English or Chinese parentheses', () => {
  for (const target of ['20001', ' 20001 ', '(20001)', '（ 20001 ）', '( 20001 )', '99999999999999999999']) {
    assert.deepEqual(parseAccessCommand(message(`/添加私聊白名单 ${target}`)), {
      kind: 'private', operation: 'add', targetId: target.includes('9999') ? target : '20001',
    })
  }
  assert.deepEqual(parseAccessCommand(message('/取消私聊白名单（20001）', { conversationId: 'private:90001' })), {
    kind: 'private', operation: 'remove', targetId: '20001',
  })
})

test('a real mention is a target but textual @, all, multiple or malformed targets are invalid', () => {
  assert.deepEqual(parseAccessCommand(message([{ type: 'text', text: '/添加私聊白名单 （ ' },
    { type: 'mention', userId: '20001' }, { type: 'text', text: ' ）' }])), { kind: 'private', operation: 'add', targetId: '20001' })
  for (const target of ['', '@20001', '20001 20002', '20001,20002', '(20001）', '((20001))', '0', '020001',
    '100000000000000000000', '20001 owner=10001', '[CQ:at,qq=20001]']) {
    assert.equal(parseAccessCommand(message(`/添加私聊白名单 ${target}`))?.targetId, null)
  }
  for (const mentions of [['20001', '20002'], ['20001', '20001'], ['all']]) {
    assert.equal(parseAccessCommand(message([{ type: 'text', text: '/添加私聊白名单 ' },
      ...mentions.map(userId => ({ type: 'mention' as const, userId }))]))?.targetId, null)
  }
})

test('only leading actual text can command and reply pointers never expand source messages', () => {
  for (const content of ['普通聊天 /添加群白名单', '> /添加群白名单', '引用：/添加群白名单', '添加群白名单', '/其他命令']) {
    assert.equal(parseAccessCommand(message(content)), null)
  }
  assert.equal(parseAccessCommand(message([{ type: 'image', assetId: 'image-1' }, { type: 'text', text: '/添加群白名单' }])), null)
  assert.equal(parseAccessCommand(message([{ type: 'mention', userId: '10001' }, { type: 'text', text: '/添加群白名单' }])), null)
  assert.equal(parseAccessCommand(message([{ type: 'forward', nodes: [{ content: [{ type: 'text', text: '/添加群白名单' }] }] }])), null)
  assert.equal(parseAccessCommand(message([{ type: 'text', text: '/添加群白名单' },
    { type: 'forward', nodes: [{ content: [{ type: 'text', text: '40001' }] }] }])), null)
  assert.deepEqual(parseAccessCommand(message([{ type: 'reply', messageId: '/添加私聊白名单 40001' },
    { type: 'text', text: '/添加群白名单' }])), { kind: 'group', operation: 'add', targetId: '30001' })
  assert.equal(parseAccessCommand(message([{ type: 'reply', messageId: '/添加群白名单' }])), null)
})

test('owner handler forwards exact actor, current revision and scope-bound stable source digest without mutating access', async () => {
  const current = fixture()
  const input = message('/添加群白名单')
  await current.handler(input, current.reply, signal)
  assert.deepEqual(current.calls, [{ actorId: '10001', expectedRevision: 'access-v1', kind: 'group', targetId: '30001', operation: 'add',
    sourceId: createHash('sha256').update(JSON.stringify(['group:30001', 'message-1', 'access-command'])).digest('hex') }])
  assert.equal(current.reads(), 1)
  assert.deepEqual(current.texts, ['白名单已更新。'])
  assert.deepEqual(document.value.allow, ['private:20001'])
  assert.deepEqual(document.value.deny, ['group:40001'])
  const otherScope = fixture()
  await otherScope.handler(message('/添加私聊白名单 20001', { conversationId: 'private:30001' }), otherScope.reply, signal)
  assert.notEqual(current.calls[0]!.sourceId, otherScope.calls[0]!.sourceId)
})

test('unconfigured owner, different exact account and self messages cannot change access', async () => {
  for (const entry of [{ owner: null, userId: '10001', isSelf: false }, { owner: '10001', userId: '100010', isSelf: false },
    { owner: '10001', userId: '10001', isSelf: true }]) {
    const current = fixture({ owner: entry.owner })
    await current.handler(message('/添加群白名单', { userId: entry.userId, isSelf: entry.isSelf }), current.reply, signal)
    assert.equal(current.calls.length, 0)
    assert.deepEqual(current.texts, ['只有配置的主人可以管理白名单。'])
  }
})

test('recognized invalid commands reply usage once without changing access', async () => {
  for (const input of [message('/添加群白名单', { conversationId: 'private:30001' }), message('/添加私聊白名单 20001 20002')]) {
    const current = fixture()
    await current.handler(input, current.reply, signal)
    assert.equal(current.calls.length, 0)
    assert.equal(current.texts.length, 1)
  }
  const ordinary = fixture()
  await ordinary.handler(message('普通聊天'), ordinary.reply, signal)
  assert.equal(ordinary.reads(), 0)
  assert.equal(ordinary.calls.length, 0)
  assert.equal(ordinary.texts.length, 0)
})

test('no-op still goes through the service owner and revision gate, without local quota or policy work', async () => {
  const current = fixture({ state: 'unchanged' })
  await current.handler(message('/添加私聊白名单 20001'), current.reply, signal)
  assert.equal(current.calls.length, 1)
  assert.deepEqual(current.texts, ['白名单无需更改。'])
})

test('stable service error codes map only to fixed conflict, denial, unknown and saved-reload replies', async () => {
  for (const [code, expected] of [
    ['ACCESS_OWNER_REQUIRED', '只有配置的主人可以管理白名单。'],
    ['ACCESS_REVISION_CONFLICT', '白名单状态已变化或正在更新，本次未修改，请稍后再试。'],
    ['ACCESS_SERVICE_BUSY', '白名单状态已变化或正在更新，本次未修改，请稍后再试。'],
    ['ACCESS_DENIED', '该会话在拒绝名单中，本次未修改。'],
    ['ACCESS_TARGET_DENIED', '该会话在拒绝名单中，本次未修改。'],
    ['ACCESS_LIMIT_EXCEEDED', '白名单已达到上限，本次未修改。'],
    ['ACCESS_INVALID_REQUEST', '白名单请求无效，本次未修改。'],
    ['ACCESS_CHANGE_UNKNOWN', '本次白名单操作结果未能确认，请先查看状态，勿重复提交。'],
    ['OTHER_ERROR', '本次白名单操作结果未能确认，请先查看状态，勿重复提交。'],
    ['APPLIED_RELOAD_REQUIRED', '白名单已保存，当前聊天需重新加载后生效。'],
  ]) {
    const current = fixture({ error: code })
    await current.handler(message('/添加群白名单'), current.reply, signal)
    assert.equal(current.calls.length, 1)
    assert.deepEqual(current.texts, [expected])
    assert.equal(current.texts[0]!.includes('RAW-ERROR-CANARY'), false)
  }
})

test('read failure never changes configuration and wrong-source receipts stay unknown', async () => {
  const texts: string[] = []
  let changes = 0
  const failedRead = createAccessCommandHandler({ async readAccess() { throw new Error('PRIVATE-READ-ERROR') },
    async change(request) { changes++; return { state: 'applied', document, sourceId: request.sourceId } } })
  const reply = async (text: string): Promise<DeliveryReceipt> => { texts.push(text); return { status: 'confirmed', messageId: 'reply' } }
  await failedRead(message('/添加群白名单'), reply, signal)
  assert.equal(changes, 0)
  const mismatched = createAccessCommandHandler({ async readAccess() { return document },
    async change() { return { state: 'applied', document, sourceId: 'wrong-source' } } })
  await mismatched(message('/添加群白名单'), reply, signal)
  assert.deepEqual(texts, Array(2).fill('本次白名单操作结果未能确认，请先查看状态，勿重复提交。'))
})

test('unknown or rejected reply is not retried and cancellation before handling performs no reads or changes', async () => {
  for (const status of ['unknown', 'rejected'] as const) {
    const current = fixture({ receipt: { status } })
    await current.handler(message('/添加群白名单'), current.reply, signal)
    assert.equal(current.calls.length, 1)
    assert.equal(current.texts.length, 1)
  }
  const aborted = new AbortController()
  aborted.abort()
  const current = fixture()
  await assert.rejects(current.handler(message('/添加群白名单'), current.reply, aborted.signal))
  assert.equal(current.reads(), 0)
  assert.equal(current.calls.length, 0)
  assert.equal(current.texts.length, 0)
  assert(Object.isFrozen(ACCESS_COMMAND_REPLIES))
})
