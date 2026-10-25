import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, type ApiClient } from '../web/lib/api.ts';
import { catalogFailureState, nativeCatalogOperation } from '../web/lib/native-catalog-operation.ts';
const client = (): ApiClient => ({ get: async () => ({}), post: async () => ({}) });

test('native catalog errors classify 409 conflict, 423/429 busy and uncertain transport separately', () => {
  for (const status of [423, 429]) assert.equal(catalogFailureState(new ApiError('busy', status)), 'busy');
  assert.equal(catalogFailureState(new ApiError('revision_conflict', 409)), 'conflict');
  assert.equal(catalogFailureState(new Error('offline')), 'unknown');
  assert.equal(catalogFailureState(new ApiError('operation_unknown', 504)), 'unknown');
  assert.equal(catalogFailureState(new ApiError('invalid', 400)), 'idle');
  assert.equal(catalogFailureState(new ApiError('provider_model_in_use', 409)), 'idle');
  assert.equal(catalogFailureState(new ApiError('assistant_target_in_use', 409)), 'idle');
});

test('unknown writes survive owner disposal and require a new read and explicit release before another save', () => {
  const api = client(); const first = nativeCatalogOperation(api, 'plans', {}); const controller = new AbortController();
  const token = first.begin('revision', controller.signal); assert(token);
  assert.equal(first.begin('revision', controller.signal), null); controller.abort();
  assert.equal(first.store.getSnapshot().plans?.reason, 'unknown'); assert.equal(first.complete(token), false);
  first.dispose(); const reopened = nativeCatalogOperation(api, 'plans', {});
  assert.equal(reopened.release(), false); reopened.review(); assert(reopened.release());
  assert(reopened.begin('new-revision', new AbortController().signal));
});

test('configuration domains share ownership rules but independent ledgers, and only definitive success clears pending', () => {
  const api = client(); const plans = nativeCatalogOperation(api, 'plans', {}); const personas = nativeCatalogOperation(api, 'personas', {});
  const a = plans.begin('p', new AbortController().signal); const b = personas.begin('q', new AbortController().signal); assert(a && b);
  plans.fail(a, new ApiError('too_many_requests', 429)); assert.equal(plans.store.getSnapshot().plans?.reason, 'busy');
  assert(personas.complete(b)); assert.equal(personas.store.getSnapshot().personas, undefined);
  plans.review(); plans.dispose(); const reopened = nativeCatalogOperation(api, 'plans', {}); assert.equal(reopened.release(), false);
});
