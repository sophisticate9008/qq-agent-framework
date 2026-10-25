import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkSourceRules } from '../scripts/source-rules.ts';

test('AST rules reject explicit any and real suppression comments without flagging text or property names', () => {
  for (const source of ['const value: any = 1;', 'type Value = Array<any>;', 'function run<T extends any>() {}']) {
    assert.equal(checkSourceRules(source, 'src/example.ts')[0]?.code, 'explicit-any');
  }
  for (const directive of ['ignore', 'nocheck']) {
    assert.equal(checkSourceRules(`// @ts-${directive}\nconst value = 1;`, 'src/example.ts')[0]?.code, 'type-suppression');
  }
  assert.deepEqual(checkSourceRules('const text = "any @ts-ignore"; const signal = AbortSignal.any([]);', 'src/example.ts'), []);
  assert.deepEqual(checkSourceRules('export const element = <input step="any" />;', 'web/example.tsx'), []);
});

test('architecture rules cover exports, imports, mixed type syntax and literal dynamic loading', () => {
  const cases = [
    ['src/core/example.ts', "import type { Runtime } from '../host/types.ts';"],
    ['src/core/example.ts', "export { adapter } from '../adapters/onebot.ts';"],
    ['src/host/example.ts', "import { type Route, runtime } from '../admin/server.ts';"],
    ['src/features/example.ts', "await import('../storage/sqlite.ts');"],
    ['src/features/example.ts', "const fs = require('node:fs/promises');"],
    ['src/features/example.ts', "import WebSocket from 'ws';"],
    ['src/features/example.ts', "await fetch('https://example.test');"],
    ['src/features/example.ts', "await globalThis.fetch('https://example.test');"],
    ['src/contracts/example.ts', "import type { Server } from 'node:http';"],
  ];
  for (const [filename, source] of cases) {
    assert.equal(checkSourceRules(source!, filename!)[0]?.code, 'architecture', `${filename}: ${source}`);
  }
  for (const source of ["import type { Port } from '../host/types.ts';", "import { type Port } from '../host/types.ts';",
    "export { type Port } from '../host/types.ts';", "import { normalize } from '../core/content.ts';"]) {
    assert.deepEqual(checkSourceRules(source, 'src/features/example.ts'), []);
  }
  assert.deepEqual(checkSourceRules("import { type Port } from '../admin/server.ts';", 'src/host/example.ts'), []);
  assert.deepEqual(checkSourceRules("import type { JsonValue } from '../core/types.ts';", 'src/contracts/ports.ts'), []);
  assert.equal(checkSourceRules("import { createPolicy } from '../core/policy.ts';", 'src/contracts/ports.ts')[0]?.code, 'architecture');
});

test('rule diagnostics identify the original source line and column', () => {
  const finding = checkSourceRules('export {};\nconst value: any = 1;', 'src/example.ts')[0];
  assert.equal(finding?.line, 2);
  assert.equal(finding?.column, 14);
});

test('the actual public checker fails on synthetic authored architecture and type violations', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const repository = basename(root) === 'dist' ? dirname(root) : root;
  const directory = mkdtempSync(join(tmpdir(), 'framework-negative-source-check-'));
  try {
    mkdirSync(join(directory, 'scripts'));
    mkdirSync(join(directory, 'src/core'), { recursive: true });
    symlinkSync(join(repository, 'node_modules'), join(directory, 'node_modules'), 'dir');
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
    for (const name of ['check.ts', 'typescript-syntax.ts', 'source-rules.ts']) {
      copyFileSync(join(repository, 'scripts', name), join(directory, 'scripts', name));
    }
    writeFileSync(join(directory, 'src/core/invalid.ts'), `import { adapter } from '../adapters/example.ts';\n// @ts-${'ignore'}\nexport const value: any = adapter;`);
    const result = spawnSync(process.execPath, [join(directory, 'scripts/check.ts')], {
      encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /src\/core\/invalid\.ts:3:\d+: explicit-any/);
    assert.match(result.stderr, /src\/core\/invalid\.ts:2:\d+: type-suppression/);
    assert.match(result.stderr, /src\/core\/invalid\.ts:1:\d+: architecture/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
