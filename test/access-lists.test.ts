import assert from 'node:assert/strict';
import test from 'node:test';
import { formatAccessLists, parseAccessLists } from '../web/lib/access-lists.ts';

test('access lists show separate plain numbers with commas and preserve stored interleaved order', () => {
  const previous = ['private:123001', 'group:456001', 'private:123002', 'group:456002'];
  const fields = formatAccessLists(previous);
  assert.deepEqual(fields, { groups: '456001, 456002', privateChats: '123001, 123002' });
  assert.deepEqual(parseAccessLists(fields, previous), { values: previous });
  assert.deepEqual(formatAccessLists([]), { groups: '', privateChats: '' });
});

test('access lists accept comma and pasted line separators without converting account numbers to numbers', () => {
  assert.deepEqual(parseAccessLists({ groups: '456001, 456002，456003\n456004', privateChats: '123001;123002；123003、123004' }).values,
    ['group:456001', 'group:456002', 'group:456003', 'group:456004', 'private:123001', 'private:123002', 'private:123003', 'private:123004']);
  assert.deepEqual(parseAccessLists({ groups: '12345678901234567890', privateChats: '' }).values, ['group:12345678901234567890']);
});

test('access lists reject invalid and repeated numbers in each scope but allow identical numbers across scopes', () => {
  for (const invalid of ['0', '0123', '-123', '1.5', '1e3', 'group:123', 'private:123', '123456789012345678901', 'abc']) {
    assert(parseAccessLists({ groups: invalid, privateChats: '' }).error);
    assert(parseAccessLists({ groups: '', privateChats: invalid }).error);
  }
  assert(parseAccessLists({ groups: '123,123', privateChats: '' }).error);
  assert(parseAccessLists({ groups: '', privateChats: '123,123' }).error);
  assert.deepEqual(parseAccessLists({ groups: '123', privateChats: '123' }).values, ['group:123', 'private:123']);
});

test('access list edits retain existing order, append new members, remove only requested members and deny all when empty', () => {
  const previous = ['private:123', 'group:456', 'group:789'];
  assert.deepEqual(parseAccessLists({ groups: '456,999', privateChats: '123,222' }, previous).values,
    ['private:123', 'group:456', 'group:999', 'private:222']);
  assert.deepEqual(parseAccessLists({ groups: '', privateChats: '' }, previous).values, []);
  assert.deepEqual(parseAccessLists({ groups: '789,456', privateChats: '123' }, previous).values, previous);
});

test('access list combined bound remains 1024, not 1024 for each scope', () => {
  const groups = Array.from({ length: 512 }, (_, index) => String(index + 1)).join(',');
  const privateChats = Array.from({ length: 512 }, (_, index) => String(index + 1)).join(',');
  assert.equal(parseAccessLists({ groups, privateChats }).values?.length, 1024);
  assert(parseAccessLists({ groups, privateChats: `${privateChats},9999` }).error);
});
