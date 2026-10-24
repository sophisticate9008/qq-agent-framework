import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
execFileSync(process.execPath, [fileURLToPath(new URL('node_modules/typescript/bin/tsc', root))],
  { cwd: fileURLToPath(root), stdio: 'inherit' });
mkdirSync(new URL('dist/web/', root), { recursive: true });
for (const name of ['index.html', 'style.css']) {
  copyFileSync(new URL(`web/${name}`, root), new URL(`dist/web/${name}`, root));
}
console.log('TypeScript and browser assets built in dist/.');
