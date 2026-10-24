import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, ChevronDown, ListTree } from 'lucide-react';
import { Button } from './ui/button.tsx';
import { indexPage, type PageIndexEntry } from '../lib/page-index.ts';

export interface PageNavigationTarget {
  readonly title: string;
  readonly sectionTitle?: string;
  readonly kind: 'page' | 'section' | 'field';
  readonly nonce?: number;
}

function sameIndex(left: readonly PageIndexEntry[], right: readonly PageIndexEntry[]): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index];
    return other?.element === entry.element && other.title === entry.title && other.sectionTitle === entry.sectionTitle;
  });
}

export function PageNavigator({ children, target, onIndexChange, onTargetHandled }: {
  children: ReactNode;
  target?: PageNavigationTarget | null;
  onIndexChange?(entries: readonly PageIndexEntry[]): void;
  onTargetHandled?(): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [entries, setEntries] = useState<readonly PageIndexEntry[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState('');
  const highlight = useRef<HTMLElement | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const navigationFrame = useRef<number | undefined>(undefined);

  useEffect(() => { onIndexChange?.(entries); }, [entries, onIndexChange]);

  useEffect(() => {
    if (!target) return;
    if (target.kind === 'page') {
      root.current?.scrollIntoView({ block: 'start', behavior: 'auto' });
      onTargetHandled?.();
      return;
    }
    const match = entries.find(entry => entry.kind === target.kind && entry.title === target.title
      && (!target.sectionTitle || entry.sectionTitle === target.sectionTitle));
    if (match) { jump(match); onTargetHandled?.(); }
  }, [entries, target, onTargetHandled]);

  useEffect(() => {
    const content = root.current;
    if (!content) return;
    let frame: number | undefined;
    const update = () => {
      frame = undefined;
      const next = indexPage(content);
      setEntries(current => sameIndex(current, next) ? current : next);
    };
    const schedule = () => { frame ??= requestAnimationFrame(update); };
    const observer = new MutationObserver(schedule);
    observer.observe(content, { childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ['class', 'hidden', 'open', 'aria-label', 'aria-hidden'] });
    update();
    return () => { observer.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame); };
  }, []);

  useEffect(() => {
    const sections = entries.filter(entry => entry.kind === 'section');
    let frame: number | undefined;
    const update = () => {
      frame = undefined;
      let current = sections[0]?.id ?? '';
      for (const entry of sections) {
        if (entry.element.getBoundingClientRect().top <= 180) current = entry.id;
        else break;
      }
      setActive(current);
    };
    const schedule = () => { frame ??= requestAnimationFrame(update); };
    addEventListener('scroll', schedule, { passive: true });
    addEventListener('resize', schedule);
    update();
    return () => {
      removeEventListener('scroll', schedule);
      removeEventListener('resize', schedule);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [entries]);

  useEffect(() => () => {
    clearTimeout(highlightTimer.current);
    if (navigationFrame.current !== undefined) cancelAnimationFrame(navigationFrame.current);
    highlight.current?.removeAttribute('data-page-nav-target');
  }, []);

  function jump(entry: PageIndexEntry): void {
    if (!entry.element.isConnected) return;
    setExpanded(false);
    if (entry.kind === 'section') {
      const section = entry.element.closest('section');
      const detail = section?.querySelector('details');
      if (detail instanceof HTMLDetailsElement) detail.open = true;
    }
    for (let parent = entry.element.parentElement; parent && parent !== root.current; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    }
    clearTimeout(highlightTimer.current);
    highlight.current?.removeAttribute('data-page-nav-target');
    highlight.current = entry.element;
    entry.element.setAttribute('data-page-nav-target', 'true');
    if (navigationFrame.current !== undefined) cancelAnimationFrame(navigationFrame.current);
    const deadline = performance.now() + 1500;
    const focus = () => {
      if (performance.now() < deadline && Array.from(document.querySelectorAll('[role="dialog"]'))
        .some(dialog => dialog.getClientRects().length > 0)) {
        navigationFrame.current = requestAnimationFrame(focus);
        return;
      }
      navigationFrame.current = undefined;
      const previous = entry.element.getAttribute('tabindex');
      entry.element.tabIndex = -1;
      entry.element.focus({ preventScroll: true });
      entry.element.addEventListener('blur', () => {
        if (previous === null) entry.element.removeAttribute('tabindex');
        else entry.element.setAttribute('tabindex', previous);
      }, { once: true });
      entry.element.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      highlightTimer.current = setTimeout(() => entry.element.removeAttribute('data-page-nav-target'), 2200);
    };
    navigationFrame.current = requestAnimationFrame(focus);
  }

  const results = entries.filter(entry => entry.kind === 'section');

  return <div className="page-explorer">
    <aside className="page-explorer-navigation" aria-label="页内目录">
      <div className="rounded-xl border bg-card p-3 shadow-xs">
        <div className="mb-3 flex items-center justify-between gap-2"><span className="flex items-center gap-2 text-xs font-semibold"><ListTree className="size-4 text-primary" />本页目录</span><Button type="button" variant="ghost" size="icon-xs" aria-label="返回本页顶部" title="返回本页顶部" onClick={() => { setExpanded(false); root.current?.scrollIntoView({ behavior: 'auto', block: 'start' }); }}><ArrowUp className="size-3.5" /></Button></div>
        <button type="button" className="page-explorer-toggle mt-2 w-full items-center justify-between rounded-md px-1 py-1.5 text-xs text-muted-foreground" aria-label="展开本页目录" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><span>{`${results.length} 个分组`}</span><ChevronDown className={`size-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} /></button>
        <nav aria-label="本页目录" className={`page-explorer-links ${expanded ? 'is-expanded' : ''}`}>
          <div className="grid gap-1 py-2">{results.map(entry => <button key={entry.id} type="button" aria-current={active === entry.id ? 'location' : undefined} onClick={() => jump(entry)} className="page-explorer-link"><span className="block text-xs leading-5">{entry.title}</span></button>)}</div>
          {results.length === 0 && <p className="px-2 py-3 text-xs leading-5 text-muted-foreground" role="status">页面加载后会显示可用分组</p>}
        </nav>
      </div>
    </aside>
    <div ref={root} className="page-explorer-content">{children}</div>
  </div>;
}
