import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkTypeScriptSyntax } from '../scripts/typescript-syntax.ts';

test('syntax checking strips leading generic initializers before checking an ESM module', () => {
  assert.equal(checkTypeScriptSyntax("const names = new Map<string, string>();\nexport { names };"), true);
  assert.equal(checkTypeScriptSyntax('type Value = readonly string[];\nexport function values(): Value { return []; }'), true);
});

test('syntax checking handles the actual feature label module without rewriting its source', () => {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const filename = new URL(`../web/lib/feature-labels.${extension}`, import.meta.url);
  const source = readFileSync(filename, 'utf8');
  assert.equal(checkTypeScriptSyntax(source), true);
  assert.equal(readFileSync(filename, 'utf8'), source);
});

test('syntax checking rejects malformed TypeScript', () => {
  for (const source of ['export const broken = ;', 'export function broken( {']) {
    assert.equal(checkTypeScriptSyntax(source), false);
  }
});

test('syntax checking compiles authored TSX before checking JavaScript syntax', () => {
  assert.equal(checkTypeScriptSyntax('export const view = <input step="any" />;', 'view.tsx'), true);
  assert.equal(checkTypeScriptSyntax('export const view = <input step="any" /;', 'view.tsx'), false);
});

test('compiled package syntax supports decorators without replacing project type checking', () => {
  const source = 'function decorate(target: unknown, context: ClassDecoratorContext) {}\n@decorate\nexport class Entry { value: string = "fixture"; }';
  assert.equal(checkTypeScriptSyntax(source), true);
  assert.equal(checkTypeScriptSyntax('export enum Mode { Off, On }'), true);
  assert.equal(checkTypeScriptSyntax('export const value: string = 1;'), true);
});

test('syntax checking never executes user code or resolves its imports', () => {
  const directory = mkdtempSync(join(tmpdir(), 'framework-syntax-'));
  const canary = join(directory, 'must-not-exist');
  try {
    const source = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(canary)}, 'executed');\nexport const value: number = 1;`;
    assert.equal(checkTypeScriptSyntax(source), true);
    assert.equal(existsSync(canary), false);
    assert.equal(checkTypeScriptSyntax("import './missing-module.ts';\nexport const value: number = 1;"), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
