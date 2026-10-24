export type ConfigurationSource = 'bridge' | 'gateway' | 'admin';
export type ConfigurationCategory = 'features' | 'model' | 'persona' | 'access' | 'settings';
export type ConfigurationFieldType = 'boolean' | 'number' | 'text' | 'textarea' | 'list' | 'select' | 'secret';

export interface ConfigurationOption {
  readonly value: string;
  readonly label: string;
}

export interface ConfigurationField {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly type: ConfigurationFieldType;
  readonly value: unknown;
  readonly configured?: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly unit?: string;
  readonly options?: readonly ConfigurationOption[];
  readonly format?: 'time-windows' | 'model-prices';
  readonly editable?: boolean;
}

export interface ConfigurationGroup {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: ConfigurationCategory;
  readonly source: ConfigurationSource;
  readonly revision: string;
  readonly fields: readonly ConfigurationField[];
  readonly applyLabel?: string;
}

export type ConfigurationValidation =
  | 'identifier'
  | 'legacy-console-token'
  | 'optional-command-path'
  | 'optional-https-url'
  | 'optional-path'
  | 'optional-relative-path'
  | 'optional-websocket-url'
  | 'pricing-models'
  | 'pricing-windows'
  | 'reference'
  | 'safe-header'
  | 'safe-url'
  | 'loopback-http-url';

export interface ConfigurationFieldDefinition {
  readonly id: string;
  readonly path: readonly string[];
  readonly label: string;
  readonly description: string;
  readonly type: ConfigurationFieldType;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly unit?: string;
  readonly options?: readonly ConfigurationOption[];
  readonly format?: 'time-windows' | 'model-prices';
  readonly editable?: boolean;
  readonly secret?: boolean;
  readonly integer?: boolean;
  readonly maxLength?: number;
  readonly maxItems?: number;
  readonly itemMaxLength?: number;
  readonly allowUnset?: boolean;
  readonly validation?: ConfigurationValidation;
  readonly presentation?: 'json';
  readonly rotatesAuthorization?: boolean;
}

export interface ConfigurationGroupDefinition {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: ConfigurationCategory;
  readonly source: ConfigurationSource;
  readonly fields: readonly ConfigurationFieldDefinition[];
  readonly applyLabel?: string;
}

type FieldOptions = Omit<ConfigurationFieldDefinition, 'id' | 'path' | 'label' | 'description' | 'type'>;

const inherited = (description: string): string => `${description} 未填写时继续使用服务默认设置。`;

function field(
  id: string,
  label: string,
  description: string,
  type: ConfigurationFieldType,
  options: FieldOptions = {}
): ConfigurationFieldDefinition {
  return Object.freeze({ id, path: Object.freeze(id.split('.')), label, description: inherited(description), type, ...options });
}

const booleanField = (id: string, label: string, description: string, options: FieldOptions = {}) =>
  field(id, label, description, 'boolean', options);
const numberField = (
  id: string,
  label: string,
  description: string,
  min: number,
  max: number,
  unit?: string,
  step = 1,
  integer = true
) => field(id, label, description, 'number', { min, max, step, unit, integer });
const probabilityField = (id: string, label: string, description: string) =>
  field(id, label, description, 'number', { min: 0, max: 1, step: 0.01, integer: false, unit: '概率' });
const textField = (
  id: string,
  label: string,
  description: string,
  maxLength = 256,
  options: FieldOptions = {}
) => field(id, label, description, 'text', { maxLength, ...options });
const textareaField = (
  id: string,
  label: string,
  description: string,
  maxLength = 8_000,
  options: FieldOptions = {}
) => field(id, label, description, 'textarea', { maxLength, ...options });
const listField = (
  id: string,
  label: string,
  description: string,
  maxItems = 100,
  itemMaxLength = 128
) => field(id, label, description, 'list', { maxItems, itemMaxLength });
const selectField = (
  id: string,
  label: string,
  description: string,
  options: readonly ConfigurationOption[]
) => field(id, label, description, 'select', { options: Object.freeze(options) });
const secretField = (id: string, label: string, description: string, maxLength = 8_192, options: FieldOptions = {}) =>
  field(id, label, `${description} 已保存的内容不会显示，只有填写新值时才会替换。`, 'secret',
    { secret: true, maxLength, ...options });

const toolFields = [
  ['getPrompt', '读取提示上下文'], ['getUnread', '读取未读消息'], ['getRecent', '读取最近消息'],
  ['socialState', '读取社交状态'], ['sendGroup', '发送群消息'], ['sendPrivate', '发送私聊消息'],
  ['reply', '回复消息'], ['sendBurst', '分条发送'], ['sendMessage', '通用消息发送'],
  ['waitMessages', '等待新消息'], ['feedback', '提交反馈'], ['getMyRecent', '读取自身近期消息'],
  ['getMessageDetail', '读取消息详情'], ['getActiveMembers', '读取活跃成员'], ['setWakeConfig', '修改会话唤醒条件'],
  ['markRead', '标记已读'], ['memory', '会话记忆工具'], ['slangQuery', '查询黑话'],
  ['slangSubmit', '提交黑话候选'], ['getImages', '读取图片'], ['getForwardMsg', '读取转发消息'],
  ['sendPoke', '发送戳一戳'], ['listStickers', '列出收藏表情'], ['getStickerImage', '读取表情图片'],
  ['sendSticker', '发送收藏表情'], ['setStickerRemark', '修改 QQ 表情备注'], ['stickerNote', '维护本地表情笔记'],
  ['collectSticker', '收藏表情'], ['getSelfImage', '生成或读取自拍'], ['sendVoice', '发送语音']
] as const;

