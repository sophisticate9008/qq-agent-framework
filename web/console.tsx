import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties, type FormEvent } from 'react';
import { Activity, Bot, ChevronRight, CircleHelp, LayoutDashboard, LoaderCircle, LogOut, MessagesSquare, Monitor, Moon, Settings2, ShieldCheck, Sparkles, Sun, UserRound, Waves } from 'lucide-react';
import { toast, Toaster } from 'sonner';
import { Button } from './components/ui/button.tsx';
import { Input } from './components/ui/input.tsx';
import { Label } from './components/ui/label.tsx';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './components/ui/dialog.tsx';
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar } from './components/ui/sidebar.tsx';
import { useTheme, type Theme } from './components/theme-provider.tsx';
import { ApiError, asRecord, createApiClient, errorMessage, loginAccessSession, logoutAccessSession, readAccessSession } from './lib/api.ts';
import type { PageId, PageProps } from './lib/types.ts';
import { OverviewPage } from './pages/overview.tsx';
import { PageNavigator } from './components/page-navigator.tsx';
import { WorkspaceSearch } from './components/workspace-search.tsx';
import type { WorkspaceSearchTarget } from './lib/workspace-search.ts';
import type { PageIndexEntry } from './lib/page-index.ts';
import { PersonaPage } from './pages/persona.tsx';
import { FeaturesPage } from './pages/features.tsx';
import { AccessPage } from './pages/access.tsx';
import { ModelPage } from './pages/model.tsx';
import { SettingsPage } from './pages/settings.tsx';
import { SessionsPage } from './pages/sessions.tsx';
import { UsagePage } from './pages/usage.tsx';

const pages = [
  { id: 'overview', label: '概览', icon: LayoutDashboard, description: '伙伴的运行近况和常用入口' },
  { id: 'sessions', label: '会话管理', icon: MessagesSquare, description: '查看群聊与私聊的会话关联，明确确认后管理' },
  { id: 'usage', label: '用量统计', icon: Activity, description: '查看真实 token 用量与按价目表估算的费用' },
  { id: 'persona', label: '人设与形象', icon: UserRound, description: '管理伙伴的人设、表达和固定形象' },
  { id: 'features', label: '功能与触发', icon: Sparkles, description: '管理能力、触发条件与表达方式' },
  { id: 'access', label: '访问范围', icon: ShieldCheck, description: '设置可对话的群、好友与管理员' },
  { id: 'model', label: '模型与回复', icon: Bot, description: '调整思考强度和聊天行为' },
  { id: 'settings', label: '运行设置', icon: Settings2, description: '管理预算、连接与服务参数' },
] as const;

function NavigationButtons({ route, navigate }: { route: PageId; navigate(page: PageId): void }) {
  const { setOpenMobile } = useSidebar();
  return pages.map(page => <SidebarMenuItem key={page.id}><SidebarMenuButton onClick={() => { navigate(page.id); setOpenMobile(false); }} isActive={route === page.id} tooltip={page.label} className="h-11 gap-3 rounded-lg px-3.5 text-[13px] data-active:font-semibold"><page.icon className="size-[18px]" /><span>{page.label}</span>{route === page.id && <span className="ml-auto size-1.5 rounded-full bg-current group-data-[collapsible=icon]:hidden" />}</SidebarMenuButton></SidebarMenuItem>);
}

function routeFromLocation(): PageId {
  const route = location.hash.slice(1);
  return pages.some(page => page.id === route) ? route as PageId : 'overview';
}

