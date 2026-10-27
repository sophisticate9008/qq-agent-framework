import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeDshOutputText } from '../src/adapters/dsh-output-content.ts'
import { createNativeOutputService } from '../src/host/native-output.ts'
import { createNativePackageConfigurationRegistry } from '../src/host/native-package-configuration.ts'
import { DEFAULT_NATIVE_OUTPUT } from '../src/contracts/native-output.ts'
import { createDshAdapter, type DshClientPort, type DshFollowRequest } from '../src/adapters/dsh.ts'
import type { AgentEvent } from '../src/host/types.ts'

const signal = new AbortController().signal
const event = { id: 'long-output', type: 'agent.message', conversationId: 'group:123', data: {} }
const markdown = '# 原文\r\n\r\n```ts\n' + 'const 内容 = "完整🙂";\n'.repeat(600) + '```\n\n**结尾**'

test('a final DSH text longer than 8000 reaches the long-forward planner without changing Markdown or Unicode', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'long-output-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const registry = createNativePackageConfigurationRegistry({ directory })
  const current = await registry.read('chat-output')
  await registry.compareAndSet('chat-output', current.revision, { ...DEFAULT_NATIVE_OUTPUT, longTextAsForward: true, longTextThreshold: 3500 }, signal)
  const output = createNativeOutputService(registry)
  for (const text of [markdown, JSON.stringify({ schema: 'qaf.output/1', content: [{ type: 'text', text: markdown }] })]) {
    const bounded = normalizeDshOutputText([{ type: 'text', text }])
    assert(bounded.length > 1)
    const result = await output.prepare(bounded, event, signal)
    assert.equal(output.split(result, event).length, 1)
    const first = result[0]
    assert(first?.type === 'forward')
    assert.equal(first.nodes.flatMap(node => node.content.map(part => part.type === 'text' ? part.text : '')).join(''), markdown)
    for (const node of first.nodes) {
      const part = node.content[0]
      assert(part?.type === 'text')
      assert(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(part.text))
    }
  }
  assert.deepEqual(normalizeDshOutputText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])
  assert.throws(() => normalizeDshOutputText([{ type: 'text', text: 'x'.repeat(64001) }]), { code: 'DSH_OUTPUT_LIMIT' })
})

test('oversized completed DSH output emits one explicit failure and retains final usage bookkeeping', async () => {
  let followed: DshFollowRequest | undefined
  const port: DshClientPort = {
    async createSession() { return { ok: true, value: { sessionId: 's' } } },
    async prompt() { return { ok: true, value: { queued: true } } },
    async follow(request) { followed = request; return () => {} },
    async cancel() { return { ok: true, value: null } },
  }
  const events: AgentEvent[] = []
  await createDshAdapter(port).follow({ sessionId: 's', signal, onEvent(event) { events.push(event) } })
  assert(followed)
  await followed.onEvent({ type: 'session/event', sessionId: 's', event: { seq: 1, type: 'turn/start', data: { turn: 1 } } })
  await followed.onEvent({ type: 'session/event', sessionId: 's', event: { seq: 2, type: 'assistant/message', data: { turn: 1, step: 1, message: {
    source: { kind: 'model', provider: 'fixture', model: 'model' }, role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(64001) }],
  }, usage: { inputTokens: 10, outputTokens: 20 } } } })
  await followed.onEvent({ type: 'session/event', sessionId: 's', event: { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } })
  assert.deepEqual(events.map(event => event.type), ['failed'])
  assert.equal(events[0]?.data?.code, 'DSH_OUTPUT_LIMIT')
  assert.equal(events[0]?.data?.usageComplete, true)
  assert(Array.isArray(events[0]?.data?.usageSteps))
  assert.equal(events[0]?.data?.usageSteps.length, 1)
})