const bridgeGroups: readonly ConfigurationGroupDefinition[] = [
  {
    id: 'bridge-model', title: 'DSH 模型与连接', category: 'model', source: 'bridge',
    description: '聊天服务使用的 DSH 连接、模型选择、上下文容量和访问设置。保存后需要重新加载，已有会话不会被清空。',
    applyLabel: '重新加载聊天服务',
    fields: [
      textField('dsh.baseUrl', 'DSH 地址', 'DSH HTTP API 地址；禁止 URL 内嵌凭据。', 2_048, { validation: 'safe-url' }),
      textField('dsh.provider', '模型提供方', 'DSH 中配置的模型提供方名称。', 128, { validation: 'reference' }),
      textField('dsh.model', '模型', 'DSH 中配置的模型名称。', 128, { validation: 'reference' }),
      selectField('dsh.reasoningEffort', '思考强度', 'DeepSeek 推理强度。', [
        { value: 'off', label: '关闭' }, { value: 'low', label: '低' },
        { value: 'high', label: '高' }, { value: 'max', label: '最高' }
      ]),
      booleanField('dsh.conversationContext', '按会话分级上下文', '按群聊和私聊使用已部署的上下文容量路由。'),
      secretField('dsh.authToken', 'DSH 访问令牌', '连接 DSH API 时使用的访问令牌。'),
      textField('dsh.authHeader', '令牌 Header', '发送访问令牌时使用的 HTTP Header 名称。', 128, { validation: 'safe-header' }),
      textField('dsh.authPrefix', '令牌前缀', '访问令牌前需要附加的文字，通常无需修改。', 64),
      booleanField('dsh.allowRemote', '允许远程 DSH', '是否允许连接本机以外的 DSH；启用前请确认使用 HTTPS 并限制网络访问。')
    ]
  },
  {
    id: 'bridge-web-search', title: '联网搜索', category: 'model', source: 'bridge',
    description: '设置联网搜索的提供方、模型、访问凭据和使用上限。保存设置不会立即发起搜索。', applyLabel: '重新加载聊天服务',
    fields: [
      selectField('webSearch.provider', '搜索提供方', '选择执行联网搜索的服务。', [
        { value: 'auto', label: '自动' }, { value: 'deepseek', label: 'DeepSeek' }, { value: 'bing', label: 'Bing' }
      ]),
      secretField('webSearch.apiKey', '搜索访问令牌', '不建议直接填写；优先通过下方凭据名称读取。'),
      textField('webSearch.apiKeyEnv', '凭据名称', '保存搜索访问令牌的环境变量或 DSH 凭据名称。', 128, { validation: 'identifier' }),
      textField('webSearch.baseURL', '搜索 API 地址', '留空时使用提供方默认地址；自定义地址必须使用 HTTPS 且不能包含账号密码。', 2_048,
        { validation: 'optional-https-url' }),
      textField('webSearch.model', '搜索模型', '执行联网搜索的模型标识。', 128, { validation: 'reference' }),
      numberField('webSearch.maxUses', '单次最多搜索', '一次工作允许的联网搜索次数。', 1, 5, '次'),
      numberField('webSearch.maxTokens', '搜索输出上限', '搜索模型输出 token 上限。', 256, 8_192, 'token'),
      numberField('webSearch.maxResults', '结果条数', '单次返回的搜索结果上限。', 1, 20, '条'),
      numberField('webSearch.timeoutMs', '搜索超时', '单次联网搜索请求超时。', 5_000, 120_000, '毫秒', 1_000)
    ]
  },
  {
    id: 'bridge-pricing', title: '模型定价', category: 'model', source: 'bridge',
    description: '设置费用估算使用的货币、峰谷时段和各模型价格。',
    applyLabel: '重新加载聊天服务',
    fields: [
      textField('pricing.version', '价目版本', '价目表版本标记。', 64),
      textField('pricing.currency', '货币代码', 'ISO 风格货币代码。', 8, { validation: 'identifier' }),
      textField('pricing.symbol', '货币符号', '控制台展示的货币符号。', 8),
      numberField('pricing.unit', '计价单位', '每个价格对应的 token 数。', 1, 1_000_000_000, 'token'),
      numberField('pricing.peakMultiplier', '高峰倍率', '高峰时段相对空闲时段的价格倍率。', 0.01, 100, '倍', 0.01, false),
      textareaField('pricing.peakWindows', '高峰时间段', '设置每天按高峰价格计算的时间段。', 2_048,
        { presentation: 'json', validation: 'pricing-windows', format: 'time-windows' }),
      field('pricing.peakWeekdays', '高峰星期', '使用 1（周一）至 7（周日）的整数列表。', 'list',
        { maxItems: 7, itemMaxLength: 1 }),
      listField('pricing.holidays', '节假日', 'YYYY-MM-DD 日期列表，命中时按非高峰计算。', 500, 10),
      textareaField('pricing.models', '模型价格', '按模型维护输入、输出和缓存相关价格。', 32_768,
        { presentation: 'json', validation: 'pricing-models', format: 'model-prices' }),
      textField('pricing.fallbackModel', '未知模型回退', '未知模型估价时使用的已登记模型标识。', 128, { validation: 'reference' })
    ]
  },
  {
    id: 'bridge-persona-runtime', title: '人格与会话标识', category: 'persona', source: 'bridge',
    description: '设置新会话使用的聊天方案、工作区标题和人格内容长度；这里不修改人格正文。', applyLabel: '重新加载聊天服务',
    fields: [
      textField('agentPreset', '聊天方案', '新建 DSH 会话时使用的聊天方案名称。', 128, { validation: 'reference' }),
      textField('workspaceTitle', '工作区标题', '新建 DSH 工作区的显示标题。', 200),
      numberField('role.maxInjectChars', '人格注入上限', '每轮注入的人格卡字符上限。', 1_000, 20_000, '字符'),
      textField('sessionCwd', '会话工作目录', '留空时按会话建立独立目录；可填写规范化绝对路径或仓库内相对路径。', 1_024,
        { validation: 'optional-path' })
    ]
  },
  {
    id: 'bridge-access-policy', title: '本地权限', category: 'access', source: 'bridge',
    description: '设置唤醒、改名和工作委派权限。身份只以 QQ 消息的真实发送者为准，这里不修改允许名单、拒绝名单或主人账号。',
    applyLabel: '重新加载聊天服务',
    fields: [
      booleanField('allowAllWhenEmpty', '空允许名单时全部放行', '私聊和群聊允许名单均为空时是否放行所有会话；属于高风险兼容开关。'),
      booleanField('localPolicy.ownerAlwaysWake', '主人每条唤醒', '主人普通消息是否总是唤醒模型；这不授予额外工具权限。'),
      booleanField('localPolicy.ownerDirectedWake', '主人定向强唤醒', '主人真实 @ 或直接称呼时强唤醒。'),
      booleanField('localPolicy.nicknameTools', '改名工具', '允许经真实主人消息授权的昵称修改工具。'),
      booleanField('localPolicy.delegation', '工作委派', '允许经真实主人消息授权的工作子代理委派。'),
      booleanField('localPolicy.workFullAccess', '工作子代理完整权限', '为严格绑定的工作子代理启用高权限预设；属于高风险配置，并要求 DSH 已部署匹配的权限插件。'),
      numberField('localPolicy.dialogueWindowMs', '续聊窗口', '被直接叫到后，同一发言者的语境续聊窗口。', 0, 300_000, '毫秒', 1_000),
      textField('localPolicy.displayName', '机器人显示名', '用于当前消息中的名字识别，不改变账号资料。', 64),
      listField('localPolicy.aliases', '唤醒称呼', '当前正文中可唤醒机器人的称呼列表。', 32, 64)
    ]
  },
  {
    id: 'bridge-security', title: '安全通知', category: 'access', source: 'bridge',
    description: '设置安全拦截发生时的通知方式。', applyLabel: '重新加载聊天服务',
    fields: [booleanField('security.interceptNotify', '拦截时通知主人', '安全拦截发生时是否发送脱敏通知。')]
  },
  {
    id: 'bridge-general', title: '通用回复', category: 'settings', source: 'bridge',
    description: '设置收到消息后的确认文字、发送节奏和等待回答的时间。', applyLabel: '重新加载聊天服务',
    fields: [
      textareaField('ackMessage', '确认消息', '开始处理消息时可发送的确认文本。', 2_000),
      numberField('sendDelayMs', '发送延迟', '普通出站消息前的基础等待时间。', 0, 60_000, '毫秒', 100),
      numberField('questionTimeoutMs', '提问超时', '等待用户回答 AI 提问的最长时间。', 1_000, 86_400_000, '毫秒', 1_000)
    ]
  },
  {
    id: 'bridge-snowluma', title: 'SnowLuma 连接与部署', category: 'settings', source: 'bridge',
    description: '设置聊天服务连接 SnowLuma 所需的地址、访问令牌和程序位置。HTTP 地址由消息网关管理，这里仅供查看。',
    applyLabel: '重新加载聊天服务',
    fields: [
      textField('snowluma.wsUrl', 'WebSocket 地址', '接收和发送 QQ 消息的 SnowLuma WebSocket 地址，不能包含账号密码。', 2_048,
        { validation: 'optional-websocket-url' }),
      textField('snowluma.httpUrl', 'HTTP 地址', '由当前网关部署管理，此配置目录不允许修改。', 2_048,
        { editable: false }),
      secretField('snowluma.accessToken', 'SnowLuma 访问令牌', '连接 SnowLuma HTTP 与 WebSocket 服务时使用的令牌。'),
      booleanField('snowluma.followDiscoveredEndpoint', '跟随发现地址', '启动发现成功后是否切换到发现的 WebSocket 地址。'),
      numberField('snowluma.silenceWarnMs', '静默告警阈值', '连接长时间无事件时发出告警的阈值。', 60_000, 86_400_000, '毫秒', 1_000),
      textField('snowluma.launcherPath', '启动器路径', '受管 SnowLuma 启动器路径；仅接受规范化路径。', 1_024,
        { validation: 'optional-path' }),
      textField('snowluma.homeDir', 'SnowLuma 主目录', '用于受控发现部署信息的主目录路径。', 1_024,
        { validation: 'optional-path' })
    ]
  },
  {
    id: 'bridge-console', title: '聊天服务管理入口', category: 'settings', source: 'bridge',
    description: '设置聊天服务原有管理页面的监听地址、端口和访问令牌。', applyLabel: '重新加载聊天服务',
    fields: [
      textField('consoleHost', '管理页面监听地址', '仅接受 localhost 或 IP 地址。', 64),
      numberField('consolePort', '管理页面端口', '聊天服务原有管理页面使用的端口。', 1, 65_535, '端口'),
      secretField('consoleToken', '原管理页面令牌', '访问聊天服务原有管理页面时使用，需为 10 至 128 位字母、数字、下划线或短横线。', 128,
        { validation: 'legacy-console-token' })
    ]
  },
  {
    id: 'social-v1', title: '一代仿真', category: 'features', source: 'bridge',
    description: '设置一代聊天模式的参与概率、活跃时间、主动话题和分条发送。保存不会改变当前会话状态。', applyLabel: '重新加载聊天服务',
    fields: [
      booleanField('social.enabled', '启用一代仿真', '一代仿真功能总开关。'),
      probabilityField('social.triggerProbability', '普通消息触发概率', '观望阶段由普通消息进入活跃状态的概率。'),
      numberField('social.contextWindow', '上下文条数', '触发和活跃回复携带的最近消息数。', 1, 100, '条'),
      numberField('social.activeCheckMinMs', '活跃检查最短间隔', '活跃期检查间隔下限。', 5_000, 3_600_000, '毫秒', 1_000),
      numberField('social.activeCheckMaxMs', '活跃检查最长间隔', '活跃期检查间隔上限。', 5_000, 3_600_000, '毫秒', 1_000),
      numberField('social.activeReplyDelayMinMs', '回复延迟下限', '活跃期回复延迟下限。', 0, 600_000, '毫秒', 100),
      numberField('social.activeReplyDelayMaxMs', '回复延迟上限', '活跃期回复延迟上限。', 0, 600_000, '毫秒', 100),
      booleanField('social.activeDurationEnabled', '限制活跃时长', '是否在持续活跃超过时限后主动收尾。'),
      numberField('social.activeDurationMinMs', '活跃时长下限', '单次活跃状态最长时长范围下限。', 60_000, 86_400_000, '毫秒', 60_000),
      numberField('social.activeDurationMaxMs', '活跃时长上限', '单次活跃状态最长时长范围上限。', 60_000, 86_400_000, '毫秒', 60_000),
      numberField('social.idleWindowMs', '冷场判定时间', '活跃期无人发言多久后进入冷场处理。', 1_000, 86_400_000, '毫秒', 1_000),
      probabilityField('social.idleRetryProbability', '冷场试探概率', '冷场时继续说一句的概率。'),
      numberField('social.idleRetryWaitMs', '试探等待时间', '冷场试探后等待回应的时间。', 1_000, 86_400_000, '毫秒', 1_000),
      booleanField('social.proactiveEnabled', '启用定时主动话题', '群安静时是否允许定时主动开话题；未填写不会自动开启。'),
      numberField('social.proactiveIdleThresholdMs', '主动话题空闲阈值', '群持续安静多久后才可判定主动开口。', 60_000, 604_800_000, '毫秒', 60_000),
      numberField('social.proactiveCheckMinMs', '主动检查最短间隔', '主动话题检查间隔下限。', 60_000, 604_800_000, '毫秒', 60_000),
      numberField('social.proactiveCheckMaxMs', '主动检查最长间隔', '主动话题检查间隔上限。', 60_000, 604_800_000, '毫秒', 60_000),
      probabilityField('social.proactiveProbability', '主动开口概率', '每次主动检查成功开口的概率。'),
      probabilityField('social.skipProbability', '选择沉默概率', '普通闲聊选择不参与的概率。'),
      probabilityField('social.surrenderProbability', '兼容退让概率', '此设置仅为兼容旧配置保留，聊天服务不再直接生成退让短句。'),
      listField('social.mustReplyKeywords', '必须回应关键词', '命中后要求回应的关键词列表。', 100, 128),
      numberField('social.maxReplyChars', '单条回复上限', '单条 QQ 文本的字符上限。', 1, 8_000, '字符'),
      booleanField('social.burstEnabled', '启用分条发送', '是否允许一代仿真按分隔规则拆成多条。'),
      numberField('social.burstIntervalMinMs', '分条间隔下限', '普通分条发送间隔下限。', 0, 600_000, '毫秒', 100),
      numberField('social.burstIntervalMaxMs', '分条间隔上限', '普通分条发送间隔上限。', 0, 600_000, '毫秒', 100),
      probabilityField('social.longGapProbability', '长间隔概率', '分条发送使用长间隔的概率。'),
      numberField('social.longGapMinMs', '长间隔下限', '分条发送长间隔下限。', 0, 600_000, '毫秒', 100),
      numberField('social.longGapMaxMs', '长间隔上限', '分条发送长间隔上限。', 0, 600_000, '毫秒', 100)
    ]
  },
  {
    id: 'social-v2-general', title: '二代仿真总体', category: 'features', source: 'bridge',
    description: '设置二代聊天模式的总开关、聊天方案、行为建议和定时检查。', applyLabel: '重新加载聊天服务',
    fields: [
      booleanField('socialV2.enabled', '启用二代仿真', '二代仿真功能总开关。'),
      textField('socialV2.agentPreset', '二代聊天方案', '二代新会话使用的 DSH 聊天方案。', 128, { validation: 'reference' }),
      booleanField('socialV2.provideRecommendations', '提供行为建议', '是否在提示中提供推荐的参与与等待策略。'),
      booleanField('socialV2.autoReplyCheckEnabled', '启用后台自动检查', '是否允许无新消息时执行后台自动回复检查。'),
      numberField('socialV2.autoReplyCheckMs', '自动检查间隔', '后台自动回复检查间隔。', 1_000, 86_400_000, '毫秒', 1_000),
      numberField('socialV2.initialPromptMaxChars', '首次提示上限', '每会话首次唤醒注入的操作者提示字符上限。', 100, 8_000, '字符')
    ]
  },
  {
    id: 'social-v2-tools', title: '二代工具开关', category: 'features', source: 'bridge',
    description: '逐项选择二代聊天模式可以使用的功能。关闭黑话功能不会删除词库，关闭主动功能也不会清空会话。',
    applyLabel: '重新加载聊天服务',
    fields: toolFields.map(([id, label]) => booleanField(`socialV2.tools.${id}`, label, `是否允许使用“${label}”功能。`))
  },
  {
    id: 'social-v2-wake', title: '二代唤醒与潜水', category: 'features', source: 'bridge',
    description: '设置二代聊天模式何时参与、何时潜水，以及唤醒频率上限。', applyLabel: '重新加载聊天服务',
    fields: [
      selectField('socialV2.wake.defaultMode', '默认状态', '新会话默认参与状态。', [
        { value: 'diving', label: '潜水' }, { value: 'active', label: '活跃' }
      ]),
      booleanField('socialV2.wake.preSleepWaitEnabled', '沉睡前观察', '潜水前是否要求一次观察等待。'),
      numberField('socialV2.wake.preSleepWaitMs', '沉睡前观察时间', '沉睡前强制观察窗口。', 0, 86_400_000, '毫秒', 1_000),
      booleanField('socialV2.wake.recommendedDefaultInfinite', '默认无限期潜水', '推荐下一次唤醒是否默认不设时间。'),
      numberField('socialV2.wake.sleepMinMs', '潜水时长下限', '允许设置的潜水时长下限。', 0, 604_800_000, '毫秒', 1_000),
      numberField('socialV2.wake.sleepMaxMs', '潜水时长上限', '允许设置的潜水时长上限；0 可表示不设有限上限。', 0, 604_800_000, '毫秒', 1_000),
      numberField('socialV2.wake.recommendedSleepMinMs', '推荐潜水下限', '提示模型使用的推荐潜水时长下限。', 0, 604_800_000, '毫秒', 1_000),
      numberField('socialV2.wake.recommendedSleepMaxMs', '推荐潜水上限', '提示模型使用的推荐潜水时长上限。', 0, 604_800_000, '毫秒', 1_000),
      probabilityField('socialV2.wake.recommendedProbability', '普通消息唤醒概率', '推荐的普通消息概率唤醒值。'),
      listField('socialV2.wake.recommendedKeywords', '推荐唤醒关键词', '推荐保留的关键词触发列表。', 100, 128),
      booleanField('socialV2.wake.recommendedAtMention', '@ 唤醒', '推荐保持真实 @ 触发。'),
      booleanField('socialV2.wake.recommendedNameMention', '名字唤醒', '推荐保持当前正文称呼触发。'),
      booleanField('socialV2.wake.recommendedQuestion', '提问唤醒', '推荐保持提问触发。'),
      booleanField('socialV2.wake.recommendedPoke', '戳一戳唤醒', '推荐保持戳一戳触发。'),
      textareaField('socialV2.wake.recommendedHint', '潜水建议文本', '注入模型的潜水与唤醒建议。', 8_000),
      numberField('socialV2.wake.batchWindowMs', '消息合并窗口', '唤醒前合并临近消息的窗口。', 1_000, 600_000, '毫秒', 100),
      numberField('socialV2.wake.maxWakePerMinute', '每分钟唤醒上限', '单会话每分钟最大唤醒次数。', 0, 1_000, '次'),
      numberField('socialV2.wake.maxWakePerHour', '每小时唤醒上限', '单会话每小时最大唤醒次数。', 0, 10_000, '次'),
      numberField('socialV2.wake.noActionLimit', '无动作轮次上限', '连续唤醒但无动作后进入保护的轮次。', 0, 1_000, '次'),
      numberField('socialV2.wake.maxWakeConfigReminders', '配置提醒上限', '单会话唤醒配置提醒次数上限。', 0, 100, '次')
    ]
  },
  {
    id: 'social-v2-send', title: '二代发送节奏', category: 'features', source: 'bridge',
    description: '设置二代消息的分条数量、发送速度、文字长度和停顿时间。', applyLabel: '重新加载聊天服务',
    fields: [
      booleanField('socialV2.send.burstEnabled', '启用分条发送', '是否允许二代工具一次发送多条消息。'),
      numberField('socialV2.send.burstMaxMessages', '单次分条上限', '一次分条发送最多消息数。', 1, 32, '条'),
      numberField('socialV2.send.burstIntervalMinMs', '分条间隔下限', '普通分条发送间隔下限。', 0, 600_000, '毫秒', 100),
      numberField('socialV2.send.burstIntervalMaxMs', '分条间隔上限', '普通分条发送间隔上限。', 0, 600_000, '毫秒', 100),
      probabilityField('socialV2.send.longGapProbability', '长间隔概率', '发送时使用长停顿的概率。'),
      numberField('socialV2.send.longGapMinMs', '长间隔下限', '长停顿时长下限。', 0, 600_000, '毫秒', 100),
      numberField('socialV2.send.longGapMaxMs', '长间隔上限', '长停顿时长上限。', 0, 600_000, '毫秒', 100),
      numberField('socialV2.send.maxSendPerMinute', '每分钟发送上限', '单会话每分钟最多发送消息数。', 0, 10_000, '条'),
      numberField('socialV2.send.maxSendPerHour', '每小时发送上限', '单会话每小时最多发送消息数。', 0, 100_000, '条'),
      numberField('socialV2.send.maxMessageChars', '单条字符上限', '单条文本消息最大字符数。', 1, 8_000, '字符'),
      numberField('socialV2.send.maxGapMs', '计算间隔上限', '按内容长度计算发送间隔时的封顶值。', 0, 600_000, '毫秒', 100),
      numberField('socialV2.send.gapBaseMs', '基础间隔', '按内容长度计算发送间隔的固定部分。', 0, 600_000, '毫秒', 100),
      numberField('socialV2.send.gapPerCharMs', '每字符间隔', '按内容长度计算发送间隔的每字符增量。', 0, 10_000, '毫秒', 1),
      textareaField('socialV2.send.recommendedHint', '发送建议文本', '注入模型的分条和节奏建议。', 8_000)
    ]
  },
  {
    id: 'social-v2-wait', title: '二代等待', category: 'features', source: 'bridge',
    description: '设置等待新消息和判断对方是否说完所需的时间。', applyLabel: '重新加载聊天服务',
    fields: [
      numberField('socialV2.wait.defaultMs', '默认等待', '工具未指定时的等待时长。', 0, 86_400_000, '毫秒', 1_000),
      numberField('socialV2.wait.minMs', '最短等待', '工具允许的等待时长下限。', 0, 86_400_000, '毫秒', 1_000),
      numberField('socialV2.wait.maxMs', '最长等待', '工具允许的等待时长上限。', 0, 86_400_000, '毫秒', 1_000),
      numberField('socialV2.wait.defaultQuietMs', '默认静默窗口', '收到消息后等待对话暂时安静的默认时长。', 0, 600_000, '毫秒', 100),
      numberField('socialV2.wait.minQuietAfterNewMs', '新消息后最短静默', '收到新消息后至少继续等待的时间。', 0, 600_000, '毫秒', 100),
      numberField('socialV2.wait.unfinishedQuietMs', '未说完静默窗口', '检测到话语未结束时继续等待的时间。', 0, 600_000, '毫秒', 100),
      numberField('socialV2.wait.burstQuietMs', '连续消息静默窗口', '检测到连续多条消息后继续等待的时间。', 0, 600_000, '毫秒', 100)
    ]
  },
  {
    id: 'social-v2-context', title: '二代上下文', category: 'features', source: 'bridge',
    description: '设置聊天时可参考的最近消息、未读消息和唤醒消息数量。', applyLabel: '重新加载聊天服务',
    fields: [
      numberField('socialV2.context.recentLimit', '最近消息上限', '读取最近消息工具的条数上限。', 1, 1_000, '条'),
      numberField('socialV2.context.unreadLimit', '未读消息上限', '读取未读消息工具的条数上限。', 1, 1_000, '条'),
      numberField('socialV2.context.contextWindow', '提示上下文条数', '常规提示中附带的最近消息数。', 1, 1_000, '条'),
      booleanField('socialV2.context.inlineWakeMessages', '唤醒时内联消息', '唤醒提示中是否直接附带消息内容。'),
      numberField('socialV2.context.wakeMessageLimit', '唤醒消息上限', '唤醒提示最多内联的新消息数。', 1, 100, '条'),
      numberField('socialV2.context.wakeRecentLimit', '唤醒近期消息上限', '唤醒提示额外携带的近期消息数。', 0, 20, '条'),
      numberField('socialV2.context.wakeMaxChars', '唤醒上下文字符上限', '唤醒提示中消息内容的总字符上限。', 500, 20_000, '字符'),
      booleanField('socialV2.context.deduplicateWakePolicy', '复用固定唤醒规则', '同一 DSH 会话已接收相同固定规则后是否改用引用，当前状态仍每轮发送。')
    ]
  },
  {
    id: 'social-v2-proactive', title: '二代主动话题', category: 'features', source: 'bridge',
    description: '设置群聊安静时是否主动开话题，以及检查间隔和开口概率。当前关闭状态不会因未填写而改变。', applyLabel: '重新加载聊天服务',
    fields: [
      booleanField('socialV2.proactive.enabled', '启用主动话题', '是否允许二代仿真定时主动开口。'),
      numberField('socialV2.proactive.checkIntervalMinMs', '检查间隔下限', '主动话题检查间隔下限。', 60_000, 604_800_000, '毫秒', 60_000),
      numberField('socialV2.proactive.checkIntervalMaxMs', '检查间隔上限', '主动话题检查间隔上限。', 60_000, 604_800_000, '毫秒', 60_000),
      numberField('socialV2.proactive.idleThresholdMs', '空闲阈值', '群聊持续安静多久后才可主动开口。', 60_000, 604_800_000, '毫秒', 60_000),
      probabilityField('socialV2.proactive.probability', '主动开口概率', '每次检查成功开口的概率。')
    ]
  },
  {
    id: 'social-v2-sticker', title: '二代表情策略', category: 'features', source: 'bridge',
    description: '设置收藏表情的更新频率、提示数量和 AI 收藏频率。', applyLabel: '重新加载聊天服务',
    fields: [
      booleanField('socialV2.sticker.enabled', '启用表情体系', '收藏表情能力总开关。'),
      numberField('socialV2.sticker.syncTtlMs', '表情缓存时间', 'QQ 收藏表情列表缓存有效期。', 1_000, 86_400_000, '毫秒', 1_000),
      numberField('socialV2.sticker.maxListCount', '单次列表上限', '工具单次返回的表情数量上限。', 1, 500, '个'),
      booleanField('socialV2.sticker.includeInPrompt', '提示中附带表情', '是否在提示和唤醒上下文附带常用表情摘要。'),
      numberField('socialV2.sticker.promptMaxStickers', '提示表情上限', '提示中最多列出的常用表情数。', 1, 30, '个'),
      booleanField('socialV2.sticker.collect.enabled', '允许 AI 收藏', '是否允许 AI 收藏他人发送的表情。'),
      numberField('socialV2.sticker.collect.maxPerMinute', '每分钟收藏上限', 'AI 每分钟最多收藏次数。', 0, 100, '次'),
      numberField('socialV2.sticker.collect.maxPerHour', '每小时收藏上限', 'AI 每小时最多收藏次数。', 0, 1_000, '次'),
      numberField('socialV2.sticker.collect.maxRemarkChars', '收藏备注上限', '收藏时 QQ 官方备注最大字符数。', 1, 50, '字符')
    ]
  },
  {
    id: 'social-v2-voice', title: '二代语音', category: 'features', source: 'bridge',
    description: '设置语音库位置、文件限制、发送频率和音量处理。使用语音还需要开启“发送语音”功能。', applyLabel: '重新加载聊天服务',
    fields: [
      booleanField('socialV2.voice.enabled', '启用语音发送', '语音能力总开关。'),
      textField('socialV2.voice.dir', '语音库目录', '通常填写项目内的相对目录；只有开启“允许绝对音频路径”后才能填写绝对路径。', 1_024,
        { validation: 'optional-path' }),
      numberField('socialV2.voice.maxSeconds', '单条时长上限', '单个语音文件最大时长。', 1, 3_600, '秒'),
      numberField('socialV2.voice.maxBytes', '单条大小上限', '单个语音文件最大字节数。', 1_024, 64 * 1_024 * 1_024, '字节', 1_024),
      numberField('socialV2.voice.maxPerMinute', '每分钟语音上限', '每分钟最多发送语音条数。', 0, 100, '条'),
      numberField('socialV2.voice.maxPerHour', '每小时语音上限', '每小时最多发送语音条数。', 0, 1_000, '条'),
      booleanField('socialV2.voice.allowAbsolutePath', '允许绝对音频路径', '允许工具读取语音库外的绝对路径；属于高风险配置。'),
      field('socialV2.voice.defaultVolume', '默认音量倍数', '未指定响度归一时使用的音量倍数。', 'number',
        { min: 0.01, max: 10, step: 0.01, integer: false, unit: '倍' }),
      selectField('socialV2.voice.loudness', '响度档位', '本地 ffmpeg 响度归一档位。', [
        { value: 'quiet', label: '较轻' }, { value: 'normal', label: '正常' }, { value: 'loud', label: '较响' }
      ]),
      textField('socialV2.voice.ffmpegPath', 'ffmpeg 路径', '留空从 PATH 查找；也可填写规范化可执行文件路径。', 1_024,
        { validation: 'optional-command-path' }),
      booleanField('socialV2.voice.autoReadback', '发送后回读', '发送语音后是否读取回执用于确认。')
    ]
  },
  {
    id: 'social-v2-media', title: '二代媒体读取', category: 'features', source: 'bridge',
    description: '设置一次最多读取多少图片或动图，以及允许的大小和像素上限。', applyLabel: '重新加载聊天服务',
    fields: [
      numberField('socialV2.media.maxBytes', '媒体总大小上限', '单轮读取媒体的总字节上限。', 256 * 1_024, 20 * 1_024 * 1_024, '字节', 1_024),
      numberField('socialV2.media.maxPixels', '媒体像素上限', '单张解码后的最大像素数。', 1_000_000, 64_000_000, '像素'),
      numberField('socialV2.media.maxCount', '媒体数量上限', '单轮最多读取的图片或表情数量。', 1, 8, '个')
    ]
  },
  {
    id: 'social-v2-feedback', title: '二代反馈', category: 'features', source: 'bridge',
    description: '设置反馈文字长度，以及发生错误时是否通知主人。', applyLabel: '重新加载聊天服务',
    fields: [
      numberField('socialV2.feedback.maxLength', '反馈长度上限', '单条模型反馈最大字符数。', 1, 8_000, '字符'),
      booleanField('socialV2.feedback.notifyOwnerOnError', '错误时通知主人', '二代工具错误是否向已验证主人发送脱敏通知。')
    ]
  },
  {
    id: 'bridge-slang', title: '黑话学习', category: 'features', source: 'bridge',
    description: '设置是否学习群聊黑话、多久提取一次、提示中使用多少词条，以及是否自动联网查询。当前关闭状态不会因未填写而改变。',
    applyLabel: '重新加载聊天服务',
    fields: [
      booleanField('slang.enabled', '启用黑话学习', '黑话学习和提示注入总开关。'),
      numberField('slang.extractMinMessages', '提取最少消息数', '达到多少条新消息后才允许批量提取候选。', 1, 10_000, '条'),
      numberField('slang.extractCooldownMs', '提取冷却', '自动提取之间的最短间隔。', 0, 604_800_000, '毫秒', 1_000),
      field('slang.inferenceThresholds', '研究触发阈值', '递增的正整数消息证据阈值列表。', 'list',
        { maxItems: 16, itemMaxLength: 8 }),
      numberField('slang.injectMax', '注入词条上限', '每轮提示中最多注入的已确认词条数。', 1, 30, '条'),
      textField('slang.learnerPreset', '学习聊天方案', '黑话学习会话使用的 DSH 聊天方案。', 128, { validation: 'reference' }),
      textField('slang.workspaceTitle', '学习工作区标题', '黑话学习工作区显示标题。', 200),
      booleanField('slang.autoResearch', '自动联网研究', '候选达到阈值后是否自动触发联网研究。')
    ]
  }
];

