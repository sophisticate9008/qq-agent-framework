import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const argumentsList = process.argv.slice(2);
if (argumentsList.some(argument => argument !== '--web') || argumentsList.filter(argument => argument === '--web').length > 1) {
  throw new Error('Use node scripts/build.ts [--web].');
}
if (!argumentsList.includes('--web')) {
  execFileSync(process.execPath, [fileURLToPath(new URL('node_modules/typescript/bin/tsc', root))],
    { cwd: fileURLToPath(root), stdio: 'inherit' });
}
execFileSync(process.execPath, [fileURLToPath(new URL('node_modules/typescript/bin/tsc', root)), '-p', 'tsconfig.web.json'],
  { cwd: fileURLToPath(root), stdio: 'inherit' });
const { build } = await import('vite');
await build({ configFile: fileURLToPath(new URL('vite.config.ts', root)) });
mkdirSync(new URL('dist/admin-web/', root), { recursive: true });
copyFileSync(new URL('web/index.html', root), new URL('dist/admin-web/index.html', root));
copyFileSync(new URL('web/favicon.svg', root), new URL('dist/admin-web/favicon.svg', root));
console.log(argumentsList.includes('--web') ? 'Browser assets built in dist/admin-web/.' : 'TypeScript and browser assets built in dist/.');
