#!/usr/bin/env node
import { chmod, copyFile, lstat, mkdir, readFile, readlink, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isRecord } from '../src/core/values.ts';

class InstallError extends Error {}

const root = fileURLToPath(new URL('../', import.meta.url));

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('安装 qqagent：node scripts/install-service-manager.ts [--bin-dir /usr/local/bin] [--admin-config /绝对路径/config.json] [--boot /绝对路径/service-boot.sh]\n先配置 runtime/live/services.json；--boot 仅更新现有 qqbridge 的启动、停止、状态和日志分发。');
    return;
  }
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]; const value = args[index + 1];
    if (!name || !['--bin-dir', '--admin-config', '--boot'].includes(name) || !value || !value.startsWith('/') || options.has(name)) throw new InstallError('参数无效。');
    options.set(name, value);
  }
  const binDirectory = options.get('--bin-dir') ?? '/usr/local/bin';
  const adminPath = options.get('--admin-config') ?? join(root, 'runtime/live/framework-admin.json');
  const bootPath = options.get('--boot');
  const target = join(root, 'ops/qqagent');
  const cli = join(binDirectory, 'qqagent');
  if (!/^\/[A-Za-z0-9_./-]+$/.test(cli)) throw new InstallError('命令安装路径不支持空格或特殊字符。');
  const adminSource = await readFile(adminPath, 'utf8');
  const admin: unknown = JSON.parse(adminSource);
  if (!isRecord(admin) || typeof admin.tokenFile !== 'string') throw new InstallError('管理配置格式无效。');
  const services: unknown = JSON.parse(await readFile(join(root, 'runtime/live/services.json'), 'utf8'));
  if (!isRecord(services) || services.schema !== 1 || !isRecord(services.services) || !isRecord(services.services.dsh)) throw new InstallError('请先配置本框架的服务清单。');
  const originalLink = await lstat(cli).catch(error => {
    if (isRecord(error) && error.code === 'ENOENT') return null;
    throw error;
  });
  if (originalLink && (!originalLink.isSymbolicLink() || resolve(binDirectory, await readlink(cli)) !== resolve(target))) throw new InstallError('qqagent 已被其他程序占用。');

  let bootSource: string | undefined;
  let bootNext: string | undefined;
  if (bootPath) {
    bootSource = await readFile(bootPath, 'utf8');
    bootNext = bootSource;
    const previous = '/usr/local/bin/qqbridge';
    if (bootSource.includes(previous)) {
      for (const action of ['start', 'stop', 'status', 'logs']) {
        if (!bootSource.includes(`${previous} ${action}`)) throw new InstallError('boot 分发格式发生变化，未修改。');
      }
      bootNext = bootNext.replaceAll(previous, cli)
        .replaceAll('failed_services+=("qqbridge")', 'failed_services+=("qqagent")')
        .replaceAll('qqbridge|framework-admin|framework-gateway|bridge|', 'qqagent|qqbridge|framework-admin|framework-gateway|')
        .replace('if [[ "$service" == qqbridge ]]; then service=framework-admin; fi',
          'if [[ "$service" == qqagent || "$service" == qqbridge ]]; then service=framework-admin; fi');
    }
    for (const action of ['start', 'stop', 'status', 'logs']) {
      if (!bootNext.includes(`${cli} ${action}`)) throw new InstallError('boot 不包含已支持的运维分发入口，未修改。');
    }
  }

  const backupDirectory = join(root, 'runtime/ops-backups', new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  await copyFile(adminPath, join(backupDirectory, 'admin.json'));
  await chmod(join(backupDirectory, 'admin.json'), 0o600);
  if (bootPath) {
    await copyFile(bootPath, join(backupDirectory, 'boot.sh'));
    await chmod(join(backupDirectory, 'boot.sh'), 0o600);
  }
  const replace = async (filename: string, before: string, after: string, mode: number): Promise<void> => {
    if (before === after) return;
    if (await readFile(filename, 'utf8') !== before) throw new InstallError('配置在安装期间被修改，停止覆盖。');
    const temporary = join(dirname(filename), `.qqagent-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, after, { mode, flag: 'wx' });
      await rename(temporary, filename);
    } finally { await unlink(temporary).catch(() => undefined); }
  };
  await mkdir(binDirectory, { recursive: true });
  await chmod(target, 0o755);
  if (!originalLink) await symlink(target, cli);
  await replace(adminPath, adminSource, `${JSON.stringify({ ...admin, serviceManager: target }, null, 2)}\n`, 0o600);
  if (bootPath && bootSource !== undefined && bootNext !== undefined) {
    const mode = (await lstat(bootPath)).mode & 0o777;
    await replace(bootPath, bootSource, bootNext, mode);
  }
  console.log('已安装 qqagent 并更新管理配置。' + (bootPath ? ' boot 已切换到本框架运维入口。' : ''));
  console.log('已有进程保持运行；管理服务下次启动时读取新的维护入口。备份位于 runtime/ops-backups。');
}

void main().catch(error => {
  console.error(error instanceof InstallError ? error.message : '安装失败，请检查路径和权限；已有备份保留在 runtime/ops-backups。');
  process.exitCode = 1;
});
