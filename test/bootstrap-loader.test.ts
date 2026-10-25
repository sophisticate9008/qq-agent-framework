import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, chown, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { loadNativeBootstrap } from '../scripts/bootstrap-loader.ts';
import { createContextStore } from '../src/core/context.ts';
import { createSqliteStore } from '../src/storage/sqlite.ts';

const runtime = new URL('../runtime/', import.meta.url);
const source = "export default { manifest: { id: 'loader-example', version: '1.0.0', apiVersion: 1 }, create() { return {}; } };\n";

async function fixture() {
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(new URL('bootstrap-loader-', runtime).pathname);
  const filename = join(directory, 'extension.ts');
  await writeFile(filename, source, { mode: 0o600 });
  return { directory, filename, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('loader verifies actual bytes, immutable manifest and unchanged source before create', async () => {
  const setup = await fixture();
  const store = createSqliteStore({ filename: join(setup.directory, 'state.sqlite') });
  try {
    const loaded = await loadNativeBootstrap(setup.filename);
    assert.equal(loaded.metadata.codeFingerprint, createHash('sha256').update(source).digest('hex'));
    assert.equal(loaded.metadata.sandboxed, false);
    assert.equal(loaded.metadata.requiresSeparateAuthorization, true);
    assert(Object.isFrozen(loaded.metadata.manifest));
    const context = { directory: setup.directory, store, context: createContextStore(), persona: 'example@1', signal: new AbortController().signal };
    assert.deepEqual(await loaded.create(context), {});
    await writeFile(setup.filename, source + '\n');
    await assert.rejects(async () => loaded.create(context), { code: 'NATIVE_BOOTSTRAP_CHANGED' });
  } finally { store.close(); await setup.cleanup(); }
});

test('loader rejects URLs, relative or non-TypeScript paths, links, writable paths and excess bytes', async () => {
  const setup = await fixture();
  try {
    for (const filename of ['./extension.ts', 'https://example.invalid/extension.ts', `file://${setup.filename}`,
      setup.filename + '?x', setup.filename + '.js']) {
      await assert.rejects(loadNativeBootstrap(filename), { code: 'NATIVE_BOOTSTRAP_PATH_DENIED' });
    }
    const symbolic = join(setup.directory, 'symbolic.ts');
    await symlink(setup.filename, symbolic);
    await assert.rejects(loadNativeBootstrap(symbolic), { code: 'NATIVE_BOOTSTRAP_FILE_DENIED' });
    const linked = join(setup.directory, 'linked.ts');
    await link(setup.filename, linked);
    await assert.rejects(loadNativeBootstrap(linked), { code: 'NATIVE_BOOTSTRAP_FILE_DENIED' });
    await rm(linked);
    await chmod(setup.filename, 0o620);
    await assert.rejects(loadNativeBootstrap(setup.filename), { code: 'NATIVE_BOOTSTRAP_FILE_DENIED' });
    await chmod(setup.filename, 0o602);
    await assert.rejects(loadNativeBootstrap(setup.filename), { code: 'NATIVE_BOOTSTRAP_FILE_DENIED' });
    await chmod(setup.filename, 0o600);
    await assert.rejects(loadNativeBootstrap(setup.filename, { maxBytes: 8 }), { code: 'NATIVE_BOOTSTRAP_FILE_DENIED' });
    await chmod(setup.directory, 0o720);
    await assert.rejects(loadNativeBootstrap(setup.filename), { code: 'NATIVE_BOOTSTRAP_DIRECTORY_DENIED' });
    await chmod(setup.directory, 0o702);
    await assert.rejects(loadNativeBootstrap(setup.filename), { code: 'NATIVE_BOOTSTRAP_DIRECTORY_DENIED' });
    await chmod(setup.directory, 0o700);
    const parentLink = join(setup.directory, 'parent-link');
    await symlink(setup.directory, parentLink);
    await assert.rejects(loadNativeBootstrap(join(parentLink, 'extension.ts')), { code: 'NATIVE_BOOTSTRAP_DIRECTORY_DENIED' });
  } finally { await chmod(setup.directory, 0o700); await setup.cleanup(); }
});

test('loader rejects foreign file ownership', async context => {
  if (process.getuid?.() !== 0) { context.skip('Creating a different-owner fixture requires root.'); return; }
  const setup = await fixture();
  try {
    await chown(setup.filename, 65534, 65534);
    await assert.rejects(loadNativeBootstrap(setup.filename), { code: 'NATIVE_BOOTSTRAP_FILE_DENIED' });
  } finally { await setup.cleanup(); }
});

test('loader validates module shape and redacts import errors', async () => {
  const setup = await fixture();
  try {
    await writeFile(setup.filename, 'export const declaration = {};');
    await assert.rejects(loadNativeBootstrap(setup.filename), { code: 'INVALID_NATIVE_BOOTSTRAP' });
    await writeFile(setup.filename, "export default { manifest: { id: 'bad', version: '1.0.0', apiVersion: 2 }, create() { return {}; } };");
    await assert.rejects(loadNativeBootstrap(setup.filename), { code: 'INVALID_NATIVE_BOOTSTRAP' });
    await writeFile(setup.filename, "throw new Error('synthetic-secret-never-echo');");
    await assert.rejects(loadNativeBootstrap(setup.filename), error => {
      assert(error instanceof Error);
      assert(!error.message.includes('synthetic-secret'));
      return true;
    });
  } finally { await setup.cleanup(); }
});

test('loader releases pre-aborted reservations and retains timed-out imports until they settle', async () => {
  const setup = await fixture();
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(loadNativeBootstrap(setup.filename, { signal: controller.signal }), { code: 'OPERATION_ABORTED_UNKNOWN' });
    await loadNativeBootstrap(setup.filename);
    await writeFile(setup.filename, `await new Promise(resolve => setTimeout(resolve, 120));\n${source}`);
    await assert.rejects(loadNativeBootstrap(setup.filename, { timeoutMs: 10 }), { code: 'NATIVE_BOOTSTRAP_LOAD_TIMEOUT_UNKNOWN' });
    await assert.rejects(loadNativeBootstrap(setup.filename), { code: 'NATIVE_BOOTSTRAP_LOAD_BUSY' });
    await delay(160);
    await loadNativeBootstrap(setup.filename);
  } finally { await setup.cleanup(); }
});

test('loader caps unresolved imports globally beyond per-path logical deadlines', async () => {
  const setup = await fixture();
  const gateName = `bootstrap-loader-test-${randomUUID()}`;
  let release: (() => void) | undefined;
  const gate = { started: new Set<string>(), wait: new Promise<void>(resolve => { release = resolve; }) };
  const controllers: AbortController[] = [];
  const rejections: Promise<void>[] = [];
  Reflect.set(globalThis, Symbol.for(gateName), gate);
  try {
    for (let index = 0; index < 4; index++) {
      const filename = join(setup.directory, `pending-${index}.ts`);
      await writeFile(filename, `const gate = Reflect.get(globalThis, Symbol.for(${JSON.stringify(gateName)})) as { started: Set<string>; wait: Promise<void> };
gate.started.add(import.meta.url);
await gate.wait;
${source}`, { mode: 0o600 });
      const controller = new AbortController();
      controllers.push(controller);
      rejections.push(assert.rejects(loadNativeBootstrap(filename, { signal: controller.signal }), { code: 'OPERATION_ABORTED_UNKNOWN' }));
    }
    const startedDeadline = Date.now() + 5000;
    while (gate.started.size < 4 && Date.now() < startedDeadline) await delay(5);
    assert.equal(gate.started.size, 4);
    for (const controller of controllers) controller.abort();
    await Promise.all(rejections);
    await assert.rejects(loadNativeBootstrap(setup.filename), { code: 'NATIVE_BOOTSTRAP_LOAD_BUSY' });
    assert(release);
    release();
    await delay(10);
    await loadNativeBootstrap(setup.filename);
  } finally {
    for (const controller of controllers) controller.abort();
    release?.();
    await Promise.allSettled(rejections);
    Reflect.deleteProperty(globalThis, Symbol.for(gateName));
    await setup.cleanup();
  }
});

test('loader retains static package configuration declarations without executing bootstrap creation', async () => {
  const setup = await fixture();
  try {
    await writeFile(setup.filename, `
export default {
  manifest: { id: 'static-settings', version: '1.0.0', apiVersion: 1 },
  packageConfigurations: [{ descriptor: { id: 'external-setting', owner: 'external', schemaVersion: 1,
    title: 'External setting', description: '', application: 'live', fields: [{ id: 'enabled', path: ['enabled'],
      kind: 'boolean', label: 'Enabled', description: '' }] }, defaults: { enabled: false },
    validate(input) { if (!input || typeof input.enabled !== 'boolean') throw new TypeError('invalid'); return { enabled: input.enabled }; } }],
  create() { throw new Error('creation must not run while loading settings'); }
};
`, { mode: 0o600 });
    const loaded = await loadNativeBootstrap(setup.filename);
    assert.equal(loaded.packageConfigurations?.[0]?.descriptor.id, 'external-setting');
    assert.deepEqual(loaded.packageConfigurations?.[0]?.defaults, { enabled: false });
    assert(Object.isFrozen(loaded.packageConfigurations));
  } finally { await setup.cleanup(); }
});
