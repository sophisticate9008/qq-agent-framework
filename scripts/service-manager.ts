import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Protocol = 'napcat' | 'snowluma';
type Group = 'core' | Protocol | 'optional';
interface Command { command: string; args: string[]; cwd?: string }
type Ready = { kind: 'http'; url: string } | ({ kind: 'command' } & Command);
interface Service {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  screen: string;
  screenAliases?: string[];
  logFile?: string;
  ready?: Ready;
  prepare?: Command;
  port?: { host: string; port: number };
  consoleUrl?: string;
  group: Group;
  enabled?: boolean;
}
interface Configuration {
  schema: 1;
  activeProtocol: Protocol;
  dshHome: string;
  logDirectory: string;
  lockFile: string;
  services: Record<string, Service>;
  order?: string[];
  accountCheck?: Command;
}
interface CommandResult { code: number; output: string }
interface ProcessIdentity { pid: number; parent: number; started: string }

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = fileURLToPath(import.meta.url);
const configFile = path.join(root, 'runtime/live/services.json');
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const sleep = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

class OperationError extends Error {}
function fail(message: string): never { throw new OperationError(message); }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function string(value: unknown, limit = 8192): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !value.includes('\0');
}
function absolute(value: unknown): value is string { return string(value) && path.isAbsolute(value); }
function args(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 128 && value.every(item => typeof item === 'string' && item.length <= 8192 && !item.includes('\0'));
}
function command(value: unknown): value is Command {
  return record(value) && absolute(value.command) && args(value.args) && (value.cwd === undefined || absolute(value.cwd));
}
function safeUrl(value: unknown, local: boolean): value is string {
  if (!string(value, 2048)) return false;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      && !parsed.search && !parsed.hash && (!local || loopback.has(parsed.hostname));
  } catch { return false; }
}
function decode(value: unknown): Configuration {
  if (!record(value) || value.schema !== 1 || !['napcat', 'snowluma'].includes(String(value.activeProtocol))
    || !absolute(value.dshHome) || !absolute(value.logDirectory) || !absolute(value.lockFile)
    || !record(value.services) || Object.keys(value.services).length === 0 || Object.keys(value.services).length > 32
    || (value.accountCheck !== undefined && !command(value.accountCheck))) fail('服务配置格式无效。');
  const services = value.services;
  const screens = new Set<string>();
  for (const [id, service] of Object.entries(value.services)) {
    if (!identifier.test(id) || !record(service) || !command(service) || !absolute(service.cwd)
      || !string(service.screen, 64) || !identifier.test(service.screen)
      || !['core', 'napcat', 'snowluma', 'optional'].includes(String(service.group))
      || (service.enabled !== undefined && typeof service.enabled !== 'boolean')
      || (service.logFile !== undefined && !absolute(service.logFile))
      || (service.consoleUrl !== undefined && !safeUrl(service.consoleUrl, false))
      || (service.prepare !== undefined && !command(service.prepare))) fail('服务配置格式无效。');
    if (service.env !== undefined && (!record(service.env) || Object.keys(service.env).length > 128
      || Object.entries(service.env).some(([key, content]) => !/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(key) || typeof content !== 'string' || content.length > 32768 || content.includes('\0')))) fail('服务环境配置格式无效。');
    if (service.screenAliases !== undefined && (!Array.isArray(service.screenAliases) || service.screenAliases.length > 8
      || service.screenAliases.some(alias => typeof alias !== 'string' || !identifier.test(alias)))) fail('服务会话配置格式无效。');
    const names = [service.screen, ...(Array.isArray(service.screenAliases) ? service.screenAliases as string[] : [])];
    for (const name of names) {
      if (screens.has(name)) fail('服务会话名称重复。');
      screens.add(name);
    }
    if (service.port !== undefined && (!record(service.port) || !string(service.port.host) || !loopback.has(service.port.host)
      || typeof service.port.port !== 'number' || !Number.isInteger(service.port.port) || service.port.port < 1 || service.port.port > 65535)) fail('服务端口配置格式无效。');
    if (service.ready !== undefined && (!record(service.ready)
      || (service.ready.kind === 'http' ? !safeUrl(service.ready.url, true) : service.ready.kind !== 'command' || !command(service.ready)))) fail('服务就绪配置格式无效。');
  }
  if (value.order !== undefined && (!Array.isArray(value.order) || value.order.length > 32
    || value.order.some(id => typeof id !== 'string' || !Object.hasOwn(services, id))
    || new Set(value.order).size !== value.order.length)) fail('服务启动顺序无效。');
  const dsh = services.dsh;
  if (dsh !== undefined && (!record(dsh) || !record(dsh.env) || dsh.env.DSH_HOME !== value.dshHome)) fail('DSH 服务的实际主目录与部署标识不一致。');
  return value as unknown as Configuration;
}

