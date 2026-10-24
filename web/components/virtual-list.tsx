import { Fragment, cloneElement, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type HTMLAttributes, type ReactElement, type ReactNode, type Ref } from 'react';
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import { includeVirtualPins, virtualGaps } from './virtual-range.ts';

const virtualizationThreshold = 60;

export interface VirtualListHandle {
  scrollToIndex(index: number): void;
}

interface VirtualItemsProps<Item> {
  readonly items: readonly Item[];
  readonly getItemKey: (item: Item, index: number) => string | number;
  readonly estimateSize?: number;
  readonly listRef?: Ref<VirtualListHandle>;
}

function scrollParent(element: HTMLElement | null): HTMLElement | null {
  for (let parent = element?.parentElement; parent; parent = parent.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}

function useMeasuredItems<Item, Element extends HTMLElement>({ items, getItemKey, estimateSize = 64, listRef }: VirtualItemsProps<Item>) {
  const root = useRef<Element>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [keyboardTarget, setKeyboardTarget] = useState<number | null>(null);
  const [selectionKeys, setSelectionKeys] = useState<readonly string[]>([]);
  const enabled = items.length > virtualizationThreshold;
  const keys = useMemo(() => items.map(getItemKey), [items, getItemKey]);
  const keyIndexes = useMemo(() => new Map(keys.map((key, index) => [String(key), index])), [keys]);
  const getScrollElement = useCallback(() => scrollParent(root.current), []);
  const getKey = useCallback((index: number) => keys[index], [keys]);
  const rangeExtractor = useCallback((range: Range) => {
    const focusedIndex = focusedKey === null ? undefined : keyIndexes.get(focusedKey);
    const pins = selectionKeys.flatMap(key => keyIndexes.get(key) ?? []);
    if (focusedIndex !== undefined) pins.push(focusedIndex - 1, focusedIndex, focusedIndex + 1);
    if (keyboardTarget !== null) pins.push(keyboardTarget);
    return includeVirtualPins(defaultRangeExtractor(range), pins, items.length);
  }, [focusedKey, items.length, keyIndexes, selectionKeys, keyboardTarget]);
  const virtualizer = useVirtualizer<HTMLElement, HTMLElement>({
    count: items.length,
    getScrollElement,
    getItemKey: getKey,
    estimateSize: () => estimateSize,
    overscan: 6,
    enabled,
    scrollMargin,
    scrollPaddingStart: headerHeight,
    rangeExtractor,
    useFlushSync: false,
  });

  useLayoutEffect(() => {
    const element = root.current;
    const viewport = getScrollElement();
    if (!element || !viewport) return;
    const table = element.closest('table');
    const measure = () => {
      setScrollMargin(element.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop - viewport.clientTop);
      setHeaderHeight(table?.tHead?.getBoundingClientRect().height ?? 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    for (let parent = element.parentElement; parent && parent !== viewport; parent = parent.parentElement) observer.observe(parent);
    const details = element.closest('details');
    details?.addEventListener('toggle', measure);
    return () => {
      observer.disconnect();
      details?.removeEventListener('toggle', measure);
    };
  }, [getScrollElement, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const rememberSelection = () => {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !root.current) {
        setSelectionKeys(current => current.length === 0 ? current : []);
        return;
      }
      const range = selection.getRangeAt(0);
      const selected = [...root.current.querySelectorAll<HTMLElement>('[data-virtual-key]')]
        .filter(element => range.intersectsNode(element)).map(element => element.dataset.virtualKey ?? '');
      setSelectionKeys(current => current.join('\0') === selected.join('\0') ? current : selected);
    };
    document.addEventListener('selectionchange', rememberSelection);
    return () => document.removeEventListener('selectionchange', rememberSelection);
  }, [enabled]);

  useImperativeHandle(listRef, () => ({
    scrollToIndex(index) {
      if (items.length === 0) return;
      const bounded = Math.max(0, Math.min(items.length - 1, index));
      if (enabled) virtualizer.scrollToIndex(bounded, { align: 'auto' });
      else root.current?.querySelector<HTMLElement>(`[data-virtual-index="${bounded}"]`)?.scrollIntoView({ block: 'nearest' });
    },
  }), [enabled, items.length, virtualizer]);

  useLayoutEffect(() => {
    if (keyboardTarget === null) return;
    const row = root.current?.querySelector<HTMLElement>(`[data-virtual-index="${keyboardTarget}"]`);
    if (!row) return;
    const control = row.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]');
    (control ?? row).focus({ preventScroll: true });
    if (enabled) virtualizer.scrollToIndex(keyboardTarget, { align: keyboardTarget === 0 ? 'start' : 'end' });
    else row.scrollIntoView({ block: 'nearest' });
    setKeyboardTarget(null);
  }, [keyboardTarget, enabled, virtualizer]);

  const captureFocus: HTMLAttributes<Element>['onFocusCapture'] = event => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-virtual-key]');
    if (row) setFocusedKey(row.dataset.virtualKey ?? null);
  };
  const captureBlur: HTMLAttributes<Element>['onBlurCapture'] = event => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFocusedKey(null);
  };
  const captureKeyDown: HTMLAttributes<Element>['onKeyDownCapture'] = event => {
    if (items.length === 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
      || (event.key !== 'Home' && event.key !== 'End')
      || (event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : items.length - 1;
    setKeyboardTarget(index);
  };
  const virtualItems = enabled ? virtualizer.getVirtualItems() : [];
  const gaps = enabled ? virtualGaps(virtualItems, virtualizer.getTotalSize(), scrollMargin) : [];
  return { root, keys, enabled, virtualItems, gaps, measureElement: virtualizer.measureElement, captureFocus, captureBlur, captureKeyDown };
}

export function VirtualTableBody<Item>({ items, getItemKey, estimateSize, listRef, columns, children }: VirtualItemsProps<Item> & {
  readonly columns: number;
  readonly children: (item: Item, index: number) => ReactElement<HTMLAttributes<HTMLTableRowElement> & { ref?: Ref<HTMLTableRowElement> }>;
}) {
  const measured = useMeasuredItems<Item, HTMLTableSectionElement>({ items, getItemKey, estimateSize, listRef });
  const gaps = new Map(measured.gaps.map(gap => [gap.before, gap.size]));
  const spacer = (size: number | undefined) => size ? <tr aria-hidden="true" data-virtual-spacer style={{ border: 0 }}><td colSpan={columns} style={{ height: size, padding: 0, border: 0, lineHeight: 0 }} /></tr> : null;
  const row = (index: number) => cloneElement(children(items[index], index), {
    key: measured.keys[index],
    ref: measured.enabled ? measured.measureElement : undefined,
    'aria-rowindex': index + 2,
    tabIndex: -1,
    ...{ 'data-index': index, 'data-virtual-index': index, 'data-virtual-key': String(measured.keys[index]) },
  });
  return <tbody ref={measured.root} className="divide-y" data-virtualized={measured.enabled || undefined} onFocusCapture={measured.captureFocus} onBlurCapture={measured.captureBlur} onKeyDownCapture={measured.captureKeyDown}>
    {measured.enabled ? measured.virtualItems.map(item => <Fragment key={item.key}>{spacer(gaps.get(item.index))}{row(item.index)}</Fragment>) : items.map((_, index) => row(index))}
    {spacer(gaps.get(-1))}
  </tbody>;
}

export function VirtualList<Item>({ items, getItemKey, estimateSize, listRef, children, className, itemClassName = '' }: VirtualItemsProps<Item> & {
  readonly children: (item: Item, index: number) => ReactNode;
  readonly className?: string;
  readonly itemClassName?: string;
}) {
  const measured = useMeasuredItems<Item, HTMLDivElement>({ items, getItemKey, estimateSize, listRef });
  const gaps = new Map(measured.gaps.map(gap => [gap.before, gap.size]));
  const spacer = (size: number | undefined) => size ? <div aria-hidden="true" data-virtual-spacer style={{ height: size }} /> : null;
  const row = (index: number) => <div key={measured.keys[index]} ref={measured.enabled ? measured.measureElement : undefined} data-index={index} data-virtual-index={index} data-virtual-key={String(measured.keys[index])} role="listitem" tabIndex={-1} aria-posinset={index + 1} aria-setsize={items.length} className={itemClassName}>{children(items[index], index)}</div>;
  return <div ref={measured.root} className={className} role="list" tabIndex={0} data-virtualized={measured.enabled || undefined} onFocusCapture={measured.captureFocus} onBlurCapture={measured.captureBlur} onKeyDownCapture={measured.captureKeyDown}>
    {measured.enabled ? measured.virtualItems.map(item => <Fragment key={item.key}>{spacer(gaps.get(item.index))}{row(item.index)}</Fragment>) : items.map((_, index) => row(index))}
    {spacer(gaps.get(-1))}
  </div>;
}
