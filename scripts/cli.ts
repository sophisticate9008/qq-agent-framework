#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { connect, isIP } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  gatewayAdminAddress,
  loadGatewayAdminConfiguration,
  startGatewayAdmin,
  type GatewayAdminConfiguration
} from '../src/admin/gateway.ts';
import { errorCode, isRecord } from '../src/core/values.ts';
import {
  loadOneBotGatewayConfiguration,
  startOneBotGateway,
  type OneBotGatewayConfiguration
} from '../src/host/onebot-gateway.ts';
import { prepareLegacyGateway } from '../src/integrations/legacy-gateway.ts';

const PLAYWRIGHT_VERSION = '1.61.1';
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const PROJECT_ROOT = basename(sourceRoot) === 'dist' ? dirname(sourceRoot) : sourceRoot;
const BROWSER_SMOKES = Object.freeze([
  'scripts/browser-smoke.ts',
  'scripts/management-smoke.ts',
  'scripts/page-navigation-smoke.ts',
  'scripts/markdown-smoke.ts',
  'scripts/presentation-smoke.ts'
]);

type CliCommand = 'init' | 'start' | 'status' | 'test' | 'build';

export interface ParsedCliArguments {
  readonly command: CliCommand;
  readonly help: boolean;
  readonly config?: string;
  readonly gatewayConfig?: string;
  readonly legacyRoot?: string;
  readonly serviceManager?: string;
  readonly host?: string;
  readonly port?: number;
  readonly browser: boolean;
  readonly withDeps: boolean;
  readonly adminOnly: boolean;
}

