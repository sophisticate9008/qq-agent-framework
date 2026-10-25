import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNativePackageConfigurationRegistry } from '../src/host/native-package-configuration.ts'
import { createNativeOutputService } from '../src/host/native-output.ts'
import { DEFAULT_NATIVE_OUTPUT } from '../src/contracts/native-output.ts'

const event = { id: 'output-1', type: 'agent.message', conversationId: 'private:123', data: {} }
const signal = new AbortController().signal

test('output package reads live CAS configuration and plans complete messages without acquiring send authority', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'native-output-')); context.after(() => rm(directory, { recursive: true, force: true }))
  const registry = createNativePackageConfigurationRegistry({ directory }); const output = createNativeOutputService(registry)
  const text = [{ type: 'text' as const, text: '第一段\n\n第二段' }]
  assert.equal(output.split(await output.prepare(text, event, signal), event).length, 2)
  const current = await registry.read('chat-output')
  await registry.compareAndSet('chat-output', current.revision, { ...DEFAULT_NATIVE_OUTPUT, bubbles: false }, signal)
  assert.equal(output.split(await output.prepare(text, event, signal), event).length, 1)
  assert.throws(() => output.split(text, event), { code: 'NATIVE_OUTPUT_UNPREPARED' })
  assert(!Object.hasOwn(output, 'send')); assert(!Object.hasOwn(output, 'grant'))
})

test('output refuses malformed control envelopes, arbitrary paths, sender impersonation and unsupported forward references', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'native-output-invalid-')); context.after(() => rm(directory, { recursive: true, force: true }))
  const output = createNativeOutputService(createNativePackageConfigurationRegistry({ directory }))
  for (const content of [[{ type: 'image', url: 'https://example.test/private' }],
    [{ type: 'audio', file: '/root/private' }], [{ type: 'forward-reference', assetId: 'unread' }],
    [{ type: 'forward', nodes: [{ senderId: 'someone-else', content: [{ type: 'text', text: 'spoof' }] }] }]]) {
    await assert.rejects(output.prepare([{ type: 'text', text: JSON.stringify({ schema: 'qaf.output/1', content }) }], event, signal))
  }
  await assert.rejects(output.prepare([{ type: 'text', text: '{"schema":"qaf.output/1",' }], event, signal))
})

test('disabled media and excessive delivery count are rejected before any partial output plan', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'native-output-disabled-')); context.after(() => rm(directory, { recursive: true, force: true }))
  const registry = createNativePackageConfigurationRegistry({ directory }); const output = createNativeOutputService(registry)
  const current = await registry.read('chat-output')
  await registry.compareAndSet('chat-output', current.revision, { ...DEFAULT_NATIVE_OUTPUT, media: false }, signal)
  await assert.rejects(output.prepare([{ type: 'image', assetId: 'registered' }], event, signal), { code: 'NATIVE_OUTPUT_MEDIA_DISABLED' })
  const saved = await registry.read('chat-output')
  await registry.compareAndSet('chat-output', saved.revision, DEFAULT_NATIVE_OUTPUT, signal)
  await assert.rejects(output.prepare(Array.from({ length: 5 }, (_, i) => ({ type: 'file', assetId: `file-${i}`, name: 'file.txt' })), event, signal),
    { code: 'NATIVE_OUTPUT_LIMIT' })
  assert.throws(() => output.split([{ type: 'text', text: 'ignored' }], event), { code: 'NATIVE_OUTPUT_UNPREPARED' })
})
