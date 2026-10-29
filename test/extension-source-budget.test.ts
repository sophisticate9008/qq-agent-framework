import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExtensionModuleLoader } from '../src/host/extension-module-loader.ts';

test('source budgets share unchanged modules and retain the running version on overflow', async context => {
  const root = await mkdtemp(join(tmpdir(), 'qbf-source-budget-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'index.ts');
  const padding = 'x'.repeat(5000);
  await writeFile(join(root, 'shared.ts'), `export const value = ${JSON.stringify(padding)};`);
  await writeFile(entry, "export { value } from './shared.ts'; export const revision = 1;");
  const loader = createExtensionModuleLoader({ entry, maxRetainedSourceBytes: 7000 });
  const first = await loader.load();
  await writeFile(entry, "export { value } from './shared.ts'; export const revision = 2;");
  const second = await loader.load();
  assert.notEqual(first.revision, second.revision);
  assert.equal((first.namespace as { revision: number }).revision, 1);
  assert.equal((second.namespace as { revision: number }).revision, 2);
  await writeFile(join(root, 'shared.ts'), `export const value = ${JSON.stringify('y'.repeat(5000))};`);
  await assert.rejects(loader.load(), { code: 'EXTENSION_RELOAD_LIMIT' });
  assert.equal((second.namespace as { value: string }).value, padding);
  // Recreating a loader cannot bypass the shared entry budget.
  const another = createExtensionModuleLoader({ entry, maxRetainedSourceBytes: 14000 });
  await assert.rejects(another.load(), { code: 'EXTENSION_RELOAD_LIMIT' });
});

test('invalid retained source budgets are rejected before loading code', () => {
  for (const maxRetainedSourceBytes of [0, -1, NaN, 1.5, 512 * 1024 * 1024 + 1]) {
    assert.throws(() => createExtensionModuleLoader({ entry: '/unused/index.ts', maxRetainedSourceBytes }),
      { code: 'EXTENSION_SOURCE_INVALID' });
  }
});
