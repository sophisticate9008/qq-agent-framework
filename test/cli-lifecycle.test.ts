import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createNativeChatGatewayFixture, nativeGatewayFixtureObject as object } from './fixtures/native-chat-gateway.ts';

test('actual CLI start drains on SIGTERM and restores a pinned bootstrap in a fresh process', { timeout: 90_000 }, async context => {
  const fixture = await createNativeChatGatewayFixture(context, { realCli: true });
  const configurationBefore = await readFile(fixture.configurationFile, 'utf8');
  await fixture.launch();
  const first = await fixture.runtime();
  assert.equal(first.state, 'stopped');
  assert.equal(object(first.bootstrap).state, 'not-started');
  assert.equal(object(object(first.bootstrap).manifest).id, 'fixture-bootstrap');
  await fixture.shutdown();
  const fingerprint = createHash('sha256').update(await readFile(fixture.bootstrapFile)).digest('hex');
  await writeFile(`${fixture.configurationFile}.bootstrap.json`, JSON.stringify({ schema: 1,
    filename: fixture.bootstrapFile, fingerprint }), { mode: 0o600 });
  await fixture.launch(true);
  const restored = await fixture.runtime();
  assert.equal(restored.state, 'stopped');
  assert.equal(object(object(restored.bootstrap).manifest).id, 'fixture-bootstrap');
  assert.equal(object(restored.bootstrap).codeFingerprint, fingerprint);
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.onebots.size, 0);
  assert.equal(await readFile(fixture.configurationFile, 'utf8'), configurationBefore);
  await fixture.shutdown();
  assert.equal((await readFile(fixture.lifecycleFile, 'utf8')).split('loaded').length - 1, 2);
});