export interface CliIo {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

class CliUsageError extends Error {}
class CliOperationError extends Error {}

const DEFAULT_IO: CliIo = {
  cwd: process.cwd(),
  env: process.env,
  stdout: message => console.log(message),
  stderr: message => console.error(message)
};

const GENERAL_HELP = `QQ Agent Framework 命令行

用法：
  npm run cli -- init [--config <管理配置>] [--service-manager <可信程序>] [--host <地址>] [--port <端口>]
  npm run cli -- init --bridge-dir /path/to/qq-bridge [--config <管理配置>] [--service-manager <可信程序>] [--host <地址>] [--port <端口>]
  npm run cli -- init --gateway-config <网关配置> [--config <管理配置>] [--service-manager <可信程序>] [--host <地址>] [--port <端口>]
  npm run cli -- start [--config <管理配置>] [--admin-only]
  npm run cli -- status [--config <管理配置>]
  npm run cli -- test [--browser] [--with-deps]
  npm run cli -- build

配置优先级：--config > QQ_AGENT_CONFIG > runtime/admin/config.json
init 默认创建独立的本机 OneBot HTTP 网关配置；不需要 qq-bridge，也不声明 DSH 已接入。
--bridge-dir 仅用于迁移已有 qq-bridge；--gateway-config 用于复用已严格校验的高级网关配置，两者互斥。
默认上游为 http://127.0.0.1:3000，网关监听 127.0.0.1:3131，管理端监听 127.0.0.1:3210。
新配置不允许任何会话发送；请首次访问管理网页生成管理令牌，再显式配置外部 OneBot 和发送范围。
只有显式提供 --service-manager 时才启用服务管理，不会自动猜测或执行脚本。
start 默认启动或复用配置匹配的 gateway；--admin-only 仅启动管理界面。
普通启动和测试不需要 Playwright；只有 test --browser 会按需安装。`;

function usage(message: string): never {
  throw new CliUsageError(message);
}

function optionValue(argumentsList: readonly string[], index: number, option: string): string {
  const value = argumentsList[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith('--')) usage(`参数 ${option} 缺少值。`);
  return value;
}

export function parseCliArguments(argumentsList: readonly string[]): ParsedCliArguments {
  const first = argumentsList[0];
  if (first === undefined) usage('缺少命令。');
  if (first === '--help' || first === '-h' || first === 'help') {
    if (argumentsList.length !== 1) usage('帮助命令不接受其他参数。');
    return { command: 'start', help: true, browser: false, withDeps: false, adminOnly: false };
  }
  if (!['init', 'start', 'status', 'test', 'build'].includes(first)) usage('未知命令。');
  const command = first as CliCommand;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 1; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]!;
    if (argument === '--help' || argument === '-h') {
      if (argumentsList.length !== 2) usage('帮助参数不能与其他参数同时使用。');
      return { command, help: true, browser: false, withDeps: false, adminOnly: false };
    }
    if (['--browser', '--with-deps', '--admin-only'].includes(argument)) {
      if (flags.has(argument)) usage(`参数 ${argument} 不能重复。`);
      flags.add(argument);
      continue;
    }
    if (['--config', '--gateway-config', '--bridge-dir', '--legacy-root', '--service-manager', '--host', '--port'].includes(argument)) {
      if (values.has(argument)) usage(`参数 ${argument} 不能重复。`);
      values.set(argument, optionValue(argumentsList, index, argument));
      index += 1;
      continue;
    }
    usage('存在无法识别的参数。');
  }

  const allowed = command === 'init'
    ? new Set(['--config', '--gateway-config', '--bridge-dir', '--legacy-root', '--service-manager', '--host', '--port'])
    : command === 'start' ? new Set(['--config', '--admin-only'])
      : command === 'status' ? new Set(['--config'])
      : command === 'test' ? new Set(['--browser', '--with-deps']) : new Set<string>();
  for (const option of [...values.keys(), ...flags]) {
    if (!allowed.has(option)) usage(`命令 ${command} 不支持参数 ${option}。`);
  }
  if (command === 'init') {
    if (values.has('--bridge-dir') && values.has('--legacy-root')) {
      usage('--bridge-dir 与兼容别名 --legacy-root 不能同时提供。');
    }
    const bridgeDirectory = values.has('--bridge-dir') || values.has('--legacy-root');
    const sources = Number(values.has('--gateway-config')) + Number(bridgeDirectory);
    if (sources > 1) usage('--bridge-dir 与 --gateway-config 互斥，不能同时提供。');
  }
  if (flags.has('--with-deps') && !flags.has('--browser')) usage('--with-deps 只能与 --browser 一起使用。');
  const portText = values.get('--port');
  if (portText !== undefined && !/^[1-9]\d{0,4}$/.test(portText)) usage('--port 必须是 1 到 65535 的整数。');
  const port = portText === undefined ? undefined : Number(portText);
  if (port !== undefined && port > 65_535) usage('--port 必须是 1 到 65535 的整数。');
  return {
    command,
    help: false,
    ...(values.has('--config') ? { config: values.get('--config')! } : {}),
    ...(values.has('--gateway-config') ? { gatewayConfig: values.get('--gateway-config')! } : {}),
    ...(values.has('--bridge-dir') || values.has('--legacy-root')
      ? { legacyRoot: values.get('--bridge-dir') ?? values.get('--legacy-root')! }
      : {}),
    ...(values.has('--service-manager') ? { serviceManager: values.get('--service-manager')! } : {}),
    ...(values.has('--host') ? { host: values.get('--host')! } : {}),
    ...(port === undefined ? {} : { port }),
    browser: flags.has('--browser'),
    withDeps: flags.has('--with-deps'),
    adminOnly: flags.has('--admin-only')
  };
}

export function resolveConfigurationFilename(
  explicit: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): string {
  const selected = explicit ?? environment.QQ_AGENT_CONFIG ?? 'runtime/admin/config.json';
  if (selected.length === 0) usage('QQ_AGENT_CONFIG 不能为空。');
  return resolve(cwd, selected);
}

function trustedServiceManager(filename: string, cwd: string): string {
  const selected = resolve(cwd, filename);
  let metadata: Stats;
  try {
    metadata = lstatSync(selected);
  } catch {
    throw new CliOperationError('--service-manager 必须指向已存在的可信可执行文件。');
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o111) === 0 || (metadata.mode & 0o022) !== 0) {
    throw new CliOperationError('--service-manager 必须是不可被组或其他用户写入的普通可执行文件，且不能是符号链接。');
  }
  return selected;
}

function gatewayRuntimeDirectory(configurationFilename: string): string {
  const configurationDirectory = dirname(configurationFilename);
  const privateRoot = basename(configurationDirectory) === 'admin'
    ? dirname(configurationDirectory)
    : configurationDirectory;
  return join(privateRoot, 'gateway');
}

