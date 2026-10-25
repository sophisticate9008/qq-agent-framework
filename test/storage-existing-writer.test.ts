import assert from 'node:assert/strict'
import test from 'node:test'
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSqliteStore } from '../src/storage/sqlite.ts'

test('existing SQLite writer preserves private schema and never creates, repairs, or follows unsafe files', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'existing-writer-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const filename = join(directory, 'existing.sqlite')
  assert.throws(() => createSqliteStore({ filename, requireExisting: true }), { code: 'STORE_NOT_FOUND' })
  await assert.rejects(lstat(filename), { code: 'ENOENT' })
  const original = createSqliteStore({ filename })
  const record = original.write('test', 'preserved', { value: 1 })
  original.close()
  const writer = createSqliteStore({ filename, requireExisting: true })
  assert.equal(writer.read('test', 'preserved')?.revision, record.revision)
  writer.compareAndSetBatch!([{ kind: 'write', namespace: 'test', key: 'preserved', expectedRevision: record.revision, value: { value: 2 } }])
  writer.close()
  await chmod(filename, 0o644)
  assert.throws(() => createSqliteStore({ filename, requireExisting: true }), { code: 'STORE_READONLY_UNSAFE' })
  assert.equal((await lstat(filename)).mode & 0o777, 0o644)
  await chmod(filename, 0o600)
  const link = join(directory, 'link.sqlite'); await symlink(filename, link)
  assert.throws(() => createSqliteStore({ filename: link, requireExisting: true }), { code: 'STORE_READONLY_UNAVAILABLE' })
  const unrelated = join(directory, 'unrelated.sqlite'); await writeFile(unrelated, 'unrelated bytes', { mode: 0o600 })
  assert.throws(() => createSqliteStore({ filename: unrelated, requireExisting: true }))
  assert.equal(await readFile(unrelated, 'utf8'), 'unrelated bytes')
  assert.throws(() => createSqliteStore({ filename: ':memory:', requireExisting: true }), { code: 'STORE_READONLY_UNSAFE' })
})
