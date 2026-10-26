import type { PageId } from './types.ts';
import { usagePriceComponents } from './usage-pricing.ts';
import { usageSectionLabels } from './usage-details.ts';

function form<Fields extends Record<string, string>>(page: PageId, id: string, title: string, fields: Fields) {
  return { page, id, title, fields } as const;
}

export const nativeFormMetadata = {
  bootstrap: form('features', 'native-bootstrap-summary', '可信扩展装配摘要', {}),
  output: form('overview', 'package-configuration-chat-output', '回复方式', {}),
  forwardAuthorization: form('features', 'forward-authorization', '合并转发权限', { conversations: '允许合并转发的会话' }),
  workRecords: form('model', 'native-work-records', '独立工作记录', { conversation: '工作所属会话筛选' }),
  memory: form('features', 'native-memory', '记忆与偏好', {
    scope: '记忆作用范围', conversation: '记忆来源会话', user: '记忆用户账号', kind: '记忆类型', content: '记忆正文', tags: '记忆标签',
    changeExpiry: '更改记忆有效期', permanent: '记忆长期保存', hours: '记忆有效小时数',
  }),
  toolPermissions: form('security', 'native-tool-permissions', '框架工具授权', {
    conversation: '授权 QQ 会话', permanent: '授权不过期', hours: '授权有效小时数',
  }),
  reminders: form('features', 'native-reminders', '提醒规则', {
    conversation: '目标 QQ 会话', timeZone: '提醒时区', text: '提醒正文', schedule: '执行规则',
    onceAt: '执行日期与时间', delayMinutes: '延迟分钟数', time: '执行时刻', dayOfWeek: '每周执行日', enabled: '保存后启用提醒',
  }),
  execution: form('security', 'chat-execution', '回复与超时', {
    turnSeconds: '单次处理总期限', noticeEnabled: '超时后发送提醒', noticeText: '超时提醒内容',
    cancelOnTimeout: '请求停止超时任务', maxActive: '最大同时处理会话数',
    cancelSeconds: '停止请求等待期限', noticeSeconds: '提醒发送等待期限',
  }),
  access: form('security', 'native-access', '消息白名单', {
    allowGroups: '群聊白名单', allowPrivate: '私聊白名单',
    denyGroups: '群聊拒绝名单', denyPrivate: '私聊拒绝名单', owner: '主人账号',
  }),
  persona: form('persona', 'native-persona-editor', '人设内容', {
    id: '内部标识', name: '显示名称', identity: '身份定义', style: '表达风格',
  }),
  plan: form('model', 'native-plan-editor', '聊天方案', {
    id: '内部标识', name: '方案名称', description: '方案说明', instructions: '方案指令',
    persona: '关联人设', reasoning: '思考强度', provider: '模型提供方', model: '模型',
    groupContext: '群聊上下文', privateContext: '私聊上下文',
  }),
  capabilities: form('model', 'native-chat-capabilities', '聊天工具', {
    selection: '聊天时可用的工具', confirm: '使用这组工具',
  }),
  provider: form('providers', 'native-provider-editor', '提供方设置', {
    allowInsecureHttp: '允许此提供方使用 HTTP（不加密）',
    name: '提供方显示名称', type: 'DSH 接口协议', baseUrl: '接口基础地址', enabled: '启用此提供方',
    replaceKey: '更换密钥（可选）', fillKey: '填写密钥（可选）', clearKey: '清除已保存密钥',
    modelId: 'API 模型 ID', modelName: '模型显示名称（可选）', id: '提供方内部标识',
  }),
  authorization: form('security', 'chat-authorization', '消息处理授权', {
    kind: '会话类型', group: '群号', private: '用户号', submitUses: '模型提交次数',
    sendUses: '回复发送次数', expires: '有效期（可选）', cancelUses: '超时停止请求次数',
    toolDelegationEnabled: '启用有限工具委派', toolDelegationUses: '工具委派尝试次数（按轮）',
  }),
  onebot: form('adapters', 'adapter-onebotHttp', 'OneBot', {
    websocket: '启用 WebSocket 收消息', websocketEndpoint: 'WebSocket 地址', websocketKey: 'WebSocket API 密钥（可选）',
    webhook: '收取 OneBot 上报', host: '监听地址', port: '监听端口', account: '机器人账号', hmac: '签名密钥',
    enabled: '启用此连接', endpoint: '服务地址', credential: '协议端 API 密钥（可选）',
  }),
  dsh: form('adapters', 'adapter-dshAgent', 'DSH 聊天引擎', {
    enabled: '启用此连接', endpoint: '服务地址', credential: '引擎访问凭据',
  }),
  triggers: form('persona', 'persona-wake', '唤醒与续聊', { nicknames: '呼叫昵称', reply: '引用机器人时唤醒', continuation: '同人续聊时长（秒）' }),
  deployment: form('model', 'dsh-deployment', '应用聊天设置', {
    profile: 'DSH 配置文件', credentials: 'DSH 凭据文件', context: '模型上下文容量', output: '模型最大输出',
    reasoning: '模型支持推理档位', layers: '基础配置文件（可选）', namespace: '生成配置名前缀',
    off: 'off 接口值', low: 'low 接口值', medium: 'medium 接口值', high: 'high 接口值', max: 'max 接口值',
  }),
  journal: form('sessions', 'execution-journal', '任务执行日志', { filter: '筛选已读取的执行记录' }),
  pricing: form('usage', 'usage-pricing-editor', usageSectionLabels.pricingEditor, {
    provider: '模型提供方', model: '模型', currency: '币种（三位代码）',
    ...Object.fromEntries(usagePriceComponents.map(component => [component.key, component.label])),
  }),
  listener: form('security', 'settings-listener', '管理端监听', { host: '监听地址', port: '监听端口' }),
} as const;

export type NativeFormId = keyof typeof nativeFormMetadata;

export const nativeFormHints: Readonly<Partial<Record<NativeFormId, string>>> = {
  execution: '请先读取处理策略；提醒内容与等待期限需开启对应提醒或停止开关后可用。',
  provider: '请先选择或创建提供方；模型字段需先添加模型。密钥操作按已配置状态显示。',
  authorization: '请先读取授权并添加会话；停止与工具委派字段仅在服务明确提供对应能力时可用，委派次数需手动开启。',
  capabilities: '这是可选的 DSH 工具接入设置，不是普通工具调用或独立工作委派的授权开关。',
  onebot: '请先读取连接配置；收消息与上报的依赖字段需开启对应开关后可用。',
  deployment: '请先启用并保存 DSH 连接，再读取应用设置；档位接口值需启用推理档位。',
  pricing: '请先读取账本单价；字段需先添加计价规则，选择对象需提供方目录可用。',
};

export function nativeFormSearchTargets() {
  return (Object.keys(nativeFormMetadata) as NativeFormId[]).filter(key => !['authorization', 'toolPermissions', 'forwardAuthorization', 'memory', 'reminders'].includes(key)).flatMap(key => {
    const metadata = nativeFormMetadata[key];
    const location = { page: metadata.page, sectionId: metadata.id, sectionTitle: metadata.title,
      fallbackSectionId: key === 'deployment' ? nativeFormMetadata.dsh.id : undefined,
      availability: 'unknown' as const };
    const unavailableMessage = nativeFormHints[key] ?? '请先读取此页配置；字段仅在对应表单可用时显示。';
    return [
      { ...location, kind: 'section' as const, title: metadata.title, unavailableMessage },
      ...Object.values(metadata.fields).map(title => ({
        ...location, kind: 'field' as const, title, unavailableMessage,
      })),
    ];
  });
}
