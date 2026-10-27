import test from 'node:test'
import assert from 'node:assert/strict'
import { readWorkProgress, validWorkProgress } from '../packages/dsh-bridge-plugin/src/work-progress.ts'
import { isDshWorkProgress } from '../src/contracts/dsh-work.ts'

function message(seq: number, text: string, tool = true) {
  return { type: 'assistant/message', seq, time: seq * 100, data: { turn: 1, step: seq,
    message: { role: 'assistant', source: { kind: 'model' }, content: [
      { type: 'reasoning', text: 'private reasoning must not leave the child' }, { type: 'text', text },
      ...(tool ? [{ type: 'tool-call', name: 'bash', arguments: 'private tool arguments' }] : [])
    ] } } }
}

test('work progress carries settled public text and excludes reasoning, tool payload and final answer', () => {
  const events = [message(1, '正在读取文件。'), { type: 'tool/result', seq: 2, data: { content: 'raw log' } },
    message(3, '核对了列格式。'), message(4, '最终结果。', false)]
  const progress = readWorkProgress(events)
  assert.deepEqual(progress.map(row => row.text), ['正在读取文件。', '核对了列格式。'])
  assert.deepEqual(progress.map(row => row.id), ['assistant/message:seq:1', 'assistant/message:seq:3'])
  assert(validWorkProgress(progress) && isDshWorkProgress(progress))
  assert.deepEqual(readWorkProgress([...events, { type: 'turn/end', data: { turn: 1 } }]), progress)
})

test('work progress excludes explicitly non-public assistant messages', () => {
  const original = message(1, 'analysis text must not leave the child')
  for (const key of ['visibility', 'channel']) {
    const hiddenData = { ...original, data: { ...original.data, [key]: 'analysis' } }
    const hiddenMessage = { ...original, data: { ...original.data,
      message: { ...original.data.message, [key]: 'analysis' } } }
    assert.deepEqual(readWorkProgress([hiddenData]), [])
    assert.deepEqual(readWorkProgress([hiddenMessage]), [])
  }
})

test('work progress is bounded by text and records and validates identically across the RPC boundary', () => {
  const progress = readWorkProgress(Array.from({ length: 12 }, (_, index) => message(index + 1, 'x'.repeat(1500))))
  assert(progress.length <= 8)
  assert.equal(progress.reduce((sum, row) => sum + row.text.length, 0), 8000)
  assert.equal(progress.at(-1)?.id, 'assistant/message:seq:12')
  for (const invalid of [[...progress, progress[0]], [{ id: 'forged', at: 1, text: 'x' }],
    [{ id: 'assistant/message:seq:1', at: 1, text: 'x'.repeat(8001) }]]) {
    assert.equal(validWorkProgress(invalid), false)
    assert.equal(isDshWorkProgress(invalid), false)
  }
  assert.deepEqual(readWorkProgress([{ ...message(1, 'forged'), data: { ...message(1, 'forged').data,
    message: { ...message(1, 'forged').data.message, role: 'user' } } }]), [])
})
