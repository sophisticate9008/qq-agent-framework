import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('framework sources have no previous-project runtime or private business integration', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const sourceRoot = root.endsWith('/dist/') ? fileURLToPath(new URL('../../', import.meta.url)) : root;
  const forbidden = [/legacyRoot/, /\/api\/legacy\b/, /createLegacy\w*/, /integrations\/legacy-/, /--bridge-dir/,
    /\/root\/qq-bridge/, /legacy-egress-compatibility/, /sync-chat-persona/, /configure-local-chat/,
    /imageWorker/i, /createImageGeneration/, /createSelfExpression/, /adapters\/image-generation/, /features\/self-expression/];
  const findings: string[] = [];
  function inspect(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = join(directory, entry.name);
      if (entry.isDirectory()) inspect(filename);
      else if (entry.isFile() && /\.(?:tsx?|js)$/.test(entry.name)) {
        const source = readFileSync(filename, 'utf8');
        if (forbidden.some(pattern => pattern.test(source))) findings.push(relative(sourceRoot, filename));
      }
    }
  }
  for (const directory of ['src', 'web', 'scripts', 'dist/src', 'dist/scripts']) {
    const location = join(sourceRoot, directory);
    if (existsSync(location)) inspect(location);
  }
  assert.deepEqual(findings, []);
});
