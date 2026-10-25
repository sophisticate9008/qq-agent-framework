import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { discoverTestFiles, testConcurrency, testExecutionBatches, testSuiteFor } from '../scripts/test-discovery.ts';

test('recursive test discovery selects source and built equivalently and partitions every test exactly once', () => {
  const directory = mkdtempSync(join(tmpdir(), 'framework-test-discovery-'));
  try {
    const names = ['unit.test', 'domain/nested.test', 'native-chat-real-deadline.test', 'integration/sdk.test',
      'native-chat-gateway.test', 'fixtures/unused.test', 'node_modules/foreign.test'];
    for (const name of names) {
      const file = join(directory, name);
      mkdirSync(join(file, '..'), { recursive: true });
      for (const extension of ['.ts', '.js']) writeFileSync(`${file}${extension}`, '');
    }
    const source = discoverTestFiles(directory, '.ts').map(file => relative(directory, file));
    assert.deepEqual(source, ['domain/nested.test.ts', 'integration/sdk.test.ts', 'native-chat-gateway.test.ts',
      'native-chat-real-deadline.test.ts', 'unit.test.ts']);
    assert.deepEqual(discoverTestFiles(directory, '.js').map(file => relative(directory, file).replace(/\.js$/, '.ts')), source);
    const partition = ['fast', 'deadline', 'integration'] as const;
    assert.deepEqual(partition.flatMap(suite => discoverTestFiles(directory, '.ts', suite)).sort(), discoverTestFiles(directory, '.ts'));
    assert.equal(testSuiteFor('/domain/native-chat-real-deadline.test.ts'), 'deadline');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('real deadlines and CLI asset builds run in separate final batches without omissions or duplication', () => {
  const files = ['/test/domain/one.test.ts', '/test/cli-lifecycle.test.ts', '/test/two.test.ts', '/test/native-chat-real-deadline.test.ts'];
  assert.deepEqual(testExecutionBatches(files), [[files[0], files[2]], [files[3]], [files[1]]]);
  assert.deepEqual(testExecutionBatches(['/dist/test/cli-lifecycle.test.js']), [['/dist/test/cli-lifecycle.test.js']]);
  assert.deepEqual(testExecutionBatches([]), []);
  assert.equal(testSuiteFor('/test/native-chat-runtime.test.ts'), 'integration');
  assert.equal(testSuiteFor('/dist/test/native-account-gateway.test.js'), 'integration');
  assert.deepEqual(testExecutionBatches(files.map(file => file.replace('.ts', '.js'))).flat().sort(), files.map(file => file.replace('.ts', '.js')).sort());
});

test('test concurrency can be lowered explicitly and invalid values fail before building', () => {
  assert.equal(testConcurrency(undefined), 4);
  assert.equal(testConcurrency('1'), 1);
  assert.equal(testConcurrency('32'), 32);
  for (const value of ['', '0', '01', '1.5', '33', '-1', 'all']) assert.throws(() => testConcurrency(value), /QQ_TEST_CONCURRENCY/);
});
