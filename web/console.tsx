import { NATIVE_ACCOUNTS_PATH, parseNativeAccountsSnapshot } from '../src/contracts/native-accounts.ts';
import { useReadResource } from './lib/use-read-resource.ts';
import { createAccountApiRegistry } from './lib/account-api.ts';
import { AccountWorkspaceContext } from './lib/account-workspace.tsx';
import type { NativeAccountView } from '../src/contracts/native-accounts.ts';
import { clearRetainedDrafts, retainedDraftCount, retainedDraftScopes, subscribeRetainedDrafts } from './lib/retained-drafts.ts';
import { clearReadResources } from './lib/resource-reader.ts';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent } from 'react';
import { LoaderCircle, LogOut, Monitor, Moon, Sun, Sparkles, Waves } from 'lucide-react';
import { toast, Toaster } from 'sonner';
import { Button } from './components/ui/button.tsx';
import { Input } from './components/ui/input.tsx';
import { Label } from './components/ui/label.tsx';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './components/ui/dialog.tsx';
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar } from './components/ui/sidebar.tsx';
import { useTheme, type Theme } from './components/theme-provider.tsx';
import { ApiError, asRecord, createApiClient, errorMessage, loginAccessSession, logoutAccessSession, readAccessSession } from './lib/api.ts';
import type { PageDestination, PageId, PageProps } from './lib/types.ts';
import { resolvePageNavigation } from './lib/page-navigation.ts';
import { PageNavigator } from './components/page-navigator.tsx';
import { WorkspaceSearch } from './components/workspace-search.tsx';
import type { WorkspaceSearchTarget } from './lib/workspace-search.ts';
import type { PageIndexEntry } from './lib/page-index.ts';
import { pageDefinition, pageNavigationGroups as navigationGroups, registeredPageId } from './lib/page-registry.ts';

import { pageComponents } from './lib/page-components.ts';
import { pageIcons } from './lib/page-icons.ts';

function NavigationBrand({ navigate }: { navigate(page: PageId): void }) {
  const { setOpenMobile } = useSidebar();
  return <a href="#overview" onClick={event => { event.preventDefault(); navigate('overview'); setOpenMobile(false); }} className="flex items-center gap-2 overflow-hidden"><span className="flex size-7 shrink-0 group-data-[collapsible=icon]:size-6 items-center justify-center rounded-md bg-accent text-accent-foreground"><Sparkles className="size-4" /></span><strong className="text-base font-semibold text-foreground group-data-[collapsible=icon]:hidden">配置工作台</strong></a>;
}

function NavigationButtons({ route, navigate }: { route: PageId; navigate(page: PageId): void }) {
  const { setOpenMobile } = useSidebar();
  return navigationGroups.map((group, index) => {
    const active = group.pages.some(page => page === route);
    const Icon = pageIcons[group.icon];
    return <SidebarMenuItem key={group.id}><SidebarMenuButton onClick={() => { navigate(group.id); setOpenMobile(false); }} isActive={active} aria-current={active ? 'page' : undefined} tooltip={group.label} className="h-8 gap-2.5 rounded-md px-2.5 text-sm data-active:font-semibold"><Icon className="size-4" /><span className="min-w-0 flex-1 truncate group-data-[collapsible=icon]:hidden">{group.label}</span><span aria-hidden="true" className="ml-auto shrink-0 text-[10px] tabular-nums opacity-50 group-data-[collapsible=icon]:hidden">{String(index + 1).padStart(2, '0')}</span></SidebarMenuButton></SidebarMenuItem>;
  });
}

