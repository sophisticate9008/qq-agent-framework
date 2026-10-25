import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { validateNativeChatAuthorization } from '../src/host/native-chat-configuration.ts'

const grant = { conversationId: 'private:123', submitUses: 2, sendUses: 2, expiresAt: null }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

test('delegation authorization preserves legacy omission and hashes while retaining explicit zero', () => {
  for (const legacy of [grant, ...[0, 2].map(cancelUses => ({ conversationId: grant.conversationId,
    submitUses: grant.submitUses, sendUses: grant.sendUses, cancelUses, expiresAt: null }))]) {
    const original = { version: 'legacy', grants: [legacy] }
    const normalized = validateNativeChatAuthorization(original)
    assert.deepEqual(normalized, original)
    assert.equal(hash(normalized), hash(original))
    assert.equal(Object.hasOwn(normalized.grants[0]!, 'toolDelegationUses'), false)
    const explicit = validateNativeChatAuthorization({ version: 'legacy', grants: [{ ...legacy, toolDelegationUses: 0 }] })
    assert.equal(explicit.grants[0]!.toolDelegationUses, 0)
    assert.notEqual(hash(explicit), hash(original))
  }
})

test('delegation authorization accepts only explicit finite bounded counts independently of submit and cancel', () => {
  for (const toolDelegationUses of [0, 1, 1_000_000]) {
    const result = validateNativeChatAuthorization({ version: 'explicit', grants: [{ ...grant, cancelUses: 0, toolDelegationUses }] })
    assert.equal(result.grants[0]!.toolDelegationUses, toolDelegationUses)
    assert.equal(result.grants[0]!.cancelUses, 0)
    assert(Object.isFrozen(result.grants[0]))
  }
  for (const toolDelegationUses of [undefined, null, -1, 1.5, 1_000_001, Infinity, NaN, '1', true]) {
    assert.throws(() => validateNativeChatAuthorization({ version: 'invalid', grants: [{ ...grant, toolDelegationUses }] }), TypeError)
  }
  assert.throws(() => validateNativeChatAuthorization({ version: 'invalid', grants: [{ ...grant, delegateUses: 1 }] }), TypeError)
})
