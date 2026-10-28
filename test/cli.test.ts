import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

import {
  browserSmokeFiles,
  browserToolchainPaths,
  parseCliArguments,
  prepareGatewayForStart,
  resolveConfigurationFilename,
  runCli,
  uninstallBrowserToolchain,
  type CliIo
} from '../scripts/cli.ts';
import { registerBrowserToolchainResolver } from '../scripts/browser-toolchain.ts';
import { loadGatewayAdminConfiguration, startGatewayAdmin } from '../src/admin/gateway.ts';
import { loadOneBotGatewayConfiguration, startOneBotGateway } from '../src/host/onebot-gateway.ts';
import { isRecord } from '../src/core/values.ts';
import { projectNativeDiagnostics } from '../src/host/native-diagnostics.ts';

const ADMIN_SECRET = 'cli-administrator-secret-0123456789';
const GATEWAY_SECRET = 'cli-gateway-secret-0123456789';

test('test CLI selects explicit suites and built output without mixing browser options', () => {
  assert.equal(parseCliArguments(['test']).suite, undefined);
  for (const suite of ['all', 'fast', 'deadline', 'integration']) {
    const parsed = parseCliArguments(['test', '--suite', suite, '--built']);
    assert.equal(parsed.suite, suite);
    assert.equal(parsed.built, true);
  }
  for (const argumentsList of [['test', '--suite', 'missing'], ['test', '--browser', '--suite', 'fast'],
    ['test', '--browser', '--built'], ['start', '--suite', 'fast'], ['build', '--built']]) {
    assert.throws(() => parseCliArguments(argumentsList));
  }
});

function privateFile(filename: string, value: string): void {
  writeFileSync(filename, value, { mode: 0o600 });
}

function fixture(port = 3131): { readonly directory: string; readonly gatewayConfiguration: string } {
  const directory = mkdtempSync(join(tmpdir(), 'qq-agent-cli-'));
  privateFile(join(directory, 'gateway.token'), `${GATEWAY_SECRET}\n`);
  const gatewayConfiguration = join(directory, 'gateway.json');
  privateFile(gatewayConfiguration, JSON.stringify({
    port,
    upstreamEndpoint: 'http://127.0.0.1:3000',
    tokenFile: './gateway.token',
    storeFilename: './gateway.sqlite',
    allowedConversations: ['private:1'],
    persona: { id: 'cli-test', version: '1' }
  }));
  return { directory, gatewayConfiguration };
}

function capturedIo(directory: string, environment: NodeJS.ProcessEnv = {}): {
  readonly io: CliIo;
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { cwd: directory, env: environment, stdout: message => stdout.push(message), stderr: message => stderr.push(message) },
    stdout,
    stderr
  };
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close(error => error ? rejectPromise(error) : resolvePromise());
  });
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address() as AddressInfo;
  await close(server);
  return address.port;
}