const gatewayGroups: readonly ConfigurationGroupDefinition[] = [
  {
    id: 'gateway-runtime', title: '网关连接', category: 'settings', source: 'gateway',
    description: '设置消息网关使用的端口和聊天服务地址。发送额度、超时和容量限制保持基本设置中的数值。',
    applyLabel: '应用消息网关设置',
    fields: [
      numberField('port', '网关端口', '消息网关使用的本机端口，应用时会同步聊天服务的连接地址。', 1, 65_535, '端口'),
      textField('upstreamEndpoint', '聊天服务地址', '消息网关转发请求的本机 HTTP 地址，不能包含账号密码或额外参数。', 2_048,
        { validation: 'loopback-http-url', allowUnset: false })
    ]
  },
  {
    id: 'gateway-persona', title: '网关人格标识', category: 'persona', source: 'gateway',
    description: '设置发送消息时使用的人格名称和版本，不包含人格正文。修改后会自动建立新的发送权限范围，不会补充旧额度。',
    applyLabel: '应用并更新发送权限',
    fields: [
      textField('persona.id', '人格 ID', '稳定的人格标识。', 128,
        { validation: 'reference', allowUnset: false, rotatesAuthorization: true }),
      textField('persona.version', '人格版本', '不可变人格定义的版本标识。', 128,
        { validation: 'reference', allowUnset: false, rotatesAuthorization: true })
    ]
  },
  {
    id: 'gateway-storage', title: '网关持久化', category: 'settings', source: 'gateway',
    description: '设置消息网关保存发送记录的数据库文件位置。', applyLabel: '应用消息网关设置',
    fields: [
      textField('storeFilename', '持久库文件', '私有 SQLite 文件路径；相对路径以网关配置目录为基准，也允许规范化绝对路径。', 1_024,
        { validation: 'optional-path', allowUnset: false })
    ]
  },
  {
    id: 'gateway-credentials', title: '网关凭据文件', category: 'access', source: 'gateway',
    description: '设置消息网关使用的令牌文件位置。这里只显示文件位置，不读取或显示令牌内容。', applyLabel: '应用消息网关设置',
    fields: [
      textField('tokenFile', '网关令牌文件', '访问消息网关时使用的私有令牌文件。', 1_024,
        { validation: 'optional-path', allowUnset: false }),
      textField('upstreamTokenFile', '聊天服务令牌文件', '消息网关访问聊天服务时使用的私有令牌文件；留空时与网关令牌文件相同。', 1_024,
        { validation: 'optional-path' })
    ]
  }
];

