import { errorCode } from '../src/core/values.ts';
import { activateLegacyGateway, prepareLegacyGateway, rollbackLegacyGateway } from '../src/integrations/legacy-gateway.ts';

try {
  const [action, ...argumentsList] = process.argv.slice(2);
  const values = new Map<string, string>();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!key || !['--legacy-root', '--runtime-directory', '--port'].includes(key) || !value || values.has(key)) throw new Error('Invalid arguments.');
    values.set(key, value);
  }
  const legacyRoot = values.get('--legacy-root');
  const runtimeDirectory = values.get('--runtime-directory');
  if (!legacyRoot || !runtimeDirectory) throw new Error('Explicit deployment paths are required.');
  const options = { legacyRoot, runtimeDirectory, ...(values.has('--port') ? { port: Number(values.get('--port')) } : {}) };
  const result = action === 'prepare' ? prepareLegacyGateway(options) : action === 'activate' ? await activateLegacyGateway(options)
    : action === 'rollback' ? rollbackLegacyGateway(options) : null;
  if (result === null) throw new Error('Use prepare, activate or rollback.');
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(errorCode(error, 'LEGACY_GATEWAY_SWITCH_FAILED'));
  process.exitCode = 1;
}
