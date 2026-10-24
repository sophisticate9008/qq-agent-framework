import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
execFileSync(process.execPath, [fileURLToPath(new URL('node_modules/typescript/bin/tsc', root))],
  { cwd: fileURLToPath(root), stdio: 'inherit' });
execFileSync(process.execPath, [fileURLToPath(new URL('node_modules/typescript/bin/tsc', root)), '-p', 'tsconfig.web.json'],
  { cwd: fileURLToPath(root), stdio: 'inherit' });
const { build } = await import('vite');
await build({ configFile: fileURLToPath(new URL('vite.config.ts', root)) });
mkdirSync(new URL('dist/admin-web/', root), { recursive: true });
copyFileSync(new URL('web/index.html', root), new URL('dist/admin-web/index.html', root));
console.log('TypeScript and browser assets built in dist/.');
