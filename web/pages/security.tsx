import { ChatExecutionSettings } from '../components/chat-execution-settings.tsx';
import { ConnectPrompt, PageHeading } from '../components/management.tsx';
import type { PageProps } from '../lib/types.ts';
import { AccessPage } from './access.tsx';
import { SettingsPage } from './settings.tsx';

export function SecurityPage(props: PageProps) {
  return <div className="page-stack" data-page="security">
    <PageHeading title="访问与设置" description="主人、会话范围、处理期限与管理服务" />
    {!props.connected ? <ConnectPrompt connect={props.connect} /> : <>
      <div className="grid2"><section id="security-access" className="min-w-0"><AccessPage {...props} embedded /></section><ChatExecutionSettings {...props} /></div>
      <section id="security-settings" className="min-w-0"><SettingsPage {...props} embedded /></section>
    </>}
  </div>;
}
