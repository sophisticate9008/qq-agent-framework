import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesPageSearch, resolvePageSearchTarget, type PageIndexEntry } from '../web/lib/page-index.ts';

test('page search matches all words across Chinese section and field labels', () => {
  assert(matchesPageSearch('预算 次数', '运营预算', '最多发送次数'));
  assert(matchesPageSearch(' DSＨ  模型 ', 'DSH 模型与连接', '模型提供方'));
  assert(matchesPageSearch('', '运行设置'));
  assert(!matchesPageSearch('预算 不存在', '运营预算', '最多发送次数'));
});

test('native field locator uses stable section id, not a resource name or unrelated field', () => {
  const element = {} as HTMLElement;
  const section: PageIndexEntry = { id: 'section-1', kind: 'section', title: 'private-resource-name',
    sectionTitle: 'private-resource-name', sectionId: 'native-provider-editor', element };
  const unrelated: PageIndexEntry = { ...section, id: 'other', kind: 'field', title: '模型显示名称（可选）', sectionId: 'unrelated' };
  const target = { kind: 'field' as const, title: '模型显示名称（可选）', sectionId: 'native-provider-editor', sectionTitle: '提供方设置' };
  assert.deepEqual(resolvePageSearchTarget([section, unrelated], target), { match: undefined, section });
  const actual = { ...section, id: 'field-1', kind: 'field' as const, title: target.title };
  assert.equal(resolvePageSearchTarget([section, unrelated, actual], target).match, actual);
  assert.equal(resolvePageSearchTarget([section], { ...target, kind: 'section' }).match, section);
  assert.deepEqual(resolvePageSearchTarget([unrelated], target), { match: undefined, section: undefined });
  assert.equal(resolvePageSearchTarget([section], { ...target, sectionId: 'not-rendered', fallbackSectionId: section.sectionId }).section, section);
});
