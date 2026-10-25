import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readNativeBootstrapContent } from '../scripts/bootstrap-content.ts'
import { loadNativeBootstrap } from '../scripts/bootstrap-loader.ts'
import { createContextStore } from '../src/core/context.ts'
import { createSqliteStore } from '../src/storage/sqlite.ts'
import { isRecord } from '../src/core/values.ts'

const signal = new AbortController().signal
async function fixture(context: TestContext, source = "import { value } from './helper.ts'; export default { manifest:{id:'content',version:'1.0.0',apiVersion:1},create(){if(value!==1) throw new Error('bad value'); return {}} }") {
  const root = new URL('../runtime/', import.meta.url)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(new URL('bootstrap-content-', root).pathname)
  context.after(() => rm(directory, { recursive: true, force: true }))
  const filename = join(directory, 'entry.ts')
  await writeFile(filename, source, { mode: 0o600 })
  await writeFile(join(directory, 'helper.ts'), 'export const value = 1', { mode: 0o600 })
  const manifest = (dependencies: readonly { specifier: string; lockFile: string }[] = []) => writeFile(`${filename}.manifest.json`, JSON.stringify({ schema: 1, entry: 'entry.ts', dependencies }), { mode: 0o600 })
  await manifest()
  return { directory, filename, manifest }
}

test('full content manifests cover helper bytes and exclude runtime/credential data without executing import expressions', async context => {
  const f = await fixture(context)
  await writeFile(join(f.directory, '.env'), 'SYNTHETIC_SECRET=private', { mode: 0o600 })
  await mkdir(join(f.directory, 'runtime'), { mode: 0o700 })
  await writeFile(join(f.directory, 'runtime', 'state.json'), '{"private":true}', { mode: 0o600 })
  const content = await readNativeBootstrapContent(f.filename, signal); assert(content)
  assert.equal(content.identity.coverage, 'package-tree-and-dependency-locks-v1')
  assert.equal(content.identity.files, 3)
  await writeFile(join(f.directory, '.env'), 'SYNTHETIC_SECRET=changed', { mode: 0o600 })
  await content.verify(signal)
  const loaded = await loadNativeBootstrap(f.filename)
  assert.deepEqual(loaded.metadata.contentIdentity, content.identity)
  const store = createSqliteStore({ filename: join(f.directory, 'state.sqlite') }); context.after(() => store.close())
  const ctx = createContextStore(); const persona = ctx.registerPersona({ id: 'fixture', version: '1', name: 'Fixture', identity: {}, style: {} })
  assert.deepEqual(await loaded.create({ directory: f.directory, store, context: ctx, persona, signal }), {})
  await writeFile(join(f.directory, 'helper.ts'), 'export const value = 2', { mode: 0o600 })
  await assert.rejects(content.verify(signal), { code: 'NATIVE_PACKAGE_CONTENT_CHANGED' })
  await assert.rejects(async () => loaded.create({ directory: f.directory, store, context: ctx, persona, signal }), { code: 'NATIVE_PACKAGE_CONTENT_CHANGED' })
  await assert.rejects(loadNativeBootstrap(f.filename), { code: 'NATIVE_PACKAGE_PROCESS_RESTART_REQUIRED' })
})

test('AST import checks reject escaped roots, dynamic expressions, undeclared bare imports and links before package evaluation', async context => {
  for (const source of ["import '../outside.ts'; export default {}", "const target='./helper.ts'; await import(target); export default {}", "import 'unlisted-module'; export default {}", "import {createRequire} from 'node:module'; export default {}"] ) {
    const f = await fixture(context, source)
    await assert.rejects(loadNativeBootstrap(f.filename), { code: 'NATIVE_PACKAGE_IMPORT_UNDECLARED' })
  }
  const f = await fixture(context)
  await symlink(join(f.directory, 'helper.ts'), join(f.directory, 'link.ts'))
  await assert.rejects(readNativeBootstrapContent(f.filename, signal), { code: 'NATIVE_PACKAGE_CONTENT_UNSAFE' })
})

test('bare dependencies require explicit exact imports and real included npm lock integrity metadata', async context => {
  const f = await fixture(context, "import ts from 'typescript'; export default { manifest:{id:'content-dependency',version:'1.0.0',apiVersion:1},create(){return {}} }")
  await f.manifest([{ specifier: 'typescript', lockFile: 'package-lock.json' }])
  await assert.rejects(readNativeBootstrapContent(f.filename, signal), { code: 'NATIVE_PACKAGE_DEPENDENCY_UNVERIFIED' })
  const rootLock: unknown = JSON.parse(await readFile(new URL(import.meta.url.endsWith('.js')
    ? '../../package-lock.json' : '../package-lock.json', import.meta.url), 'utf8'))
  assert(isRecord(rootLock) && isRecord(rootLock.packages))
  const installed = rootLock.packages['node_modules/typescript']; assert(isRecord(installed))
  await writeFile(join(f.directory, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/typescript': installed } }), { mode: 0o600 })
  const content = await readNativeBootstrapContent(f.filename, signal); assert(content)
  assert.equal(content.identity.files, 4)
  const loaded = await loadNativeBootstrap(f.filename)
  assert.equal(loaded.metadata.contentIdentity?.coverage, 'package-tree-and-dependency-locks-v1')
  await writeFile(join(f.directory, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/typescript': { ...installed, version: 'changed' } } }), { mode: 0o600 })
  await assert.rejects(content.verify(signal), { code: 'NATIVE_PACKAGE_CONTENT_CHANGED' })
})
