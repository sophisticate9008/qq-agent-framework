import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { link, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import { BROWSER_DIAGNOSTIC_LIMITS, collectBrowserDiagnostics, projectBrowserDiagnostic,
  runBrowserDiagnosticCollector } from '../scripts/collect-browser-diagnostics.ts';

const syntheticSecret = 'SYNTHETIC-PRIVATE-BODY-CONFIG-TOKEN-1234567890';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6C0cAAAAASUVORK5CYII=', 'base64');

async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'browser-diagnostics-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, 'workspace');
  const runnerTemp = join(directory, 'runner');
  await mkdir(workspace);
  await mkdir(runnerTemp);
  const put = async (filename: string, value: string | Buffer): Promise<string> => {
    const location = join(workspace, filename);
    await mkdir(dirname(location), { recursive: true });
    await writeFile(location, value);
    return location;
  };
  return { directory, workspace, runnerTemp, put };
}

test('browser diagnostics project only known booleans/counts, error types and public script basenames', () => {
  const projected = projectBrowserDiagnostic({ fixtureOnly: true, pageCount: 10, allVisibleH2Indexed: false,
    token: syntheticSecret, status: 'failed', stage: syntheticSecret, account: 123456,
    SYNTHETICALPHANUMERICSECRET1234567890: true,
    requests: [{ body: { password: syntheticSecret, grants: [{ userId: 123456 }] } }],
    state: { browserAuthorizations: [syntheticSecret], nested: { config: syntheticSecret } },
    pageEntryCounts: { usage: 2, account: 123456, token: syntheticSecret },
    error: { name: 'AssertionError', message: syntheticSecret,
      stack: `AssertionError: ${syntheticSecret}\n at run (file:///private/account/scripts/page-navigation-smoke.ts:279:16)\n at leak (file:///private/${syntheticSecret}.ts:1:1)` },
    executionRuntime: { accepted: true, rejected: false, config: { token: syntheticSecret } }
  });
  assert.deepEqual(projected, { diagnosticSummary: true, fixtureOnly: true, allVisibleH2Indexed: false,
    pageCount: 10, requestsCount: 1, pageEntryCounts: { usage: 2 },
    executionRuntime: { trueFlagCount: 1, falseFlagCount: 1 }, reportedPassed: false,
    errorName: 'AssertionError', locations: ['page-navigation-smoke.ts:279:16'] });
  const serialized = JSON.stringify(projected);
  for (const forbidden of [syntheticSecret, 'SYNTHETICALPHANUMERICSECRET1234567890', '123456', '/private/', 'message', 'stack', 'grants']) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.deepEqual(projectBrowserDiagnostic(null), { diagnosticSummary: true });
  assert.deepEqual(projectBrowserDiagnostic({ error: { name: syntheticSecret, stack: 'private-smoke.ts:1:1' },
    pageCount: -1, screenshots: Infinity }), { diagnosticSummary: true, locations: [] });
});

test('browser diagnostics retain whitelisted synthetic PNG and JSON summaries, not raw runtime data', async context => {
  const values = await fixture(context);
  await values.put('runtime/page-navigation-smoke/failure-2026-10-25T00-00-00-000Z.json', JSON.stringify({
    allVisibleH2Indexed: false, error: { name: 'TimeoutError', message: syntheticSecret },
    state: { body: syntheticSecret }, token: syntheticSecret
  }));
  await values.put('runtime/page-navigation-smoke/failure.png', png);
  await values.put('runtime/page-navigation-smoke/forged.png', syntheticSecret);
  await values.put('runtime/page-navigation-smoke/admin.token', syntheticSecret);
  await values.put('runtime/page-navigation-smoke/config.json', syntheticSecret);
  await values.put('runtime/page-navigation-smoke/native-chat.sqlite', syntheticSecret);
  await values.put('runtime/page-navigation-smoke/console.log', syntheticSecret);
  await values.put('runtime/page-navigation-smoke/result-1.json', '{' + syntheticSecret);
  await values.put('runtime/testing/failure.png', png);
  await values.put('runtime/private/result.json', syntheticSecret);
  await values.put('runtime/engineering/validation/006/private.png', png);
  await values.put('runtime/engineering/validation/006/markdown-page-1.png', png);
  await values.put('runtime/engineering/validation/006/presentation-assets/page-1.png', png);
  await values.put('runtime/engineering/validation/006/presentation-assets/result.json', syntheticSecret);
  await values.put('runtime/execution-journal-smoke/terminal.json', JSON.stringify({ status: 'failed', error: syntheticSecret }));
  const result = await collectBrowserDiagnostics(values);
  assert.deepEqual((await readdir(result.directory)).sort(), ['execution-journal-terminal.json', 'markdown-markdown-page-1.png',
    'page-navigation-failure-2026-10-25T00-00-00-000Z.json', 'page-navigation-failure.png',
    'page-navigation-result-1.json', 'presentation-page-1.png']);
  for (const name of (await readdir(result.directory)).filter(value => value.endsWith('.json'))) {
    assert.equal((await readFile(join(result.directory, name), 'utf8')).includes(syntheticSecret), false);
  }
  assert.deepEqual(JSON.parse(await readFile(join(result.directory, 'page-navigation-result-1.json'), 'utf8')),
    { diagnosticSummary: true, invalidJson: true });
  assert.deepEqual(await readFile(join(result.directory, 'page-navigation-failure.png')), png);
  assert.equal(result.files, 6);
  assert.equal(result.rejected, 1);
});

