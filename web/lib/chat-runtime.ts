import { asRecord } from './api.ts';
import type { PageId } from './types.ts';

const revisionKeys = ['plans', 'personas', 'access', 'adapters', 'providers', 'authorization', 'deployment'] as const;

export interface ChatRuntimeStatus {
  readonly state: 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
  readonly canStart: boolean;
  readonly canApplyDeployment: boolean;
  readonly chatReady: boolean;
  readonly protocolConnected: boolean;
  readonly missingReasons: readonly string[];
  readonly blockingReasons: readonly string[];
  readonly revisions: Readonly<Record<string, string>>;
  readonly configurationChanged: boolean;
  readonly lastError: string | null;
  readonly readinessScope: string | null;
  readonly modelExecutionVerified: boolean | null;
}

export function parseChatRuntimeStatus(value: unknown): ChatRuntimeStatus | null {
  const root = asRecord(value);
  const revisions = asRecord(root.revisions);
  if (!['stopped', 'starting', 'running', 'stopping', 'error'].includes(String(root.state))
    || typeof root.chatReady !== 'boolean' || typeof root.protocolConnected !== 'boolean' || typeof root.canStart !== 'boolean'
    || !Array.isArray(root.configurationIssues) || root.configurationIssues.some(reason => typeof reason !== 'string')
    || !Array.isArray(root.missingReasons) || root.missingReasons.some(reason => typeof reason !== 'string')
    || root.lastError !== null && typeof root.lastError !== 'string'
    || revisionKeys.some(key => typeof revisions[key] !== 'string' || !/^[a-f0-9]{64}$/.test(revisions[key] as string))
    || Object.keys(revisions).length !== revisionKeys.length
    || root.chatReady && root.state !== 'running') return null;
  const active = asRecord(root.activeRevisions);
  return {
    state: root.state as ChatRuntimeStatus['state'], chatReady: root.chatReady, canStart: root.canStart,
    canApplyDeployment: root.canApplyDeployment === true,
    protocolConnected: root.protocolConnected, missingReasons: root.missingReasons as string[],
    blockingReasons: root.configurationIssues as string[],
    revisions: revisions as Readonly<Record<string, string>>,
    configurationChanged: Object.keys(active).length > 0 && revisionKeys.some(key => active[key] !== revisions[key]),
    lastError: root.lastError as string | null,
    readinessScope: typeof root.readinessScope === 'string' ? root.readinessScope : null,
    modelExecutionVerified: typeof root.modelExecutionVerified === 'boolean' ? root.modelExecutionVerified : null,
  };
}

const reasons: Readonly<Record<string, { readonly text: string; readonly page: PageId }>> = {
  active_plan_or_persona_missing: { text: '先选择聊天方案，并为方案关联人设。', page: 'model' },
  provider_model_missing_or_disabled: { text: '方案使用的提供方或模型尚未启用。', page: 'providers' },
  provider_not_usable: { text: '请补全已启用的模型提供方、模型和密钥。', page: 'providers' },
  onebot_ws_not_enabled: { text: '启用 WebSocket 收消息并保存连接。', page: 'adapters' },
  onebot_http_not_enabled: { text: '启用 HTTP 发送并保存连接。', page: 'adapters' },
  dsh_agent_not_enabled: { text: '启用 DSH 聊天引擎并保存连接。', page: 'adapters' },
  dsh_auth_missing: { text: '补全 DSH 引擎访问凭据。', page: 'adapters' },
  access_allow_missing: { text: '在访问范围中添加允许聊天的群或私聊。', page: 'access' },
  explicit_authorization_missing: { text: '为允许的会话设置消息处理与发送授权。', page: 'access' },
  explicit_dsh_target_required: { text: '指定 DSH 配置位置，再预览并应用聊天设置。', page: 'adapters' },
  model_capacity_required: { text: '补全模型容量与最大输出长度。', page: 'adapters' },
  context_capacity_incompatible: { text: '群聊、私聊上下文必须大于最大输出，且不超过模型容量。', page: 'model' },
  reasoning_effort_not_offered: { text: '方案的推理档位需要匹配模型支持的档位映射。', page: 'adapters' },
  unsupported_reasoning_mapping: { text: '请核对模型支持的推理档位映射。', page: 'adapters' },
  trusted_deployment_runtime_unavailable: { text: '当前管理服务未提供 DSH 配置应用功能，需要更新管理服务。', page: 'adapters' },
  explicit_dsh_path_required: { text: '请填写 DSH 配置文件与凭据文件的绝对路径。', page: 'adapters' },
  dsh_credential_target_unverified: { text: '引擎报告的凭据文件位置与所选目标不符或无法确认，请核对 DSH 的凭据配置。', page: 'adapters' },
  dsh_credential_file_source_unverified: { text: '引擎尚未确认从指定文件读取凭据；环境变量中的同名值不算文件加载成功。', page: 'adapters' },
  dsh_file_permissions_unsafe: { text: 'DSH 配置或凭据文件允许其他用户读取，请在服务器收紧文件权限后重试。', page: 'adapters' },
  dsh_directory_permissions_unsafe: { text: '所选 DSH 目录允许其他用户访问，请先收紧服务器目录权限。', page: 'adapters' },
  dsh_symlink_path_rejected: { text: '所选配置路径包含符号链接，请使用明确的真实目录与文件。', page: 'adapters' },
  dsh_file_unsafe: { text: '所选 DSH 文件不可安全读取，请核对路径、文件类型和大小。', page: 'adapters' },
  dsh_read_conflict: { text: '读取时 DSH 文件已变化，请重新预览并核对。', page: 'adapters' },
  dsh_explicit_layers_required: { text: '目标配置引用了未提供的基础配置，请在高级选项按顺序补全。', page: 'adapters' },
  dsh_provider_entry_ambiguous: { text: 'DSH 中有多个无法区分的模型提供方配置，请先明确要管理的提供方节点。', page: 'adapters' },
  dsh_dynamic_provider_unsupported: { text: '当前提供方配置由动态脚本生成，不能安全合并；请提供静态的专用 DSH 配置。', page: 'adapters' },
  dsh_yaml_invalid: { text: 'DSH 配置格式未通过安全校验，请核对 YAML 内容与重复字段。', page: 'adapters' },
  dsh_live_schema_mismatch: { text: '所连接 DSH 的配置结构与当前适配器不一致，请核对支持版本。', page: 'adapters' },
  deployment_revision_conflict: { text: '引擎文件已变化或预览已被替换，请重新读取并确认新的预览。', page: 'adapters' },
  deployment_preview_required: { text: '请先预览变更，再确认应用。', page: 'adapters' },
  deployment_result_unknown: { text: '应用结果未知，请先检查文件与备份，不要重复提交。', page: 'adapters' },
  dsh_live_verification_required: { text: 'DSH 尚未确认加载本次设置，请核对服务后重新检查。', page: 'adapters' },
  pending_reload: { text: '配置已写入，等待 DSH 加载；加载前不能启动聊天。', page: 'adapters' },
  onebot_protocol_not_connected: { text: '协议尚未连接；启动聊天时会验证并建立连接。', page: 'adapters' },
  runtime_not_started: { text: '聊天尚未启动，完成设置后点击启动聊天。', page: 'adapters' },
  configuration_changed: { text: '已保存设置有变更，请停止聊天后重新启动以应用。', page: 'adapters' },
  authorization_budget_unavailable: { text: '消息授权已用完或过期，请到访问范围检查。', page: 'access' },
  agent_follow_unavailable: { text: '引擎回复连接已中断。新消息处理前必须重新建立跟随；不会重放旧请求。', page: 'adapters' },
  host_not_ready: { text: '聊天处理链路尚未就绪，请检查服务状态。', page: 'adapters' },
  host_fault: { text: '聊天处理出现故障，请检查服务状态；不要重复发送未确认的请求。', page: 'adapters' },
};