function pathExists(filename: string): boolean {
  try {
    lstatSync(filename);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function preflightAbsent(files: readonly string[]): void {
  const duplicate = new Set(files).size !== files.length;
  if (duplicate) throw new CliOperationError('初始化目标路径发生冲突，未创建任何文件。');
  const existing = files.find(pathExists);
  if (existing !== undefined) throw new CliOperationError(`初始化目标已存在，拒绝覆盖：${existing}`);
}

function privateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) {
    throw new CliOperationError(`初始化目录必须是权限 0700 的真实目录：${directory}`);
  }
}

function writePrivateFile(filename: string, content: string, createdFiles: string[]): void {
  writeFileSync(filename, content, { mode: 0o600, flag: 'wx' });
  createdFiles.push(filename);
  chmodSync(filename, 0o600);
  const metadata = lstatSync(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
    throw new CliOperationError(`初始化文件必须是权限 0600 的普通文件：${filename}`);
  }
}

function assertDistinctGatewayEndpoint(configuration: Readonly<OneBotGatewayConfiguration>): void {
  const upstream = new URL(configuration.upstreamEndpoint);
  const upstreamPort = Number(upstream.port || '80');
  if (configuration.port !== 0 && upstreamPort === configuration.port) {
    throw new CliOperationError('OneBot 上游端点不能指向网关自身，存在自代理风险，拒绝初始化。');
  }
}

function writeAdminConfiguration(options: {
  readonly filename: string;
  readonly gatewayConfiguration: string;
  readonly legacyRoot?: string;
  readonly serviceManager?: string;
  readonly host?: string;
  readonly port?: number;
  readonly createdFiles: string[];
}): void {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 3210;
  if (host !== 'localhost' && isIP(host) === 0) {
    throw new CliOperationError('--host 必须是明确的 IP 地址或 localhost。');
  }
  const tokenFile = join(dirname(options.filename), 'gateway-admin.token');
  const markerFile = `${tokenFile}.initialized`;
  preflightAbsent([options.filename, tokenFile, markerFile]);
  privateDirectory(dirname(options.filename));
  writePrivateFile(options.filename, JSON.stringify({
    host,
    port,
    tokenFile,
    gatewayConfiguration: options.gatewayConfiguration,
    ...(options.legacyRoot === undefined ? {} : { legacyRoot: options.legacyRoot }),
    ...(options.serviceManager === undefined ? {} : { serviceManager: options.serviceManager })
  }, null, 2) + '\n', options.createdFiles);
  loadGatewayAdminConfiguration(options.filename);
}

function standaloneGatewayFiles(configurationFilename: string): {
  readonly configuration: string;
  readonly token: string;
  readonly store: string;
} {
  const directory = gatewayRuntimeDirectory(configurationFilename);
  return Object.freeze({
    configuration: join(directory, 'config.json'),
    token: join(directory, 'gateway.token'),
    store: join(directory, 'gateway.sqlite')
  });
}

function adminInitializationFiles(configurationFilename: string): readonly string[] {
  const tokenFile = join(dirname(configurationFilename), 'gateway-admin.token');
  return Object.freeze([configurationFilename, tokenFile, `${tokenFile}.initialized`]);
}

function preflightLegacyGateway(legacyRoot: string, configurationFilename: string): void {
  const runtimeDirectory = gatewayRuntimeDirectory(configurationFilename);
  const migration = join(runtimeDirectory, 'migration.json');
  if (pathExists(migration)) return;
  preflightAbsent([
    join(runtimeDirectory, 'legacy-config-before.json'),
    join(runtimeDirectory, 'gateway.token'),
    join(runtimeDirectory, 'gateway.sqlite'),
    join(legacyRoot, 'config/local/framework-gateway.json'),
    migration
  ]);
}

