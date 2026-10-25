import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AdminRequestError } from '../src/admin/errors.ts'
import { readPrivateJson, replacePrivateJson } from '../src/admin/private-json-storage.ts'

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

for (const stage of ['candidate', 'revision', 'readback'] as const) {
  test(`private JSON replacement preserves commit classification at ${stage}`, async context => {
    const directory = await mkdtemp(join(tmpdir(), 'private-json-stage-'))
    context.after(() => rm(directory, { recursive: true, force: true }))
    const filename = join(directory, 'configuration.json')
    const temporary = join(directory, 'candidate.tmp')
    await writeFile(filename, '{"value":"old"}\n', { mode: 0o600 })
    const read = () => readPrivateJson(filename, { maxBytes: 1_024, validate: object,
      invalidCode: 'private_invalid', conflictCode: 'private_conflict' })
    const before = await read()
    let reads = 0
    const operation = replacePrivateJson({ directory, filename, temporary, expectedRevision: before.revision,
      content: Buffer.from('{"value":"new"}\n'), conflictCode: 'private_conflict',
      writeFailedCode: 'private_write_failed', writeUnknownCode: 'private_write_unknown',
      beforeRevisionCheck: () => { if (stage === 'candidate') throw new AdminRequestError(400, 'candidate_rejected') },
      read: async () => {
        const document = await read()
        if (stage === 'revision' || stage === 'readback' && reads++ > 0) return { ...document, revision: '0'.repeat(64) }
        return document
      } })
    const code = stage === 'candidate' ? 'candidate_rejected' : stage === 'revision' ? 'private_conflict' : 'private_write_unknown'
    await assert.rejects(operation, error => error instanceof AdminRequestError && error.code === code)
    assert.equal(object((await read()).value).value, stage === 'readback' ? 'new' : 'old')
    assert.deepEqual(await readdir(directory), ['configuration.json'])
  })
}

for (const stage of ['create', 'file-sync', 'rename', 'directory-sync'] as const) {
  test(`private JSON filesystem failure at ${stage} never misreports a committed result`, async context => {
    const directory = await mkdtemp(join(tmpdir(), 'private-json-filesystem-'))
    context.after(() => rm(directory, { recursive: true, force: true }))
    const filename = join(directory, 'configuration.json')
    await writeFile(filename, '{"value":"old"}\n', { mode: 0o600 })
    const script = `
      import { mock } from 'node:test'
      import * as actual from 'node:fs/promises'
      import { pathToFileURL } from 'node:url'
      import { join } from 'node:path'
      const [directory, stage] = process.argv.slice(1)
      const filename = join(directory, 'configuration.json')
      const temporary = join(directory, 'candidate.tmp')
      mock.module('node:fs/promises', { namedExports: { ...actual,
        async open(path, flags, mode) {
          if (stage === 'create' && path === temporary) throw new Error('synthetic create failure')
          const handle = await actual.open(path, flags, mode)
          if (stage === 'file-sync' && path === temporary || stage === 'directory-sync' && path === directory) {
            return new Proxy(handle, { get(target, property) {
              if (property === 'sync') return async () => { throw new Error('synthetic sync failure') }
              const value = Reflect.get(target, property, target)
              return typeof value === 'function' ? value.bind(target) : value
            } })
          }
          return handle
        },
        async rename(from, to) {
          if (stage === 'rename') throw new Error('synthetic rename failure')
          return actual.rename(from, to)
        }
      } })
      const storage = await import(pathToFileURL(process.cwd() + '/src/admin/private-json-storage.ts').href)
      const read = () => storage.readPrivateJson(filename, { maxBytes: 1024,
        validate: value => value, invalidCode: 'private_invalid', conflictCode: 'private_conflict' })
      const before = await read()
      let failure
      try {
        await storage.replacePrivateJson({ directory, filename, temporary,
          expectedRevision: before.revision, content: Buffer.from('{"value":"new"}\\n'), read,
          conflictCode: 'private_conflict', writeFailedCode: 'private_write_failed', writeUnknownCode: 'private_write_unknown' })
      } catch (error) { failure = { code: error.code, statusCode: error.statusCode } }
      process.stdout.write(JSON.stringify({ failure, value: (await read()).value }))
    `
    const child = spawnSync(process.execPath,
      ['--experimental-test-module-mocks', '--input-type=module', '-e', script, directory, stage],
      { cwd: process.cwd(), encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    const result = object(JSON.parse(child.stdout) as unknown)
    assert.deepEqual(result.failure, { code: stage === 'directory-sync' ? 'private_write_unknown' : 'private_write_failed', statusCode: 500 })
    assert.deepEqual(result.value, { value: stage === 'directory-sync' ? 'new' : 'old' })
    assert.deepEqual(await readdir(directory), ['configuration.json'])
    assert.equal((await readFile(filename, 'utf8')).includes(stage === 'directory-sync' ? 'new' : 'old'), true)
  })
}
