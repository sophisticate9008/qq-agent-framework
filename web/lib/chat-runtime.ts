import { isNativeAccessScope } from '../../src/contracts/native-access.ts';
import { parseNativeConfigurationImpact, type NativeConfigurationImpact } from '../../src/contracts/native-configuration-impact.ts';
import { NATIVE_CONFIGURATION_REVISION_KEYS } from '../../src/contracts/native-revisions.ts';
import { nativeRuntimeIsQuiescent } from '../../src/contracts/native-runtime-quiescence.ts';
import { asRecord } from './api.ts';
import type { PageDestination, PageId } from './types.ts';
import { nativeFormMetadata } from './native-form-metadata.ts';

const legacyRevisionKeys = NATIVE_CONFIGURATION_REVISION_KEYS.filter(key => key !== 'execution');

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
  readonly configurationImpact?: NativeConfigurationImpact | null;
  readonly lastError: string | null;
  readonly readinessScope: string | null;
  readonly modelExecutionVerified: boolean | null;
  readonly sessionMigrationEligible?: boolean;
}

export function parseChatRuntimeStatus(value: unknown): ChatRuntimeStatus | null {
  const root = asRecord(value);
  const revisions = asRecord(root.revisions);
  const expectedKeys = Object.hasOwn(revisions, 'execution') ? NATIVE_CONFIGURATION_REVISION_KEYS : legacyRevisionKeys;
  if (!['stopped', 'starting', 'running', 'stopping', 'error'].includes(String(root.state))
    || typeof root.chatReady !== 'boolean' || typeof root.protocolConnected !== 'boolean' || typeof root.canStart !== 'boolean'
    || !Array.isArray(root.configurationIssues) || root.configurationIssues.some(reason => typeof reason !== 'string')
    || !Array.isArray(root.missingReasons) || root.missingReasons.some(reason => typeof reason !== 'string')
    || root.lastError !== null && typeof root.lastError !== 'string'
    || expectedKeys.some(key => typeof revisions[key] !== 'string' || !/^[a-f0-9]{64}$/.test(revisions[key] as string))
    || Object.keys(revisions).length !== expectedKeys.length
    || root.chatReady && root.state !== 'running') return null;
  const impact = root.configurationImpact == null ? null : parseNativeConfigurationImpact(root.configurationImpact);
  if (root.configurationImpact != null && !impact) return null;
  const active = asRecord(root.activeRevisions);
  const migration = asRecord(root.sessionMigration);
  if (root.sessionMigration !== undefined && (typeof migration.eligible !== 'boolean' || migration.availability !== 'requires-preview'
    || migration.requiresPreview !== true || !Array.isArray(migration.missingReasons) || migration.missingReasons.some(reason => typeof reason !== 'string'))) return null;
  return {
    state: root.state as ChatRuntimeStatus['state'], chatReady: root.chatReady, canStart: root.canStart,
    canApplyDeployment: root.canApplyDeployment === true,
    protocolConnected: root.protocolConnected, missingReasons: root.missingReasons as string[],
    blockingReasons: root.configurationIssues as string[],
    revisions: revisions as Readonly<Record<string, string>>,
    configurationChanged: impact ? !impact.canContinue : Object.keys(active).length > 0 && expectedKeys.some(key => active[key] !== revisions[key]),
    configurationImpact: impact,
    lastError: root.lastError as string | null,
    readinessScope: typeof root.readinessScope === 'string' ? root.readinessScope : null,
    modelExecutionVerified: typeof root.modelExecutionVerified === 'boolean' ? root.modelExecutionVerified : null,
    ...(root.sessionMigration === undefined ? {} : { sessionMigrationEligible: migration.eligible as boolean }),
  };
}

export function chatRuntimeEngineReadiness(status: ChatRuntimeStatus | null): string {
  if (!status) return '未读取';
  if (status.chatReady) return '已就绪';
  return { stopped: '未启动', starting: '正在连接', running: '需要处理', stopping: '正在停止', error: '需要处理' }[status.state];
}

export function chatRuntimeCanRecoverStoppedControl(value: unknown): boolean {
  return parseChatRuntimeStatus(value) !== null && nativeRuntimeIsQuiescent(value);
}

