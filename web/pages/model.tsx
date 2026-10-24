import { ChatPlanManager } from '../components/chat-plan-manager.tsx';
import { PageHeading } from '../components/management.tsx';
import type { PageProps } from '../lib/types.ts';

export function ModelPage(props: PageProps) {
  return <div className="page-stack" data-page="model">
    <PageHeading title="聊天方案" description="直接创建、编辑并选择原生聊天方案。模型、关联人设和方案指令在这里组合，人设库、能力与授权仍分别管理。" />
    <ChatPlanManager {...props} />
  </div>;
}
