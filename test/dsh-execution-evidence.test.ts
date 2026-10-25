import assert from 'node:assert/strict'
import test from 'node:test'
import { readDshExecutionEvidence } from '../src/adapters/dsh-execution-evidence.ts'
import { DSH_EXECUTION_EVIDENCE_PROTOCOL } from '../src/contracts/dsh-execution-evidence.ts'

const request = { sessionId: 'session-a', requestId: 'request-a', userMessageId: 'message-a', turn: 2 }
const settled = { ...request, schema: 1, protocol: DSH_EXECUTION_EVIDENCE_PROTOCOL, issuerEpoch: 'epoch-a', state: 'settled',
  matchedUserMessageId: 'message-a', matchedTurn: 2, outcome: 'completed', userSequence: 3, terminalSequence: 8,
  checkpointSequence: 9, checkpointHash: 'a'.repeat(64), quiescent: true, missingReasons: [] }
const read = (value: unknown) => readDshExecutionEvidence(request, 'epoch-a', new AbortController().signal, async () => value)

test('execution checkpoint codec accepts only exact scoped durable terminal proof', async () => {
  assert.deepEqual(await read(settled), settled)
  for (const invalid of [
    { ...settled, issuerEpoch: 'other-epoch' }, { ...settled, sessionId: 'other-session' },
    { ...settled, requestId: 'other-request' }, { ...settled, matchedUserMessageId: 'other-message' },
    { ...settled, matchedTurn: 3 }, { ...settled, checkpointHash: 'not-a-hash' },
    { ...settled, terminalSequence: 10 }, { ...settled, userSequence: 8 },
    { ...settled, quiescent: false }, { ...settled, outcome: 'interrupted' },
    { ...settled, state: 'pending' }, { ...settled, content: 'private session text' },
    { ...settled, missingReasons: ['execution_request_not_observed'] },
  ]) await assert.rejects(read(invalid), { code: 'DSH_EXECUTION_EVIDENCE_INVALID' })
})

test('absence is a bounded diagnostic and never a terminal receipt', async () => {
  const absent = { ...settled, state: 'not-observed', matchedUserMessageId: null, matchedTurn: null, outcome: null,
    userSequence: null, terminalSequence: null, checkpointSequence: null, checkpointHash: null,
    missingReasons: ['execution_request_not_observed'] }
  assert.deepEqual(await read(absent), absent)
  await assert.rejects(read({ ...absent, checkpointHash: settled.checkpointHash }), { code: 'DSH_EXECUTION_EVIDENCE_INVALID' })
  await assert.rejects(read({ ...absent, missingReasons: ['raw private error text'] }), { code: 'DSH_EXECUTION_EVIDENCE_INVALID' })
})