const reasons: Readonly<Record<string, { readonly text: string; readonly page: PageId }>> = {
  application_process_interrupted: { text: '管理进程在应用期间中断，原阶段未确认；请核对实际结果，不会重放。', page: 'adapters' },
  application_journal_write_unknown: { text: '应用记录写入结果待核对，请保留原操作标识并核对实际结果。', page: 'adapters' },
  application_stopped_verified_new_intent_required: { text: '已确认聊天安全停止。请处理缺失条件，再明确发起新的应用；原操作不会续跑。', page: 'adapters' },
  APPLICATION_STATUS_UNAVAILABLE: { text: '无法读取应用阶段所需的实际运行状态，请重新核对连接与应用记录。', page: 'adapters' },
  APPLICATION_CONFIGURATION_CHANGED: { text: '应用期间已保存的依赖版本发生变化，后续阶段已停止；请核对当前设置。', page: 'adapters' },
  APPLICATION_PHASE_UNKNOWN: { text: '当前应用阶段超过确认时限，执行结果待核对；不会重复调用该阶段。', page: 'adapters' },
  APPLICATION_STOP_UNCONFIRMED: { text: '停止聊天尚未确认，未继续部署或启动，请核对实际停止结果。', page: 'adapters' },
  APPLICATION_RUNTIME_BUSY: { text: '聊天尚未安全停止或另一项操作仍在处理，请先核对运行状态。', page: 'adapters' },
  APPLICATION_PREPARATION_UNVERIFIED: { text: '自动识别的设置或版本未通过核验，请重新读取并检查应用条件。', page: 'adapters' },
  APPLICATION_DEPLOYMENT_UNCONFIRMED: { text: 'DSH 配置写入或加载尚未确认，请核对实际结果；不会再次应用。', page: 'adapters' },
  APPLICATION_MIGRATION_PREVIEW_UNAVAILABLE: { text: '无法获得保留上下文的会话衔接预览，尚未提交衔接。', page: 'adapters' },
  APPLICATION_MIGRATION_UNCONFIRMED: { text: '会话衔接尚未全部确认，已停止后续启动，不会重建或清空会话。', page: 'adapters' },
  APPLICATION_START_UNCONFIRMED: { text: '启动聊天尚未确认，请核对实际运行结果；不会再次启动。', page: 'adapters' },
  active_plan_or_persona_missing: { text: '先选择聊天方案，并为方案关联人设。', page: 'model' },
  persisted_session_configuration_conflict: { text: '方案已更新，但已有会话尚未完成方案衔接。聊天记录已保留，当前不能启动；协议连接正常不代表此项已完成。', page: 'model' },
  persisted_persona_identity_conflict: { text: '已保存的人设正文尚未应用到现有会话，请在伙伴页应用并启动／更新聊天；上下文仍保留。', page: 'model' },
  provider_model_missing_or_disabled: { text: '方案使用的提供方或模型尚未启用。', page: 'providers' },
  provider_not_usable: { text: '请补全已启用的模型提供方、模型和密钥。', page: 'providers' },
  onebot_ws_not_enabled: { text: '启用 WebSocket 收消息并保存连接。', page: 'adapters' },
  onebot_http_not_enabled: { text: '启用 HTTP 发送并保存连接。', page: 'adapters' },
  dsh_agent_not_enabled: { text: '启用 DSH 聊天引擎并保存连接。', page: 'adapters' },
  dsh_auth_missing: { text: '补全 DSH 引擎访问凭据。', page: 'adapters' },
  access_allow_missing: { text: '在访问范围中添加允许聊天的群或私聊。', page: 'access' },
  explicit_authorization_missing: { text: '为允许的会话设置消息处理与发送授权。', page: 'access' },
  explicit_dsh_target_required: { text: '在伙伴的聊天方案中点击“自动识别并应用聊天设置”。', page: 'model' },
  model_capacity_required: { text: '尚未读取模型容量，请先自动识别；无法识别时再在高级设置补充。', page: 'adapters' },
  context_capacity_incompatible: { text: '群聊、私聊上下文必须大于最大输出，且不超过模型容量。', page: 'model' },
  reasoning_effort_not_offered: { text: '所选模型没有声明支持当前推理强度，请在聊天方案中选择模型支持的档位。', page: 'model' },
  unsupported_reasoning_mapping: { text: '尚未识别到有效的模型推理设置，请检查模型信息。', page: 'adapters' },
  trusted_deployment_runtime_unavailable: { text: '当前管理服务未提供 DSH 配置应用功能，需要更新管理服务。', page: 'adapters' },
  explicit_dsh_path_required: { text: '尚未确定 DSH 配置位置，请先自动识别；远程部署使用高级设置。', page: 'adapters' },
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
  dsh_live_schema_mismatch: { text: '所连接 DSH 的配置结构与当前连接协议不一致，请核对支持版本。', page: 'adapters' },
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
  execution_controller_unavailable: { text: '请求状态记录暂不可用，聊天已暂停保护；请检查服务和存储，不要重复提交未确认的请求。', page: 'adapters' },
  trusted_dsh_binding_missing: { text: '尚未确认聊天方案与 DSH 的实际配置对应，请先预览、应用并检查加载结果。', page: 'adapters' },
};