async function load(): Promise<Configuration> {
  try {
    const file = await open(configFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024 || (info.mode & 0o077) !== 0
        || (process.getuid && info.uid !== process.getuid())) fail('服务配置须由当前用户持有并限制为私有文件。');
      return decode(JSON.parse(await file.readFile('utf8')) as unknown);
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof OperationError) throw error;
    fail('无法读取私有服务配置 runtime/live/services.json。');
  }
}

async function execute(executable: string, argumentsList: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; inherit?: boolean } = {}): Promise<CommandResult> {
  return new Promise(resolve => {
    let output = '';
    let finished = false;
    const child = spawn(executable, argumentsList, { cwd: options.cwd, env: options.env, shell: false, detached: !options.inherit, stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'ignore'] });
    const finish = (code: number): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ code, output });
    };
    child.stdout?.on('data', (data: Buffer) => {
      if (output.length < 131072) output += data.toString('utf8').slice(0, 131072 - output.length);
    });
    const timer = setTimeout(() => {
      if (!options.inherit && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Process already exited. */ }
      } else child.kill('SIGKILL');
      finish(124);
    }, options.timeout ?? 3000);
    child.on('error', () => finish(127));
    child.on('close', code => finish(code ?? 1));
  });
}

async function sessions(service: Service): Promise<string[]> {
  const result = await execute('/usr/bin/screen', ['-ls']);
  const names = new Set([service.screen, ...(service.screenAliases ?? [])]);
  return result.output.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\.([^\s]+)\s+\(/.exec(line);
    return match && names.has(match[2]!) && !line.includes('(Dead') ? [`${match[1]}.${match[2]}`] : [];
  });
}
async function listening(service: Service): Promise<boolean> {
  if (!service.port) return false;
  const port = service.port;
  return new Promise(resolve => {
    const socket = createConnection({ host: port.host.replace(/^\[|\]$/g, ''), port: port.port });
    const finish = (result: boolean): void => { socket.destroy(); resolve(result); };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
async function ready(service: Service, timeout = 8000): Promise<boolean> {
  if (!service.ready) return service.port ? listening(service) : (await sessions(service)).length > 0;
  if (service.ready.kind === 'command') {
    return (await execute(service.ready.command, service.ready.args, { cwd: service.ready.cwd ?? service.cwd, env: { ...process.env, ...service.env }, timeout })).code === 0;
  }
  try {
    const response = await fetch(service.ready.url, { redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(timeout, 2000))) });
    void response.body?.cancel();
    return response.ok;
  } catch { return false; }
}
function ordered(config: Configuration): string[] {
  return [...(config.order ?? []), ...Object.keys(config.services).filter(id => !config.order?.includes(id))];
}
function selected(config: Configuration, stop = false): string[] {
  return ordered(config).filter(id => {
    const service = config.services[id]!;
    if (service.group === 'napcat' || service.group === 'snowluma') return stop || (service.group === config.activeProtocol && service.enabled !== false);
    return service.group === 'optional' ? service.enabled === true : service.enabled !== false;
  });
}
function component(config: Configuration, id: string): Service {
  if (!identifier.test(id) || !Object.hasOwn(config.services, id)) fail('未知组件，请用 qqbridge-framework status 查看配置。');
  return config.services[id]!;
}
function remaining(deadline: number, maximum: number): number {
  const left = deadline - Date.now();
  if (left <= 0) fail('操作等待超时，请查看状态和日志。');
  return Math.min(left, maximum);
}
async function ensureProtocol(config: Configuration, service: Service): Promise<void> {
  if (service.group !== 'napcat' && service.group !== 'snowluma') return;
  if (service.group !== config.activeProtocol) fail('请使用 qqbridge-framework protocol 切换协议端。');
  for (const other of Object.values(config.services)) {
    if ((other.group === 'napcat' || other.group === 'snowluma') && other.group !== service.group
      && ((await sessions(other)).length > 0 || await listening(other))) fail('另一协议端仍在运行，请使用 qqbridge-framework protocol 切换。');
  }
}
async function startOne(config: Configuration, id: string, deadline: number): Promise<void> {
  const service = component(config, id);
  await ensureProtocol(config, service);
  const running = (await sessions(service)).length > 0;
  if (!running && await ready(service, remaining(deadline, 8000))) {
    console.log(`${id} 已就绪（外部进程）。`);
    return;
  }
  if (!running) {
    if (await listening(service)) fail(`${id} 端口已占用但尚未就绪。`);
    if (service.prepare) {
      const result = await execute(service.prepare.command, service.prepare.args, { cwd: service.prepare.cwd ?? service.cwd, env: { ...process.env, ...service.env }, timeout: remaining(deadline, 10000) });
      if (result.code !== 0) fail(`${id} 启动准备失败（${result.code}）。`);
    }
    await mkdir(config.logDirectory, { recursive: true, mode: 0o700 });
    await chmod(config.logDirectory, 0o700);
    const logfile = service.logFile ?? path.join(config.logDirectory, `${id}.log`);
    const handle = await open(logfile, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    await handle.chmod(0o600);
    await handle.close();
    const environment = { ...process.env };
    delete environment.QQ_BRIDGE_FRAMEWORK_OPS_LOCKED;
    const result = await execute('/usr/bin/screen', ['-L', '-Logfile', logfile, '-dmS', service.screen, process.execPath, entry, 'run', id], { cwd: root, env: environment, timeout: remaining(deadline, 5000) });
    if (result.code !== 0) fail(`${id} 启动失败（${result.code}）。`);
    console.log(`${id} 正在启动。`);
  }
  while (Date.now() < deadline) {
    if ((await sessions(service)).length === 0) fail(`${id} 进程已退出，请查看日志。`);
    if (await ready(service, remaining(deadline, 8000))) { console.log(`${id} 已就绪。`); return; }
    await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
  }
  fail(`${id} 等待就绪超时，请查看日志。`);
}

async function identity(pid: number): Promise<ProcessIdentity | undefined> {
  try {
    const content = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = content.slice(content.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z') return undefined;
    return { pid, parent: Number(fields[1]), started: fields[19]! };
  } catch { return undefined; }
}
async function descendants(parents: number[]): Promise<ProcessIdentity[]> {
  const all = (await Promise.all((await readdir('/proc')).filter(name => /^\d+$/.test(name)).map(name => identity(Number(name))))).filter((item): item is ProcessIdentity => item !== undefined);
  const included = new Set(parents);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of all) if (included.has(item.parent) && !included.has(item.pid)) { included.add(item.pid); changed = true; }
  }
  return all.filter(item => included.has(item.pid) && !parents.includes(item.pid));
}
async function alive(item: ProcessIdentity): Promise<boolean> { return (await identity(item.pid))?.started === item.started; }
async function signal(item: ProcessIdentity, value: NodeJS.Signals): Promise<void> {
  if (!await alive(item)) return;
  try { process.kill(item.pid, value); } catch { /* The process may have just exited. */ }
}
async function stopOne(config: Configuration, id: string, deadline: number): Promise<void> {
  const service = component(config, id);
  const running = await sessions(service);
  if (running.length === 0) {
    if (await listening(service)) fail(`${id} 由外部进程占用，无法安全停止。`);
    console.log(`${id} 已停止。`);
    return;
  }
  const processes = await descendants(running.map(session => Number(session.split('.')[0])));
  await Promise.all(processes.map(item => signal(item, 'SIGTERM')));
  for (const session of running) await execute('/usr/bin/screen', ['-S', session, '-X', 'quit'], { timeout: remaining(deadline, 2000) });
  const forceAfter = Math.min(Date.now() + 10000, deadline - 2000);
  let forced = false;
  while (Date.now() < deadline) {
    const survivors = (await Promise.all(processes.map(async item => await alive(item) ? item : undefined))).filter((item): item is ProcessIdentity => item !== undefined);
    if (survivors.length === 0 && (await sessions(service)).length === 0 && !await listening(service)) { console.log(`${id} 已停止。`); return; }
    if (!forced && Date.now() >= forceAfter) { await Promise.all(survivors.map(item => signal(item, 'SIGKILL'))); forced = true; }
    await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
  }
  fail(`${id} 未完全停止，已取消后续操作。`);
}
async function saveSelection(config: Configuration, selectedProtocol: Protocol): Promise<void> {
  const temporary = `${configFile}.${process.pid}.tmp`;
  const updated = { ...config, activeProtocol: selectedProtocol };
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(updated, null, 2)}\n`); await file.sync(); }
  finally { await file.close(); }
  try { await rename(temporary, configFile); config.activeProtocol = selectedProtocol; }
  finally { await unlink(temporary).catch(() => undefined); }
}
async function validateLaunchFiles(id: string, service: Service): Promise<void> {
  const commands: Command[] = [service];
  if (service.prepare) commands.push(service.prepare);
  if (service.ready?.kind === 'command') commands.push(service.ready);
  try {
    for (const item of commands) {
      const cwd = item.cwd ?? service.cwd;
      if (!(await stat(item.command)).isFile() || !(await stat(cwd)).isDirectory()) fail(`${id} 启动文件或目录不可用。`);
      await access(item.command, constants.X_OK);
      await access(cwd, constants.X_OK);
    }
  } catch { fail(`${id} 启动文件或目录不可用。`); }
}
async function switchProtocol(config: Configuration, target: Protocol): Promise<void> {
  const previous = config.activeProtocol;
  const protocolIds = ordered(config).filter(id => ['napcat', 'snowluma'].includes(config.services[id]!.group));
  const targets = protocolIds.filter(id => config.services[id]!.group === target && config.services[id]!.enabled !== false);
  if (targets.length === 0) fail('目标协议端尚未配置。');
  for (const id of targets) await validateLaunchFiles(id, config.services[id]!);
  const previouslyRunning: string[] = [];
  for (const id of protocolIds) if ((await sessions(config.services[id]!)).length > 0) previouslyRunning.push(id);
  const stopDeadline = Date.now() + 30000;
  for (const id of protocolIds.toReversed()) if (config.services[id]!.group !== target || target !== previous) await stopOne(config, id, stopDeadline);
  try {
    await saveSelection(config, target);
    const deadline = Date.now() + 90000;
    for (const id of targets) await startOne(config, id, deadline);
    console.log(`当前协议端：${target}（已保存）。`);
  } catch (error) {
    console.error('协议端启动失败，正在恢复原选择。');
    const deadline = Date.now() + 30000;
    try {
      for (const id of targets.toReversed()) await stopOne(config, id, deadline);
    } finally { await saveSelection(config, previous); }
    const restoreDeadline = Date.now() + 90000;
    for (const id of previouslyRunning) if (config.services[id]!.group === previous) await startOne(config, id, restoreDeadline);
    throw error;
  }
}

async function supervise(config: Configuration, id: string): Promise<void> {
  const service = component(config, id);
  const environment = { ...process.env, ...service.env };
  delete environment.QQ_BRIDGE_FRAMEWORK_OPS_LOCKED;
  const child = spawn(service.command, service.args, { cwd: service.cwd, env: environment, shell: false, stdio: 'inherit', detached: true });
  let stopping = false;
  let completed = false;
  let exitCode = 1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const forward = (signalValue: NodeJS.Signals): void => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signalValue); } catch { /* A completed process group needs no signal. */ }
  };
  const cleanup = (): void => {
    if (completed) return;
    completed = true;
    if (timer) clearTimeout(timer);
    forward('SIGKILL');
    process.exitCode = exitCode;
  };
  const stoppingNow = (signalValue: NodeJS.Signals): void => {
    forward(signalValue);
    if (stopping) return;
    stopping = true;
    timer = setTimeout(cleanup, 10000);
  };
  for (const signalValue of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signalValue, () => stoppingNow(signalValue));
  child.on('error', () => { console.error(`${id} 子进程启动失败。`); exitCode = 1; cleanup(); });
  child.on('exit', (code, signalValue) => {
    exitCode = code ?? (signalValue ? 1 : 0);
    forward('SIGTERM');
    if (timer) clearTimeout(timer);
    timer = setTimeout(cleanup, 500);
  });
}

function help(): void {
  console.log(`qqbridge-framework [start|stop|restart|status|doctor|logs|console|protocol|extensions|describe|help] [组件]

不带参数：启动框架、当前协议端与已启用的辅助服务。
start [组件]       启动并等待就绪，接管已有 screen 会话
stop [组件]        停止配置中的组件；省略组件时包含两套协议端
restart [组件]     停止后启动；可只重启 framework-admin 或 dsh
status [组件]      查看配置中的 screen 会话与监听状态
doctor [组件]      只读检查服务就绪状态
logs [组件] [-f]   查看最近 100 行日志；默认 framework-admin
console [组件]     显示配置中的控制台地址
protocol [napcat|snowluma]  查看或切换协议端并保存选择
extensions [list] 查看已登记插件的版本、调用与排空状态
extensions reload <插件标识>  核对当前版本后重载指定插件
describe --json    输出框架部署的只读标识
help              显示帮助`);
}
async function lockAndRun(config: Configuration, argumentsList: string[]): Promise<void> {
  await mkdir(path.dirname(config.lockFile), { recursive: true, mode: 0o700 });
  const file = await open(config.lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  await file.chmod(0o600);
  await file.close();
  const result = await execute('/usr/bin/flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '75', '--close', config.lockFile, process.execPath, entry, ...argumentsList], {
    env: { ...process.env, QQ_BRIDGE_FRAMEWORK_OPS_LOCKED: '1' }, inherit: true, timeout: 300000,
  });
  if (result.code === 75) fail('另一项运维操作正在运行，请稍后查看状态。');
  process.exitCode = result.code;
}
async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const action = argumentsList[0] ?? 'start';
  const rest = argumentsList.slice(1);
  if (['help', '--help', '-h'].includes(action)) { help(); return; }
  if (action === 'extensions') {
    const { ExtensionManagementError, manageExtensions } = await import('./extension-management.ts');
    try { await manageExtensions(root, rest); }
    catch (error) { if (error instanceof ExtensionManagementError) fail(error.message); throw error; }
    return;
  }
  if (!['start', 'stop', 'restart', 'status', 'doctor', 'logs', 'console', 'protocol', 'describe', 'run'].includes(action)) fail('未知命令，请运行 qqbridge-framework help。');
  if (action === 'describe' ? rest.length !== 1 || rest[0] !== '--json'
    : action === 'logs' ? rest.filter(value => value !== '-f').length > 1 || rest.filter(value => value === '-f').length > 1
    : rest.length > 1) fail('命令参数无效，请运行 qqbridge-framework help。');
  const config = await load();
  if (action === 'describe') {
    if (!Object.hasOwn(config.services, 'dsh')) fail('当前部署未配置受管 DSH 服务。');
    console.log(JSON.stringify({ schema: 1, kind: 'qq-bridge-framework', dshHome: config.dshHome }));
    return;
  }
  if (action === 'protocol' && rest.length === 0) { console.log(config.activeProtocol); return; }
  if (action === 'protocol' && rest[0] !== 'napcat' && rest[0] !== 'snowluma') fail('协议端须为 napcat 或 snowluma。');
  const id = action === 'logs' ? rest.find(value => value !== '-f') : rest[0];
  if (id && action !== 'protocol') component(config, id);
  if (['start', 'stop', 'restart', 'protocol'].includes(action) && process.env.QQ_BRIDGE_FRAMEWORK_OPS_LOCKED !== '1') {
    await lockAndRun(config, argumentsList);
    return;
  }
  if (action === 'run') { if (!id) fail('内部启动命令缺少组件。'); await supervise(config, id); return; }
  if (action === 'protocol') { await switchProtocol(config, rest[0] as Protocol); return; }
  if (action === 'start' || action === 'stop' || action === 'restart') {
    if (action !== 'start') {
      const deadline = Date.now() + 30000;
      for (const target of id ? [id] : selected(config, true).toReversed()) await stopOne(config, target, deadline);
    }
    if (action !== 'stop') {
      const deadline = Date.now() + 90000;
      for (const target of id ? [id] : selected(config)) await startOne(config, target, deadline);
      if (!id && config.accountCheck) {
        const result = await execute(config.accountCheck.command, config.accountCheck.args, { cwd: config.accountCheck.cwd ?? root, timeout: Math.max(1, Math.min(8000, deadline - Date.now())) });
        console.log(result.code === 0 ? 'QQ 账号在线。' : '服务已启动，QQ 账号尚未在线；请查看协议端控制台。');
      }
    }
    return;
  }
  if (action === 'logs') {
    const target = id ?? (Object.hasOwn(config.services, 'framework-admin') ? 'framework-admin' : selected(config).at(-1));
    if (!target) fail('尚未配置日志组件。');
    const service = component(config, target);
    const logfile = service.logFile ?? path.join(config.logDirectory, `${target}.log`);
    try { if (!(await lstat(logfile)).isFile()) fail('日志文件不可用。'); }
    catch { fail('日志文件尚未生成。'); }
    const child = spawn('/usr/bin/tail', ['-n', '100', ...(rest.includes('-f') ? ['-F'] : []), '--', logfile], { stdio: 'inherit', shell: false });
    for (const signalValue of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signalValue, () => child.kill(signalValue));
    child.on('error', () => { console.error('日志读取失败。'); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 0; });
    return;
  }
  const ids = id ? [id] : selected(config);
  for (const target of ids) {
    const service = config.services[target]!;
    if (action === 'console') { if (service.consoleUrl) console.log(`${target}: ${service.consoleUrl}`); }
    else if (action === 'doctor') {
      const healthy = await ready(service);
      console.log(`${target}: ${healthy ? '就绪' : '未就绪'}`);
      if (!healthy) process.exitCode = 1;
    } else {
      const active = (await sessions(service)).length > 0;
      console.log(`${target}: ${active ? '运行中' : await listening(service) ? '外部监听中' : '已停止'}`);
    }
  }
  if (action === 'doctor' && !id && config.accountCheck) {
    const result = await execute(config.accountCheck.command, config.accountCheck.args, { cwd: config.accountCheck.cwd ?? root, timeout: 8000 });
    console.log(result.code === 0 ? 'QQ 账号：在线' : 'QQ 账号：未在线');
    if (result.code !== 0) process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error instanceof OperationError ? error.message : '运维操作失败，请检查配置、目录权限和服务状态。');
  process.exitCode = 1;
});
