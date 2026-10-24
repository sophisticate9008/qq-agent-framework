import { PageHeading } from '../components/management.tsx';
import { ProviderManager } from '../components/provider-manager.tsx';
import type { PageProps } from '../lib/types.ts';

export function ProvidersPage(props: PageProps) {
  return <div className="page-stack" data-page="providers">
    <PageHeading title="模型提供方" description="集中维护模型接口、认证与模型目录。显示名称方便辨认，API 模型 ID 用于实际请求；聊天方案引用这里的选择。" />
    <ProviderManager {...props} />
  </div>;
}
