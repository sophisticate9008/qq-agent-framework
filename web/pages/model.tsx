import { ChatAssistantManager } from '../components/chat-assistant-manager.tsx';
import { WorkRecords } from '../components/work-records.tsx';
import { ChatPlanManager } from '../components/chat-plan-manager.tsx';
import { PageHeading } from '../components/management.tsx';
import type { PageProps } from '../lib/types.ts';

export function ModelPage(props: PageProps) {
  return <div className="page-stack" data-page="model">
    <PageHeading title="聊天方案" description="配置聊天模型、人设和回复方式，应用独立助手目标并查看工作记录；各项分别保存与核对。" />
    <ChatPlanManager {...props} />
    <ChatAssistantManager api={props.api} connected={props.connected} setDirty={props.setDirty} />
    <WorkRecords api={props.api} connected={props.connected} />
  </div>;
}
