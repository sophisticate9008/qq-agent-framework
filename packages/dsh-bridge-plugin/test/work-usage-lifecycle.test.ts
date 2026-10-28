import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { createWorkChannel, type WorkStart } from '../dist/work.js'
import { createWorkJournal } from '../dist/work-journal.js'

test('SDK registry detaches before subagent/end: exact disposed child usage is persisted and survives completed polling and reload', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'work-disposed-usage-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const journal = createWorkJournal(directory)
  const request: WorkStart = { issuerEpoch: 'epoch', id: 'owned-work', parentSessionId: 'parent', childId: 'child',
    generation: 1, modelProvider: 'provider', model: 'model', agentPreset: 'assistant', fullAccess: true,
    task: 'Owner task', context: '', timeoutMs: 2000 }
  const events = [{ type: 'assistant/message', seq: 16, time: 1000, data: { turn: 1, step: 1,
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, totalTokens: 170 },
    message: { source: { kind: 'model', provider: 'actual-provider', model: 'actual-model' } } } },
  { type: 'turn/end', seq: 17, time: 1001, data: { turn: 1, reason: { kind: 'completed' } } }]
  const parent = { id: 'parent', session: { id: 'parent' } } as unknown as Agent
  const child = { id: 'child', session: { id: 'child', header: { origin: 'subagent', parentSession: 'parent' },
    snapshotEvents: () => events }, options: { provider: 'provider', model: 'model' } } as unknown as Agent
  let resident = true
  let finish!: (value: { stopReason: string; output: readonly { type: 'text'; text: string }[] }) => void
  const result = new Promise<{ stopReason: string; output: readonly { type: 'text'; text: string }[] }>(resolve => { finish = resolve })
  const runtime = { getProvider: () => ({ prepareContinuable() {}, inheritsParentContext: false,
    capabilities: { agentOptions: true, agentPreset: true } }), async startActivation() {
    channel.admitCreatedChild(child)
    return { childId: 'child', result, async dispose() {} }
  } } as unknown as SubagentRuntime
  const options = { issuerEpoch: 'epoch', journal, getAgent: (id: string) => id === 'parent' ? parent : id === 'child' && resident ? child : undefined,
    runtime: () => runtime, hasPreset: async () => true, continuationAvailable: () => true,
    fullAccessAvailable: () => true, applyFullAccess: () => {} }
  const channel = createWorkChannel(options)
  try {
    await channel.start(request, new AbortController().signal)
    resident = false
    const wrong = { ...child, session: { ...child.session, header: { origin: 'subagent', parentSession: 'another-parent' } } } as unknown as Agent
    channel.recordDisposedChild(wrong)
    const unrelated = await channel.inspect(request)
    assert(unrelated.state !== 'unknown')
    assert.equal(unrelated.usage.length, 0)
    channel.recordDisposedChild(child)
    channel.recordEnd({ id: 'child', stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'Done' }] })
    finish({ stopReason: 'completed', output: [{ type: 'text', text: 'Done' }] })
    const observed = await channel.inspect(request)
    assert.equal(observed.state, 'completed')
    assert.equal(observed.usage.length, 1)
    assert.deepEqual(observed.usage[0]?.usage, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 0, totalTokens: 170 })
    assert.deepEqual((await journal.read(request.id))?.usage, observed.usage)
    const restored = createWorkChannel(options)
    try {
      const reloaded = await restored.inspect(request)
      assert.equal(reloaded.state, 'completed')
      assert.deepEqual(reloaded.usage, observed.usage)
    } finally { await restored.close() }
  } finally { await channel.close() }
})