export function chatRuntimeLastError(code: string): string {
  const messages: Readonly<Record<string, string>> = {
    NATIVE_CHAT_CORRELATION_PLUGIN_UNAVAILABLE: 'DSH 的请求关联插件尚未安装、加载或通过认证。请在 DSH 中安装并启用请求关联插件后重新检查；不会自动安装或重启引擎。',
    NATIVE_CHAT_SESSION_CONFIGURATION_CONFLICT: '当前聊天设置与已有会话不一致，已保留上下文并停止启动。请核对原方案，不要通过清空会话强行重试。',
    NATIVE_CHAT_PERSONA_VERSION_MIGRATION_REQUIRED: '已有会话的人设版本需要显式迁移，已保留历史与资源。请先核对迁移方式，不会自动覆盖人设或重新建会话。',
    NATIVE_CHAT_PERSONA_IDENTITY_CONFLICT: '已有会话的人设记录不一致，已停止启动以保护历史与资源。请检查原设置，不会自动替换身份。',
    NATIVE_CHAT_PROTOCOL_UNVERIFIED: '尚未确认协议端的登录账号，请核对接收和发送连接是否使用同一账号。',
    NATIVE_CHAT_STOP_UNKNOWN: '停止操作的结果尚未确认。请重新检查当前状态，不要重复启动聊天。',
  };
  return Object.hasOwn(messages, code) ? messages[code] : '上次启动或运行未完成，请核对连接与设置后重新检查。';
}

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
  return [...new Set([...reasons.filter(reason => status.state !== 'running' || reason !== 'runtime_not_started'),
    ...(status.state === 'stopped' && status.missingReasons.includes('runtime_not_started') ? ['runtime_not_started'] : [])])];
}

export function chatRuntimeNeedsSessionMigration(status: ChatRuntimeStatus): boolean {
  return [...status.blockingReasons, ...status.missingReasons].some(reason =>
    reason === 'persisted_session_configuration_conflict' || reason === 'persisted_persona_identity_conflict');
}

export function chatRuntimeCanApplyAndStart(status: ChatRuntimeStatus): boolean {
  return status.state === 'stopped' && status.canApplyDeployment && status.sessionMigrationEligible === true
    && chatRuntimeNeedsSessionMigration(status) && status.blockingReasons.every(reason =>
      reason === 'persisted_session_configuration_conflict' || reason === 'persisted_persona_identity_conflict');
}

