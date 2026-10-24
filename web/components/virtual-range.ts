export interface MeasuredVirtualItem {
  readonly index: number;
  readonly start: number;
  readonly end: number;
}

export interface VirtualGap {
  readonly before: number;
  readonly size: number;
}

export function includeVirtualPins(visible: readonly number[], pins: readonly number[], count: number): number[] {
  return [...new Set([...visible, ...pins].filter(index => Number.isInteger(index) && index >= 0 && index < count))]
    .sort((left, right) => left - right);
}

export function virtualGaps(items: readonly MeasuredVirtualItem[], totalSize: number, scrollMargin: number): VirtualGap[] {
  const gaps: VirtualGap[] = [];
  let previousEnd = scrollMargin;
  for (const item of items) {
    const size = Math.max(0, item.start - previousEnd);
    if (size > 0) gaps.push({ before: item.index, size });
    previousEnd = item.end;
  }
  const remaining = Math.max(0, totalSize + scrollMargin - previousEnd);
  if (remaining > 0) gaps.push({ before: -1, size: remaining });
  return gaps;
}
