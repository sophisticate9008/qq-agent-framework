import { execFileSync } from 'node:child_process';
import { copyFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
rmSync(new URL('packages/framework-sdk/dist/', root), { recursive: true, force: true });
execFileSync(process.execPath, [fileURLToPath(new URL('node_modules/typescript/bin/tsc', root)),
  '-p', 'packages/framework-sdk/tsconfig.json'], { cwd: fileURLToPath(root), stdio: 'inherit' });
copyFileSync(new URL('LICENSE', root), new URL('packages/framework-sdk/LICENSE', root));
copyFileSync(new URL('NOTICE.md', root), new URL('packages/framework-sdk/NOTICE.md', root));