test('browser diagnostics reject symlinks, hardlinks, linked directories and noncanonical roots', async context => {
  const values = await fixture(context);
  const external = await values.put('private.json', syntheticSecret);
  const suite = join(values.workspace, 'runtime/page-navigation-smoke');
  await mkdir(suite, { recursive: true });
  await symlink(external, join(suite, 'failure.png'));
  await link(external, join(suite, 'failure-1.json'));
  const outside = join(values.directory, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'failure.png'), png);
  await symlink(outside, join(values.workspace, 'runtime/native-chat-ui-smoke'));
  const result = await collectBrowserDiagnostics(values);
  assert.equal(result.files, 0);
  assert.equal(result.rejected, 2);
  const workspaceLink = join(values.directory, 'workspace-link');
  await symlink(values.workspace, workspaceLink);
  await assert.rejects(collectBrowserDiagnostics({ ...values, workspace: workspaceLink }));
  await assert.rejects(collectBrowserDiagnostics({ ...values, workspace: `${values.workspace}/../workspace` }));
  await assert.rejects(collectBrowserDiagnostics({ ...values, workspace: 'relative' }));
});

test('browser diagnostics refuse preexisting runner output without uploading foreign files', async context => {
  const values = await fixture(context);
  const output = join(values.runnerTemp, 'browser-smoke-diagnostics');
  await mkdir(output);
  await writeFile(join(output, 'foreign.json'), syntheticSecret);
  await assert.rejects(collectBrowserDiagnostics(values));
  assert.equal(await readFile(join(output, 'foreign.json'), 'utf8'), syntheticSecret);
});

test('browser diagnostics bound source file sizes before reading or parsing oversized files', async context => {
  const values = await fixture(context);
  for (const [name, length] of [['failure.png', BROWSER_DIAGNOSTIC_LIMITS.pngBytes + 1],
    ['failure-1.json', BROWSER_DIAGNOSTIC_LIMITS.jsonBytes + 1]] as const) {
    const filename = await values.put(`runtime/page-navigation-smoke/${name}`, '');
    const handle = await open(filename, 'r+');
    await handle.truncate(length);
    await handle.close();
  }
  const result = await collectBrowserDiagnostics(values);
  assert.equal(result.files, 0);
  assert.equal(result.rejected, 2);
  assert.equal(result.bytes, 0);
});

test('browser diagnostics cap total files and shallow directory entries', async context => {
  const values = await fixture(context);
  for (let index = 0; index < BROWSER_DIAGNOSTIC_LIMITS.files + 3; index++) {
    await values.put(`runtime/ui-smoke/image-${index}.png`, png);
  }
  const result = await collectBrowserDiagnostics(values);
  assert.equal(result.files, BROWSER_DIAGNOSTIC_LIMITS.files);
  assert.equal(result.fileLimitReached, true);
  const entries = await fixture(context);
  for (let index = 0; index < BROWSER_DIAGNOSTIC_LIMITS.entriesPerSuite + 3; index++) {
    await entries.put(`runtime/ui-smoke/ignored-${index}.token`, syntheticSecret);
  }
  const capped = await collectBrowserDiagnostics(entries);
  assert.equal(capped.files, 0);
  assert.equal(capped.entryLimitReached, true);
});

