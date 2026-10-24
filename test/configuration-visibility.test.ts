import assert from 'node:assert/strict';
import test from 'node:test';
import { configurationSearchMatch, resolveConfigurationVisibility, type VisibilityGroup } from '../web/lib/configuration-visibility.ts';

const groups: readonly VisibilityGroup[] = [
  { id: 'base', title: '连接', fields: [
    { id: 'enabled', label: '启用连接' },
    { id: 'endpoint', label: '服务地址', dependsOn: ['enabled'] },
    { id: 'retryEnabled', label: '重试开关', dependsOn: ['enabled'] },
    { id: 'retryLimit', label: '重试上限', dependsOn: ['enabled', 'retryEnabled'] },
  ] },
  { id: 'optional', title: '扩展设置', dependsOn: ['extensionEnabled'], fields: [
    { id: 'extensionModel', label: '扩展模型' },
  ] },
];

test('generic visibility uses declared dependencies rather than project-specific modes', () => {
  const visible = resolveConfigurationVisibility(groups, { values: { enabled: true, retryEnabled: false } });
  assert.deepEqual([...visible.get('base')!.fieldIds], ['enabled', 'endpoint', 'retryEnabled']);
  assert.equal(visible.get('optional')!.visible, false);
});

test('missing or disabled parents do not reveal dependent fields', () => {
  const missing = resolveConfigurationVisibility(groups, { values: {} });
  assert.deepEqual([...missing.get('base')!.fieldIds], ['enabled']);
  const disabled = resolveConfigurationVisibility(groups, { values: { enabled: false, retryEnabled: true } });
  assert.deepEqual([...disabled.get('base')!.fieldIds], ['enabled']);
});

test('nested dependencies and optional groups can be enabled explicitly', () => {
  const visible = resolveConfigurationVisibility(groups, {
    values: { enabled: true, retryEnabled: true, extensionEnabled: true },
  });
  assert.equal(visible.get('base')!.fieldIds.size, 4);
  assert.deepEqual([...visible.get('optional')!.fieldIds], ['extensionModel']);
});

test('hidden drafts remain visible without changing the parent switch', () => {
  const values = Object.freeze({ enabled: false });
  const visible = resolveConfigurationVisibility(groups, { values, dirtyFieldIds: new Set(['endpoint', 'extensionModel']) });
  assert(visible.get('base')!.fieldIds.has('endpoint'));
  assert(visible.get('base')!.inactiveDirtyFieldIds.has('endpoint'));
  assert(visible.get('optional')!.inactiveDirtyFieldIds.has('extensionModel'));
  assert.equal(values.enabled, false);
});

test('explicit inactive inspection does not modify saved configuration', () => {
  const values = Object.freeze({ enabled: false });
  const visible = resolveConfigurationVisibility(groups, { values, showInactive: true });
  assert.equal(visible.get('base')!.fieldIds.size, 4);
  assert.equal(visible.get('optional')!.visible, true);
  assert.equal(values.enabled, false);
});

test('configuration search only includes visible metadata', () => {
  const ids = new Set(['enabled']);
  assert.equal(configurationSearchMatch(groups[0]!, ids, '连接'), null);
  assert.deepEqual(configurationSearchMatch(groups[0]!, ids, '启用'), ids);
  assert.equal(configurationSearchMatch(groups[0]!, ids, '地址'), undefined);
  assert.equal(configurationSearchMatch(groups[0]!, new Set(), ''), undefined);
});
