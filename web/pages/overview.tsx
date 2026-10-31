import { ConversationWakeSettings } from '../components/conversation-wake-settings.tsx';
import { useState, type ReactNode } from 'react';
import { Bot, Cpu, RefreshCw, Waves } from 'lucide-react';
import { parseNativeInboxSummary } from '../../src/contracts/native-inbox.ts';
import { AdapterManager } from '../components/adapter-manager.tsx';
import { AutomaticMaintenanceStatus } from '../components/automatic-maintenance-status.tsx';
import { ChatAssistantManager } from '../components/chat-assistant-manager.tsx';
import { ChatPlanManager } from '../components/chat-plan-manager.tsx';
import { ChatRuntimeControls } from '../components/chat-runtime-controls.tsx';
import { HelpTip } from '../components/help-tip.tsx';
import { ConnectPrompt, PageHeading, Section, StatusPill } from '../components/management.tsx';
import { PackageConfigurationManager } from '../components/package-configuration-manager.tsx';
import { RawDetails, ReadOnlyDetails, TechnicalDetails } from '../components/read-only-details.tsx';
import { RecentActivity } from '../components/recent-activity.tsx';
import { SettingsWindow } from '../components/settings-window.tsx';
import { Button } from '../components/ui/button.tsx';
import { asRecord } from '../lib/api.ts';
import { assistantAvailabilityMessage, parseChatAssistant } from '../lib/chat-assistant.ts';
import { parsePlanCatalog } from '../lib/chat-plans.ts';
import { chatRuntimeBadge, chatRuntimeEngineReadiness, chatRuntimeLastError, chatRuntimeReason, chatRuntimeVisibleReasons, parseChatRuntimeStatus } from '../lib/chat-runtime.ts';
import { inboxStateLabel, inboxDeadline } from '../lib/chat-inbox.ts';
import { sessionPagePath } from '../lib/session-pages.ts';
import { parseSessionSnapshot } from '../lib/session-management.ts';
import { useReadResource } from '../lib/use-read-resource.ts';
import type { PageProps } from '../lib/types.ts';
import { AccessPage } from './access.tsx';

function parseAccessSummary(value: unknown): { groups: number; privateChats: number } | null {
  const record = asRecord(value);
  if (!Array.isArray(record.allow) || !record.allow.every((entry: unknown): entry is string => typeof entry === 'string' && /^(group|private):[1-9][0-9]{0,19}$/.test(entry))) return null;
  return { groups: record.allow.filter(entry => entry.startsWith('group:')).length, privateChats: record.allow.filter(entry => entry.startsWith('private:')).length };
}