const adminGroups: readonly ConfigurationGroupDefinition[] = [
  {
    id: 'admin-deployment', title: '管理端部署文件', category: 'settings', source: 'admin',
    description: '查看管理页面使用的令牌文件和消息网关设置文件位置。为避免连接中断，这些位置不能在此修改。',
    fields: [
      textField('tokenFile', '管理令牌文件', '访问管理页面时使用的私有令牌文件；不会显示文件内容。', 1_024,
        { editable: false }),
      textField('gatewayConfiguration', '网关配置文件', '管理端启动时加载的网关配置文件路径。', 1_024,
        { editable: false }),
      textField('legacyRoot', '旧版桥接目录', '管理端启动时读取的旧版桥接项目目录，仅供查看。', 1_024,
        { editable: false }),
      textField('serviceManager', '服务管理程序', '由本机部署指定的受信任服务管理程序路径，仅供查看；网页不能修改或传入命令参数。', 1_024,
        { editable: false })
    ]
  }
];

function freezeGroup(group: ConfigurationGroupDefinition): ConfigurationGroupDefinition {
  return Object.freeze({ ...group, fields: Object.freeze(group.fields.map(item => Object.freeze(item))) });
}

export const CONFIGURATION_SCHEMA: readonly ConfigurationGroupDefinition[] = Object.freeze(
  [...bridgeGroups, ...gatewayGroups, ...adminGroups].map(freezeGroup)
);

export function configurationSchemaForSource(source: ConfigurationSource): readonly ConfigurationGroupDefinition[] {
  return CONFIGURATION_SCHEMA.filter(group => group.source === source);
}
