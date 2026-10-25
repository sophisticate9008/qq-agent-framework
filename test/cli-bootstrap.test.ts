import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseGatewayAdminArguments } from '../scripts/gateway-admin.ts';
import { runCli, type CliIo } from '../scripts/cli.ts';
import { isRecord } from '../src/core/values.ts';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const repository = basename(sourceRoot) === 'dist' ? dirname(sourceRoot) : sourceRoot;

test('gateway administrator bootstrap is start-only and rejects duplicate or ambiguous arguments', () => {
  const filename = '/root/framework-local-extension.ts';
  assert.deepEqual(parseGatewayAdminArguments(['--config', 'private.json', '--bootstrap', filename]), {
    help: false, config: 'private.json', mode: 'start', bootstrap: filename
  });
  assert.deepEqual(parseGatewayAdminArguments(['--help']), { help: true });
  for (const mode of ['--health', '--listening', '--address']) {
    assert.throws(() => parseGatewayAdminArguments(['--config', 'private.json', mode, '--bootstrap', filename]), /只接受启动/);
    assert.deepEqual(parseGatewayAdminArguments(['--config', 'private.json', mode]), {
      help: false, config: 'private.json', mode
    });
  }
  for (const value of ['relative.ts', 'file:///root/local.ts', 'https://example.test/local.ts', '/root/local.js',
    '/root/../root/local.ts', '/root/local.ts?version=1', '/root/local.ts#version', '/root/local\n.ts']) {
    assert.throws(() => parseGatewayAdminArguments(['--config', 'private.json', '--bootstrap', value]), /绝对路径/);
  }
  for (const argumentsList of [[], ['--config'], ['--config', 'one', '--config', 'two'],
    ['--config', 'one', '--health', '--health'], ['--config', 'one', '--health', '--address'],
    ['--config', 'one', '--bootstrap'], ['--config', 'one', '--bootstrap', filename, '--bootstrap', filename]]) {
    assert.throws(() => parseGatewayAdminArguments(argumentsList));
  }
});

test('both visible CLI entries reject a failing trusted bootstrap before starting or building and redact its exception',
  { timeout: 15_000 }, async context => {
    const privateRoot = join(repository, 'runtime', 'cli-bootstrap-tests');
    mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
    const directory = mkdtempSync(join(privateRoot, 'case-'));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const configuration = join(directory, 'admin', 'config.json');
    const output: string[] = [];
    const errors: string[] = [];
    const io: CliIo = { cwd: directory, env: {}, stdout: message => output.push(message), stderr: message => errors.push(message) };
    assert.equal(await runCli(['init', '--config', configuration], io), 0);
    const before = readFileSync(configuration, 'utf8');
    const filename = join(directory, 'extension.ts');
    const entered = join(directory, 'loaded.marker');
    const privateMessage = 'fixture-bootstrap-exception-not-for-public-output';
    writeFileSync(filename, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(entered)}, 'loaded', { mode: 0o600 });
throw new Error(${JSON.stringify(privateMessage)});
export default { manifest: { id: 'local-fixture', version: '1.0.0', apiVersion: 1 }, create() { return {}; } };
`, { mode: 0o600 });
    output.length = 0;
    assert.equal(await runCli(['start', '--config', configuration, '--admin-only', '--bootstrap', filename], io), 1);
    assert.equal(readFileSync(entered, 'utf8'), 'loaded');
    assert.match(errors.join('\n'), /NATIVE_BOOTSTRAP_LOAD_FAILED/);
    assert(!errors.join('\n').includes(privateMessage));
    assert.equal(output.length, 0);
    rmSync(entered);
    const rejectedCheck = spawnSync(process.execPath, [join(repository, 'scripts/gateway-admin.ts'),
      '--config', configuration, '--address', '--bootstrap', filename], { cwd: directory, encoding: 'utf8', timeout: 5_000 });
    assert.equal(rejectedCheck.status, 1, rejectedCheck.stderr);
    assert.match(rejectedCheck.stderr, /只接受启动/);
    assert.equal(existsSync(entered), false);
    const rejectedStart = spawnSync(process.execPath, [join(repository, 'scripts/gateway-admin.ts'),
      '--config', configuration, '--bootstrap', filename], { cwd: directory, encoding: 'utf8', timeout: 5_000 });
    assert.equal(rejectedStart.status, 1, rejectedStart.stderr);
    assert.match(rejectedStart.stderr, /NATIVE_BOOTSTRAP_LOAD_FAILED/);
    assert.equal(rejectedStart.stdout, '');
    assert(!rejectedStart.stderr.includes(privateMessage));
    assert.equal(readFileSync(entered, 'utf8'), 'loaded');
    assert.equal(readFileSync(configuration, 'utf8'), before);
    const savedConfiguration: unknown = JSON.parse(before);
    assert(isRecord(savedConfiguration));
    assert.equal(Object.hasOwn(savedConfiguration, 'bootstrap'), false);
    const help = spawnSync(process.execPath, [join(repository, 'scripts/gateway-admin.ts'), '--help'],
      { cwd: directory, encoding: 'utf8', timeout: 5_000 });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--bootstrap <可信本机TS绝对路径>/);
    assert.match(help.stdout, /不自动授予权限/);
  });