/** Mount editors on first use; keep ordinary draft state when the window closes. */
function OverviewSettings({ title, label, children }: { readonly title: string; readonly label: string; readonly children: (active: boolean) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const [visited, setVisited] = useState(false);
  return <SettingsWindow title={title} label={label} open={open} onOpenChange={value => { setOpen(value); if (value) setVisited(true); }} triggerVariant="ghost">{visited && children(open)}</SettingsWindow>;
}

export function OverviewPage(props: PageProps) {
  const { connected, refresh, navigate, connect, api, setDirty } = props;
  const [localDirty, setLocalDirty] = useState(false);
  const runtime = useReadResource(api, '/api/chat/runtime', connected, parseChatRuntimeStatus, { intervalMs: 5_000 });
  const plans = useReadResource(api, '/api/chat/plans', connected, parsePlanCatalog, { intervalMs: 5_000 });
  const assistant = useReadResource(api, '/api/chat/assistant', connected, parseChatAssistant);
  const access = useReadResource(api, '/api/chat/access', connected, parseAccessSummary, { intervalMs: 5_000 });
  const sessions = useReadResource(api, sessionPagePath(), connected, parseSessionSnapshot, { intervalMs: 15_000 });
  const inbox = useReadResource(api, '/api/chat/inbox', connected, parseNativeInboxSummary, { intervalMs: 5_000 });
  const status = runtime.error ? null : runtime.snapshot;
  const planCatalog = plans.error ? null : plans.snapshot;
  const selectedPlan = planCatalog?.plans.find(plan => plan.id === planCatalog.activePlanId);
  const assistantValue = assistant.snapshot;
  const scope = access.error ? null : access.snapshot;
  const bound = sessions.error ? null : sessions.snapshot;
  const inboxValue = inbox.error ? null : inbox.snapshot;
  const reasons = status ? chatRuntimeVisibleReasons(status).map(chatRuntimeReason) : [];
  const runtimeDetails = <div className="stack">
    <div className="row"><StatusPill tone={status?.chatReady ? 'success' : runtime.error || status?.state === 'error' ? 'warning' : 'neutral'}>{runtime.error ? '读取失败' : chatRuntimeBadge(status)}</StatusPill><span className="small muted">{status ? status.configurationChanged ? '有设置等待应用' : '配置未报告变更' : '运行状态待读取'}</span></div>
    <TechnicalDetails fields={[
      { label: '聊天方案', value: selectedPlan?.name ?? (plans.error ? '读取失败' : '尚未确认') },
      { label: 'QQ 连接', value: status ? status.protocolConnected ? '已连接' : '未连接' : '尚未确认' },
      { label: '聊天引擎', value: runtime.error ? '读取失败' : chatRuntimeEngineReadiness(status) },
      { label: '会话绑定', value: bound ? `${bound.next ? '至少 ' : ''}${bound.sessions.length} 个` : '尚未确认' },
    ]} />
    {reasons.length > 0 && <div className="strip warn">{reasons.map((reason, index) => <p key={index}>{reason.text}</p>)}</div>}
    {status?.lastError && <div className="strip warn">{chatRuntimeLastError(status.lastError)}</div>}
    {runtime.error && <div className="strip warn">运行状态读取失败，请稍后刷新。</div>}
  </div>;
  const rawRuntime = <div className="border-t pt-2"><RawDetails title="运行技术记录" label="查看技术记录" value={{ runtime: runtime.snapshot, inbox: inbox.snapshot, runtimeReadError: runtime.error ? String(runtime.error) : null, inboxReadError: inbox.error ? String(inbox.error) : null }} /></div>;
  const inboxDetails = <section className="stack">
    <h3 className="border-b pb-1.5 font-semibold">消息排队</h3>
    {inboxValue ? <>
      <div className="row small"><span className="chip">等待处理 {inboxValue.pending} 条</span><span className="muted">{inboxValue.items.length} 个会话有收件记录</span></div>
      {inboxValue.items.length > 0 ? <div className="tablewrap rounded border"><table><thead><tr><th>会话</th><th>状态</th><th>排队</th><th>等待截止</th></tr></thead><tbody>{inboxValue.items.map(item => <tr key={item.conversationId}><td>{item.conversationId.replace(/^group:/, '群聊 · ').replace(/^private:/, '私聊 · ')}</td><td>{inboxStateLabel(item)}</td><td>{item.pending} 条</td><td>{inboxDeadline(item)?.label ?? '—'}</td></tr>)}</tbody></table></div> : <p className="small muted">暂无收件记录。</p>}
    </> : <p className="small muted">{inbox.error ? '收件状态读取失败。' : '正在读取收件状态…'}</p>}
  </section>;

  const reload = () => { runtime.refresh(); plans.refresh(); assistant.refresh(); access.refresh(); sessions.refresh(); inbox.refresh(); void refresh(); };
  return <div className="page-stack" data-page="overview">
    <PageHeading title="连接与概览" description="查看连接、调整当前聊天、处理运行问题" actions={<><HelpTip label="启动检查">启动只检查连接和配置，不调用模型；聊天就绪即可使用。</HelpTip><Button variant="ghost" size="sm" disabled={!connected || runtime.loading} onClick={reload}><RefreshCw className="size-3.5" />刷新</Button></>} />
    {!connected ? <ConnectPrompt connect={connect} /> : <>
      <div className="grid3">
        <section className="entity" id="native-runtime">
          <div className="row"><span className="avatar"><Waves className="size-5" /></span><div><h2 className="font-semibold">日常聊天</h2><p className="small muted">QQ · OneBot</p></div><span className="push"><StatusPill tone={status?.chatReady ? 'success' : runtime.error || status?.state === 'error' ? 'warning' : 'neutral'}>{runtime.error ? '读取失败' : chatRuntimeBadge(status)}</StatusPill></span></div>
          <div className="meta"><span>{bound ? `${bound.next ? '至少 ' : ''}${bound.sessions.length} 个已绑定会话` : '会话待读取'}</span><span>{status ? status.protocolConnected ? '机器人已连接' : '机器人未连接' : '连接状态待读取'}</span></div>
          <div className="strip">{selectedPlan ? `已选方案：${selectedPlan.name}` : '选择聊天方案并关联人设。'}</div>
          <div className="actions"><Button variant="outline" size="sm" onClick={() => navigate('adapters', { kind: 'section', sectionId: 'adapter-onebotHttp', title: 'QQ 连接' })}>查看连接</Button><ReadOnlyDetails title="聊天运行详情" description="当前方案、连接与会话状态。"><div className="stack">{runtimeDetails}{rawRuntime}</div></ReadOnlyDetails><OverviewSettings title="QQ 连接设置" label="设置">{active => <AdapterManager {...props} compact="onebot" active={active} />}</OverviewSettings><span className="push"><OverviewSettings title="聊天运行" label="运行控制">{() => <ChatRuntimeControls compact api={api} connected={connected} dirty={localDirty} navigate={navigate} />}</OverviewSettings></span></div>
        </section>
        <section className="entity">
          <div className="row"><span className="avatar"><Cpu className="size-5" /></span><div><h2 className="font-semibold">聊天引擎</h2><p className="small muted">DSH · 模型会话</p></div><span className="push"><StatusPill tone={status?.chatReady ? 'success' : runtime.error || status?.state === 'error' ? 'warning' : 'neutral'}>{runtime.error ? '读取失败' : chatRuntimeEngineReadiness(status)}</StatusPill></span></div>
          <div className="meta"><span>{planCatalog ? `${planCatalog.plans.length} 个聊天方案` : '方案待读取'}</span><span>保持已有会话上下文</span></div>
          <div className="strip">{status?.configurationChanged ? '有已保存设置等待应用。' : '模型请求通过 DSH 处理。'}</div>
          <div className="actions"><Button variant="outline" size="sm" disabled={runtime.loading} onClick={runtime.refresh}>检查状态</Button><ReadOnlyDetails title="引擎详情" description="当前聊天引擎与配置载入状态。"><div className="stack">{runtimeDetails}{rawRuntime}</div></ReadOnlyDetails><span className="push"><OverviewSettings title="聊天引擎设置" label="设置">{active => <AdapterManager {...props} compact="dsh" active={active} />}</OverviewSettings></span></div>
        </section>
        <section className="entity">
          <div className="row"><span className="avatar"><Bot className="size-5" /></span><div><h2 className="font-semibold">后台助手</h2><p className="small muted">独立工作模式</p></div><span className="push"><StatusPill tone={assistantValue?.executionAvailable || assistantValue?.state === 'configured' && assistantValue.configuration.mode === 'chat-assistant' ? 'success' : assistantValue?.configuration.mode === 'chat-only' ? 'neutral' : 'warning'}>{assistantValue ? assistantValue.configuration.mode === 'chat-only' ? '已关闭' : assistantValue.state === 'configured' ? '已开启' : assistantValue.executionAvailable ? '已启用' : '待就绪' : assistant.error ? '读取失败' : '读取中'}</StatusPill></span></div>
          <div className="meta"><span>{assistantValue?.configuration.model ?? '未选择模型'}</span><span>敏感操作仅主人可用</span></div>
          <div className={`strip ${assistantValue && assistantValue.state !== 'configured' && !assistantValue.executionAvailable && assistantValue.configuration.mode !== 'chat-only' ? 'warn' : ''}`}>{assistantValue ? assistantAvailabilityMessage(assistantValue) : '读取助手配置与运行状态。'}</div>
          <div className="actions"><OverviewSettings title="设置后台助手" label="选择模型">{() => <ChatAssistantManager api={api} connected={connected} setDirty={setDirty} onSaved={assistant.refresh} onManageCapabilities={() => navigate('providers')} />}</OverviewSettings><ReadOnlyDetails title="后台助手状态"><TechnicalDetails fields={[{ label: '运行状态', value: assistantValue ? assistantAvailabilityMessage(assistantValue) : '待读取' }, { label: '模型', value: assistantValue?.configuration.model }, { label: '原因', value: assistantValue?.missingReasons }]} /></ReadOnlyDetails><Button className="ml-auto" variant="ghost" size="sm" onClick={() => navigate('sessions', { kind: 'section', sectionId: 'native-work-records', title: '工作记录' })}>工作记录</Button></div>
        </section>
      </div>
      <div className="split overview-activity-layout">
        <RecentActivity api={api} connected={connected} onViewAll={() => navigate('sessions')} />
        <Section title="当前聊天" scrollable height="lg" className="[&>.panel-body]:p-0 [&>.panel-body]:max-h-[min(32rem,70dvh)]" actions={<Button size="xs" variant="link" onClick={() => navigate('model')}>完整编辑</Button>}>
          <ChatPlanManager {...props} compact setDirty={(dirty, scope) => { setLocalDirty(dirty); setDirty(dirty, scope); }}>
            <ConversationWakeSettings api={api} connected={connected} setDirty={setDirty} />
            <PackageConfigurationManager api={api} connected={connected} setDirty={setDirty} onlyIds={['chat-output', 'media']} embedded />
            <div className="flatgroup"><div className="row"><h3 className="settings-group-title">访问范围</h3><div className="row push">{scope ? <><span className="chip">{scope.groups} 个群聊</span><span className="chip">{scope.privateChats} 个私聊</span></> : <span className="small muted">名单待读取</span>}<OverviewSettings title="主人与白名单" label="管理">{() => <AccessPage {...props} connected={connected} embedded />}</OverviewSettings></div></div><div className="row small mt-1"><span className="oktext">✓ 群聊 @ 唤醒</span><span className="oktext">✓ 私聊唤醒</span><span className="muted">引用与续聊跟随人设</span><HelpTip label="唤醒规则">在白名单范围内，群聊 @ 和私聊必定唤醒；引用唤醒在人设中配置，续聊时长、发言追加和群聊唤醒概率在上方设置。空 @ 和戳一戳也会唤醒。</HelpTip></div></div>
            <div className="flatgroup"><div className="row between"><h3 className="settings-group-title">自动维护</h3><AutomaticMaintenanceStatus api={api} connected={connected} /></div><p className="small muted mt-1">已结束运行记录保留 7 天；未完成和未知结果保留。</p></div>
          </ChatPlanManager>
        </Section>
      </div>
      <Section title="需要关注" className="[&>.panel-body]:py-1.5" actions={<ReadOnlyDetails title="运行与收件状态" description="当前运行情况与各会话的消息排队状态。"><div className="stack">{runtimeDetails}{inboxDetails}{rawRuntime}</div></ReadOnlyDetails>}>
        <div className="grid divide-y">
          {runtime.error ? <div className="row py-1"><StatusPill tone="warning">读取失败</StatusPill><span className="grow">运行状态暂时不可用。</span><Button size="sm" variant="outline" onClick={runtime.refresh}>重新读取</Button></div> : status?.lastError ? <div className="row py-1"><StatusPill tone="warning">运行异常</StatusPill><span className="grow">{chatRuntimeLastError(status.lastError)}</span><Button size="sm" variant="outline" onClick={() => navigate('adapters')}>查看连接</Button></div> : null}
          {!status?.chatReady && reasons.map((reason, index) => <div className="row py-1" key={index}><StatusPill tone="warning">需要设置</StatusPill><span className="grow">{reason.text}</span><Button size="sm" variant="outline" onClick={() => navigate(reason.page)}>去处理</Button></div>)}
          {inboxValue?.items.filter(item => item.state === 'blocked').map(item => <div className="row py-1" key={item.conversationId}><StatusPill tone="warning">结果待核对</StatusPill><strong className="text-xs">{item.conversationId}</strong><span className="grow text-xs">检测到旧排队记录，聊天启动时会自动整理。</span><Button size="sm" variant="outline" onClick={() => navigate('sessions')}>核对状态</Button></div>)}
          {inbox.error && <p className="text-xs text-destructive py-1">收件状态暂时无法读取。<Button size="xs" variant="link" onClick={inbox.refresh}>重新读取</Button></p>}
          {status?.chatReady && !status.lastError && inboxValue?.blockedConversations === 0 && <p className="text-xs text-muted-foreground py-1">当前没有需要处理的运行问题。</p>}
          {!status && !runtime.error && <p className="text-xs text-muted-foreground py-1">正在读取运行状态…</p>}
        </div>
      </Section>
    </>}
  </div>;
}
