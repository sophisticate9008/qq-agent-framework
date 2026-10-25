import assert from 'node:assert/strict'
import test from 'node:test'
import { createClaimReceiptJournal, RECEIPT_LIMITS } from '../dist/receipts.js'

test('bounded paged receipts separate sessions, reject stale epochs and signal cursor gaps', () => {
  let time = 1
  const journal = createClaimReceiptJournal(() => time)
  const record = (requestId: string, sessionId = 'group-session') => journal.record({ sessionId, requestId, userMessageId: `message-${requestId}`, turn: 3 })
  record('request-a')
  record('request-private', 'private-session')
  record('request-steer')
  const first = journal.read({ sessionId: 'group-session', limit: 1 })
  assert(first.state === 'page')
  assert.equal(first.hasMore, true)
  assert.equal(first.coverage, 'retained-window-only')
  assert.equal(first.receipts[0]?.requestId, 'request-a')
  const next = journal.read({ sessionId: 'group-session', issuerEpoch: first.issuerEpoch, after: first.nextAfter })
  assert.deepEqual(next.receipts.map(receipt => receipt.requestId), ['request-steer'])
  assert.equal(next.absenceProven, false)
  assert.equal(next.nextAfter, 3)
  record('request-steer')
  assert.equal(journal.read({ sessionId: 'group-session' }).head, 3)
  assert.equal(journal.read({ sessionId: 'group-session', issuerEpoch: createClaimReceiptJournal().issuerEpoch, after: 0 }).state, 'unknown-epoch')
  time += RECEIPT_LIMITS.maxAgeMs
  assert.equal(journal.read({ sessionId: 'group-session', issuerEpoch: first.issuerEpoch, after: 0 }).state, 'cursor-gap')
  assert.throws(() => journal.read({ sessionId: 'group-session', after: 0 }))
  assert.throws(() => journal.read({ sessionId: 'group-session', limit: 129 }))
  assert.throws(() => journal.read({ sessionId: 'group-session', issuerEpoch: 'bad', after: NaN }))
  assert.equal(journal.read({ sessionId: 'private-session' }).receipts.length, 0)
})

test('count retention is finite and no arbitrary claim fields enter receipts', () => {
  const journal = createClaimReceiptJournal(() => 1)
  for (let index = 0; index <= RECEIPT_LIMITS.maxReceipts; index++) {
    const input = { sessionId: 'session', requestId: `request-${index}`, userMessageId: `message-${index}`, turn: index,
      content: 'PRIVATE-CONTENT', key: 'PRIVATE-KEY', principal: 'PRIVATE-PRINCIPAL' }
    journal.record(input)
  }
  const page = journal.read({ sessionId: 'session' })
  assert.equal(page.oldestAvailableAfter, 1)
  assert(!JSON.stringify(page).includes('PRIVATE-'))
  assert.equal(journal.read({ sessionId: 'session', issuerEpoch: page.issuerEpoch, after: 0 }).state, 'cursor-gap')
  journal.record({ sessionId: 'session', requestId: 'bad', userMessageId: 'message', turn: -1 })
  assert.equal(journal.read({ sessionId: 'session' }).head, RECEIPT_LIMITS.maxReceipts + 1)
})
