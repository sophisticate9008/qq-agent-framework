import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { defaultRangeExtractor, measureElement as measureVirtualElement, useVirtualizer, useWindowVirtualizer,
  type Range, type Virtualizer } from '@tanstack/react-virtual'
import { includeVirtualPins } from './virtual-range.ts'

export interface VirtualMasonryItemContext {
  readonly width: number
  /** null means the document viewport; otherwise the closest scrolling ancestor. */
  readonly viewport: HTMLElement | null
  readonly active: boolean
}
interface VirtualMasonryProps<Item> {
  readonly items: readonly Item[]
  readonly getItemKey: (item: Item, index: number) => string
  readonly estimateSize?: (item: Item, index: number, width: number) => number
  readonly minimumColumnWidth?: number
  readonly maximumColumns?: number
  readonly gap?: number
  readonly resetKey?: string
  /** Keep a small number of dialog origin/focus targets mounted outside the viewport. */
  readonly pinnedKeys?: readonly string[]
  readonly className?: string
  readonly children: (item: Item, index: number, context: VirtualMasonryItemContext) => ReactNode
}
function scrollingAncestor(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) return parent
  }
  return null
}

/** Equal-width, dynamically measured columns in the actual page or panel scroll viewport. */
export function VirtualMasonry<Item>({ items, getItemKey, estimateSize, minimumColumnWidth = 208, maximumColumns = 6,
  gap = 12, resetKey, pinnedKeys = [], className, children }: VirtualMasonryProps<Item>) {
  const root = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState({ width: 0, margin: 0, offset: 0, height: 0, viewport: null as HTMLElement | null, visible: false })
  const activeVirtualizer = useRef<Virtualizer<HTMLElement, HTMLDivElement> | Virtualizer<Window, HTMLDivElement> | null>(null)
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const [keyboardTarget, setKeyboardTarget] = useState<number | null>(null)
  const [anchorKey, setAnchorKey] = useState<string | null>(null)
  const widthAnchor = useRef<{ key: string; offset: number } | null>(null)
  const observedWidth = useRef(0)
  const measured = useRef(new Map<string, { width: number; height: number }>())
  const lastHeight = useRef(0)
  const previousReset = useRef(resetKey)
  const keys = useMemo(() => items.map(getItemKey), [items, getItemKey])
  const indexes = useMemo(() => new Map(keys.map((key, index) => [key, index])), [keys])
  const columns = Math.max(1, Math.min(maximumColumns, Math.floor((layout.width + gap) / (minimumColumnWidth + gap))))
  const columnWidth = Math.max(1, (layout.width - gap * (columns - 1)) / columns)
  const enabled = layout.visible && layout.width > 0 && items.length > 0
  const itemKey = useCallback((index: number) => keys[index], [keys])
  const estimatedHeight = useCallback((index: number) => {
    const cached = measured.current.get(keys[index])
    if (cached && Math.abs(cached.width - columnWidth) < 1) return cached.height
    return Math.max(80, estimateSize?.(items[index], index, columnWidth) ?? 420)
  }, [keys, columnWidth, estimateSize, items])
  const rangeExtractor = useCallback((range: Range) => {
    const focused = focusedKey === null ? undefined : indexes.get(focusedKey)
    const pins = focused === undefined ? [] : [focused - 1, focused, focused + 1]
    if (keyboardTarget !== null) pins.push(keyboardTarget)
    if (anchorKey !== null) { const anchor = indexes.get(anchorKey); if (anchor !== undefined) pins.push(anchor) }
    for (const key of pinnedKeys.slice(0, 4)) { const index = indexes.get(key); if (index !== undefined) pins.push(index) }
    // Multi-lane ranges are contiguous index spans. A tall card in one lane
    // can leave many offscreen cards from other lanes inside that span.
    // Use the prepared public measurements to mount only the actual viewport
    // plus a small pixel overscan, then add the few explicit focus pins.
    const instance = activeVirtualizer.current
    const overscan = Math.min(160, layout.height / 4)
    const offset = instance?.scrollOffset ?? layout.offset
    const visible = defaultRangeExtractor(range).filter(index => {
      const item = instance?.measurementsCache[index]
      return !item || item.end >= offset - overscan && item.start <= offset + layout.height + overscan
    })
    return includeVirtualPins(visible, pins, items.length)
  }, [focusedKey, indexes, keyboardTarget, anchorKey, pinnedKeys, items.length, layout.offset, layout.height])
  const measureElement = useCallback(<Scroll extends Element | Window>(element: HTMLDivElement,
    entry: ResizeObserverEntry | undefined, instance: Virtualizer<Scroll, HTMLDivElement>): number => {
    const index = instance.indexFromElement(element), key = instance.options.getItemKey(index)
    const cached = measured.current.get(String(key))
    const rect = element.getBoundingClientRect()
    // Kept-mounted hidden panels must not replace real dimensions with zero.
    if (element.getClientRects().length === 0 || rect.width <= 0 || rect.height <= 0) return cached?.height ?? instance.options.estimateSize(index)
    const height = measureVirtualElement(element, entry, instance)
    if (height > 0 && Number.isFinite(height)) {
      measured.current.delete(String(key)); measured.current.set(String(key), { width: rect.width, height })
      if (measured.current.size > 10_000) measured.current.delete(measured.current.keys().next().value!)
    }
    return height
  }, [])
  const options = { getItemKey: itemKey, estimateSize: estimatedHeight, lanes: columns, laneAssignmentMode: 'measured' as const,
    gap, overscan: 1, scrollMargin: layout.margin, rangeExtractor, measureElement, useFlushSync: false,
    useAnimationFrameWithResizeObserver: true }
  // Both hooks stay mounted; only the matching scroll transport observes anything.
  const elementVirtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({ ...options, count: layout.viewport ? items.length : 0,
    getScrollElement: () => layout.viewport, enabled: enabled && layout.viewport !== null })
  const windowVirtualizer = useWindowVirtualizer<HTMLDivElement>({ ...options, count: layout.viewport ? 0 : items.length,
    enabled: enabled && layout.viewport === null })
  const virtualizer = layout.viewport ? elementVirtualizer : windowVirtualizer
  activeVirtualizer.current = virtualizer

  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    let frame: number | undefined
    let scrollTarget: HTMLElement | Window | null = null
    const measure = () => {
      // Responsive panel styles can change which ancestor actually scrolls.
      const viewport = scrollingAncestor(element)
      const nextTarget = viewport ?? window
      if (scrollTarget !== nextTarget) {
        scrollTarget?.removeEventListener('scroll', schedule)
        scrollTarget = nextTarget
        scrollTarget.addEventListener('scroll', schedule, { passive: true })
      }
      const rect = element.getBoundingClientRect(), viewportRect = viewport?.getBoundingClientRect()
      if (element.getClientRects().length === 0 || rect.width <= 0 || /^(hidden|collapse)$/.test(getComputedStyle(element).visibility)
        || viewport && (viewport.getClientRects().length === 0 || viewport.clientHeight <= 0)) {
        setLayout(current => current.visible ? { ...current, visible: false } : current); return
      }
      const top = viewportRect ? viewportRect.top + viewport!.clientTop : 0
      if (observedWidth.current > 0 && Math.abs(observedWidth.current - rect.width) >= 1) {
        const bottom = top + (viewport?.clientHeight ?? window.innerHeight)
        const first = [...element.querySelectorAll<HTMLElement>('[data-masonry-key]')]
          .map(node => ({ node, rect: node.getBoundingClientRect() }))
          .filter(item => item.rect.bottom > top && item.rect.top < bottom).sort((left, right) => left.rect.top - right.rect.top)[0]
        if (first?.node.dataset.masonryKey) {
          widthAnchor.current = { key: first.node.dataset.masonryKey, offset: first.rect.top - top }
          setAnchorKey(first.node.dataset.masonryKey)
        }
      }
      observedWidth.current = rect.width
      const offset = viewport?.scrollTop ?? window.scrollY
      const height = viewport?.clientHeight ?? window.innerHeight
      const margin = rect.top - top + offset
      setLayout(current => current.width === rect.width && current.margin === margin && current.viewport === viewport && current.visible
        && current.offset === offset && current.height === height ? current : { width: rect.width, margin, viewport, offset, height, visible: true })
    }
    const schedule = () => { if (frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; measure() }) }
    measure()
    const observer = new ResizeObserver(schedule)
    const mutations = new MutationObserver(schedule)
    observer.observe(element)
    for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
      if (parent !== element) observer.observe(parent)
      mutations.observe(parent, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] })
    }
    window.addEventListener('resize', schedule)
    document.addEventListener('toggle', schedule, true)
    return () => { observer.disconnect(); mutations.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame)
      scrollTarget?.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule); document.removeEventListener('toggle', schedule, true) }
  }, [])

  useLayoutEffect(() => {
    if (!enabled) return
    const changedFilter = previousReset.current !== resetKey
    previousReset.current = resetKey
    if (changedFilter) { widthAnchor.current = null; setAnchorKey(null) }
    virtualizer.measure()
    for (const element of root.current?.querySelectorAll<HTMLDivElement>('[data-masonry-index]') ?? []) virtualizer.measureElement(element)
    if (changedFilter && (layout.viewport?.scrollTop ?? window.scrollY) > layout.margin) virtualizer.scrollToOffset(layout.margin)
    const frame = requestAnimationFrame(() => {
      const anchor = widthAnchor.current
      if (anchor) {
        const item = virtualizer.getVirtualItems().find(item => String(item.key) === anchor.key)
        if (item) virtualizer.scrollToOffset(Math.max(0, item.start - anchor.offset))
        widthAnchor.current = null; setAnchorKey(null)
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [columns, columnWidth, enabled, resetKey, virtualizer, layout.viewport])

  useLayoutEffect(() => {
    if (keyboardTarget === null || !enabled) return
    if (keyboardTarget < 0 || keyboardTarget >= items.length) { setKeyboardTarget(null); return }
    const element = root.current?.querySelector<HTMLElement>(`[data-masonry-index="${keyboardTarget}"]`)
    if (!element) return
    const control = element.querySelector<HTMLElement>('button:not(:disabled), summary, a[href], [tabindex="0"]')
    ;(control ?? element).focus({ preventScroll: true })
    virtualizer.scrollToIndex(keyboardTarget, { align: 'auto' }); setKeyboardTarget(null)
  }, [keyboardTarget, enabled, virtualizer, items.length])
  const virtualItems = enabled ? virtualizer.getVirtualItems() : []
  if (enabled) lastHeight.current = virtualizer.getTotalSize()
  const context = { width: columnWidth, viewport: layout.viewport, active: enabled }
  return <div ref={root} className={className} role="list" aria-label="内容列表" tabIndex={0} data-virtual-masonry data-masonry-columns={columns}
    style={{ position: 'relative', width: '100%', height: items.length === 0 ? 0 : lastHeight.current, minHeight: items.length ? 1 : 0, overflowAnchor: 'none' }}
    onFocusCapture={event => { const element = (event.target as HTMLElement).closest<HTMLElement>('[data-masonry-key]'); if (element) setFocusedKey(element.dataset.masonryKey ?? null) }}
    onBlurCapture={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFocusedKey(null) }}
    onKeyDownCapture={event => {
      if (!items.length || !event.currentTarget.contains(event.target as Node) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.key !== 'Home' && event.key !== 'End'
        || (event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return
      event.preventDefault(); setKeyboardTarget(event.key === 'Home' ? 0 : items.length - 1)
    }}>
    {virtualItems.map(item => <div key={item.key} ref={virtualizer.measureElement} data-index={item.index} data-masonry-index={item.index}
      data-masonry-key={String(item.key)} role="listitem" aria-posinset={item.index + 1} aria-setsize={items.length} tabIndex={-1} style={{ position: 'absolute', top: 0, left: item.lane * (columnWidth + gap), width: columnWidth,
        transform: `translateY(${item.start - layout.margin}px)` }}>
      {children(items[item.index], item.index, context)}
    </div>)}
  </div>
}