test('browser diagnostics enforce a total byte budget across individually allowed PNG files', async context => {
  const values = await fixture(context);
  const count = Math.floor(BROWSER_DIAGNOSTIC_LIMITS.totalBytes / BROWSER_DIAGNOSTIC_LIMITS.pngBytes) + 1;
  for (let index = 0; index < count; index++) {
    const filename = await values.put(`runtime/ui-smoke/image-${index}.png`, png);
    const handle = await open(filename, 'r+');
    await handle.truncate(BROWSER_DIAGNOSTIC_LIMITS.pngBytes);
    await handle.close();
  }
  const result = await collectBrowserDiagnostics(values);
  assert.equal(result.files, count - 1);
  assert.equal(result.bytes, (count - 1) * BROWSER_DIAGNOSTIC_LIMITS.pngBytes);
  assert.equal(result.rejected, 1);
  assert.equal(result.byteLimitReached, true);
  assert(result.bytes <= BROWSER_DIAGNOSTIC_LIMITS.totalBytes);
});

test('browser diagnostics reject custom CLI scan paths and require the runner environment', async context => {
  const values = await fixture(context);
  for (const argumentsList of [['--source', values.workspace], ['--target', values.runnerTemp], ['../../private']]) {
    await assert.rejects(runBrowserDiagnosticCollector(argumentsList, { RUNNER_TEMP: values.runnerTemp }));
  }
  await assert.rejects(runBrowserDiagnosticCollector([], {}));
  const extension = import.meta.url.endsWith('.js') ? 'js' : 'ts';
  const entry = fileURLToPath(new URL(`../scripts/collect-browser-diagnostics.${extension}`, import.meta.url));
  const help = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /固定合成测试目录/);
});

test('browser diagnostics executable collects only the current fixture workspace and refuses custom arguments', async context => {
  const values = await fixture(context);
  await values.put('runtime/ui-smoke/result.json', JSON.stringify({ pageErrors: 0, token: syntheticSecret }));
  const extension = import.meta.url.endsWith('.js') ? 'js' : 'ts';
  const entry = fileURLToPath(new URL(`../scripts/collect-browser-diagnostics.${extension}`, import.meta.url));
  const environment = { ...process.env, RUNNER_TEMP: values.runnerTemp };
  const collected = spawnSync(process.execPath, [entry], { cwd: values.workspace, env: environment, encoding: 'utf8' });
  assert.equal(collected.status, 0, collected.stderr);
  assert.match(collected.stdout, /已收集 1 个合成浏览器诊断文件/);
  const summary = await readFile(join(values.runnerTemp, 'browser-smoke-diagnostics/browser-result.json'), 'utf8');
  assert.equal(summary.includes(syntheticSecret), false);
  const rejected = spawnSync(process.execPath, [entry, '--source', syntheticSecret], {
    cwd: values.workspace, env: environment, encoding: 'utf8'
  });
  assert.equal(rejected.status, 1);
  assert.equal((rejected.stdout + rejected.stderr).includes(syntheticSecret), false);
});

test('CI calls the strict collector and uploads only after safe projection succeeds with the Node24 pin', async () => {
  const root = fileURLToPath(new URL(import.meta.url.endsWith('.js') ? '../../' : '../', import.meta.url));
  const workflow: unknown = parse(await readFile(join(root, '.github/workflows/full.yml'), 'utf8'));
  assert(workflow !== null && typeof workflow === 'object' && 'jobs' in workflow);
  const jobs = workflow.jobs as Record<string, { steps: Array<Record<string, unknown>> }>;
  const prepare = jobs.browser.steps.find(step => step.id === 'diagnostics');
  const upload = jobs.browser.steps.find(step => typeof step.uses === 'string' && step.uses.startsWith('actions/upload-artifact@'));
  assert(prepare);
  assert(upload);
  assert.equal(prepare.run, 'node scripts/collect-browser-diagnostics.ts');
  assert.equal(prepare.if, "${{ failure() && steps.browser.outcome == 'failure' }}");
  assert.equal(upload.if, "${{ failure() && steps.browser.outcome == 'failure' && steps.diagnostics.outcome == 'success' }}");
  assert.equal(upload.uses, 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9');
  const options = upload.with as Record<string, unknown>;
  assert.equal(options['retention-days'], 3);
  assert.equal(options['include-hidden-files'], false);
  assert.equal(options.path, '${{ runner.temp }}/browser-smoke-diagnostics/*.png\n${{ runner.temp }}/browser-smoke-diagnostics/*.json\n');
  const config = JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8')) as { include: string[]; compilerOptions: { strict: boolean } };
  assert(config.include.includes('scripts/**/*.ts'));
  assert.equal(config.compilerOptions.strict, true);
});
