import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNativePackageConfigurationRegistry } from '../src/host/native-package-configuration.ts'
import { createNativeOutputService, NATIVE_OUTPUT_CONFIGURATION } from '../src/host/native-output.ts'
import { DEFAULT_NATIVE_OUTPUT, validateNativeOutputConfiguration } from '../src/contracts/native-output.ts'
import { packageConfigurationChanges, packageConfigurationDraft } from '../web/lib/package-configuration-ui.ts'
import { isRecord } from '../src/core/values.ts'

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

test('stored legacy media false is ignored and removed from model facts, UI controls and subsequent saves', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'native-output-legacy-')); context.after(() => rm(directory, { recursive: true, force: true }))
  const filename = join(directory, 'package-chat-output.configuration.json')
  await writeFile(filename, JSON.stringify({ schema: 1, id: 'chat-output', schemaVersion: 1,
    configuration: { ...DEFAULT_NATIVE_OUTPUT, media: false } }), { mode: 0o600 })
  const registry = createNativePackageConfigurationRegistry({ directory }); const output = createNativeOutputService(registry)
  const current = await registry.read('chat-output')
  assert.deepEqual(current.configuration, DEFAULT_NATIVE_OUTPUT)
  assert.equal(Object.hasOwn(await output.context(signal), 'media'), false)
  const legacyImage = [{ type: 'image' as const, assetId: 'registered-image' }]
  assert.deepEqual(output.split(await output.prepare(legacyImage, event, signal), event), [legacyImage])
  const descriptor = NATIVE_OUTPUT_CONFIGURATION.descriptor
  assert.equal(descriptor.fields.some(field => field.id === 'media' || field.path.includes('media')), false)
  const draft = packageConfigurationDraft(descriptor, current.configuration)
  assert(draft)
  const changed = packageConfigurationChanges(descriptor, current.configuration, { ...draft, bubbles: false })
  const saved = await registry.compareAndSet('chat-output', current.revision, changed, signal)
  assert(isRecord(saved.configuration))
  assert.equal(Object.hasOwn(saved.configuration, 'media'), false)
  const stored: unknown = JSON.parse(await readFile(filename, 'utf8'))
  assert(isRecord(stored) && isRecord(stored.configuration))
  assert.equal(Object.hasOwn(stored.configuration, 'media'), false)
  for (const part of [{ type: 'image' as const, assetId: 'registered-image' },
    { type: 'audio' as const, assetId: 'registered-audio' }, { type: 'file' as const, assetId: 'registered-file', name: 'report.txt' }]) {
    assert.deepEqual(output.split(await output.prepare([part], event, signal), event), [[part]])
  }
  const ordinary = [{ type: 'reply' as const, messageId: '123' }, { type: 'mention' as const, userId: '456' }, { type: 'face' as const, id: '14' }]
  assert.deepEqual(output.split(await output.prepare(ordinary, event, signal), event), [ordinary])
  const forward = [{ type: 'forward' as const, nodes: [{ content: [{ type: 'image' as const, assetId: 'registered-image' }] }] }]
  assert.deepEqual(output.split(await output.prepare(forward, event, signal), event), [forward])
  assert.deepEqual(validateNativeOutputConfiguration({ ...DEFAULT_NATIVE_OUTPUT, media: true }), DEFAULT_NATIVE_OUTPUT)
  assert.throws(() => validateNativeOutputConfiguration({ ...DEFAULT_NATIVE_OUTPUT, media: 'false' }))
  assert.throws(() => validateNativeOutputConfiguration({ ...DEFAULT_NATIVE_OUTPUT, arbitrary: true }))
})

test('excessive delivery count is rejected before any partial output plan', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'native-output-limit-')); context.after(() => rm(directory, { recursive: true, force: true }))
  const output = createNativeOutputService(createNativePackageConfigurationRegistry({ directory }))
  await assert.rejects(output.prepare(Array.from({ length: 5 }, (_, i) => ({ type: 'file', assetId: `file-${i}`, name: 'file.txt' })), event, signal),
    { code: 'NATIVE_OUTPUT_LIMIT' })
  assert.throws(() => output.split([{ type: 'text', text: 'ignored' }], event), { code: 'NATIVE_OUTPUT_UNPREPARED' })
})

test('explicit and obvious Markdown become scoped PNG content while long plain text retains forward planning', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'native-output-markdown-')); context.after(() => rm(directory, { recursive: true, force: true }))
  const registry = createNativePackageConfigurationRegistry({ directory })
  const rendered: { body: string; title?: string }[] = []
  const output = createNativeOutputService(registry, { async renderMarkdown(request) {
    assert.equal(request.event, event); assert.equal(request.signal, signal)
    rendered.push(request)
    return [{ type: 'image', assetId: 'scoped-generated-png' }]
  } })
  const current = await registry.read('chat-output')
  await registry.compareAndSet('chat-output', current.revision, { ...DEFAULT_NATIVE_OUTPUT, longTextAsForward: true, longTextThreshold: 500 }, signal)
  const envelope = { schema: 'qaf.output/1', format: 'markdown-image', body: '# 报告\n\n内容', title: '实际标题' }
  assert.deepEqual(await output.prepare([{ type: 'text', text: JSON.stringify(envelope) }], event, signal), [{ type: 'image', assetId: 'scoped-generated-png' }])
  assert.equal(rendered[0]?.title, '实际标题')
  for (const text of ['# 标题\n正文', '名称 | 数量\n--- | ---\n甲 | 2', '```ts\nconst x = 1\n```']) {
    assert.equal((await output.prepare([{ type: 'text', text }], event, signal))[0]?.type, 'image')
  }
  assert.equal(rendered.length, 4)
  assert.equal((await output.prepare([{ type: 'text', text: '这是一段纯文本。'.repeat(100) }], event, signal))[0]?.type, 'forward')
  assert.equal(rendered.length, 4)
  assert.equal((await output.context(signal)).markdownImageSupported, true)
  await assert.rejects(output.prepare([{ type: 'text', text: JSON.stringify({ ...envelope, path: '/tmp/private' }) }], event, signal), { code: 'NATIVE_OUTPUT_INVALID' })
})
