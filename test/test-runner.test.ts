import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runTestFiles } from '../scripts/test-runner.ts';

test('bounded test runner aggregates successes and reports assertion failures without dumping successful output', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qbf-test-runner-'));
  try {
    const passing = join(directory, 'passing.test.mjs');
    const failing = join(directory, 'failing.test.mjs');
    writeFileSync(join(directory, 'marker.txt'), 'fixture-cwd');
    writeFileSync(passing, "import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; import test from 'node:test'; test('passes', () => { assert.equal(readFileSync('marker.txt', 'utf8'), 'fixture-cwd'); console.log('success-noise'); }); test.skip('optional', () => {});\n");
    writeFileSync(failing, "import test from 'node:test'; test('meaningful-failure', () => { throw new Error('fixture-assertion'); });\n");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await runTestFiles([passing, failing], { concurrency: 2, cwd: directory, timeoutMs: 5000,
      stdout: message => stdout.push(message), stderr: message => stderr.push(message) });
    assert.deepEqual(result, { files: 2, failed: 1, tests: 3, passed: 1, skipped: 1 });
    assert.equal(stdout.join('').includes('success-noise'), false);
    assert.match(stderr.join(''), /fixture-assertion/);
    assert.match(stderr.join(''), /failing.test.mjs/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('an unresolved test with a leaked handle cannot outlive its hard process deadline', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qbf-test-hang-'));
  try {
    const filename = join(directory, 'leaked.test.mjs');
    writeFileSync(filename, "import test from 'node:test'; test('never settles', () => new Promise(() => { setInterval(() => {}, 1000); }));\n");
    const stderr: string[] = [];
    const started = Date.now();
    const result = await runTestFiles([filename], { concurrency: 1, timeoutMs: 700,
      stdout: () => {}, stderr: message => stderr.push(message) });
    assert.equal(result.files, 1);
    assert.equal(result.failed, 1);
    assert.match(stderr.join(''), /超过 700ms，已终止进程组/);
    assert(Date.now() - started < 5000);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