export function chatRuntimeBadge(status: ChatRuntimeStatus | null): string {
  if (!status) return '状态待检查';
  if (status.state === 'starting' || status.state === 'stopping') return '正在处理';
  if (status.chatReady) return '聊天已启用';
  if (status.state === 'error') return '启动或运行失败';
  if (status.state !== 'running') return '聊天已停止';
  if (!status.protocolConnected) return '协议连接中断';
  if (status.missingReasons.includes('authorization_budget_unavailable')
    || status.missingReasons.includes('explicit_authorization_missing')) return '授权需要处理';
  if (status.configurationChanged) return '设置等待应用';
  if (status.missingReasons.includes('agent_follow_unavailable')) return '引擎回复连接中断';
  return '聊天暂不可用';
}

export function chatRuntimeVisibleReasons(status: ChatRuntimeStatus): readonly string[] {
  const reasons = status.state === 'running' || status.state === 'error' ? status.missingReasons : status.blockingReasons;
  return [...new Set(reasons.filter(reason => reason !== 'runtime_not_started'))];
}

export function chatRuntimeReason(code: string): { readonly text: string; readonly page: PageId } {
  return reasons[code] ?? { text: '聊天设置尚未通过检查，请核对引擎配置与连接状态。', page: 'adapters' };
}

export interface ChatGrant {
  readonly conversationId: string;
  readonly submitUses: number;
  readonly sendUses: number;
  readonly expiresAt: number | null;
}

export interface ChatAuthorization {
  readonly revision: string;
  readonly version: string;
  readonly grants: readonly ChatGrant[];
}

export function parseChatAuthorization(value: unknown): ChatAuthorization | null {
  const root = asRecord(value);
  if (typeof root.revision !== 'string' || !/^[a-f0-9]{64}$/.test(root.revision)
    || typeof root.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(root.version)
    || !Array.isArray(root.grants) || root.grants.length > 1024) return null;
  const scopes = new Set<string>();
  const grants: ChatGrant[] = [];
  for (const entry of root.grants) {
    const grant = asRecord(entry);
    if (typeof grant.conversationId !== 'string' || !/^(group|private):[1-9][0-9]{0,15}$/.test(grant.conversationId)
      || !Number.isSafeInteger(Number(grant.conversationId.split(':')[1])) || scopes.has(grant.conversationId)
      || ![grant.submitUses, grant.sendUses].every(amount => typeof amount === 'number'
        && Number.isSafeInteger(amount) && amount >= 0 && amount <= 1_000_000)
      || grant.expiresAt !== null && (typeof grant.expiresAt !== 'number'
        || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= 0)) return null;
    scopes.add(grant.conversationId);
    grants.push({ conversationId: grant.conversationId, submitUses: grant.submitUses as number,
      sendUses: grant.sendUses as number, expiresAt: grant.expiresAt as number | null });
  }
  return { revision: root.revision, version: root.version, grants };
}

export function newChatConfigurationId(): string {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}