export function chatRuntimeReason(code: string): { readonly text: string; readonly page: PageId; readonly target: PageDestination } {
  const reason = Object.hasOwn(reasons, code) ? reasons[code] : { text: '聊天设置尚未通过检查，请核对引擎配置与连接状态。', page: 'adapters' as const };
  const form = (metadata: { readonly page: PageId; readonly id: string; readonly title: string }, field?: string) => ({
    page: metadata.page,
    target: { title: field ?? metadata.title, sectionId: metadata.id, sectionTitle: metadata.title,
      kind: field ? 'field' as const : 'section' as const,
      unavailableMessage: '请先读取配置并核对前置条件；不会自动修改设置或触发操作。' },
  });
  const locations: Readonly<Record<string, { readonly page: PageId; readonly target: PageDestination }>> = {
    active_plan_or_persona_missing: { page: 'model', target: { title: '聊天方案', sectionTitle: '聊天方案', kind: 'section' } },
    persisted_session_configuration_conflict: form(nativeFormMetadata.deployment, '应用并启动／更新聊天'),
    persisted_persona_identity_conflict: form(nativeFormMetadata.deployment, '应用并启动／更新聊天'),
    provider_model_missing_or_disabled: { page: 'providers', target: { title: '提供方目录', sectionTitle: '提供方目录', kind: 'section' } },
    provider_not_usable: form(nativeFormMetadata.provider),
    onebot_ws_not_enabled: form(nativeFormMetadata.onebot, nativeFormMetadata.onebot.fields.websocket),
    onebot_http_not_enabled: form(nativeFormMetadata.onebot, nativeFormMetadata.onebot.fields.enabled),
    dsh_agent_not_enabled: form(nativeFormMetadata.dsh, nativeFormMetadata.dsh.fields.enabled),
    dsh_auth_missing: form(nativeFormMetadata.dsh, nativeFormMetadata.dsh.fields.credential),
    access_allow_missing: form(nativeFormMetadata.access),
    explicit_authorization_missing: { ...form(nativeFormMetadata.authorization),
      target: { ...form(nativeFormMetadata.authorization).target, fallbackSectionId: nativeFormMetadata.access.id } },
    authorization_budget_unavailable: { ...form(nativeFormMetadata.authorization),
      target: { ...form(nativeFormMetadata.authorization).target, fallbackSectionId: nativeFormMetadata.access.id } },
    context_capacity_incompatible: form(nativeFormMetadata.plan, nativeFormMetadata.plan.fields.groupContext),
    reasoning_effort_not_offered: form(nativeFormMetadata.plan, nativeFormMetadata.plan.fields.reasoning),
    onebot_protocol_not_connected: { page: 'adapters', target: { title: '运行状态', sectionId: 'adapter-runtime', kind: 'section' } },
    runtime_not_started: { page: 'adapters', target: { title: '启动聊天', sectionId: 'chat-runtime', kind: 'field',
      unavailableMessage: '请先完成启动条件并保存设置；这里只定位，不会自动启动聊天。' } },
    agent_follow_unavailable: form(nativeFormMetadata.dsh),
  };
  const deploymentReasons = new Set(['explicit_dsh_target_required', 'model_capacity_required', 'unsupported_reasoning_mapping',
    'trusted_deployment_runtime_unavailable', 'explicit_dsh_path_required', 'trusted_dsh_binding_missing', 'pending_reload']);
  const deploymentFields: Readonly<Record<string, string>> = {
    explicit_dsh_path_required: nativeFormMetadata.deployment.fields.profile,
    model_capacity_required: nativeFormMetadata.deployment.fields.context,
    unsupported_reasoning_mapping: nativeFormMetadata.deployment.fields.reasoning,
    dsh_explicit_layers_required: nativeFormMetadata.deployment.fields.layers,
    dsh_credential_target_unverified: nativeFormMetadata.deployment.fields.credentials,
    dsh_credential_file_source_unverified: nativeFormMetadata.deployment.fields.credentials,
  };
  const deployment = Object.hasOwn(reasons, code) && (deploymentReasons.has(code) || code.startsWith('application_') || code.startsWith('APPLICATION_') || code.startsWith('deployment_')
    || code.startsWith('dsh_') && !['dsh_agent_not_enabled', 'dsh_auth_missing'].includes(code));
  const location = deployment ? form(nativeFormMetadata.deployment, deploymentFields[code])
    : Object.hasOwn(locations, code) ? locations[code] : { page: reason.page, target: { title: '聊天运行', sectionId: 'chat-runtime', kind: 'section' as const } };
  return { ...reason, ...location };
}

export interface ChatGrant {
  readonly conversationId: string;
  readonly submitUses: number;
  readonly sendUses: number;
  readonly forwardUses?: number;
  readonly expiresAt: number | null;
  readonly cancelUses?: number;
  readonly toolDelegationUses?: number;
}

export interface ChatAuthorization {
  readonly revision: string;
  readonly version: string;
  readonly grants: readonly ChatGrant[];
  readonly forwardAllow?: readonly string[];
  readonly cancelAvailable?: boolean;
  readonly toolDelegationAvailable?: boolean;
  readonly mode?: 'whitelist' | 'counted';
  readonly whitelistAvailable?: boolean;
  readonly modeSource?: 'explicit' | 'legacy-counted' | 'new-default-whitelist' | 'missing-with-history';
  readonly authorizationDocumentPresent?: boolean;
  readonly migrationRequired?: boolean;
  readonly taskDelegationAvailable?: boolean;
}

