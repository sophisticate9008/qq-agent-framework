import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadGatewayAdminConfiguration } from '../src/admin/gateway.ts';
import { assert, errorCode } from '../src/core/values.ts';
import { loadOneBotGatewayConfiguration } from '../src/host/onebot-gateway.ts';

export interface ConfigureGatewayAdminOptions {
  configurationFilename: string;
  gatewayConfigurationFilename: string;
  tokenFilename?: string;
  host?: string;
  port?: number;
}

function privateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const status = lstatSync(directory);
  assert(status.isDirectory() && !status.isSymbolicLink() && (status.mode & 0o077) === 0,
    'ADMIN_SETUP_PRIVATE_DIRECTORY', 'Configuration and token directories must be private.');
}

export function configureGatewayAdmin(options: ConfigureGatewayAdminOptions) {
  const filename = resolve(options.configurationFilename);
  const gatewayConfiguration = resolve(options.gatewayConfigurationFilename);
  const tokenFile = resolve(options.tokenFilename ?? join(dirname(filename), 'gateway-admin.token'));
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 3210;
  assert(host === 'localhost' || isIP(host) !== 0, 'ADMIN_SETUP_INVALID_HOST', 'Use an explicit IP address or localhost.');
  assert(Number.isSafeInteger(port) && port >= 1 && port <= 65535, 'ADMIN_SETUP_INVALID_PORT', 'Use an available nonzero port.');
  assert(filename !== tokenFile && filename !== gatewayConfiguration && tokenFile !== gatewayConfiguration,
    'ADMIN_SETUP_PATH_CONFLICT', 'Configuration, gateway and token files must be distinct.');
  assert(!existsSync(filename), 'ADMIN_SETUP_CONFIG_EXISTS', 'Existing configuration is never overwritten; edit it explicitly.');
  loadOneBotGatewayConfiguration(gatewayConfiguration);
  privateDirectory(dirname(filename));
  privateDirectory(dirname(tokenFile));
  let tokenCreated = false;
  if (existsSync(tokenFile)) {
    const status = lstatSync(tokenFile);
    assert(status.isFile() && !status.isSymbolicLink() && (status.mode & 0o077) === 0 && status.size <= 4096,
      'ADMIN_SETUP_INVALID_TOKEN', 'Existing administrator token must be a private bounded file.');
    const token = readFileSync(tokenFile, 'utf8').trim();
    assert(token.length >= 24 && !/[\r\n]/.test(token), 'ADMIN_SETUP_INVALID_TOKEN', 'Administrator token must have at least 24 characters.');
  } else {
    writeFileSync(tokenFile, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
    tokenCreated = true;
  }
  writeFileSync(filename, JSON.stringify({ host, port, tokenFile, gatewayConfiguration }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  loadGatewayAdminConfiguration(filename);
  return Object.freeze({ configuration: filename, host, port, tokenFile, tokenCreated,
    gatewayConfiguration, access: host === '0.0.0.0' || host === '::' ? 'Use this machine’s actual network address.' : host });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const values = new Map<string, string>();
    const argumentsList = process.argv.slice(2);
    for (let index = 0; index < argumentsList.length; index += 2) {
      const key = argumentsList[index];
      const value = argumentsList[index + 1];
      assert(key !== undefined && ['--config', '--gateway-config', '--token-file', '--host', '--port'].includes(key)
        && value !== undefined && value.length > 0 && !values.has(key), 'ADMIN_SETUP_ARGUMENTS', 'Invalid setup arguments.');
      values.set(key, value);
    }
    const configurationFilename = values.get('--config');
    const gatewayConfigurationFilename = values.get('--gateway-config');
    assert(configurationFilename && gatewayConfigurationFilename, 'ADMIN_SETUP_ARGUMENTS', 'Explicit configuration paths are required.');
    if (values.has('--port')) assert(/^[1-9]\d{0,4}$/.test(values.get('--port')!), 'ADMIN_SETUP_INVALID_PORT', 'Invalid port.');
    console.log(JSON.stringify(configureGatewayAdmin({ configurationFilename, gatewayConfigurationFilename,
      ...(values.has('--token-file') ? { tokenFilename: values.get('--token-file')! } : {}),
      ...(values.has('--host') ? { host: values.get('--host')! } : {}),
      ...(values.has('--port') ? { port: Number(values.get('--port')) } : {}) })));
  } catch (error) {
    console.error(errorCode(error, 'ADMIN_SETUP_FAILED'));
    process.exitCode = 1;
  }
}