const pageComponents: Readonly<Record<PageId, ComponentType<PageProps>>> = {
  overview: OverviewPage, persona: PersonaPage, features: FeaturesPage, access: AccessPage, model: ModelPage, settings: SettingsPage,
  sessions: SessionsPage, usage: UsagePage,
};

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
  const api = useMemo(() => {
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
  const [route, setRoute] = useState<PageId>(routeFromLocation);
  const [snapshot, setSnapshot] = useState<Record<string, unknown>>({});
  const [connected, setConnected] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [token, setToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [sessionRetryAvailable, setSessionRetryAvailable] = useState(false);
  const [setupPath, setSetupPath] = useState('');
  const [setupMessage, setSetupMessage] = useState('');
  const [dirty, setDirty] = useState(false);
  const [pendingRoute, setPendingRoute] = useState<PageId | 'disconnect' | null>(null);
  const [pageEntries, setPageEntries] = useState<readonly PageIndexEntry[]>([]);
  const [searchTarget, setSearchTarget] = useState<(WorkspaceSearchTarget & { nonce: number }) | null>(null);
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
  const current = pages.find(page => page.id === route)!;
  const ActivePage = pageComponents[route];

  function clearConnectionState(): void {
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
      if (next === route) return;
      if (dirty) {
        setPendingRoute(next);
        history.replaceState(null, '', `#${route}`);
        return;
      }
      setRoute(next);
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

  function navigate(page: PageId): void {
    setSearchTarget(null);
    setPendingSearchTarget(null);
    if (dirty && page !== route) { setPendingRoute(page); return; }
    if (page !== route) history.pushState(null, '', `#${page}`);
    setRoute(page);
  }

  function chooseSearchTarget(target: WorkspaceSearchTarget): void {
    if (dirty && target.page !== route) {
      setPendingSearchTarget(target);
      setPendingRoute(target.page);
      return;
    }
    navigate(target.page);
    setSearchTarget({ ...target, nonce: ++searchSequence.current });
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

  const props: PageProps = { api, connected, snapshot, navigate, refresh, connect: () => setConnectionOpen(true), setDirty: setPageDirty };
  const ThemeIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;

  return <SidebarProvider style={{ '--sidebar-width': '15.5rem', '--sidebar-width-icon': '4rem' } as CSSProperties}>
    <Sidebar collapsible="icon" className="border-sidebar-border"><SidebarHeader className="px-5 pt-7 pb-8"><a href="#overview" onClick={event => { event.preventDefault(); navigate('overview'); }} className="flex items-center gap-3 overflow-hidden"><span className="flex size-10 shrink-0 items-center justify-center rounded-[13px] bg-primary text-primary-foreground shadow-sm"><Waves className="size-6" /></span><span className="group-data-[collapsible=icon]:hidden"><strong className="block text-[18px] font-semibold tracking-tight text-foreground">QQ Agent</strong><span className="mt-0.5 block text-[10px] tracking-wider text-muted-foreground">你的智能伙伴工作台</span></span></a></SidebarHeader><SidebarContent><SidebarGroup className="px-3"><SidebarGroupLabel className="px-3 pb-3 text-[10px] tracking-widest text-muted-foreground">工作空间</SidebarGroupLabel><SidebarGroupContent><SidebarMenu className="gap-1.5"><NavigationButtons route={route} navigate={navigate} /></SidebarMenu></SidebarGroupContent></SidebarGroup></SidebarContent><SidebarFooter className="px-5 pb-5"><div className="flex items-center gap-3 border-t pt-5"><span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent text-xs font-semibold text-accent-foreground">A</span><span className="min-w-0 group-data-[collapsible=icon]:hidden"><strong className="block text-xs font-medium text-foreground">我的工作空间</strong><span className="mt-0.5 block text-[10px] text-muted-foreground">{connected ? '工作台已连接' : '准备好后，随时开始'}</span></span><span className="ml-auto size-1.5 rounded-full bg-[var(--success)] group-data-[collapsible=icon]:hidden" /></div></SidebarFooter></Sidebar>
    <SidebarInset className="min-w-0 bg-background"><header className="flex h-[74px] shrink-0 items-center justify-between gap-3 border-b bg-card px-4 sm:px-7 lg:px-10"><div className="flex min-w-0 items-center gap-3"><SidebarTrigger aria-label="切换侧栏" className="text-muted-foreground" /><span className="hidden text-xs text-muted-foreground sm:inline">工作空间</span><ChevronRight className="hidden size-3 text-muted-foreground/60 sm:block" /><strong className="truncate text-xs font-medium">{current.label}</strong></div><div className="flex items-center gap-3 sm:gap-4"><WorkspaceSearch api={api} connected={connected} currentPage={route} visibleEntries={pageEntries} onSelect={chooseSearchTarget} /><span className="hidden items-center gap-2 text-[11px] text-muted-foreground lg:flex"><span className={connected ? 'size-1.5 rounded-full bg-[var(--success)]' : 'size-1.5 rounded-full bg-muted-foreground'} />{connected ? '工作台已连接' : '本地管理工作台'}</span><label className="flex items-center gap-1.5 border-l pl-3 text-muted-foreground sm:pl-4"><ThemeIcon className="size-4" /><select aria-label="显示模式" value={theme} onChange={event => setTheme(event.target.value as Theme)} className="max-w-24 bg-transparent py-1 text-[11px] text-foreground outline-none"><option value="system">跟随系统</option><option value="light">日间模式</option><option value="dark">夜间模式</option></select></label>{connected ? <Button variant="ghost" size="icon-sm" aria-label="断开连接" title="退出并撤销访问会话" disabled={disconnecting} onClick={disconnect}>{disconnecting ? <LoaderCircle className="size-4 animate-spin" /> : <LogOut className="size-4" />}</Button> : <Button size="sm" variant="outline" onClick={() => setConnectionOpen(true)}>连接工作台</Button>}</div></header>
      <div className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-7 sm:px-7 sm:py-9 lg:px-10" id="main-content"><PageNavigator key={route} target={searchTarget?.page === route ? searchTarget : null} onIndexChange={updatePageIndex} onTargetHandled={clearSearchTarget}><ActivePage {...props} /></PageNavigator></div><footer className="flex items-center justify-between px-4 py-5 text-[10px] text-muted-foreground/75 sm:px-7 lg:px-10"><span>QQ Agent Framework</span><span className="hidden sm:inline">让设置简单，让连接自然。</span><span className="flex items-center gap-1"><CircleHelp className="size-3" />本机工作空间</span></footer>
    </SidebarInset>
    <Dialog open={connectionOpen} onOpenChange={setConnectionOpen}><DialogContent className="rounded-2xl sm:max-w-[440px]"><DialogHeader><span className="mb-3 flex size-11 items-center justify-center rounded-[14px] bg-primary text-primary-foreground"><Waves className="size-6" /></span><DialogTitle className="text-2xl tracking-tight">连接你的工作台</DialogTitle><DialogDescription className="pt-1 text-xs leading-6">从本机令牌文件复制管理员令牌，仅用于创建本浏览器的访问会话。</DialogDescription></DialogHeader>{setupMessage && <p className="rounded-lg bg-accent px-3 py-2.5 text-xs leading-6 text-accent-foreground" role="status">{setupMessage}</p>}{setupPath && <div className="grid gap-2 rounded-xl border bg-muted/50 p-3.5"><span className="text-[11px] text-muted-foreground">管理员令牌保存在这台机器的文件中</span><code className="break-all text-[11px] leading-5 text-foreground" data-testid="token-path">{setupPath}</code><span className="text-[10px] leading-5 text-muted-foreground">首次创建后一直保留，无需再次生成或运行命令。</span></div>}<form onSubmit={event => void login(event)} className="grid gap-4 pt-1"><div className="grid gap-2"><Label htmlFor="token" className="text-xs">管理员令牌</Label><Input id="token" type="password" autoComplete="off" spellCheck={false} value={token} onChange={event => setToken(event.target.value)} placeholder="粘贴本机文件中的管理员令牌" /><p className="text-[10px] text-muted-foreground">管理员令牌仅在本次验证时保留在内存中。访问会话使用 HttpOnly cookie，默认 7 天绝对有效，主动退出时撤销。</p></div>{loginError && <p className="text-xs text-destructive" role="alert">{loginError}</p>}{sessionRetryAvailable && <Button type="button" variant="outline" disabled={connecting} onClick={() => void restoreAccessSession()}>重试现有访问会话</Button>}<Button id="connect" type="submit" disabled={connecting} className="w-full">{connecting && <LoaderCircle className="size-4 animate-spin" />}{connecting ? '正在连接' : '进入工作台'}</Button></form></DialogContent></Dialog>
    <Dialog open={pendingRoute !== null} onOpenChange={open => { if (!open) cancelPendingNavigation(); }}><DialogContent><DialogHeader><DialogTitle>还有未保存的更改</DialogTitle><DialogDescription>可以留在当前页面保存，或舍弃本次修改后离开。</DialogDescription></DialogHeader><div className="flex justify-end gap-2"><Button variant="outline" onClick={cancelPendingNavigation}>继续编辑</Button><Button variant="destructive" onClick={discardAndContinue}>舍弃并离开</Button></div></DialogContent></Dialog>
    <Toaster theme={theme} richColors closeButton />
  </SidebarProvider>;
}
