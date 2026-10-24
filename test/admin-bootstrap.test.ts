import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { createAdminBootstrap } from '../src/admin/bootstrap.ts';
import { FrameworkError } from '../src/core/values.ts';

const execute = promisify(execFile);
const EXISTING_TOKEN = 'existing-administrator-token-value';

function fixture(): { directory: string; tokenFile: string } {
  const directory = mkdtempSync(join(tmpdir(), 'admin-bootstrap-'));
  return { directory, tokenFile: join(directory, 'admin.token') };
}

function frameworkCode(code: string): (error: unknown) => boolean {
  return error => error instanceof FrameworkError && error.code === code;
}

test('initializes once, persists a private marker, and never includes the token in status responses', t => {
  const values = fixture();
  t.after(() => rmSync(values.directory, { recursive: true, force: true }));
  const bootstrap = createAdminBootstrap({ tokenFile: values.tokenFile });

  assert.deepEqual(bootstrap.status(), {
    initialized: false,
    canInitialize: true,
    tokenFile: values.tokenFile
  });
  assert.equal(bootstrap.token(), null);

  const initialized = bootstrap.initialize();
  const token = readFileSync(values.tokenFile, 'utf8').trim();
  assert.equal(token.length, 64);
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(statSync(values.directory).mode & 0o777, 0o700);
  assert.equal(statSync(values.tokenFile).mode & 0o777, 0o600);
  assert.equal(statSync(`${values.tokenFile}.initialized`).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(`${values.tokenFile}.initialized`, 'utf8')), { schema: 1 });
  assert.equal(readFileSync(`${values.tokenFile}.initialized`, 'utf8').includes(token), false);
  assert.equal(JSON.stringify(initialized).includes(token), false);
  assert.deepEqual(initialized, { initialized: true, canInitialize: false, tokenFile: values.tokenFile });
  assert.equal(bootstrap.token(), token);

  assert.deepEqual(bootstrap.initialize(), initialized);
  assert.equal(readFileSync(values.tokenFile, 'utf8').trim(), token);
  const reopened = createAdminBootstrap({ tokenFile: values.tokenFile });
  assert.deepEqual(reopened.status(), initialized);
  assert.equal(reopened.token(), token);
  assert.equal(readFileSync(values.tokenFile, 'utf8').trim(), token);
});

test('adopts an existing valid token without changing it and records initialization', t => {
  const values = fixture();
  t.after(() => rmSync(values.directory, { recursive: true, force: true }));
  writeFileSync(values.tokenFile, `${EXISTING_TOKEN}\n`, { mode: 0o600 });
  const before = readFileSync(values.tokenFile);

  const bootstrap = createAdminBootstrap({ tokenFile: values.tokenFile });
  assert.deepEqual(bootstrap.status(), { initialized: true, canInitialize: false, tokenFile: values.tokenFile });
  assert.deepEqual(readFileSync(values.tokenFile), before);
  assert.equal(bootstrap.token(), EXISTING_TOKEN);
  assert.equal(existsSync(`${values.tokenFile}.initialized`), true);
  assert.equal(readFileSync(`${values.tokenFile}.initialized`, 'utf8').includes(EXISTING_TOKEN), false);
  bootstrap.initialize();
  assert.deepEqual(readFileSync(values.tokenFile), before);
});

test('fails closed after an initialized token is removed', t => {
  const values = fixture();
  t.after(() => rmSync(values.directory, { recursive: true, force: true }));
  const bootstrap = createAdminBootstrap({ tokenFile: values.tokenFile });
  bootstrap.initialize();
  unlinkSync(values.tokenFile);

  const missing = { initialized: true, canInitialize: false, tokenFile: values.tokenFile, error: 'token_missing' };
  assert.deepEqual(bootstrap.status(), missing);
  assert.deepEqual(bootstrap.initialize(), missing);
  assert.equal(bootstrap.token(), null);
  assert.equal(existsSync(values.tokenFile), false);
  assert.deepEqual(createAdminBootstrap({ tokenFile: values.tokenFile }).status(), missing);
});

