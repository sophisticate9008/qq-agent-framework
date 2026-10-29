import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from '../src/core/values.ts';

// Pack only the components' allowlisted files. Compatibility archives keep old imports usable.
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert(isRecord(manifest) && typeof manifest.version === 'string' && /^\d+\.\d+\.\d+$/.test(manifest.version));
const version = manifest.version;
const destination = join(root, 'runtime', 'releases', `v${version}`);
await mkdir(destination, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'qq-bridge-framework-release-'));
const checksums: string[] = [];

async function pack(directory: string, name: string): Promise<string> {
  const result: unknown = JSON.parse(execFileSync('npm', ['pack', directory, '--ignore-scripts', '--json',
    '--pack-destination', destination], { cwd: root, encoding: 'utf8' }));
  assert(Array.isArray(result) && result.length === 1);
  const packed: unknown = result[0];
  assert(isRecord(packed) && packed.name === name && packed.version === version
    && typeof packed.filename === 'string' && /^[a-z0-9.-]+\.tgz$/.test(packed.filename) && Array.isArray(packed.files));
  for (const file of packed.files) {
    assert(isRecord(file) && typeof file.path === 'string');
    assert(['package.json', 'README.md', 'LICENSE', 'NOTICE.md'].includes(file.path)
      || /^dist\/(?!.*(?:^|\/)\.\.\/)[a-z0-9./-]+\.(?:js|d\.ts)$/.test(file.path), `Unexpected package file: ${file.path}`);
    assert(!/(?:^|\/)(?:runtime|node_modules|test|admin|web|scripts)(?:\/|$)/.test(file.path));
  }
  const filename = join(destination, packed.filename);
  const sum = createHash('sha256').update(await readFile(filename)).digest('hex');
  checksums.push(`${sum}  ${packed.filename}`);
  console.log(`${name}@${version}: ${packed.filename}`);
  return filename;
}

try {
  for (const [directory, component] of [['framework-sdk', 'sdk'], ['dsh-bridge-plugin', 'dsh-bridge-plugin']] as const) {
    const source = join(root, 'packages', directory);
    const name = `@qq-bridge-framework/${component}`;
    const metadata: unknown = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    assert(isRecord(metadata) && metadata.name === name && metadata.version === version);
    if (component === 'dsh-bridge-plugin') {
      const entry = await readFile(join(source, 'dist', 'index.js'), 'utf8');
      assert(entry.includes(`pluginVersion: '${version}'`), 'Build the matching bridge plugin before packing.');
    }
    const canonical = await pack(source, name);
    const staging = join(scratch, component);
    await mkdir(staging);
    execFileSync('tar', ['-xzf', canonical, '-C', staging]);
    const legacyName = `@qq-agent-framework/${component}`;
    const legacyDirectory = join(staging, 'package');
    await writeFile(join(legacyDirectory, 'package.json'), JSON.stringify({ ...metadata, name: legacyName }, null, 2) + '\n');
    await pack(legacyDirectory, legacyName);
  }
  await writeFile(join(destination, 'SHA256SUMS'), checksums.sort().join('\n') + '\n');
  console.log(`Release files: ${destination}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
