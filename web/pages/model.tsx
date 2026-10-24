import { ChatPlanManager } from '../components/chat-plan-manager.tsx';
import { PageHeading } from '../components/management.tsx';
import type { PageProps } from '../lib/types.ts';

export function ModelPage(props: PageProps) {
  return <div className="page-stack" data-page="model">
    <PageHeading title="聊天方案" description="从集中维护的提供方和模型中选择，分别设置群聊、私聊上下文，再组合人设与回复指令。" />
    <ChatPlanManager {...props} />
  </div>;
}