function SubpageNavigation({ route, navigate }: { route: PageId; navigate(page: PageId): void }) {
  const group = navigationGroups.find(group => group.pages.some(page => page === route));
  if (!group || group.pages.length < 2) return null;
  return <nav aria-label={`${group.label}子导航`} className="mb-2 flex max-w-full gap-0.5 overflow-x-auto overscroll-x-contain border-b">
    {group.pages.map(pageId => {
      const page = pageDefinition(pageId);
      const active = route === pageId;
      const Icon = pageIcons[page.icon];
      return <Button key={pageId} type="button" size="sm" variant="ghost" className={active ? 'h-[29px] rounded-none border-b-2 border-b-primary px-3 font-semibold text-primary' : 'h-[29px] rounded-none px-3 text-muted-foreground'} aria-current={active ? 'page' : undefined} onClick={() => navigate(pageId)}><Icon className="size-4" aria-hidden="true" />{page.subpageLabel ?? page.label}</Button>;
    })}
  </nav>;
}

function routeFromLocation(): { readonly page: PageId; readonly target?: PageDestination } {
  const route = location.hash.slice(1);
  return registeredPageId(route) ? resolvePageNavigation(route) : { page: 'overview' };
}

function invalidAuthentication(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

function validAccessSession(value: unknown): boolean {
  const session = asRecord(value);
  return session.authenticated === true
    && typeof session.expiresAt === 'number'
    && Number.isFinite(session.expiresAt);
}

export function Console() {
  const { theme, setTheme } = useTheme();
  const authenticationFailure = useRef<(error: ApiError) => void>(() => undefined);
  const globalApi = useMemo(() => {
    const client = createApiClient();
    const guarded = async (request: Promise<unknown>): Promise<unknown> => {
      try { return await request; }
      catch (error) {
        if (invalidAuthentication(error)) authenticationFailure.current(error);
        throw error;
      }
    };
    return {
      get: (path: string, signal?: AbortSignal) => guarded(client.get(path, signal)),
      post: (path: string, body: unknown, signal?: AbortSignal) => guarded(client.post(path, body, signal))
    };
  }, []);
  const accountApis = useMemo(() => createAccountApiRegistry(globalApi), [globalApi]);
  const [selectedAccount, setSelectedAccount] = useState<NativeAccountView | null>(null);
  const api = accountApis.client(selectedAccount?.id ?? null);
  const [route, setRoute] = useState<PageId>(() => routeFromLocation().page);
  const [snapshot, setSnapshot] = useState<Record<string, unknown>>({});
  const [connected, setConnected] = useState(false);
  const accountDirectory = useReadResource(globalApi, NATIVE_ACCOUNTS_PATH, connected, parseNativeAccountsSnapshot);
  useEffect(() => {
    const snapshot = accountDirectory.snapshot;
    if (!selectedAccount && snapshot?.legacy.adoptedBy) { const adopted = snapshot.accounts.find(item => item.id === snapshot.legacy.adoptedBy); if (adopted) { clearReadResources(api); setSelectedAccount(adopted); } }
  }, [api, selectedAccount, accountDirectory.snapshot]);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [token, setToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [sessionRetryAvailable, setSessionRetryAvailable] = useState(false);
  const [setupPath, setSetupPath] = useState('');
  const [setupMessage, setSetupMessage] = useState('');
  const [pageDirty, setDirty] = useState(false);
  const subscribeDrafts = useCallback((listener: () => void) => subscribeRetainedDrafts(api, listener), [api]);
  const getDraftCount = useCallback(() => retainedDraftCount(api), [api]);
  const draftCount = useSyncExternalStore(subscribeDrafts, getDraftCount, getDraftCount);
  const dirty = pageDirty || draftCount > 0;
  const [pendingRoute, setPendingRoute] = useState<PageId | 'disconnect' | null>(null);
  const [pageEntries, setPageEntries] = useState<readonly PageIndexEntry[]>([]);
  const [searchTarget, setSearchTarget] = useState<(WorkspaceSearchTarget & { nonce: number }) | null>(() => {
    const initial = routeFromLocation();
    return initial.target ? { ...initial.target, page: initial.page, nonce: 0 } : null;
  });
  const [pendingSearchTarget, setPendingSearchTarget] = useState<WorkspaceSearchTarget | null>(null);
  const searchSequence = useRef(0);
  const authenticationSequence = useRef(0);
  const authenticationController = useRef<AbortController | null>(null);
  const updatePageIndex = useCallback((entries: readonly PageIndexEntry[]) => setPageEntries(entries), []);
  const clearSearchTarget = useCallback(() => setSearchTarget(null), []);
  const dirtyScopes = useRef(new Set<string>());
  const setPageDirty = useCallback((value: boolean, scope = 'page') => {
    if (value) dirtyScopes.current.add(scope); else dirtyScopes.current.delete(scope);
    setDirty(dirtyScopes.current.size > 0);
  }, []);
  const current = pageDefinition(route);
  const ActivePage = pageComponents.get(pageDefinition(route).id)!;

  function clearConnectionState(): void {
    for (const client of accountApis.clients()) { clearReadResources(client); clearRetainedDrafts(client); }
    setSelectedAccount(null);
    setToken('');
    setConnecting(false);
    setDisconnecting(false);
    setSessionRetryAvailable(false);
    setConnected(false);
    setSnapshot({});
  }

  authenticationFailure.current = error => {
    authenticationSequence.current += 1;
    authenticationController.current?.abort();
    authenticationController.current = null;
    clearConnectionState();
    setLoginError('访问会话已失效，请使用管理员令牌重新连接。');
    setConnectionOpen(true);
  };

  async function restoreAccessSession(): Promise<void> {
    authenticationController.current?.abort();
    const controller = new AbortController();
    const sequence = ++authenticationSequence.current;
    authenticationController.current = controller;
    setConnecting(true);
    setLoginError('');
    try {
      const session = await readAccessSession(controller.signal);
      if (!validAccessSession(session)) throw new ApiError('invalid_auth_session', 502);
      const next = asRecord(await api.get('/api/snapshot', controller.signal));
      if (controller.signal.aborted || sequence !== authenticationSequence.current) return;
      setSnapshot(next);
      setConnected(true);
      setConnectionOpen(false);
      setToken('');
      setSessionRetryAvailable(false);
    } catch (error) {
      if (controller.signal.aborted || sequence !== authenticationSequence.current) return;
      if (invalidAuthentication(error)) {
        authenticationFailure.current(error);
      } else {
        setConnected(false);
        setSnapshot({});
        setSessionRetryAvailable(true);
        setConnectionOpen(true);
        setLoginError(`暂时无法验证现有访问会话。${errorMessage(error)}`);
      }
    } finally {
      if (sequence === authenticationSequence.current) {
        authenticationController.current = null;
        setConnecting(false);
      }
    }
  }

  useEffect(() => {
    const change = () => {
      const next = routeFromLocation();
      if (next.page === route) {
        if (next.target) setSearchTarget({ ...next.target, page: next.page, nonce: ++searchSequence.current });
        return;
      }
      if (hasUnretainedDraft()) {
        setPendingRoute(next.page); setPendingSearchTarget(next.target ? { ...next.target, page: next.page } : null);
        history.replaceState(null, '', `#${route}`); return;
      }
      setRoute(next.page);
      setSearchTarget(next.target ? { ...next.target, page: next.page, nonce: ++searchSequence.current } : null);
    };
    addEventListener('hashchange', change);
    addEventListener('popstate', change);
    return () => { removeEventListener('hashchange', change); removeEventListener('popstate', change); };
  }, [dirty, route]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/setup', { signal: controller.signal });
        if (!response.ok) return;
        let status = asRecord(await response.json());
        if (status.canInitialize === true) {
          const created = await fetch('/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: controller.signal });
          if (!created.ok) throw new Error('setup_failed');
          status = asRecord(await created.json());
          setSetupMessage('管理员令牌已为你创建，之后会一直保留。');
        }
        if (typeof status.tokenFile === 'string') setSetupPath(status.tokenFile);
        if (status.error === 'token_missing') setSetupMessage('原管理员令牌文件暂时找不到，请恢复该文件后再连接。');
      } catch { if (!controller.signal.aborted) setSetupMessage('暂时无法读取初始设置，请稍后重试。'); }
    })();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    void restoreAccessSession();
  }, []);

  useEffect(() => () => {
    authenticationSequence.current += 1;
    authenticationController.current?.abort();
    authenticationController.current = null;
    authenticationFailure.current = () => undefined;
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    addEventListener('beforeunload', guard);
    return () => removeEventListener('beforeunload', guard);
  }, [dirty]);

  function hasUnretainedDraft(): boolean {
    const retained = new Set(retainedDraftScopes(api));
    return [...dirtyScopes.current].some(scope => !retained.has(scope));
  }

  function navigate(page: PageId, target?: PageDestination): void {
    const destination = resolvePageNavigation(page, target);
    page = destination.page;
    target = destination.target;
    setSearchTarget(null);
    setPendingSearchTarget(null);
    if (page !== route && hasUnretainedDraft()) {
      setPendingRoute(page); if (target) setPendingSearchTarget({ ...target, page }); return;
    }
    if (page !== route) history.pushState(null, '', `#${page}`);
    setRoute(page);
    if (target) setSearchTarget({ ...target, page, nonce: ++searchSequence.current });
  }

  function chooseSearchTarget(target: WorkspaceSearchTarget): void {
    navigate(target.page, target);
  }

  function cancelPendingNavigation(): void {
    setPendingRoute(null);
    setPendingSearchTarget(null);
  }

  function disconnect(): void {
    if (dirty) { setPendingRoute('disconnect'); return; }
    void logout();
  }

  function discardAndContinue(): void {
    dirtyScopes.current.clear();
    setDirty(false);
    if (pendingRoute === 'disconnect') {
      void logout();
    } else if (pendingRoute) {
      history.pushState(null, '', `#${pendingRoute}`);
      setRoute(pendingRoute);
      if (pendingSearchTarget?.page === pendingRoute) {
        setSearchTarget({ ...pendingSearchTarget, nonce: ++searchSequence.current });
      }
    }
    setPendingRoute(null);
    setPendingSearchTarget(null);
  }

  async function refresh(): Promise<void> {
    if (!connected) return;
    try { setSnapshot(asRecord(await api.get('/api/snapshot'))); }
    catch (error) { toast.error(errorMessage(error)); }
  }

  async function logout(): Promise<void> {
    if (disconnecting) return;
    authenticationController.current?.abort();
    const controller = new AbortController();
    const sequence = ++authenticationSequence.current;
    authenticationController.current = controller;
    setDisconnecting(true);
    try {
      await logoutAccessSession(controller.signal);
      if (controller.signal.aborted || sequence !== authenticationSequence.current) return;
      clearConnectionState();
      setConnectionOpen(false);
      setLoginError('');
    } catch (error) {
      if (controller.signal.aborted || sequence !== authenticationSequence.current) return;
      if (invalidAuthentication(error)) {
        clearConnectionState();
        setConnectionOpen(false);
        setLoginError('');
      } else {
        toast.error(`暂时无法安全退出。${errorMessage(error)}`);
      }
    } finally {
      if (sequence === authenticationSequence.current) {
        authenticationController.current = null;
        setDisconnecting(false);
      }
    }
  }

  async function login(event: FormEvent): Promise<void> {
    event.preventDefault();
    const value = token.trim();
    if (value.length < 24) { setLoginError('请复制完整的管理员令牌。'); return; }
    setToken('');
    authenticationController.current?.abort();
    const controller = new AbortController();
    const sequence = ++authenticationSequence.current;
    authenticationController.current = controller;
    setConnecting(true);
    setSessionRetryAvailable(false);
    setLoginError('');
    let sessionCreated = false;
    try {
      const session = await loginAccessSession(value, controller.signal);
      sessionCreated = true;
      if (!validAccessSession(session)) throw new ApiError('invalid_auth_session', 502);
      const next = asRecord(await api.get('/api/snapshot', controller.signal));
      if (controller.signal.aborted || sequence !== authenticationSequence.current) return;
      setSnapshot(next);
      setConnected(true);
      setConnectionOpen(false);
    } catch (error) {
      if (controller.signal.aborted || sequence !== authenticationSequence.current) return;
      if (invalidAuthentication(error)) {
        authenticationSequence.current += 1;
        authenticationController.current?.abort();
        authenticationController.current = null;
        clearConnectionState();
        setLoginError('管理员令牌不正确或不再有效，请重新复制后连接。');
        setConnectionOpen(true);
      } else {
        const sessionMayExist = sessionCreated || error instanceof ApiError && error.code === 'operation_unknown';
        setConnected(false);
        setSnapshot({});
        setSessionRetryAvailable(sessionMayExist);
        setConnectionOpen(true);
        setLoginError(sessionMayExist
          ? `访问会话已创建，但暂时无法载入工作台。${errorMessage(error)}`
          : errorMessage(error));
      }
    } finally {
      if (sequence === authenticationSequence.current) {
        authenticationController.current = null;
        setConnecting(false);
      }
    }
  }

  function selectAccount(account: NativeAccountView | null): void {
    if (account?.id === selectedAccount?.id) { setSelectedAccount(account); return; }
    clearReadResources(api);
    dirtyScopes.current.clear(); setDirty(false); setPageEntries([]); setSearchTarget(null);
    setSelectedAccount(account);
  }

  const props: PageProps = { api, connected, snapshot, navigate, refresh, connect: () => setConnectionOpen(true), setDirty: setPageDirty };
  const ThemeIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;

  return <AccountWorkspaceContext.Provider value={{ globalApi, selected: selectedAccount, select: selectAccount }}><SidebarProvider style={{ '--sidebar-width': '12rem', '--sidebar-width-icon': '2.75rem' } as CSSProperties}>
    <Sidebar collapsible="icon" className="border-sidebar-border"><SidebarHeader className="px-3 py-4 group-data-[collapsible=icon]:px-2"><NavigationBrand navigate={navigate} /></SidebarHeader><SidebarContent><SidebarGroup className="px-2 pt-0 group-data-[collapsible=icon]:px-1.5"><SidebarGroupContent><SidebarMenu className="gap-1"><NavigationButtons route={route} navigate={navigate} /></SidebarMenu></SidebarGroupContent></SidebarGroup></SidebarContent></Sidebar>
    <SidebarInset className="min-w-0 bg-background"><header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b bg-card px-3 sm:px-4"><div className="flex min-w-0 flex-1 items-center gap-2"><SidebarTrigger aria-label="切换侧栏" className="size-[27px] text-muted-foreground" /><strong className="truncate text-sm font-medium">{current.label}{selectedAccount ? ` · ${selectedAccount.label}` : ''}</strong></div><div className="flex shrink-0 items-center gap-1.5 sm:gap-2"><WorkspaceSearch api={api} connected={connected} currentPage={route} visibleEntries={pageEntries} onSelect={chooseSearchTarget} /><div id="page-navigation-toolbar" className="flex shrink-0 items-center" /><span className="hidden items-center gap-2 text-xs text-muted-foreground lg:flex"><span className={connected ? 'size-1.5 rounded-full bg-[var(--success)]' : 'size-1.5 rounded-full bg-muted-foreground'} />{connected ? '已连接' : '未连接'}</span><label className="relative flex size-[27px] items-center justify-center gap-1.5 rounded-md text-muted-foreground focus-within:ring-2 focus-within:ring-ring sm:w-auto sm:border-l sm:pl-3"><ThemeIcon className="size-4" /><select aria-label="显示模式" value={theme} onChange={event => setTheme(event.target.value as Theme)} className="absolute inset-0 h-[27px] w-full bg-transparent text-sm text-foreground opacity-0 outline-none sm:static sm:w-24 sm:opacity-100"><option value="system">跟随系统</option><option value="light">日间模式</option><option value="dark">夜间模式</option></select></label>{connected ? <Button variant="ghost" size="icon" aria-label="断开连接" title="退出并撤销访问会话" disabled={disconnecting} onClick={disconnect}>{disconnecting ? <LoaderCircle className="size-4 animate-spin" /> : <LogOut className="size-4" />}</Button> : <Button size="sm" variant="outline" onClick={() => setConnectionOpen(true)}>连接</Button>}</div></header>
      <div className="mx-auto w-full max-w-[1540px] flex-1 px-3 py-2.5 sm:px-4" id="main-content"><SubpageNavigation route={route} navigate={navigate} /><PageNavigator toolbarTargetId="page-navigation-toolbar" key={`${route}:${selectedAccount?.id ?? 'legacy'}`} target={searchTarget?.page === route ? searchTarget : null} onIndexChange={updatePageIndex} onTargetHandled={clearSearchTarget}><Suspense fallback={<p role="status">正在载入页面…</p>}><ActivePage {...props} /></Suspense></PageNavigator></div>
    </SidebarInset>
    <Dialog open={connectionOpen} onOpenChange={setConnectionOpen}><DialogContent className="sm:max-w-[440px]"><DialogHeader><span className="mb-1 flex size-7 items-center justify-center rounded bg-primary text-primary-foreground"><Waves className="size-6" /></span><DialogTitle className="text-[18px]">连接你的工作台</DialogTitle><DialogDescription className="pt-1 text-xs leading-[1.45]">从本机令牌文件复制管理员令牌，仅用于创建本浏览器的访问会话。</DialogDescription></DialogHeader>{setupMessage && <p className="rounded-lg bg-accent px-3 py-2.5 text-xs leading-[1.45] text-accent-foreground" role="status">{setupMessage}</p>}{setupPath && <div className="grid gap-1 rounded border bg-muted/50 p-2"><span className="text-xs text-muted-foreground">管理员令牌保存在这台机器的文件中</span><code className="break-all text-xs leading-5 text-foreground" data-testid="token-path">{setupPath}</code><span className="text-xs leading-5 text-muted-foreground">首次创建后一直保留，无需再次生成或运行命令。</span></div>}<form onSubmit={event => void login(event)} className="grid gap-2 pt-1"><div className="grid gap-2"><Label htmlFor="token" className="text-sm">管理员令牌</Label><Input id="token" type="password" autoComplete="off" spellCheck={false} value={token} onChange={event => setToken(event.target.value)} placeholder="粘贴本机文件中的管理员令牌" /><p className="text-xs text-muted-foreground">管理员令牌仅在本次验证时保留在内存中。访问会话使用 HttpOnly cookie，默认 7 天绝对有效，主动退出时撤销。</p></div>{loginError && <p className="text-xs text-destructive" role="alert">{loginError}</p>}{sessionRetryAvailable && <Button type="button" variant="outline" disabled={connecting} onClick={() => void restoreAccessSession()}>重试现有访问会话</Button>}<Button id="connect" type="submit" disabled={connecting} className="w-full">{connecting && <LoaderCircle className="size-4 animate-spin" />}{connecting ? '正在连接' : '进入工作台'}</Button></form></DialogContent></Dialog>
    <Dialog open={pendingRoute !== null} onOpenChange={open => { if (!open) cancelPendingNavigation(); }}><DialogContent><DialogHeader><DialogTitle>{pendingRoute === 'disconnect' ? '退出工作台？' : '还有未保存的更改'}</DialogTitle><DialogDescription>{pendingRoute === 'disconnect' ? '未保存的草稿会被清除，退出后不会保留凭据输入。' : '当前页面还有未保留的更改，请先保存，或明确放弃后离开。伙伴、模型和连接草稿会保留到退出工作台。'}</DialogDescription></DialogHeader><div className="flex justify-end gap-2"><Button variant="outline" onClick={cancelPendingNavigation}>继续编辑</Button><Button variant="destructive" onClick={discardAndContinue}>{pendingRoute === 'disconnect' ? '退出并清除草稿' : '舍弃并离开'}</Button></div></DialogContent></Dialog>
    <Toaster theme={theme} richColors closeButton />
  </SidebarProvider></AccountWorkspaceContext.Provider>;
}