test('concurrent initializers converge on one durable token', async t => {
  const values = fixture();
  t.after(() => rmSync(values.directory, { recursive: true, force: true }));
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const bootstrapModule = new URL(`../src/admin/bootstrap.${extension}`, import.meta.url).href;
  const program = [
    `import { createAdminBootstrap } from ${JSON.stringify(bootstrapModule)};`,
    'const status = createAdminBootstrap({ tokenFile: process.env.ADMIN_BOOTSTRAP_TOKEN_FILE }).initialize();',
    'process.stdout.write(JSON.stringify(status));'
  ].join('\n');
  const environment = { ...process.env, ADMIN_BOOTSTRAP_TOKEN_FILE: values.tokenFile };
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    execute(process.execPath, ['--input-type=module', '--eval', program], {
      env: environment
    })));

  const token = readFileSync(values.tokenFile, 'utf8').trim();
  assert.match(token, /^[a-f0-9]{64}$/);
  for (const result of results) {
    assert.deepEqual(JSON.parse(result.stdout), {
      initialized: true,
      canInitialize: false,
      tokenFile: values.tokenFile
    });
    assert.equal(result.stdout.includes(token), false);
  }
  assert.equal(createAdminBootstrap({ tokenFile: values.tokenFile }).token(), token);
});

test('rejects weak, linked, malformed, and oversized token files without modifying them', t => {
  const root = mkdtempSync(join(tmpdir(), 'admin-bootstrap-invalid-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const weak = join(root, 'weak.token');
  writeFileSync(weak, EXISTING_TOKEN, { mode: 0o644 });
  const weakBefore = readFileSync(weak);
  assert.throws(() => createAdminBootstrap({ tokenFile: weak }).initialize(),
    frameworkCode('ADMIN_BOOTSTRAP_TOKEN_SECURITY'));
  assert.deepEqual(readFileSync(weak), weakBefore);

  const target = join(root, 'target.token');
  const linked = join(root, 'linked.token');
  writeFileSync(target, EXISTING_TOKEN, { mode: 0o600 });
  symlinkSync(target, linked);
  assert.throws(() => createAdminBootstrap({ tokenFile: linked }).initialize(),
    frameworkCode('ADMIN_BOOTSTRAP_TOKEN_SECURITY'));
  assert.equal(readFileSync(target, 'utf8'), EXISTING_TOKEN);
  assert.equal(lstatSync(linked).isSymbolicLink(), true);

  for (const [name, content] of [
    ['short.token', 'too-short'],
    ['newline.token', `${EXISTING_TOKEN}\nsecond-line`],
    ['oversized.token', 'x'.repeat(4_097)]
  ]) {
    const filename = join(root, name);
    writeFileSync(filename, content, { mode: 0o600 });
    const before = readFileSync(filename);
    assert.throws(() => createAdminBootstrap({ tokenFile: filename }).initialize(), FrameworkError);
    assert.deepEqual(readFileSync(filename), before);
  }
});

test('rejects nonprivate directories and unsafe initialization markers', t => {
  const values = fixture();
  t.after(() => rmSync(values.directory, { recursive: true, force: true }));
  chmodSync(values.directory, 0o755);
  assert.throws(() => createAdminBootstrap({ tokenFile: values.tokenFile }).initialize(),
    frameworkCode('ADMIN_BOOTSTRAP_DIRECTORY_SECURITY'));
  assert.equal(existsSync(values.tokenFile), false);

  chmodSync(values.directory, 0o700);
  writeFileSync(values.tokenFile, EXISTING_TOKEN, { mode: 0o600 });
  const markerTarget = join(values.directory, 'marker-target');
  writeFileSync(markerTarget, '{"schema":1}\n', { mode: 0o600 });
  symlinkSync(markerTarget, `${values.tokenFile}.initialized`);
  assert.throws(() => createAdminBootstrap({ tokenFile: values.tokenFile }).status(),
    frameworkCode('ADMIN_BOOTSTRAP_MARKER_SECURITY'));
  assert.equal(readFileSync(values.tokenFile, 'utf8'), EXISTING_TOKEN);
});