function writeStandaloneGateway(configurationFilename: string, createdFiles: string[]): string {
  const files = standaloneGatewayFiles(configurationFilename);
  preflightAbsent([files.configuration, files.token, files.store]);
  privateDirectory(dirname(files.configuration));
  writePrivateFile(files.token, `${randomBytes(32).toString('hex')}\n`, createdFiles);
  writePrivateFile(files.configuration, JSON.stringify({
    port: 3131,
    upstreamEndpoint: 'http://127.0.0.1:3000',
    tokenFile: './gateway.token',
    storeFilename: './gateway.sqlite',
    allowedConversations: [],
    persona: { id: 'standalone-onebot', version: '1.0.0' },
    timeoutMs: 60_000,
    budgetEnabled: false
  }, null, 2) + '\n', createdFiles);
  const configuration = loadOneBotGatewayConfiguration(files.configuration);
  assertDistinctGatewayEndpoint(configuration);
  return files.configuration;
}

function cliErrorMessage(error: unknown): string {
  if (error instanceof CliOperationError) return error.message;
  const code = errorCode(error, 'CLI_FAILED');
  if (code === 'LEGACY_PREPARE_CONFLICT') return '检测到已有 gateway 部署文件，拒绝覆盖；请先核对现有部署。';
  if (code === 'LEGACY_INVALID_UPSTREAM') return '旧 bridge 端点不是独立的本机 HTTP 上游，存在自代理风险，拒绝初始化。';
  return code;
}

function runProcess(executable: string, argumentsList: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, argumentsList, {
      cwd: PROJECT_ROOT,
      env: process.env,
      shell: false,
      stdio: 'inherit'
    });
    child.once('error', rejectPromise);
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new CliOperationError(signal === null
        ? `子进程退出，状态码 ${code ?? 'unknown'}。`
        : `子进程被信号 ${signal} 终止。`));
    });
  });
}

function nodeArguments(...argumentsList: string[]): readonly string[] {
  return argumentsList.map(argument => resolve(PROJECT_ROOT, argument));
}

async function build(webOnly = false): Promise<void> {
  await runProcess(process.execPath, [resolve(PROJECT_ROOT, 'scripts/build.ts'), ...(webOnly ? ['--web'] : [])]);
}

function playwrightInstalled(): boolean {
  try {
    const filename = resolve(PROJECT_ROOT, 'node_modules/playwright/package.json');
    const value: unknown = JSON.parse(readFileSync(filename, 'utf8'));
    return isRecord(value) && value.version === PLAYWRIGHT_VERSION;
  } catch {
    return false;
  }
}

async function prepareBrowser(withDeps: boolean): Promise<void> {
  if (!playwrightInstalled()) {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    await runProcess(npm, [
      'install',
      '--no-save',
      '--package-lock=false',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `playwright@${PLAYWRIGHT_VERSION}`
    ]);
  }
  const playwrightCli = resolve(PROJECT_ROOT, 'node_modules/playwright/cli.js');
  if (!existsSync(playwrightCli)) throw new CliOperationError('Playwright 安装不完整。');
  await runProcess(process.execPath, [playwrightCli, 'install', ...(withDeps ? ['--with-deps'] : []), 'chromium']);
}

function testFiles(directory: string, extension: '.ts' | '.js'): readonly string[] {
  const root = resolve(PROJECT_ROOT, directory);
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(`.test${extension}`))
    .map(entry => join(root, entry.name))
    .sort();
}

async function runTests(browser: boolean, withDeps: boolean): Promise<void> {
  if (!browser) {
    await build();
    await runProcess(process.execPath, ['--test', ...testFiles('test', '.ts')]);
    await runProcess(process.execPath, ['--test', ...testFiles('dist/test', '.js')]);
    return;
  }
  await prepareBrowser(withDeps);
  await runProcess(process.execPath, [
    resolve(PROJECT_ROOT, 'node_modules/typescript/bin/tsc'),
    '-p',
    resolve(PROJECT_ROOT, 'tsconfig.browser.json'),
    '--noEmit'
  ]);
  await build();
  for (const smoke of BROWSER_SMOKES) await runProcess(process.execPath, nodeArguments(smoke));
}

function revision(configuration: Readonly<GatewayAdminConfiguration> | Readonly<OneBotGatewayConfiguration>): string {
  return createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
}

type PortState = 'open' | 'closed' | 'unknown';

