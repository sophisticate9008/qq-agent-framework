import assert from 'node:assert/strict';
import test from 'node:test';
import { Virtualizer, defaultRangeExtractor } from '@tanstack/react-virtual';
import { includeVirtualPins, virtualGaps } from '../web/components/virtual-range.ts';
import { parseSessionSnapshot, parseUsageSnapshot } from '../web/lib/activity.ts';
import { parseUsageConversation, parseUsageRecent, parseUsageSeries } from '../web/lib/usage-details.ts';
import { virtualizedPagesFixture } from './fixtures/virtualized-pages.ts';

test('large real-page fixtures obey current parser bounds rather than replacing failures with empty data', () => {
  const fixture = virtualizedPagesFixture();
  assert.equal(parseSessionSnapshot(fixture.sessions)?.sessions.length, 256);
  assert.equal(parseUsageSnapshot(fixture.summary)?.conversations.length, 200);
  assert.equal(parseUsageConversation(fixture.turns('group:100000'))?.turns.length, 200);
  assert.equal(parseUsageRecent(fixture.recent)?.entries.length, 40);
  assert.equal(parseUsageSeries(fixture.series(24))?.buckets.length, 48);
});

test('focus pins stay sorted and bounded without filling the gap to a distant viewport', () => {
  assert.deepEqual(includeVirtualPins([49_990, 49_991], [1, 0, 1, -1, 50_000, 2.5], 50_000), [0, 1, 49_990, 49_991]);
  assert.deepEqual(includeVirtualPins([], [0], 0), []);
});

test('semantic spacer gaps preserve total height with header offset and disjoint pinned rows', () => {
  const rows = [{ index: 0, start: 40, end: 95 }, { index: 99, start: 6_040, end: 6_115 }];
  const gaps = virtualGaps(rows, 6_075, 40);
  assert.deepEqual(gaps, [{ before: 99, size: 5_945 }]);
  assert.equal(rows.reduce((total, row) => total + row.end - row.start, 0) + gaps.reduce((total, gap) => total + gap.size, 0), 6_075);
  assert.deepEqual(virtualGaps([], 100, 40), [{ before: -1, size: 100 }]);
  assert.deepEqual(virtualGaps([{ index: 3, start: 140, end: 160 }], 200, 40), [{ before: 3, size: 100 }, { before: -1, size: 80 }]);
});

test('50,000 variable measured items retain bounded render ranges and include the last row', () => {
  const count = 50_000;
  const virtualizer = new Virtualizer<HTMLElement, HTMLElement>({
    count,
    getScrollElement: () => null,
    getItemKey: index => `fixture-${index}`,
    estimateSize: () => 64,
    initialRect: { width: 1000, height: 384 },
    overscan: 6,
    scrollToFn: () => {},
    observeElementRect: () => {},
    observeElementOffset: () => {},
    rangeExtractor: range => includeVirtualPins(defaultRangeExtractor(range), [0, 1], count),
  });
  assert.ok(virtualizer.getVirtualItems().length < 30);
  for (let index = 0; index < count; index += 997) virtualizer.resizeItem(index, 40 + index % 160);
  for (const fraction of [0.25, 0.5, 0.75, 1]) {
    virtualizer.scrollOffset = (virtualizer.getTotalSize() - 384) * fraction;
    const rendered = virtualizer.getVirtualItems();
    assert.ok(rendered.length < 30);
    const gaps = virtualGaps(rendered, virtualizer.getTotalSize(), 0);
    const occupied = rendered.reduce((total, row) => total + row.size, 0) + gaps.reduce((total, gap) => total + gap.size, 0);
    assert.equal(occupied, virtualizer.getTotalSize());
  }
  assert.equal(virtualizer.getVirtualItems().at(-1)?.index, count - 1);
  assert.equal(virtualizer.getVirtualItems()[0]?.key, 'fixture-0');
});
