import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNativeToolRuntimeStatus } from '../web/lib/native-tool-status.ts';

test('runtime installation parser keeps registered tools separate from projected sessions and rejects declaration-only state', () => {
  assert.equal(parseNativeToolRuntimeStatus({ features: [{ id: 'media', status: 'available' }], capabilities: ['native.media.read'] }), null);
  const value = { packages: [{ schema: 1, id: 'media', version: '1.0.0', state: 'running', phase: null, reason: null,
    resources: [{ id: 'media-read', kind: 'contribution', state: 'active' }] }], frameworkTools: { schema: 1, available: true, reason: null,
    channel: { state: 'idle', pending: 0, lastError: null }, tools: [{ name: 'qaf_media_read', capability: 'native.media.read' }], projections: 0 } };
  const result = parseNativeToolRuntimeStatus(value); assert(result);
  assert.equal(result.packages[0]?.state, 'running'); assert.equal(result.frameworkTools?.tools.length, 1);
  assert.equal(result.frameworkTools?.projections, 0); assert.equal(result.frameworkTools?.channel.state, 'idle');
  assert.equal(parseNativeToolRuntimeStatus({ ...value, frameworkTools: null })?.frameworkTools, null);
  assert.equal(parseNativeToolRuntimeStatus({ ...value, frameworkTools: { ...value.frameworkTools, projections: -1 } }), null);
  assert.equal(parseNativeToolRuntimeStatus({ ...value, packages: [{ ...value.packages[0], state: 'enabled' }] }), null);
  assert.equal(parseNativeToolRuntimeStatus({ ...value, packages: [...value.packages, ...value.packages] }), null);
});