export function parseChatAuthorization(value: unknown): ChatAuthorization | null {
  const root = asRecord(value);
  if (typeof root.revision !== 'string' || !/^[a-f0-9]{64}$/.test(root.revision)
    || typeof root.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(root.version)
    || root.forwardAllow !== undefined && (root.mode !== 'whitelist' || !Array.isArray(root.forwardAllow) || root.forwardAllow.length > 1024 || !root.forwardAllow.every(scope => isNativeAccessScope(scope, 16) && Number.isSafeInteger(Number(scope.split(':')[1]))) || new Set(root.forwardAllow).size !== root.forwardAllow.length)
    || !Array.isArray(root.grants) || root.grants.length > 1024
    || root.cancelAvailable !== undefined && typeof root.cancelAvailable !== 'boolean'
    || root.toolDelegationAvailable !== undefined && typeof root.toolDelegationAvailable !== 'boolean'
    || root.mode !== undefined && root.mode !== 'whitelist' && root.mode !== 'counted'
    || root.modeSource !== undefined && (typeof root.modeSource !== 'string'
      || !['explicit', 'legacy-counted', 'new-default-whitelist', 'missing-with-history'].includes(root.modeSource))
    || ['whitelistAvailable', 'authorizationDocumentPresent', 'migrationRequired', 'taskDelegationAvailable']
      .some(key => root[key] !== undefined && typeof root[key] !== 'boolean')) return null;
  const scopes = new Set<string>();
  const grants: ChatGrant[] = [];
  for (const entry of root.grants) {
    const grant = asRecord(entry);
    if (typeof grant.conversationId !== 'string' || !/^(group|private):[1-9][0-9]{0,15}$/.test(grant.conversationId)
      || !Number.isSafeInteger(Number(grant.conversationId.split(':')[1])) || scopes.has(grant.conversationId)
      || ![grant.submitUses, grant.sendUses].every(amount => typeof amount === 'number'
        && Number.isSafeInteger(amount) && amount >= 0 && amount <= 1_000_000)
      || grant.forwardUses !== undefined && (typeof grant.forwardUses !== 'number' || !Number.isSafeInteger(grant.forwardUses) || grant.forwardUses < 0 || grant.forwardUses > 1_000_000)
      || grant.cancelUses !== undefined && (typeof grant.cancelUses !== 'number'
        || !Number.isSafeInteger(grant.cancelUses) || grant.cancelUses < 0 || grant.cancelUses > 1_000_000)
      || grant.toolDelegationUses !== undefined && (typeof grant.toolDelegationUses !== 'number'
        || !Number.isSafeInteger(grant.toolDelegationUses) || grant.toolDelegationUses < 0 || grant.toolDelegationUses > 1_000_000)
      || grant.expiresAt !== null && (typeof grant.expiresAt !== 'number'
        || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= 0)) return null;
    scopes.add(grant.conversationId);
    grants.push({ conversationId: grant.conversationId, submitUses: grant.submitUses as number,
      sendUses: grant.sendUses as number, expiresAt: grant.expiresAt as number | null,
      ...(grant.forwardUses === undefined ? {} : { forwardUses: grant.forwardUses as number }),
      ...(grant.cancelUses === undefined ? {} : { cancelUses: grant.cancelUses as number }),
      ...(grant.toolDelegationUses === undefined ? {} : { toolDelegationUses: grant.toolDelegationUses as number }) });
  }
  return { revision: root.revision, version: root.version, grants,
    ...(root.forwardAllow === undefined ? {} : { forwardAllow: [...root.forwardAllow as string[]] }),
    ...(root.cancelAvailable === undefined ? {} : { cancelAvailable: root.cancelAvailable as boolean }),
    ...(root.toolDelegationAvailable === undefined ? {} : { toolDelegationAvailable: root.toolDelegationAvailable as boolean }),
    ...(root.mode === undefined ? {} : { mode: root.mode as 'whitelist' | 'counted' }),
    ...(root.whitelistAvailable === undefined ? {} : { whitelistAvailable: root.whitelistAvailable as boolean }),
    ...(root.modeSource === undefined ? {} : { modeSource: root.modeSource as ChatAuthorization['modeSource'] }),
    ...(root.authorizationDocumentPresent === undefined ? {} : { authorizationDocumentPresent: root.authorizationDocumentPresent as boolean }),
    ...(root.migrationRequired === undefined ? {} : { migrationRequired: root.migrationRequired as boolean }),
    ...(root.taskDelegationAvailable === undefined ? {} : { taskDelegationAvailable: root.taskDelegationAvailable as boolean }) };
}

export function newChatConfigurationId(): string {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}
