import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshot } from '../src/core/values.ts';

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
