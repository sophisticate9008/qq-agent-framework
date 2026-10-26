import { PageHeading } from '../components/management.tsx';
import { ProviderManager } from '../components/provider-manager.tsx';
import type { PageProps } from '../lib/types.ts';

export function ProvidersPage(props: PageProps) {
  return <div className="page-stack" data-page="providers">
    <PageHeading title="模型服务" description="连接参数和模型目录集中管理，供聊天方案与后台助手选择。" />
    <ProviderManager {...props} />
  </div>;
}
