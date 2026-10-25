import { ForwardAuthorizationManager } from '../components/forward-authorization-manager.tsx';
import { ConnectPrompt, PageHeading } from '../components/management.tsx';
import type { PageProps } from '../lib/types.ts';
import { AccessPage } from './access.tsx';
import { SettingsPage } from './settings.tsx';
import { ToolPermissionsManager } from '../components/tool-permissions-manager.tsx';

export function SecurityPage(props: PageProps) {
  return <div className="page-stack" data-page="security">
    <PageHeading title="安全" description="配置访问控制与工具授权、聊天处理、管理服务和独立出站网关；各项更改分别保存。" />
    {!props.connected ? <ConnectPrompt connect={props.connect} /> : <>
      <section id="security-access" className="min-w-0"><AccessPage {...props} embedded /></section>
      <ForwardAuthorizationManager api={props.api} connected={props.connected} setDirty={props.setDirty} navigate={props.navigate} />
      <ToolPermissionsManager api={props.api} connected={props.connected} setDirty={props.setDirty} />
      <section id="security-settings" className="min-w-0"><SettingsPage {...props} embedded /></section>
    </>}
  </div>;
}
