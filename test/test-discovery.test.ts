import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { discoverTestFiles, parseTestShard, shardTestFiles, testConcurrency, testExecutionBatches, testNeedsBuild, testSuiteFor } from '../scripts/test-discovery.ts';

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
    const partition = ['fast', 'deadline', 'integration', 'artifacts'] as const;
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


test('slow clocks and artifact-dependent checks cannot enter the build-free fast suite', () => {
  for (const extension of ['ts', 'js']) {
    assert.equal(testSuiteFor(`/test/admin-deadline.test.${extension}`), 'deadline');
    assert.equal(testSuiteFor(`/test/cli-lifecycle.test.${extension}`), 'artifacts');
    for (const stem of ['admin-chunks', 'admin', 'app']) assert.equal(testSuiteFor(`/test/${stem}.test.${extension}`), 'artifacts');
    assert.equal(testSuiteFor(`/test/native-protocol.test.${extension}`), 'integration');
  }
  for (const suite of ['fast', 'integration', 'deadline'] as const) assert.equal(testNeedsBuild(suite, false), false);
  for (const suite of ['all', 'artifacts'] as const) assert.equal(testNeedsBuild(suite, false), true);
  assert.equal(testNeedsBuild('fast', true), true);
});

test('stable shards cover every discovered source and compiled file once, independent of input order', () => {
  const files = ['/test/c.test.ts', '/test/a.test.ts', '/test/b.test.ts', '/test/d.test.ts', '/test/e.test.ts'];
  for (const total of [1, 2, 3, 5]) {
    const groups = Array.from({ length: total }, (_, index) => shardTestFiles(files, parseTestShard(`${index + 1}/${total}`)));
    assert.deepEqual(groups.flat().sort(), [...files].sort());
    assert.equal(new Set(groups.flat()).size, files.length);
    for (let index = 0; index < total; index++) {
      const shard = parseTestShard(`${index + 1}/${total}`);
      assert.deepEqual(shardTestFiles([...files].reverse(), shard), groups[index]);
      assert.deepEqual(shardTestFiles(files.map(file => file.replace('.ts', '.js')), shard), groups[index]!.map(file => file.replace('.ts', '.js')));
    }
  }
  for (const value of ['0/3', '4/3', '1/33', '01/3', '1/0', '1', '1/2/3', '-1/3', '1.5/3']) assert.throws(() => parseTestShard(value), /--shard/);
  assert.deepEqual(shardTestFiles([], parseTestShard('1/3')), []);
});
