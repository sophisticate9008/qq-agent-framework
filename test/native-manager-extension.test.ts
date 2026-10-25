import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { loadNativeBootstrap } from '../scripts/bootstrap-loader.ts';
import { defineNativeBootstrap, type NativeBootstrapDefinition } from '../src/host/native-bootstrap.ts';
import type { ControlCommandDefinition } from '../src/host/control-commands.ts';
import type { LifecycleHookDefinition } from '../src/host/lifecycle-hooks.ts';

const manifest = { id: 'manager-extension-test', version: '1.0.0', apiVersion: 1 } as const;
const command: ControlCommandDefinition = { id: 'fixture-command', matches: () => true,
  replyTexts: ['Registered.'], async handle() {} };
const hook: LifecycleHookDefinition = { id: 'fixture-hook', checkpoint: 'message.normalized', kind: 'observe', run() {} };
const hash = (source: string): string => createHash('sha256').update(source).digest('hex');

function source(commands = '[command]', hooks = '[hook]', imported = false): string {
  return `import { command, hook, markImport, noChatCreate } from './definitions.ts';
${imported ? 'markImport();' : ''}
export default { manifest: { id: 'manager-extension-test', version: '1.0.0', apiVersion: 1 },
  controlCommands: ${commands}, lifecycleHooks: ${hooks}, create: noChatCreate };
`;
}

async function fixture(context: TestContext) {
  const root = fileURLToPath(new URL('../runtime/engineering/validation/017/native-manager-extension/', import.meta.url));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, 'fixture-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'extension.ts');
  const marker = join(directory, 'imported.txt');
  const created = join(directory, 'created.txt');
  await writeFile(join(directory, 'definitions.ts'), `import { writeFileSync } from 'node:fs';
export const command = { id: 'fixture-command', matches() { return true; }, replyTexts: ['Registered.'], async handle() {} };
export const hook = { id: 'fixture-hook', checkpoint: 'message.normalized', kind: 'observe', run() {} };
export function markImport() { writeFileSync(new URL('./imported.txt', import.meta.url), 'imported', { mode: 0o600 }); }
export function noChatCreate() {
  writeFileSync(new URL('./created.txt', import.meta.url), 'created', { mode: 0o600 });
  throw new Error('Chat create must not run to obtain manager declarations.');
}
`, { mode: 0o600 });
  return { filename, marker, created, async write(value: string) { await writeFile(filename, value, { mode: 0o600 }); } };
}

test('define and real loader preserve manager declarations before chat create without public-source imports in the module', async context => {
  let creates = 0;
  const defined = defineNativeBootstrap({ manifest, controlCommands: [command], lifecycleHooks: [hook],
    create() { creates++; return {}; } });
  assert.equal(creates, 0);
  assert.equal(defined.controlCommands?.[0]?.handle, command.handle);
  assert.equal(defined.lifecycleHooks?.[0]?.run, hook.run);
  assert.ok(Object.isFrozen(defined.controlCommands));
  assert.ok(Object.isFrozen(defined.controlCommands?.[0]?.replyTexts));
  assert.ok(Object.isFrozen(defined.lifecycleHooks));
  const setup = await fixture(context);
  const bytes = source();
  await setup.write(bytes);
  const loaded = await loadNativeBootstrap(setup.filename, { expectedFingerprint: hash(bytes) });
  assert.equal(loaded.metadata.codeFingerprint, hash(bytes));
  assert.deepEqual(loaded.controlCommands?.map(item => ({ id: item.id, replyTexts: item.replyTexts })),
    [{ id: 'fixture-command', replyTexts: ['Registered.'] }]);
  assert.deepEqual(loaded.lifecycleHooks?.map(({ id, checkpoint, kind }) => ({ id, checkpoint, kind })),
    [{ id: 'fixture-hook', checkpoint: 'message.normalized', kind: 'observe' }]);
  assert.equal(typeof loaded.controlCommands?.[0]?.matches, 'function');
  assert.equal(typeof loaded.controlCommands?.[0]?.handle, 'function');
  assert.equal(typeof loaded.lifecycleHooks?.[0]?.run, 'function');
  assert.ok(Object.isFrozen(loaded.controlCommands));
  assert.ok(Object.isFrozen(loaded.lifecycleHooks));
  await assert.rejects(access(setup.created), { code: 'ENOENT' });
  assert.equal(creates, 0);
});

test('define and real loader reject oversized templates, duplicate command identities and invalid manager hook placement', async context => {
  const setup = await fixture(context);
  const base: NativeBootstrapDefinition = { manifest, create: () => ({}) };
  const invalid = [
    { definition: { ...base, controlCommands: [{ ...command, replyTexts: ['x'.repeat(1001)] }] },
      source: source("[{ ...command, replyTexts: ['x'.repeat(1001)] }]"), code: 'INVALID_NATIVE_BOOTSTRAP' },
    { definition: { ...base, controlCommands: [command, { ...command }] },
      source: source('[command, { ...command }]'), code: 'INVALID_NATIVE_BOOTSTRAP' },
    { definition: { ...base, lifecycleHooks: [{ ...hook, kind: 'guard' as const }] },
      source: source('[command]', "[{ ...hook, kind: 'guard' }]"), code: 'INVALID_LIFECYCLE_HOOKS' }
  ];
  for (const entry of invalid) {
    assert.throws(() => defineNativeBootstrap(entry.definition), { code: entry.code });
    await setup.write(entry.source);
    await assert.rejects(loadNativeBootstrap(setup.filename), { code: entry.code });
  }
  await assert.rejects(access(setup.created), { code: 'ENOENT' });
});

test('expected entry fingerprint drift rejects before import, with a real import-side-effect positive control', async context => {
  const setup = await fixture(context);
  const original = source();
  await setup.write(original);
  const expectedFingerprint = hash(original);
  const changed = source('[command]', '[hook]', true);
  await setup.write(changed);
  assert.notEqual(hash(changed), expectedFingerprint);
  await assert.rejects(loadNativeBootstrap(setup.filename, { expectedFingerprint }), { code: 'NATIVE_BOOTSTRAP_CHANGED' });
  await assert.rejects(access(setup.marker), { code: 'ENOENT' });
  const loaded = await loadNativeBootstrap(setup.filename, { expectedFingerprint: hash(changed) });
  assert.equal(await readFile(setup.marker, 'utf8'), 'imported');
  assert.equal(loaded.controlCommands?.[0]?.id, 'fixture-command');
  assert.equal(loaded.lifecycleHooks?.[0]?.id, 'fixture-hook');
  await assert.rejects(access(setup.created), { code: 'ENOENT' });
});
