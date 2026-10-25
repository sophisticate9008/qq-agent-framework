import assert from 'node:assert/strict';
import test from 'node:test';
import { awaitCondition } from './fixtures/await-condition.ts';

test('fixture wait bounds never-settling asynchronous conditions and reports useful state', async () => {
  await assert.rejects(awaitCondition(() => new Promise<boolean>(() => {}), {
    message: 'Expected local stream ready', timeoutMs: 20, diagnostics: () => ({ stage: 'opening' }),
  }), error => error instanceof Error && /Expected local stream ready; elapsed=\d+ms; attempts=1; state=\{"stage":"opening"\}/.test(error.message));
  await awaitCondition(() => true, { message: 'Already ready', timeoutMs: 20 });
});
