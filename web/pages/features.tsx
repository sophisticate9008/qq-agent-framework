import { ConfigurationEditor } from '../components/configuration-editor.tsx';
import { PageHeading } from '../components/management.tsx';
import type { PageProps } from '../lib/types.ts';

export function FeaturesPage(props: PageProps) {
  return <div className="page-stack" data-page="features">
    <PageHeading title="功能与触发" description="按需管理能力、触发条件与表达方式；关闭功能不会清除其他设置。" />
    <ConfigurationEditor {...props} category="features" />
  </div>;
}
