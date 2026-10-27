import assert from 'node:assert/strict'
import test from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { createWorkChannel, type WorkStart } from '../dist/work.js'
import { workFingerprint } from '../dist/work-journal.js'

const request: WorkStart = { issuerEpoch: 'epoch', id: 'operation', parentSessionId: 'parent', childId: 'child',
  generation: 1, modelProvider: 'provider', model: 'model', agentPreset: 'assistant', fullAccess: true,
  task: 'Owner task', context: '', timeoutMs: 1000 }

function fixture(options: { parent?: string; permissionService?: boolean; fullAccess?: boolean } = {}) {
  const parent = { id: 'parent', session: { id: 'parent' } } as unknown as Agent
  const child = { id: 'child', session: { id: 'child', header: { origin: 'subagent', parentSession: options.parent ?? 'parent' } },
    options: { provider: 'provider', model: 'model' } } as unknown as Agent
  const applied: Agent[] = []
  let firstTurn = false
  const runtime = { getProvider: () => ({ prepareContinuable() {}, inheritsParentContext: false,
    capabilities: { agentOptions: true, agentPreset: true } }), async startActivation() {
    channel.admitCreatedChild(child)
    if (options.fullAccess !== false) assert.deepEqual(applied, [child], 'permission must be applied before the first turn')
    firstTurn = true
    return { childId: 'child', result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'result' }] }), async dispose() {} }
  } } as unknown as SubagentRuntime
  const channel = createWorkChannel({ issuerEpoch: 'epoch', getAgent: id => id === 'parent' ? parent : id === 'child' ? child : undefined,
    runtime: () => runtime, hasPreset: async () => true, continuationAvailable: () => true,
    fullAccessAvailable: () => options.permissionService !== false,
    applyFullAccess: agent => { applied.push(agent) } })
  return { channel, child, parent, applied, firstTurn: () => firstTurn }
}

test('only a reserved work child receives full access at the serial creation barrier before its first turn', async () => {
  const data = fixture()
  try {
    data.channel.admitCreatedChild(data.parent)
    data.channel.admitCreatedChild(data.child)
    assert.equal(data.applied.length, 0, 'an unreserved child and the ordinary parent have no grant')
    const result = await data.channel.start(request, new AbortController().signal)
    assert.equal(result.fullAccess, true)
    assert.equal(data.firstTurn(), true)
    assert.deepEqual(data.applied, [data.child])
  } finally { await data.channel.close() }
})

test('mismatched real parent fails before the first turn and never grants permissions', async () => {
  const data = fixture({ parent: 'another-parent' })
  try {
    assert.equal((await data.channel.start(request, new AbortController().signal)).state, 'unknown')
    assert.equal(data.firstTurn(), false)
    assert.equal(data.applied.length, 0)
  } finally { await data.channel.close() }
})

test('missing permission service rejects full access; ordinary work retains its original permission scope', async () => {
  const absent = fixture({ permissionService: false })
  const ordinary = fixture({ fullAccess: false })
  try {
    assert.equal((await absent.channel.verify(request)).available, false)
    await assert.rejects(absent.channel.start(request, new AbortController().signal))
    assert.equal(absent.firstTurn(), false)
    assert.equal((await ordinary.channel.start({ ...request, fullAccess: false }, new AbortController().signal)).fullAccess, false)
    assert.equal(ordinary.applied.length, 0)
    assert.notEqual(workFingerprint(request), workFingerprint({ ...request, fullAccess: false }))
  } finally { await absent.channel.close(); await ordinary.channel.close() }
})