function gatewayPortState(port: number): Promise<PortState> {
  return new Promise(resolvePromise => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (state: PortState): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(state);
    };
    socket.setTimeout(1_500);
    socket.once('connect', () => finish('open'));
    socket.once('timeout', () => finish('unknown'));
    socket.once('error', error => finish('code' in error && error.code === 'ECONNREFUSED' ? 'closed' : 'unknown'));
  });
}

export interface PreparedGateway {
  readonly started: boolean;
  close(): Promise<void>;
}

export async function prepareGatewayForStart(configurationFilename: string): Promise<PreparedGateway> {
  const configuration = loadOneBotGatewayConfiguration(configurationFilename);
  assertDistinctGatewayEndpoint(configuration);
  if (configuration.port === 0) {
    throw new CliOperationError('统一启动要求 gateway 配置使用固定非零端口；仅启动管理界面可使用 --admin-only。');
  }
  const portState = await gatewayPortState(configuration.port);
  if (portState === 'unknown') throw new CliOperationError('无法安全确认 gateway 端口状态，未启动任何服务。');
  if (portState === 'open') {
    const token = readFileSync(configuration.tokenFile, 'utf8').trim();
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${configuration.port}/health`, {
        headers: { authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(2_500)
      });
    } catch {
      throw new CliOperationError('gateway 端口已被占用，但无法验证现有服务。');
    }
    const health = await readJson(response);
    if (!response.ok || !isRecord(health) || health.ok !== true
      || health.mode !== 'legacy-egress-compatibility' || health.revision !== revision(configuration)) {
      throw new CliOperationError('gateway 端口已被其他或配置不匹配的服务占用。');
    }
    return Object.freeze({ started: false, async close() {} });
  }
  const service = await startOneBotGateway(configuration);
  return Object.freeze({ started: true, close: () => service.close() });
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new CliOperationError('管理服务返回了无效响应。');
  }
}

async function status(configurationFilename: string, output: (message: string) => void): Promise<void> {
  const configuration = loadGatewayAdminConfiguration(configurationFilename);
  const address = gatewayAdminAddress(configuration);
  let publicResponse: Response;
  try {
    publicResponse = await fetch(`${address}/health`, { redirect: 'error', signal: AbortSignal.timeout(5_000) });
  } catch {
    throw new CliOperationError('无法连接管理服务。');
  }
  const publicHealth = await readJson(publicResponse);
  if (!publicResponse.ok || !isRecord(publicHealth) || publicHealth.ok !== true || publicHealth.mode !== 'framework') {
    throw new CliOperationError('管理服务健康检查失败。');
  }
  if (!existsSync(configuration.tokenFile)) {
    output(`管理服务可访问，等待首次网页初始化：${address}`);
    return;
  }
  const token = readFileSync(configuration.tokenFile, 'utf8').trim();
  let gatewayResponse: Response;
  try {
    gatewayResponse = await fetch(`${address}/api/gateway/health`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(5_000)
    });
  } catch {
    throw new CliOperationError('无法读取网关健康状态。');
  }
  const gatewayHealth = await readJson(gatewayResponse);
  if (!gatewayResponse.ok || !isRecord(gatewayHealth) || gatewayHealth.ok !== true
    || gatewayHealth.mode !== 'gateway-live' || gatewayHealth.revision !== revision(configuration)) {
    throw new CliOperationError('网关管理服务尚未就绪。');
  }
  output(`管理服务运行正常：${address}`);
}

async function start(configurationFilename: string, adminOnly: boolean, output: (message: string) => void): Promise<void> {
  const configuration = loadGatewayAdminConfiguration(configurationFilename);
  await build(true);
  let gateway: PreparedGateway | undefined;
  let service: Awaited<ReturnType<typeof startGatewayAdmin>>;
  try {
    if (!adminOnly) gateway = await prepareGatewayForStart(configuration.gatewayConfiguration);
    service = await startGatewayAdmin(configuration, { configurationFilename });
  } catch (error: unknown) {
    if (gateway?.started) await gateway.close();
    throw error;
  }
  output(`${gateway?.started ? 'gateway 与管理服务' : adminOnly ? '管理服务' : '现有 gateway 与管理服务'}已启动：${gatewayAdminAddress({
    ...configuration,
    port: service.address.port
  })}`);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let closing = false;
    const handlers = new Map<NodeJS.Signals, () => void>();
    const cleanup = (): void => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
    const close = (): void => {
      if (closing) return;
      closing = true;
      void (async () => {
        try {
          await service.close();
          if (gateway?.started) await gateway.close();
          cleanup();
          resolvePromise();
        } catch (error: unknown) {
          if (gateway?.started) await gateway.close().catch(() => undefined);
          cleanup();
          rejectPromise(error);
        }
      })();
    };
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
      const handler = (): void => close();
      handlers.set(signal, handler);
      process.once(signal, handler);
    }
  });
}

export async function runCli(argumentsList: readonly string[], io: CliIo = DEFAULT_IO): Promise<number> {
  let parsed: ParsedCliArguments;
  try {
    parsed = parseCliArguments(argumentsList);
  } catch (error: unknown) {
    io.stderr(error instanceof CliUsageError ? error.message : '参数解析失败。');
    io.stderr(GENERAL_HELP);
    return 1;
  }
  if (parsed.help) {
    io.stdout(GENERAL_HELP);
    return 0;
  }
  try {
    if (parsed.command === 'init') {
      const configurationFilename = resolveConfigurationFilename(parsed.config, io.env, io.cwd);
      if (pathExists(configurationFilename)) {
        throw new CliOperationError('管理配置已存在，拒绝覆盖已有部署。');
      }
      const serviceManager = parsed.serviceManager === undefined
        ? undefined
        : trustedServiceManager(parsed.serviceManager, io.cwd);
      const legacyRoot = parsed.legacyRoot === undefined ? undefined : resolve(io.cwd, parsed.legacyRoot);
      preflightAbsent(adminInitializationFiles(configurationFilename));
      if (legacyRoot !== undefined) preflightLegacyGateway(legacyRoot, configurationFilename);
      if (legacyRoot === undefined && parsed.gatewayConfig === undefined) {
        const standalone = standaloneGatewayFiles(configurationFilename);
        preflightAbsent([standalone.configuration, standalone.token, standalone.store]);
      }
      const createdFiles: string[] = [];
      try {
        const gatewayConfigurationFilename = legacyRoot !== undefined
          ? prepareLegacyGateway({
            legacyRoot,
            runtimeDirectory: gatewayRuntimeDirectory(configurationFilename)
          }).gatewayConfiguration
          : parsed.gatewayConfig !== undefined
            ? resolve(io.cwd, parsed.gatewayConfig)
            : writeStandaloneGateway(configurationFilename, createdFiles);
        const gatewayConfiguration = loadOneBotGatewayConfiguration(gatewayConfigurationFilename);
        assertDistinctGatewayEndpoint(gatewayConfiguration);
        writeAdminConfiguration({
          filename: configurationFilename,
          gatewayConfiguration: gatewayConfigurationFilename,
          ...(legacyRoot === undefined ? {} : { legacyRoot }),
          ...(serviceManager === undefined ? {} : { serviceManager }),
          ...(parsed.host === undefined ? {} : { host: parsed.host }),
          ...(parsed.port === undefined ? {} : { port: parsed.port }),
          createdFiles
        });
      } catch (error: unknown) {
        for (const filename of createdFiles.reverse()) {
          try { unlinkSync(filename); } catch {}
        }
        throw error;
      }
      io.stdout(`管理配置已创建：${configurationFilename}`);
      const address = gatewayAdminAddress(loadGatewayAdminConfiguration(configurationFilename));
      io.stdout(`启动后访问 ${address}，首次网页访问将生成管理令牌。`);
    } else if (parsed.command === 'start') {
      await start(resolveConfigurationFilename(parsed.config, io.env, io.cwd), parsed.adminOnly, io.stdout);
    } else if (parsed.command === 'status') {
      await status(resolveConfigurationFilename(parsed.config, io.env, io.cwd), io.stdout);
    } else if (parsed.command === 'test') {
      await runTests(parsed.browser, parsed.withDeps);
    } else {
      await build();
    }
    return 0;
  } catch (error: unknown) {
    io.stderr(cliErrorMessage(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
