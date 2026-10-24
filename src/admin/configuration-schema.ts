export type ConfigurationSource = 'gateway' | 'admin';
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

export type ConfigurationValidation = 'reference' | 'optional-path' | 'loopback-http-url' | 'public-origin';

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

const textField = (
  id: string,
  label: string,
  description: string,
  maxLength = 256,
  options: FieldOptions = {}
) => field(id, label, description, 'text', { maxLength, ...options });

const gatewayGroups: readonly ConfigurationGroupDefinition[] = [
  {
    id: 'gateway-targets', title: '消息发送范围', category: 'access', source: 'gateway',
    description: '只允许向明确列出的会话发送消息；空列表拒绝所有发送。修改后更新授权版本，保存不等于已应用。',
    applyLabel: '应用消息网关设置',
    fields: [field('allowedConversations', '允许发送的会话', '每行填写 group:群号 或 private:QQ号。此处只控制出站发送。', 'list',
      { maxItems: 1_000, itemMaxLength: 24, allowUnset: false, rotatesAuthorization: true })]
  },
  {
    id: 'gateway-runtime', title: '网关连接', category: 'settings', source: 'gateway',
    description: '设置消息网关使用的端口和 OneBot HTTP 上游地址。发送额度、超时和容量限制保持基本设置中的数值。',
    applyLabel: '应用消息网关设置',
    fields: [
      numberField('port', '网关端口', '消息网关使用的本机端口。', 1, 65_535, '端口'),
      textField('upstreamEndpoint', 'OneBot 上游地址', '网关转发请求的本机 OneBot HTTP 地址，不能包含账号密码或额外参数。', 2_048,
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
      textField('upstreamTokenFile', 'OneBot 上游令牌文件', '网关访问 OneBot 上游时使用的私有令牌文件；留空时与网关令牌文件相同。', 1_024,
        { validation: 'optional-path' })
    ]
  }
];

const adminGroups: readonly ConfigurationGroupDefinition[] = [
  {
    id: 'admin-public-origin', title: 'HTTPS 反向代理', category: 'settings', source: 'admin',
    description: '仅用于本机 TLS 终止代理。两个选项须同时配置，管理后端须绑定回环 IP；保存后另行重启管理服务生效，不自动重启。',
    fields: [
      textField('publicOrigin', '管理页公开 HTTPS 来源', '精确填写 HTTPS origin（例如 https://console.example.test），不带路径、账号、查询或尾斜杠。留空表示普通本机 HTTP。', 2_048,
        { validation: 'public-origin' }),
      field('trustedLoopbackProxy', '信任本机 TLS 代理', '仅接受 socket 两端实际为回环 IP 的代理连接；不信任 X-Forwarded-Proto、Forwarded 或转发 Host。启用后浏览器访问 cookie 始终为 Secure。', 'boolean')
    ]
  },
  {
    id: 'admin-access-session', title: '访问会话', category: 'settings', source: 'admin',
    description: '管理员凭据只用于登录验证；访问会话允许刷新后继续使用，主动退出时立即注销。保存后重启管理服务生效。',
    fields: [
      numberField('accessSessionTtlMs', '访问令牌有效期', '默认 7 天，最长 30 天；到期或管理服务重启后需重新登录。管理员凭据不会写入浏览器存储。', 300_000, 30 * 86_400_000, '毫秒')
    ]
  },
  {
    id: 'admin-deployment', title: '管理端部署文件', category: 'settings', source: 'admin',
    description: '查看管理页面使用的令牌文件和消息网关设置文件位置。为避免连接中断，这些位置不能在此修改。',
    fields: [
      textField('tokenFile', '管理令牌文件', '访问管理页面时使用的私有令牌文件；不会显示文件内容。', 1_024,
        { editable: false }),
      textField('gatewayConfiguration', '网关配置文件', '管理端启动时加载的网关配置文件路径。', 1_024,
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
  [...gatewayGroups, ...adminGroups].map(freezeGroup)
);

export function configurationSchemaForSource(source: ConfigurationSource): readonly ConfigurationGroupDefinition[] {
  return CONFIGURATION_SCHEMA.filter(group => group.source === source);
}
