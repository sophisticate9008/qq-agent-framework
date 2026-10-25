import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { errorCode, isRecord } from '../src/core/values.ts';
import {
  gatewayAdminAddress,
  loadGatewayAdminConfiguration,
  startGatewayAdmin
} from '../src/admin/gateway.ts';
import { loadSelectedNativeBootstrap } from './bootstrap-loader.ts';

const HELP = `管理服务命令行
用法：node scripts/gateway-admin.ts --config <私有管理配置> [--bootstrap <可信本机TS绝对路径>]
检查：node scripts/gateway-admin.ts --config <私有管理配置> [--health | --listening | --address]
--bootstrap 用于本次明确选择；未指定时读取管理配置旁的固定版本启动扩展选择，不自动授予权限，也不是代码沙箱。`;

class GatewayAdminUsageError extends Error {}

export type GatewayAdminArguments = { readonly help: true } | {
  readonly help: false;
  readonly config: string;
  readonly mode: 'start' | '--health' | '--listening' | '--address';
  readonly bootstrap?: string;
};

export function parseGatewayAdminArguments(argumentsList: readonly string[]): GatewayAdminArguments {
  if (argumentsList.length === 1 && ['--help', '-h'].includes(argumentsList[0]!)) return { help: true };
  const values = new Map<string, string>();
  let mode: '--health' | '--listening' | '--address' | undefined;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]!;
    if (argument === '--config' || argument === '--bootstrap') {
      const value = argumentsList[index + 1];
      if (values.has(argument) || !value || value.startsWith('--')) {
        throw new GatewayAdminUsageError(`参数 ${argument} 需要唯一且非空的值。\n${HELP}`);
      }
      values.set(argument, value);
      index += 1;
    } else if (argument === '--health' || argument === '--listening' || argument === '--address') {
      if (mode !== undefined) throw new GatewayAdminUsageError(`检查模式不能重复或组合。\n${HELP}`);
      mode = argument;
    } else {
      throw new GatewayAdminUsageError(`存在无法识别的参数。\n${HELP}`);
    }
  }
  const config = values.get('--config');
  if (config === undefined) throw new GatewayAdminUsageError(`请指定 --config。\n${HELP}`);
  const bootstrap = values.get('--bootstrap');
  if (bootstrap !== undefined && (mode !== undefined || !isAbsolute(bootstrap) || resolve(bootstrap) !== bootstrap
    || !bootstrap.endsWith('.ts') || bootstrap.length > 4096 || /[\x00-\x1f\x7f?#]/.test(bootstrap))) {
    throw new GatewayAdminUsageError(`--bootstrap 只接受启动时明确的本机 .ts 文件绝对路径，不支持检查模式。\n${HELP}`);
  }
  return { help: false, config, mode: mode ?? 'start', ...(bootstrap === undefined ? {} : { bootstrap }) };
}

async function runGatewayAdmin(argumentsList: readonly string[]): Promise<void> {
  const parsed = parseGatewayAdminArguments(argumentsList);
  if (parsed.help) {
    console.log(HELP);
    return;
  }
  const configuration = loadGatewayAdminConfiguration(parsed.config);
  const address = gatewayAdminAddress(configuration);
  if (parsed.mode === '--address') {
    console.log(address);
  } else if (parsed.mode === '--listening') {
    const target = new URL(address);
    const ready = await new Promise<boolean>(resolvePromise => {
      const socket = connect({ host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port) });
      const finish = (result: boolean): void => {
        socket.destroy();
        resolvePromise(result);
      };
      socket.setTimeout(1_500);
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.once('timeout', () => finish(false));
    });
    process.exitCode = ready ? 0 : 1;
  } else if (parsed.mode === '--health') {
    if (!existsSync(configuration.tokenFile)) {
      const response = await fetch(`${address}/api/setup`, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
      const setup: unknown = await response.json();
      if (!response.ok || !isRecord(setup) || setup.initialized !== false || setup.canInitialize !== true
        || setup.revision !== createRevision(configuration)) throw new Error('Administrator setup is unavailable.');
      console.log('Framework administrator awaiting first connection.');
      process.exit(0);
    }
    const token = readFileToken(configuration.tokenFile);
    const response = await fetch(`${address}/api/gateway/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
      redirect: 'error'
    });
    const result: unknown = await response.json();
    if (!response.ok || !isRecord(result) || result.ok !== true || result.mode !== 'gateway-live'
      || result.revision !== createRevision(configuration)) throw new Error('Gateway administrator is not ready.');
    console.log('Framework gateway administrator ready.');
  } else {
    const bootstrap = await loadSelectedNativeBootstrap(parsed.config, parsed.bootstrap);
    const service = await startGatewayAdmin(configuration, {
      configurationFilename: parsed.config, ...(bootstrap === undefined ? {} : { bootstrap })
    });
    console.log(`Framework gateway administrator listening on ${gatewayAdminAddress({
      ...configuration,
      port: service.address.port
    })}.`);
    if (bootstrap !== undefined) {
      console.log(`可信启动扩展已加载：${bootstrap.metadata.manifest.id}@${bootstrap.metadata.manifest.version}；功能权限仍需独立授权。`);
    }
    let closing = false;
    const stop = (): void => {
      if (closing) return;
      closing = true;
      const deadline = setTimeout(() => {
        console.error('GATEWAY_ADMIN_SHUTDOWN_UNKNOWN');
        process.exit(1);
      }, 15_000);
      void service.close().then(() => clearTimeout(deadline), () => {
        clearTimeout(deadline);
        process.exitCode = 1;
      });
    };
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(signal, stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runGatewayAdmin(process.argv.slice(2));
  } catch (error: unknown) {
    console.error(error instanceof GatewayAdminUsageError ? error.message : errorCode(error, 'GATEWAY_ADMIN_START_FAILED'));
    process.exitCode = 1;
  }
}

function readFileToken(filename: string): string {
  return readFileSync(filename, 'utf8').trim();
}

function createRevision(configuration: Readonly<{
  host: string;
  port: number;
  tokenFile: string;
  gatewayConfiguration: string;
}>): string {
  return createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
}
