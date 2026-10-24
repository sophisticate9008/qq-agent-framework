import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowRight, FileText, LoaderCircle, Search, SlidersHorizontal } from 'lucide-react';
import { Button } from './ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog.tsx';
import { Input } from './ui/input.tsx';
import { errorMessage, type ApiClient } from '../lib/api.ts';
import {
  applyCurrentPageVisibility,
  buildWorkspaceSearchTargets,
  groupWorkspaceSearchTargets,
  searchWorkspaceTargets,
  workspacePageTargets,
  workspaceSearchPath,
  type WorkspaceSearchTarget,
  type WorkspaceSearchVisibleEntry,
} from '../lib/workspace-search.ts';
import type { PageId } from '../lib/types.ts';

export interface WorkspaceSearchProps {
  readonly api: ApiClient;
  readonly connected: boolean;
  readonly currentPage: PageId;
  onSelect(target: WorkspaceSearchTarget): void;
  readonly visibleEntries?: readonly WorkspaceSearchVisibleEntry[];
}

type LoadState =
  | { readonly status: 'idle' | 'loading' }
  | { readonly status: 'ready'; readonly targets: readonly WorkspaceSearchTarget[] }
  | { readonly status: 'error'; readonly message: string };

const listboxId = 'workspace-search-results';

export function WorkspaceSearch({ api, connected, currentPage, onSelect, visibleEntries }: WorkspaceSearchProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [loadVersion, setLoadVersion] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ status: 'idle' });

  useEffect(() => {
    const openSearch = (event: KeyboardEvent) => {
      if (event.key.toLocaleLowerCase() !== 'k' || (!event.ctrlKey && !event.metaKey) || event.altKey) return;
      event.preventDefault();
      setOpen(true);
    };
    addEventListener('keydown', openSearch);
    return () => removeEventListener('keydown', openSearch);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
  }, [open]);

  useEffect(() => {
    if (!open) {
      if (!connected) setLoadState({ status: 'idle' });
      return;
    }
    if (!connected) {
      setLoadState({ status: 'idle' });
      return;
    }
    const controller = new AbortController();
    setLoadState({ status: 'loading' });
    void Promise.allSettled([
      api.get('/api/configuration', controller.signal),
      api.get('/api/legacy/mode', controller.signal),
      api.get('/api/settings', controller.signal),
    ]).then(([configuration, legacyMode, settings]) => {
      if (controller.signal.aborted) return;
      if (configuration.status !== 'fulfilled') throw configuration.reason;
      const targets = buildWorkspaceSearchTargets({ configuration: configuration.value,
        legacyMode: legacyMode.status === 'fulfilled' ? legacyMode.value : undefined,
        settings: settings.status === 'fulfilled' ? settings.value : undefined });
      setLoadState({ status: 'ready', targets });
    }).catch(error => {
      if (!controller.signal.aborted) {
        setLoadState({ status: 'error', message: `无法读取搜索目录。${errorMessage(error)}` });
      }
    });
    return () => controller.abort();
  }, [api, connected, loadVersion, open]);

  const targets = useMemo(() => {
    if (loadState.status === 'ready') {
      return visibleEntries
        ? applyCurrentPageVisibility(loadState.targets, currentPage, visibleEntries)
        : loadState.targets;
    }
    return visibleEntries
      ? applyCurrentPageVisibility(workspacePageTargets, currentPage, visibleEntries)
      : workspacePageTargets;
  }, [currentPage, loadState, visibleEntries]);
  const matches = useMemo(() => searchWorkspaceTargets(targets, query), [query, targets]);
  const groups = useMemo(() => groupWorkspaceSearchTargets(matches), [matches]);
  const displayedTargets = useMemo(() => groups.flatMap(group => group.targets), [groups]);
  const searching = query.trim() !== '';

  useEffect(() => {
    if (open) document.getElementById(`workspace-search-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  useEffect(() => {
    setActiveIndex(current => displayedTargets.length === 0 ? 0 : Math.min(current, displayedTargets.length - 1));
  }, [displayedTargets]);

  function choose(target: WorkspaceSearchTarget): void {
    setOpen(false);
    setQuery('');
    onSelect(target);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (displayedTargets.length === 0) return;
      setActiveIndex(current => event.key === 'ArrowDown'
        ? (current + 1) % displayedTargets.length
        : (current - 1 + displayedTargets.length) % displayedTargets.length);
      return;
    }
    if (event.key === 'Enter' && displayedTargets[activeIndex]) {
      event.preventDefault();
      choose(displayedTargets[activeIndex]);
    }
  }

  let status: React.ReactNode = null;
  if (loadState.status === 'loading') {
    status = <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground" role="status"><LoaderCircle className="size-3.5 animate-spin" />正在读取设置与功能目录…</div>;
  } else if (loadState.status === 'error') {
    status = <div className="flex items-center justify-between gap-3 border-t px-4 py-3 text-xs text-destructive" role="alert"><span>{loadState.message}</span><Button type="button" size="xs" variant="outline" onClick={() => setLoadVersion(version => version + 1)}>重试</Button></div>;
  } else if (searching && displayedTargets.length === 0) {
    status = <p className="px-4 py-8 text-center text-xs text-muted-foreground" role="status">没有找到匹配的设置或功能</p>;
  } else if (!connected && searching) {
    status = <p className="border-t px-4 py-3 text-xs text-muted-foreground" role="status">连接工作台后可搜索全部设置和功能。</p>;
  }

  return <>
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label="搜索工作台"
      aria-haspopup="dialog"
      onClick={() => setOpen(true)}
      className="min-w-7 gap-2 px-2 sm:min-w-44 sm:justify-between sm:px-2.5"
    >
      <span className="flex items-center gap-2"><Search className="size-3.5" /><span className="hidden sm:inline">搜索工作台</span></span>
      <kbd className="hidden rounded border bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground md:inline">Ctrl K</kbd>
    </Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-xl" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>搜索工作台</DialogTitle>
          <DialogDescription>搜索设置、功能或页面并跳转。</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-3 border-b px-4">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <Input
            role="combobox"
            aria-label="搜索设置或功能"
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded={open}
            aria-activedescendant={displayedTargets[activeIndex] ? `workspace-search-option-${activeIndex}` : undefined}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={query}
            placeholder="搜索设置或功能…"
            className="h-12 border-0 px-0 text-sm shadow-none focus-visible:ring-0"
            onChange={event => { setQuery(event.target.value); setActiveIndex(0); }}
            onKeyDown={handleKeyDown}
          />
          <kbd className="shrink-0 rounded border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">Esc</kbd>
        </div>
        {displayedTargets.length > 0 && <div id={listboxId} role="listbox" aria-label="搜索结果" className="max-h-[min(26rem,65vh)] overflow-y-auto p-2">
          {searching ? groups.map(group => <div key={group.page} className="mb-2 last:mb-0">
            <p className="px-2 py-1.5 text-[10px] font-medium tracking-wide text-muted-foreground">{group.title}</p>
            {group.targets.map(target => {
              const index = displayedTargets.indexOf(target);
              const selected = index === activeIndex;
              const Icon = target.kind === 'page' ? FileText : SlidersHorizontal;
              return <button
                key={`${target.page}-${target.kind}-${target.sectionTitle ?? ''}-${target.title}`}
                id={`workspace-search-option-${index}`}
                type="button"
                role="option"
                aria-selected={selected}
                data-search-title={target.title}
                data-search-page={target.page}
                className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left outline-none aria-selected:bg-accent aria-selected:text-accent-foreground"
                onMouseMove={() => setActiveIndex(index)}
                onClick={() => choose(target)}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1"><strong className="block truncate text-xs font-medium">{target.title}</strong><span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{workspaceSearchPath(target)}</span></span>
                <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
              </button>;
            })}
          </div>) : <div>
            <p className="px-2 py-1.5 text-[10px] font-medium tracking-wide text-muted-foreground">页面快捷入口</p>
            <div className="grid gap-1 sm:grid-cols-2">{displayedTargets.map((target, index) => <button
              key={target.page}
              id={`workspace-search-option-${index}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              data-search-title={target.title}
              data-search-page={target.page}
              className="flex items-center gap-3 rounded-md px-2.5 py-2.5 text-left outline-none aria-selected:bg-accent aria-selected:text-accent-foreground"
              onMouseMove={() => setActiveIndex(index)}
              onClick={() => choose(target)}
            ><FileText className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate text-xs font-medium">{target.title}</span><ArrowRight className="size-3.5 shrink-0 text-muted-foreground" /></button>)}</div>
          </div>}
        </div>}
        {status}
        <div className="flex items-center gap-4 border-t bg-muted/40 px-4 py-2 text-[10px] text-muted-foreground"><span>↑↓ 选择</span><span>Enter 跳转</span><span>Esc 关闭</span></div>
      </DialogContent>
    </Dialog>
  </>;
}

export type { WorkspaceSearchTarget } from '../lib/workspace-search.ts';
