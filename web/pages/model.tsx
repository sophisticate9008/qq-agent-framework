import { ChatAssistantManager } from '../components/chat-assistant-manager.tsx';
import { WorkRecords } from '../components/work-records.tsx';
import { ChatPlanManager } from '../components/chat-plan-manager.tsx';
import type { PageProps } from '../lib/types.ts';

export function ModelPage(props: PageProps) {
  return <div className="page-stack" data-page="model">
    <ChatPlanManager {...props}>
    <ChatAssistantManager api={props.api} connected={props.connected} setDirty={props.setDirty} />
    <WorkRecords api={props.api} connected={props.connected} />
    </ChatPlanManager>
  </div>;
}
