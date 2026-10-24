import { connect } from 'node:net';
import { errorCode } from '../src/core/values.ts';
import { loadOneBotGatewayConfiguration, startOneBotGateway } from '../src/host/onebot-gateway.ts';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

try {
  const argumentsList = process.argv.slice(2);
  const index = argumentsList.indexOf('--config');
  if (index < 0 || !argumentsList[index + 1] || argumentsList.some((argument, position) =>
    !['--config', '--health', '--listening'].includes(argument) && position !== index + 1)) {
    throw new Error('Use --config <private-json> [--health | --listening].');
  }
  const configuration = loadOneBotGatewayConfiguration(argumentsList[index + 1]);
  if (argumentsList.includes('--listening')) {
    const ready = await new Promise<boolean>(complete => {
      const socket = connect({ host: '127.0.0.1', port: configuration.port });
      const finish = (result: boolean) => { socket.destroy(); complete(result); };
      socket.setTimeout(1500);
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.once('timeout', () => finish(false));
    });
    process.exitCode = ready ? 0 : 1;
  } else if (argumentsList.includes('--health')) {
    const token = readFileSync(configuration.tokenFile, 'utf8').trim();
    const response = await fetch(`http://127.0.0.1:${configuration.port}/health`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2500), redirect: 'error',
    });
    const result: unknown = await response.json();
    const revision = createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
    if (!response.ok || !result || typeof result !== 'object' || !('ok' in result) || result.ok !== true
      || !('revision' in result) || result.revision !== revision) throw new Error('Gateway is not ready.');
    console.log('Framework compatibility gateway ready.');
  } else {
    const service = await startOneBotGateway(configuration);
    console.log(`Framework OneBot gateway listening on 127.0.0.1:${service.address.port}.`);
    let closing = false;
    const stop = () => {
      if (closing) return;
      closing = true;
      const deadline = setTimeout(() => { console.error('GATEWAY_SHUTDOWN_UNKNOWN'); process.exit(1); }, 15000);
      void service.close().then(() => { clearTimeout(deadline); }, () => { clearTimeout(deadline); process.exitCode = 1; });
    };
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(signal, stop);
  }
} catch (error) {
  console.error(errorCode(error, 'GATEWAY_START_FAILED'));
  process.exitCode = 1;
}
