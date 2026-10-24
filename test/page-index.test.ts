import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesPageSearch } from '../web/lib/page-index.ts';

test('page search matches all words across Chinese section and field labels', () => {
  assert(matchesPageSearch('预算 次数', '运营预算', '最多发送次数'));
  assert(matchesPageSearch(' DSＨ  模型 ', 'DSH 模型与连接', '模型提供方'));
  assert(matchesPageSearch('', '运行设置'));
  assert(!matchesPageSearch('预算 不存在', '运营预算', '最多发送次数'));
});
