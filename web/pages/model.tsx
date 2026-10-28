import { ChatAssistantManager } from '../components/chat-assistant-manager.tsx';
import { ChatPlanManager } from '../components/chat-plan-manager.tsx';
import type { PageProps } from '../lib/types.ts';

export function ModelPage(props: PageProps) {
  return <div className="page-stack" data-page="model">
    <ChatPlanManager {...props}>
    <ChatAssistantManager api={props.api} connected={props.connected} setDirty={props.setDirty} onManageCapabilities={() => props.navigate('providers')} />
    </ChatPlanManager>
  </div>;
}
