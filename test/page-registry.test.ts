import assert from 'node:assert/strict';
import test from 'node:test';
import { overviewPageShortcuts, pageDefinition, pageNavigationGroups, pageRegistry, registeredPageId } from '../web/lib/page-registry.ts';
import { resolvePageNavigation } from '../web/lib/page-navigation.ts';
import { groupWorkspaceSearchTargets, workspacePageTargets, workspacePageTitle } from '../web/lib/workspace-search.ts';

test('registered pages share titles across navigation and search and each belongs to one navigation group', () => {
  assert.equal(new Set(pageRegistry.map(page => page.id)).size, pageRegistry.length);
  for (const page of pageRegistry) {
    assert(registeredPageId(page.id));
    assert.equal(workspacePageTitle(page.id), page.label);
    assert.equal(workspacePageTargets.find(target => target.page === page.id)?.title, page.label);
    assert.equal(pageNavigationGroups.filter(group => group.pages.includes(page.id)).length, 1);
  }
  assert.deepEqual(groupWorkspaceSearchTargets(workspacePageTargets).map(group => group.page), pageRegistry.map(page => page.id));
  assert.deepEqual(pageNavigationGroups.find(group => group.id === 'persona')?.pages, ['persona', 'model']);
  for (const shortcut of overviewPageShortcuts) assert(registeredPageId(shortcut.id));
  assert.equal(registeredPageId('not-a-page'), false);
});

test('legacy page hashes and overview shortcuts keep the registered section destination', () => {
  for (const [id, sectionId] of [['access', 'security-access'], ['settings', 'security-settings']] as const) {
    assert(registeredPageId(id));
    assert.equal(pageDefinition(id).id, 'security');
    assert.equal(resolvePageNavigation(id).target?.sectionId, sectionId);
    assert(overviewPageShortcuts.some(shortcut => shortcut.id === id));
  }
  const field = { title: '精确字段', sectionId: 'specific', kind: 'field' as const };
  assert.deepEqual(resolvePageNavigation('settings', field), { page: 'security', target: field });
});