test('CLI parses only supported command options and presents standalone init first', async () => {
  assert.deepEqual(parseCliArguments(['test', '--browser', '--with-deps']), {
    command: 'test', help: false, browser: true, withDeps: true, adminOnly: false
  });
  assert.equal(parseCliArguments(['start', '--admin-only']).adminOnly, true);
  assert.equal(parseCliArguments(['init']).command, 'init');
  const directory = mkdtempSync(join(tmpdir(), 'qq-agent-cli-empty-'));
  try {
    const help = capturedIo(directory);
    assert.equal(await runCli(['init', '--help'], help.io), 0);
    assert.match(help.stdout.join('\n'), /用法：\n  npm run cli -- init \[/);
    assert.match(help.stdout.join('\n'), /npm run cli -- init --gateway-config <网关配置>/);
    assert.doesNotMatch(help.stdout.join('\n'), /bridge-dir|legacy-root|qq-bridge/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('init rejects removed bridge directory options', () => {
  assert.throws(() => parseCliArguments(['init', '--bridge-dir', '/tmp/bridge']), /无法识别/);
  assert.throws(() => parseCliArguments(['init', '--legacy-root', '/tmp/bridge']), /无法识别/);
});

test('bootstrap is an explicit start-only local TypeScript option, never an initialization or status setting', async () => {
  const filename = '/root/framework-local-extension.ts';
  assert.equal(parseCliArguments(['start', '--admin-only', '--bootstrap', filename]).bootstrap, filename);
  for (const command of ['init', 'status', 'test', 'install', 'uninstall', 'build']) {
    assert.throws(() => parseCliArguments([command, '--bootstrap', filename]), /不支持/);
  }
  for (const value of ['extension.ts', 'file:///root/extension.ts', 'https://example.test/extension.ts',
    '/root/extension.js', '/root/../root/extension.ts', '/root/extension.ts?version=1', '/root/extension.ts#loaded',
    '/root/extension\n.ts']) {
    assert.throws(() => parseCliArguments(['start', '--bootstrap', value]), /绝对路径/);
  }
  assert.throws(() => parseCliArguments(['start', '--bootstrap']), /缺少值/);
  assert.throws(() => parseCliArguments(['start', '--bootstrap', filename, '--bootstrap', filename]), /不能重复/);
  const captured = capturedIo('/');
  assert.equal(await runCli(['start', '--help'], captured.io), 0);
  assert.match(captured.stdout.join('\n'), /--bootstrap <可信本机TS绝对路径>/);
  assert.match(captured.stdout.join('\n'), /未指定时读取管理配置旁的固定版本选择，不自动授予权限/);
});

test('browser dependency commands and targeted tests require explicit valid options', () => {
  assert.equal(parseCliArguments(['install', '--browser']).command, 'install');
  assert.equal(parseCliArguments(['install', '--browser', '--skip-browser-download']).skipBrowserDownload, true);
  assert.equal(parseCliArguments(['uninstall', '--browser']).command, 'uninstall');
  assert.equal(parseCliArguments(['test', '--browser', '--target', 'markdown']).target, 'markdown');
  for (const argumentsList of [
    ['install'], ['uninstall'], ['test', '--target', 'markdown'],
    ['test', '--browser', '--target', 'missing'], ['test', '--browser', '--target', '__proto__'],
    ['test', '--skip-browser-download'], ['uninstall', '--browser', '--with-deps'],
    ['install', '--browser', '--skip-browser-download', '--with-deps'],
    ['install', '--browser', '--target', 'markdown'], ['start', '--browser']
  ]) assert.throws(() => parseCliArguments(argumentsList));
});

test('each browser alias selects exactly its named test and the default selects all', () => {
  const root = dirname(dirname(browserToolchainPaths().directory));
  const packageValue: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert(isRecord(packageValue) && isRecord(packageValue.scripts));
  const aliases = {
    'test:management': 'management', 'test:page-navigation': 'page-navigation',
    'test:activity': 'activity', 'test:usage': 'usage',
    'test:markdown-smoke': 'markdown', 'test:presentation-smoke': 'presentation',
    'test:virtual-list-perf': 'virtual-list-perf', 'test:native-chat-ui': 'native-chat-ui',
    'test:execution-journal': 'execution-journal'
  };
  for (const [alias, target] of Object.entries(aliases)) {
    const command: unknown = packageValue.scripts[alias];
    assert.equal(command, `node scripts/cli.ts test --browser --target ${target}`);
    const parsed = parseCliArguments(['test', '--browser', '--target', target]);
    assert.deepEqual(browserSmokeFiles(parsed.target), [`scripts/${target}-smoke.ts`]);
  }
  assert.equal(packageValue.scripts['test:browser'], 'node scripts/cli.ts test --browser');
  assert.equal(browserSmokeFiles().length, 10);
  assert.equal(new Set(browserSmokeFiles()).size, 10);
  assert(browserSmokeFiles().includes('scripts/browser-smoke.ts'));
  assert.equal(packageValue.scripts.test, 'node scripts/cli.ts test');
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const dependencies = packageValue[section];
    if (isRecord(dependencies)) {
      assert(Object.keys(dependencies).every(name => !name.includes('playwright') && !name.startsWith('@deepseek-ai/')));
    }
  }
});

test('execution browser target and native runtime acceptance remain inside the isolated no-emit typecheck', () => {
  const root = dirname(dirname(browserToolchainPaths().directory));
  assert.deepEqual(browserSmokeFiles('execution-journal'), ['scripts/execution-journal-smoke.ts']);
  const configuration: unknown = JSON.parse(readFileSync(join(root, 'tsconfig.browser.json'), 'utf8'));
  assert(isRecord(configuration) && isRecord(configuration.compilerOptions));
  assert.equal(configuration.compilerOptions.noEmit, true);
  assert.deepEqual(configuration.include, ['scripts/**/*-smoke.ts']);
  for (const filename of ['scripts/execution-journal-smoke.ts', 'scripts/native-chat-ui-smoke.ts']) {
    assert(filename.endsWith('-smoke.ts'));
    assert.equal(existsSync(join(root, filename)), true);
  }
  assert(browserSmokeFiles().includes('scripts/native-chat-ui-smoke.ts'));
  assert.match(readFileSync(join(root, 'scripts/native-chat-ui-smoke.ts'), 'utf8'), /createNativeCapabilityRuntimeFixture/);
});

test('optional SDK CI installs, tests and verifies the package tarball in its own locked job', () => {
  const root = dirname(dirname(browserToolchainPaths().directory));
  const workflow: unknown = parseYaml(readFileSync(join(root, '.github/workflows/verify.yml'), 'utf8'));
  assert(isRecord(workflow) && isRecord(workflow.jobs));
  const job = workflow.jobs['dsh-bridge-plugin'];
  assert(isRecord(job) && isRecord(job.defaults) && isRecord(job.defaults.run) && Array.isArray(job.steps));
  assert.equal(job.defaults.run['working-directory'], 'packages/dsh-bridge-plugin');
  const commands = job.steps.flatMap((step: unknown) => isRecord(step) && typeof step.run === 'string' ? [step.run] : []);
  assert.deepEqual(commands, ['npm ci --ignore-scripts --no-audit --no-fund', 'npm ci --ignore-scripts --no-audit --no-fund',
    'npm audit --audit-level=high', 'npm test', 'npm run test:framework', 'npm run test:pack']);
  const integration = job.steps.find((step: unknown) => isRecord(step) && step.run === 'npm run test:framework');
  assert(isRecord(integration) && isRecord(integration.env));
  assert.equal(integration.env.QQ_FRAMEWORK_DSH_PORT_MODULE, '${{ github.workspace }}/src/adapters/dsh-jsonrpc.ts');
  assert.equal(existsSync(join(root, 'packages/dsh-bridge-plugin/package-lock.json')), true);
});

test('browser resolver handles static imports from the isolated package, not the project package', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qq-agent-toolchain space-'));
  const isolated = browserToolchainPaths(directory).directory;
  const fixture = join(directory, 'smoke.ts');
  const hooks = registerBrowserToolchainResolver(isolated);
  try {
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
    for (const [root, marker] of [[directory, 'project'], [isolated, 'isolated']] as const) {
      const dependency = join(root, 'node_modules/playwright');
      mkdirSync(dependency, { recursive: true });
      writeFileSync(join(dependency, 'package.json'), JSON.stringify({
        name: 'playwright', marker, exports: { '.': './package.json', './package.json': './package.json' }
      }));
    }
    writeFileSync(fixture, 'import metadata from "playwright" with { type: "json" };\nexport default metadata;\n');
    const imported: unknown = await import(pathToFileURL(fixture).href);
    assert(isRecord(imported) && isRecord(imported.default));
    assert.equal(imported.default.marker, 'isolated');
    assert.throws(() => registerBrowserToolchainResolver('relative/directory'), /绝对路径/);
  } finally {
    hooks.deregister();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('browser resolver refuses to fall back to an unrelated project dependency', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qq-agent-toolchain-fallback-'));
  const dependency = join(directory, 'node_modules/playwright');
  mkdirSync(dependency, { recursive: true });
  writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: 'playwright', exports: './package.json' }));
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  const fixture = join(directory, 'smoke.ts');
  writeFileSync(fixture, 'import metadata from "playwright" with { type: "json" };\nexport default metadata;\n');
  const hooks = registerBrowserToolchainResolver(browserToolchainPaths(directory).directory);
  try {
    await assert.rejects(import(pathToFileURL(fixture).href), /浏览器测试依赖缺失/);
  } finally {
    hooks.deregister();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('uninstall removes only the isolated toolchain and preserves configurations and evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qq-agent-toolchain-remove-'));
  try {
    const paths = browserToolchainPaths(directory);
    assert.equal(paths.manifest, join(directory, 'runtime/testing/package.json'));
    assert.equal(paths.playwright, join(directory, 'runtime/testing/node_modules/playwright/cli.js'));
    assert.equal(paths.browsers, join(directory, 'runtime/testing/browsers'));
    const preserved = [
      'package.json', 'package-lock.json', 'node_modules/retained',
      'runtime/admin/config.json', 'runtime/sessions/state.json', 'runtime/ui-smoke/evidence.json'
    ];
    for (const filename of [...preserved, 'runtime/testing/browsers/download', 'runtime/testing/node_modules/installed']) {
      mkdirSync(dirname(join(directory, filename)), { recursive: true });
      writeFileSync(join(directory, filename), 'keep');
    }
    writeFileSync(paths.manifest, JSON.stringify({ name: 'qq-agent-browser-testing', private: true, type: 'module' }));
    uninstallBrowserToolchain(directory);
    assert.equal(existsSync(paths.directory), false);
    for (const filename of preserved) assert.equal(readFileSync(join(directory, filename), 'utf8'), 'keep');
    uninstallBrowserToolchain(directory);
    symlinkSync(join(directory, 'runtime/admin'), paths.directory, 'dir');
    assert.throws(() => uninstallBrowserToolchain(directory), /符号链接/);
    assert.equal(readFileSync(join(directory, 'runtime/admin/config.json'), 'utf8'), 'keep');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('uninstall refuses missing, foreign, invalid and symlinked markers without deleting data', () => {
  const markers: readonly (string | undefined)[] = [
    undefined,
    JSON.stringify({ name: 'foreign-browser-testing', private: true, type: 'module' }),
    JSON.stringify({ name: 'qq-agent-browser-testing', private: false, type: 'module' }),
    JSON.stringify({ name: 'qq-agent-browser-testing', private: true, type: 'commonjs' }),
    '{not-json', ' '.repeat(4097)
  ];
  for (const marker of markers) {
    const directory = mkdtempSync(join(tmpdir(), 'qq-agent-toolchain-unowned-'));
    try {
      const paths = browserToolchainPaths(directory);
      mkdirSync(paths.directory, { recursive: true });
      const retained = join(paths.directory, 'unrelated-data');
      writeFileSync(retained, 'preserve');
      if (marker !== undefined) writeFileSync(paths.manifest, marker);
      assert.throws(() => uninstallBrowserToolchain(directory), /安装标记/);
      assert.equal(readFileSync(retained, 'utf8'), 'preserve');
      assert.equal(existsSync(paths.manifest), marker !== undefined);
      if (marker !== undefined) assert.equal(readFileSync(paths.manifest, 'utf8'), marker);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  const directory = mkdtempSync(join(tmpdir(), 'qq-agent-toolchain-linked-marker-'));
  try {
    const paths = browserToolchainPaths(directory);
    mkdirSync(paths.directory, { recursive: true });
    const externalMarker = join(directory, 'external-package.json');
    const content = JSON.stringify({ name: 'qq-agent-browser-testing', private: true, type: 'module' });
    writeFileSync(externalMarker, content);
    symlinkSync(externalMarker, paths.manifest);
    const retained = join(paths.directory, 'unrelated-data');
    writeFileSync(retained, 'preserve');
    assert.throws(() => uninstallBrowserToolchain(directory), /安装标记/);
    assert.equal(readFileSync(retained, 'utf8'), 'preserve');
    assert.equal(readFileSync(externalMarker, 'utf8'), content);
    assert.equal(readFileSync(paths.manifest, 'utf8'), content);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('gateway preparation starts only an unused port and closes only the owned service', async context => {
  const values = fixture(await availablePort());
  let prepared: Awaited<ReturnType<typeof prepareGatewayForStart>> | undefined;
  context.after(async () => {
    await prepared?.close();
    rmSync(values.directory, { recursive: true, force: true });
  });
  prepared = await prepareGatewayForStart(values.gatewayConfiguration);
  assert.equal(prepared.started, true);
  const configuration = loadOneBotGatewayConfiguration(values.gatewayConfiguration);
  const response = await fetch(`http://127.0.0.1:${configuration.port}/health`, {
    headers: { authorization: `Bearer ${GATEWAY_SECRET}` }
  });
  assert.equal(response.status, 200);
  await prepared.close();
  await assert.rejects(fetch(`http://127.0.0.1:${configuration.port}/health`));
});

test('gateway preparation reuses only an exact healthy revision and leaves it running', async context => {
  const values = fixture(await availablePort());
  const service = await startOneBotGateway(loadOneBotGatewayConfiguration(values.gatewayConfiguration));
  context.after(async () => {
    await service.close();
    rmSync(values.directory, { recursive: true, force: true });
  });
  const prepared = await prepareGatewayForStart(values.gatewayConfiguration);
  assert.equal(prepared.started, false);
  await prepared.close();
  const response = await fetch(`http://127.0.0.1:${service.address.port}/health`, {
    headers: { authorization: `Bearer ${GATEWAY_SECRET}` }
  });
  assert.equal(response.status, 200);
});

test('gateway preparation rejects an occupied mismatched port without stopping its owner', async context => {
  const port = await availablePort();
  const values = fixture(port);
  const requests: string[] = [];
  const occupant = createServer((request, response) => {
    requests.push(request.headers.authorization ?? '');
    request.resume();
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, mode: 'onebot-egress', revision: 'different' }));
  });
  context.after(async () => {
    await close(occupant);
    rmSync(values.directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    occupant.once('error', rejectPromise);
    occupant.listen(port, '127.0.0.1', resolvePromise);
  });
  await assert.rejects(prepareGatewayForStart(values.gatewayConfiguration), /配置不匹配/);
  assert.deepEqual(requests, [`Bearer ${GATEWAY_SECRET}`]);
  assert.equal(occupant.listening, true);
});

test('configuration selection prefers explicit argument, then environment, then runtime default', () => {
  const directory = join(tmpdir(), 'cli-precedence');
  assert.equal(resolveConfigurationFilename('explicit.json', { QQ_AGENT_CONFIG: 'environment.json' }, directory),
    join(directory, 'explicit.json'));
  assert.equal(resolveConfigurationFilename(undefined, { QQ_AGENT_CONFIG: 'environment.json' }, directory),
    join(directory, 'environment.json'));
  assert.equal(resolveConfigurationFilename(undefined, {}, directory), join(directory, 'runtime/admin/config.json'));
});

test('standalone init creates private safe defaults, defers the admin token and never partially overwrites', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'qq-agent-cli-standalone-'));
  const conflictDirectory = mkdtempSync(join(tmpdir(), 'qq-agent-cli-conflict-'));
  let service: Awaited<ReturnType<typeof startGatewayAdmin>> | undefined;
  context.after(async () => {
    await service?.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(conflictDirectory, { recursive: true, force: true });
  });

  const output = capturedIo(directory);
  assert.equal(await runCli(['init'], output.io), 0);
  const runtimeDirectory = join(directory, 'runtime');
  const adminDirectory = join(runtimeDirectory, 'admin');
  const gatewayDirectory = join(runtimeDirectory, 'gateway');
  const adminConfiguration = join(adminDirectory, 'config.json');
  const adminToken = join(adminDirectory, 'gateway-admin.token');
  const gatewayConfiguration = join(gatewayDirectory, 'config.json');
  const gatewayToken = join(gatewayDirectory, 'gateway.token');
  for (const privateDirectory of [runtimeDirectory, adminDirectory, gatewayDirectory]) {
    assert.equal(statSync(privateDirectory).mode & 0o777, 0o700);
  }
  for (const privateFilename of [adminConfiguration, gatewayConfiguration, gatewayToken]) {
    assert.equal(statSync(privateFilename).mode & 0o777, 0o600);
  }

  const gateway = loadOneBotGatewayConfiguration(gatewayConfiguration);
  assert.equal(gateway.port, 3131);
  assert.equal(gateway.upstreamEndpoint, 'http://127.0.0.1:3000');
  assert.deepEqual(gateway.allowedConversations, []);
  assert.equal(gateway.budgetEnabled, false);
  assert.equal(gateway.timeoutMs, 60_000);
  assert.equal(Object.hasOwn(gateway, 'upstreamTokenFile'), false);
  const gatewaySecret = readFileSync(gatewayToken, 'utf8').trim();
  assert.match(gatewaySecret, /^[a-f0-9]{64}$/);
  assert.doesNotMatch([...output.stdout, ...output.stderr].join('\n'), new RegExp(gatewaySecret));

  const admin = JSON.parse(readFileSync(adminConfiguration, 'utf8')) as Record<string, unknown>;
  assert.equal(admin.host, '127.0.0.1');
  assert.equal(admin.port, 3210);
  assert.equal(existsSync(adminToken), false);
  admin.port = await availablePort();
  writeFileSync(adminConfiguration, JSON.stringify(admin, null, 2) + '\n', { mode: 0o600 });
  service = await startGatewayAdmin(loadGatewayAdminConfiguration(adminConfiguration), {
    configurationFilename: adminConfiguration
  });
  const address = `http://127.0.0.1:${service.address.port}`;
  const beforeSetup = await fetch(`${address}/api/setup`);
  const beforeSetupBody = await beforeSetup.json() as Record<string, unknown>;
  assert.equal(beforeSetupBody.canInitialize, true);
  assert.equal(existsSync(adminToken), false);
  const setupResponse = await fetch(`${address}/api/setup`, {
    method: 'POST',
    headers: { origin: address, 'content-type': 'application/json' },
    body: '{}'
  });
  const setupText = await setupResponse.text();
  assert.equal(setupResponse.status, 200);
  assert.equal(existsSync(adminToken), true);
  assert.equal(statSync(adminToken).mode & 0o777, 0o600);
  const adminSecret = readFileSync(adminToken, 'utf8').trim();
  assert.match(adminSecret, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(setupText, new RegExp(adminSecret));

  const beforeRetry = new Map([
    [adminConfiguration, readFileSync(adminConfiguration, 'utf8')],
    [gatewayConfiguration, readFileSync(gatewayConfiguration, 'utf8')],
    [gatewayToken, readFileSync(gatewayToken, 'utf8')],
    [adminToken, readFileSync(adminToken, 'utf8')]
  ]);
  assert.equal(await runCli(['init'], output.io), 1);
  for (const [filename, content] of beforeRetry) assert.equal(readFileSync(filename, 'utf8'), content);

  const conflictingGatewayDirectory = join(conflictDirectory, 'runtime/gateway');
  mkdirSync(conflictingGatewayDirectory, { recursive: true, mode: 0o700 });
  const conflictingToken = join(conflictingGatewayDirectory, 'gateway.token');
  privateFile(conflictingToken, 'existing-private-token\n');
  const conflictOutput = capturedIo(conflictDirectory);
  assert.equal(await runCli(['init'], conflictOutput.io), 1);
  assert.equal(readFileSync(conflictingToken, 'utf8'), 'existing-private-token\n');
  assert.equal(existsSync(join(conflictingGatewayDirectory, 'config.json')), false);
  assert.equal(existsSync(join(conflictDirectory, 'runtime/admin/config.json')), false);
});

test('init creates a private admin configuration without a token and never overwrites it', async () => {
  const values = fixture();
  try {
    const output = capturedIo(values.directory);
    const argumentsList = ['init', '--gateway-config', values.gatewayConfiguration, '--host', '127.0.0.1', '--port', '4321'];
    assert.equal(await runCli(argumentsList, output.io), 0);
    const adminConfiguration = join(values.directory, 'runtime/admin/config.json');
    const before = readFileSync(adminConfiguration, 'utf8');
    assert.equal(statSync(adminConfiguration).mode & 0o077, 0);
    assert.equal(readFileSync(adminConfiguration, 'utf8').includes(ADMIN_SECRET), false);
    assert.equal(readFileSync(adminConfiguration, 'utf8').includes(GATEWAY_SECRET), false);
    assert.equal(await runCli(argumentsList, output.io), 1);
    assert.equal(readFileSync(adminConfiguration, 'utf8'), before);
    assert.doesNotMatch([...output.stdout, ...output.stderr].join('\n'), new RegExp(`${ADMIN_SECRET}|${GATEWAY_SECRET}`));
  } finally {
    rmSync(values.directory, { recursive: true, force: true });
  }
});

test('init accepts only an explicit trusted service manager and never executes it', async () => {
  const values = fixture();
  try {
    const marker = join(values.directory, 'manager-ran');
    const manager = join(values.directory, 'service-manager');
    writeFileSync(manager, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o700 });
    chmodSync(manager, 0o722);
    const rejected = capturedIo(values.directory);
    assert.equal(await runCli([
      'init', '--gateway-config', values.gatewayConfiguration, '--service-manager', manager
    ], rejected.io), 1);
    assert.match(rejected.stderr.join('\n'), /不可被组或其他用户写入/);
    assert.equal(existsSync(join(values.directory, 'runtime')), false);
    assert.equal(existsSync(marker), false);

    chmodSync(manager, 0o700);
    const output = capturedIo(values.directory);
    assert.equal(await runCli([
      'init', '--gateway-config', values.gatewayConfiguration, '--service-manager', manager
    ], output.io), 0);
    const admin = JSON.parse(readFileSync(join(values.directory, 'runtime/admin/config.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(admin.serviceManager, manager);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(values.directory, { recursive: true, force: true });
  }
});

test('init rejects an existing admin deployment before preparing gateway files', async () => {
  const values = fixture();
  try {
    const adminConfiguration = join(values.directory, 'runtime/admin/config.json');
    mkdirSync(join(values.directory, 'runtime/admin'), { recursive: true, mode: 0o700 });
    privateFile(adminConfiguration, '{"existing":true}\n');
    const output = capturedIo(values.directory);
    assert.equal(await runCli(['init'], output.io), 1);
    assert.match(output.stderr.join('\n'), /管理配置已存在.*拒绝覆盖/);
    assert.equal(readFileSync(adminConfiguration, 'utf8'), '{"existing":true}\n');
    assert.equal(existsSync(join(values.directory, 'runtime/gateway')), false);
  } finally {
    rmSync(values.directory, { recursive: true, force: true });
  }
});

test('init clearly rejects advanced gateway endpoints that would self-proxy', async () => {
  const advanced = fixture();
  try {
    const advancedInput = JSON.parse(readFileSync(advanced.gatewayConfiguration, 'utf8')) as Record<string, unknown>;
    advancedInput.upstreamEndpoint = 'http://localhost:3131';
    writeFileSync(advanced.gatewayConfiguration, JSON.stringify(advancedInput), { mode: 0o600 });
    const advancedOutput = capturedIo(advanced.directory);
    assert.equal(await runCli(['init', '--gateway-config', advanced.gatewayConfiguration], advancedOutput.io), 1);
    assert.match(advancedOutput.stderr.join('\n'), /自代理风险.*拒绝初始化/);
    assert.equal(existsSync(join(advanced.directory, 'runtime/admin/config.json')), false);
  } finally {
    rmSync(advanced.directory, { recursive: true, force: true });
  }
});

test('status performs read-only health requests and does not print administrator credentials', async context => {
  const values = fixture();
  const requests: Array<{ readonly method: string | undefined; readonly url: string | undefined; readonly authorization: string | undefined }> = [];
  let expectedRevision = '';
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    request.resume();
    response.setHeader('content-type', 'application/json');
    if (request.url === '/health') response.end(JSON.stringify({ ok: true, mode: 'framework' }));
    else if (request.url === '/api/gateway/health') response.end(JSON.stringify({ ok: true, mode: 'gateway-live', revision: expectedRevision }));
    else { response.statusCode = 404; response.end(JSON.stringify({ secret: ADMIN_SECRET })); }
  });
  context.after(async () => {
    await close(server);
    rmSync(values.directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address() as AddressInfo;
  privateFile(join(values.directory, 'admin.token'), `${ADMIN_SECRET}\n`);
  const adminConfiguration = join(values.directory, 'admin.json');
  privateFile(adminConfiguration, JSON.stringify({
    host: '127.0.0.1',
    port: address.port,
    tokenFile: './admin.token',
    gatewayConfiguration: './gateway.json'
  }));
  const configuration = JSON.parse(readFileSync(adminConfiguration, 'utf8')) as Record<string, unknown>;
  configuration.tokenFile = join(values.directory, 'admin.token');
  configuration.gatewayConfiguration = values.gatewayConfiguration;
  const { createHash } = await import('node:crypto');
  expectedRevision = createHash('sha256').update(JSON.stringify(configuration)).digest('hex');

  const output = capturedIo(values.directory, { QQ_AGENT_CONFIG: join(values.directory, 'missing.json') });
  assert.equal(await runCli(['status', '--config', adminConfiguration], output.io), 0);
  assert.deepEqual(requests.map(request => [request.method, request.url]), [
    ['GET', '/health'],
    ['GET', '/api/gateway/health']
  ]);
  assert.equal(requests[0]?.authorization, undefined);
  assert.equal(requests[1]?.authorization, `Bearer ${ADMIN_SECRET}`);
  assert.doesNotMatch([...output.stdout, ...output.stderr].join('\n'), new RegExp(`${ADMIN_SECRET}|${GATEWAY_SECRET}`));
});

test('doctor requires one canonical conversation and accepts only read configuration options', () => {
  assert.equal(parseCliArguments(['doctor', '--conversation', 'group:123']).conversation, 'group:123');
  assert.equal(parseCliArguments(['doctor', '--conversation', 'private:123', '--config', '/tmp/admin.json']).command, 'doctor');
  assert.equal(parseCliArguments(['doctor', '--conversation', 'private:123', '--account', 'a'.repeat(64)]).account, 'a'.repeat(64));
  for (const args of [['doctor'], ['doctor', '--conversation', 'group:0'], ['doctor', '--conversation', 'group:123', '--admin-only'],
    ['status', '--conversation', 'group:123'], ['doctor', '--conversation', 'private:123', '--account', '123'],
    ['status', '--account', 'a'.repeat(64)]]) assert.throws(() => parseCliArguments(args));
});

test('doctor sends authenticated read-only requests for the exact conversation and optional account and rejects invalid evidence', async context => {
  const values = fixture();
  const requests: { method: string | undefined; url: URL; authorization: string | undefined }[] = [];
  let invalid = false;
  const diagnosis = projectNativeDiagnostics({ conversationId: 'group:123', running: false, globalReasons: [],
    accessAllowed: false, authorized: null, input: null, history: null, historyState: 'absent', pendingInteractions: 0 });
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: new URL(request.url!, 'http://localhost'), authorization: request.headers.authorization });
    request.resume(); response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(invalid ? { secret: ADMIN_SECRET, state: 'ready' } : diagnosis));
  });
  context.after(async () => { await close(server); rmSync(values.directory, { recursive: true, force: true }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  privateFile(join(values.directory, 'admin.token'), ADMIN_SECRET);
  const filename = join(values.directory, 'admin.json');
  privateFile(filename, JSON.stringify({ host: '127.0.0.1', port: (server.address() as AddressInfo).port,
    tokenFile: './admin.token', gatewayConfiguration: './gateway.json' }));
  const output = capturedIo(values.directory);
  const args = ['doctor', '--conversation', 'group:123', '--config', filename];
  assert.equal(await runCli(args, output.io), 0);
  assert.deepEqual(JSON.parse(output.stdout[0]), diagnosis);
  assert.equal(await runCli([...args, '--account', 'a'.repeat(64)], output.io), 0);
  assert.equal(requests[0].url.pathname, '/api/chat/diagnostics');
  assert.equal(requests[1].url.pathname, '/api/accounts/dispatch');
  assert.equal(requests[1].url.searchParams.get('account'), 'a'.repeat(64));
  assert.equal(requests[1].url.searchParams.get('path'), '/api/chat/diagnostics');
  for (const request of requests) {
    assert.equal(request.method, 'GET'); assert.equal(request.url.searchParams.get('conversationId'), 'group:123');
    assert.equal(request.authorization, `Bearer ${ADMIN_SECRET}`);
  }
  invalid = true;
  assert.equal(await runCli(args, output.io), 1);
  assert.doesNotMatch([...output.stdout, ...output.stderr].join('\n'), new RegExp(ADMIN_SECRET));
});
