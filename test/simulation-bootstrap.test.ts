import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { loadSimulationBootstrap, parseSimulationArguments } from '../scripts/simulate-qq.ts';

test('simulation bootstrap is an explicit optional argument with ordinary option validation', () => {
  const defaults = parseSimulationArguments([]);
  assert.equal(defaults?.bootstrap, undefined);
  const configured = parseSimulationArguments(['--bootstrap', 'runtime/example.ts', '--prepare-only']);
  assert.equal(configured?.bootstrap, resolve('runtime/example.ts'));
  assert.equal(configured?.prepareOnly, true);
  assert.throws(() => parseSimulationArguments(['--bootstrap']), /simulation_option_value_required/);
  assert.throws(() => parseSimulationArguments(['--bootstrap', '--prepare-only']), /simulation_option_value_required/);
  assert.throws(() => parseSimulationArguments(['--bootstrap', 'a.ts', '--bootstrap', 'b.ts']), /simulation_duplicate_option/);
});

test('simulation prepare-only never imports selected code and normal loading uses the trusted bootstrap loader', async context => {
  const root = resolve('runtime');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, 'simulation-bootstrap-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, 'imported.txt');
  const bootstrap = join(directory, 'fixture.ts');
  await writeFile(bootstrap, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'imported');\nexport default { manifest: { id: 'simulation-fixture', version: '1.0.0', apiVersion: 1 }, create() { return {}; } };\n`, { mode: 0o600 });
  const signal = new AbortController().signal;
  assert.equal(await loadSimulationBootstrap({ prepareOnly: false }, signal), undefined);
  assert.equal(await loadSimulationBootstrap({ bootstrap, prepareOnly: true }, signal), undefined);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  const loaded = await loadSimulationBootstrap({ bootstrap, prepareOnly: false }, signal);
  assert.equal(loaded?.metadata.manifest.id, 'simulation-fixture');
  assert.equal(await readFile(marker, 'utf8'), 'imported');
  await assert.rejects(async () => loadSimulationBootstrap({ bootstrap: bootstrap + '.js', prepareOnly: false }, signal),
    { code: 'NATIVE_BOOTSTRAP_PATH_DENIED' });
});
