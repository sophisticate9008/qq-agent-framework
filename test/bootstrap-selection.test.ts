import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { loadSelectedNativeBootstrap } from '../scripts/bootstrap-loader.ts';

const source = "export default { manifest: { id: 'selected-extension', version: '1.0.0', apiVersion: 1 }, create() { return {}; } };\n";
async function fixture() {
  const directory = await mkdtemp(new URL('../runtime/bootstrap-selection-', import.meta.url).pathname);
  const configuration = join(directory, 'admin.json');
  const filename = join(directory, 'extension.ts');
  const selection = `${configuration}.bootstrap.json`;
  await writeFile(configuration, '{}', { mode: 0o600 });
  await writeFile(filename, source, { mode: 0o600 });
  return { directory, configuration, filename, selection };
}

test('first deployment does not load code; explicit operator selection survives a fresh loader call', async () => {
  const setup = await fixture();
  try {
    assert.equal(await loadSelectedNativeBootstrap(setup.configuration), undefined);
    await writeFile(setup.selection, JSON.stringify({ schema: 1, filename: setup.filename,
      fingerprint: createHash('sha256').update(source).digest('hex') }), { mode: 0o600 });
    assert.equal((await loadSelectedNativeBootstrap(setup.configuration))?.metadata.manifest.id, 'selected-extension');
    assert.equal((await loadSelectedNativeBootstrap(setup.configuration))?.metadata.codeFingerprint,
      createHash('sha256').update(source).digest('hex'));
  } finally { await rm(setup.directory, { recursive: true, force: true }); }
});

test('changed bytes and non-private operator selections do not load', async () => {
  const setup = await fixture();
  try {
    await writeFile(setup.selection, JSON.stringify({ schema: 1, filename: setup.filename, fingerprint: '0'.repeat(64) }), { mode: 0o600 });
    await assert.rejects(loadSelectedNativeBootstrap(setup.configuration), { code: 'NATIVE_BOOTSTRAP_CHANGED' });
    await chmod(setup.selection, 0o644);
    await assert.rejects(loadSelectedNativeBootstrap(setup.configuration), { code: 'NATIVE_BOOTSTRAP_SELECTION_DENIED' });
    assert.equal((await loadSelectedNativeBootstrap(setup.configuration, setup.filename))?.metadata.manifest.id, 'selected-extension');
  } finally { await rm(setup.directory, { recursive: true, force: true }); }
});
