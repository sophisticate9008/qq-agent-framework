import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';

import { errorCode, isRecord } from '../src/core/values.ts';
import {
  gatewayAdminAddress,
  loadGatewayAdminConfiguration,
  startGatewayAdmin
} from '../src/admin/gateway.ts';

try {
  const argumentsList = process.argv.slice(2);
  const configIndex = argumentsList.indexOf('--config');
  const modes = ['--health', '--listening', '--address'].filter(flag => argumentsList.includes(flag));
  if (configIndex < 0 || !argumentsList[configIndex + 1] || modes.length > 1
    || argumentsList.some((argument, position) =>
      !['--config', '--health', '--listening', '--address'].includes(argument) && position !== configIndex + 1)) {
    throw new Error('Use --config <private-json> [--health | --listening | --address].');
  }
  const configuration = loadGatewayAdminConfiguration(argumentsList[configIndex + 1]);
  const address = gatewayAdminAddress(configuration);
  if (argumentsList.includes('--address')) {
    console.log(address);
  } else if (argumentsList.includes('--listening')) {
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
  } else if (argumentsList.includes('--health')) {
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
    const service = await startGatewayAdmin(configuration);
    console.log(`Framework gateway administrator listening on ${gatewayAdminAddress({
      ...configuration,
      port: service.address.port
    })}.`);
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
} catch (error: unknown) {
  console.error(errorCode(error, 'GATEWAY_ADMIN_START_FAILED'));
  process.exitCode = 1;
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
