import test from 'node:test';
import assert from 'node:assert/strict';
import { errorCode, FrameworkError, snapshot } from '../src/core/values.ts';

test('error codes survive separate extension constructors without exposing arbitrary errors or getters', () => {
  class ExtensionError extends Error {
    readonly code = 'PLUGIN_MODEL_SESSION_UNAVAILABLE';
    constructor() { super('private detail'); this.name = 'FrameworkError'; }
  }
  assert.equal(errorCode(new FrameworkError('DIARY_PLAN_INVALID', 'detail')), 'DIARY_PLAN_INVALID');
  class AdapterError extends FrameworkError { constructor() { super('DSH_FOLLOW_ENDED', 'detail'); this.name = 'DshAdapterError'; } }
  assert.equal(errorCode(new AdapterError()), 'DSH_FOLLOW_ENDED');
  assert.equal(errorCode(new ExtensionError()), 'PLUGIN_MODEL_SESSION_UNAVAILABLE');
  assert.equal(errorCode(Object.assign(new Error('private detail'), { code: 'PRIVATE_DETAIL' })), 'INTERNAL_ERROR');
  assert.equal(errorCode({ name: 'FrameworkError', code: 'PRIVATE_DETAIL' }), 'INTERNAL_ERROR');
  const malformed = new FrameworkError('private detail', 'private detail');
  assert.equal(errorCode(malformed), 'INTERNAL_ERROR');
  Object.defineProperty(malformed, 'code', { get() { throw new Error('must not be invoked'); } });
  assert.equal(errorCode(malformed), 'INTERNAL_ERROR');
});

test('snapshots detach and freeze nested data without prototype setters', () => {
  const input: { identity: { name: string }; authorized?: boolean } = JSON.parse('{"identity":{"name":"demo"},"__proto__":{"authorized":true}}');
  const value = snapshot(input);
  input.identity.name = 'changed';
  assert.equal(value.identity.name, 'demo');
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(value.authorized, undefined);
  assert(Object.hasOwn(value, '__proto__'));
  assert(Object.isFrozen(value.identity));
});

test('non-data, cycles, accessors and sparse arrays are rejected without invoking getters', () => {
  let called = false;
  const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get() { called = true; return 'not-data'; } });
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const value of [undefined, NaN, Infinity, new Date(), new Map(), () => {}, cycle, accessor, new Array(2), [undefined]]) {
    assert.throws(() => snapshot(value), { code: 'INVALID_DATA' });
  }
  assert.equal(called, false);
});
