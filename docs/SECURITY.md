# 安全边界

## 信任模型

功能包、宿主服务和适配器都在同一 Node.js 权限域内运行，必须视为可信代码。SDK 和 policy 用于约束正确接入的代码，不提供针对恶意 JavaScript 的隔离。

普通消息、模型输出、人设、配置、偏好和资源元数据都是不可信数据。它们不能安装代码、注册适配器、读取任意路径、创建授权或修改安全边界。

## 权限与副作用

- capability 必须同时出现在功能 manifest 和有效 policy grant 中。
- grant 精确限定功能、会话、能力、期限和有限尝试预算。
- 动作排队后、调用适配器前再次检查暂停、撤销和过期。
- 撤销不能回滚已进入外部系统的动作。
- `unknown` 表示结果不确定，应进入查询、对账或人工处置，不应盲目重试。
- 幂等键只有在下游明确实现持久去重后，才能提供跨重启保证。

## 入站与身份

HTTP 入站适配器必须限制方法、挂载路径、请求体大小和处理时间，并在解析业务内容前验证共享密钥或签名。当前 OneBot 接收器以原始请求体校验 `X-Signature: sha1=…`，使用 timing-safe 比较；缺失或无效签名直接拒绝。该签名不含时间戳，防重放仍依赖可信网络边界和宿主持久去重。

协议用户标识不自动等于框架授权主体。会话映射、管理身份和功能权限应由宿主分别验证。

### 可信装配与路由

event/effect 注册表、model、审计 observer 只由可信装配根注入；createBridgeHost 禁止覆盖内置事件/capability 和 agent.* 注册项。effect 与 model 仍需对应 manifest 和有限授权，observer 只收脱敏元数据，其异常不能变成授权或阻断策略。

routeIncoming 在入站授权后产生归属事实，不是权限判断。selector 仅接收冻结规范消息，必须同步严格返回 boolean；异常、thenable、非法标识与最高优先级多命中均拒绝。默认 fallback 必须显式配置，不能把失败当作 true。路由决策不带授权或正文，不把完整 body 写入审计。

withMessageRoute 只筛该功能的 message.received，不屏蔽其 trigger 等订阅，也不改变旁观者广播。route/relayToAgent 不能替代 agent.submit 或 messaging.send；不得把消息自报的 routing、模型意图或用户名字当作可信 grant。多个同路由响应者仍需装配者避免重复回复。

### 作用域与合并转发

人格 id@version、conversation 与可选 session/generation 从可信执行 scope 经 outbox 传到资源解析，不由模型 body 决定。scope 纳入出站幂等指纹；切人格或 generation 不能沿用同键覆盖。资源 resolve 还检查批准状态、类型、期限及可选 expectedVersion。旧无 scope/无人格绑定资源为兼容保留，使用它们不能宣称拥有新作用域保证；绑定 session 的资源也不能通过省略参数绕过检查。

forward 必须同时获得 messaging.forward 与 messaging.send 授权，禁止嵌套、外层混发与任意发送人字段。OneBot 的 group/private forward 扩展默认关闭，须 operator 单独开启并核对网关能力；每个节点的 QQ 号与姓名固定来自可信 senderId/senderName 配置。模型输出不得伪造转发身份，不能把开关、capabilities 声明或渲染成功当作发送授权。

### 文档准备与渲染

presentation 的 select 是受约束选择器，不能暗改显式 format；只有 fallback: 'text' 可明确降级。回复目标的距离/年龄由调用方给出，服务不自动读取聊天或推断：near 的 auto 回复不引，far 可引，uncertain 无 selector 时不引；selector 不能越过 near、never 或目标缺失等硬约束。

prepare 不发送，但可能渲染和发布本地 PNG；这些准备副作用需由可信宿主控制，使用 effect 入口时还需独立授权。图片批准不是 messaging.send 授权，最终仍须通过引擎 execution.send、policy 和出站。selectAgentMessage 是同步过滤点，不能直接承担异步渲染。

标准 relay 的异步 agentMessagePreparation 只获得 context/signal/invoke/generate，不获得 send/state/store；额外 capability 仍需 grant，受控 invoke 被拒绝时不得绕开 policy 直调 renderer。只有启用 hook 才传入原始 event.data.agentData，metadata 仍不可信，不直接写入审计或当成授权。null 不发送、不等于已确认回复；未配置 hook 不改变普通 relay 格式。

Markdown renderer 禁用原始 HTML 与输入脚本，浏览器 context 关闭页面 JavaScript、下载、service worker 和权限，使用 CSP、离线模式及全请求拦截。链接/图片只显示文字，不下载远程图片、字体或本地资源。宿主负责注入、更新和关闭 browser，部署本地中文字体，并保留浏览器自身的沙箱；输入字节、输出字节、页数、超时和未结并发限制不是操作系统内存或恶意可信代码隔离。

可选本地 publisher 校验 PNG 结构/尺寸/字节，锚定 canonical 私有目录，拒绝 symlink/hardlink、覆盖和损坏，完整落盘后才登记审批；pending/revoked 冲突不复活。Linux 实现依赖 /proc/self/fd；其他平台的 /dev/fd 不保证可用，不能把它写成框架整体平台要求。目录必须落在 registry 的受限根内，错误不泄漏路径，遗留锁与保留文件由 operator 检查而非自动恢复。它仅审批可信文档 renderer 的 PNG，不是对任意 AI 图或用户上传 PNG 的自动批准机制。

## 凭据与存储

- 凭据只由装配根注入需要它的适配器，不进入功能上下文、管理快照或错误消息。
- 不提交环境文件、生产配置、会话数据、资源内容或 `runtime/`。
- 持久存储应放在受限目录，并使用 revision 条件写入避免并发覆盖。
- namespace 和 key 不是文件路径；实现不得通过字符串拼接开放任意文件访问。
- 资源目录只解析已登记标识，并校验媒体类型、大小和生命周期。
- registry.get/list 只返回脱敏元数据，不能用它们绕开 resolve 的来源与 scope 校验。
- daily/weekly 日历规则须显式时区、DST 与有限窗口；误配置不能扩展发送权限。恢复遗留 running occurrence 为 unknown，不自动重做外部动作；规则停用或改代也不能保证撤销在途发送。

## 管理界面

演示服务只监听回环地址。长期管理员凭据至少 24 字符，仅在登录验证时以 Bearer 发送；不放入 URL、日志、源码或浏览器持久存储。服务器签发独立的随机访问令牌，使用 HttpOnly、SameSite=Strict 的同源 cookie，页面脚本不能读取。访问会话默认绝对有效期 7 天，可在运行设置调整；主动退出立即撤销当前会话，管理服务重启、管理员凭据变更或会话到期后需要重新登录。访问令牌只代表当前管理权限，不是协议服务密钥，也不授予功能包额外 capability。

真实网关管理宿主的监听地址由私有配置指定，可显式开放全部网卡，但不会关闭认证。它使用独立管理员凭据，支持受控配置保存与应用。首次网页初始化只在服务器私有文件生成管理员凭据并显示文件位置，不把凭据值返回浏览器，也不允许浏览器抢先指定管理员凭据。普通 HTTP 无链路加密，包括访问 cookie；非可信网络应使用 HTTPS 反向代理或受控隧道，开放监听不是公网安全部署。

### 本机 TLS 终止代理

普通 HTTPS→HTTP 反向代理必须在“设置 → HTTPS 反向代理”同时设置管理端 `publicOrigin` 与 `trustedLoopbackProxy: true`，并将管理端 `host` 绑定为回环 **IP 字面量**。例如公开来源为 `https://console.example.test`，后端监听 `127.0.0.1:3210`；不把公网地址或域名当成受信代理地址。公开 origin 必须是规范化 HTTPS origin，不含账号、路径、尾斜杠、查询或 fragment。两个字段默认 `''/false`，本机普通 HTTP 的既有行为不变。配置进入公开 schema/UI，CAS 保存后仍须在另行授权维护窗口重启管理服务生效，保存不会自动重启或假装已应用。

启用后服务器对**所有**请求验证真实 socket 的 remoteAddress 和 localAddress 均是回环地址；IPv4 `127/8`、`::1` 及 IPv4-mapped loopback 可用，`localhost`/DNS、网段声明、zone id 和远端地址不构成代理身份。网关配置加载器另拒绝通配或非回环 bind。可信代理边界是本机传输，而不是请求自报；它不能隔离本机其他有能力连接回环端口的进程，不应把它当作恶意本地用户隔离机制。

所有写路由（登录、退出、首次初始化、演示和管理扩展）仍要求浏览器原始 `Origin` **精确等于**配置的 publicOrigin，以及 JSON、认证和原有限界。服务器不使用 `X-Forwarded-Proto`、`X-Forwarded-Host`、`Forwarded` 或客户端 Host 来推断公开 HTTPS 来源。未启用该模式时伪造转发头不会把 HTTP 请求变成 HTTPS；显式代理模式下来自非回环 socket 的请求即使携带正确 Origin/转发头也拒绝。签发和清除访问 cookie 均含 `Secure; HttpOnly; SameSite=Strict`，维持 host-only、`Path=/api`；无 Cookie Domain 扩域、无跨域/CORS 例外、无 Bearer 写请求的 CSRF 豁免。

TLS 代理必须监听预期公开虚拟主机、完成证书校验/HTTPS 跳转，**保留**浏览器原始 Origin（不要覆盖为可信固定值），并把流量转给指定回环地址。代理可保留或重写 Host，本模式不依赖它；不要把后端端口公开，不要在普通 HTTP 公网链路传递管理员凭据或 cookie。修改了公开 origin 后应通过新的 HTTPS 地址访问；错误 origin 不会因重定向头或 Cookie 存在被放行。框架不安装证书、不部署代理、不提供 TLS server，也不自动扩大监听范围。

`src/admin/public-origin.ts` 是纯策略边界；`test/admin-public-origin.test.ts` 用临时回环 HTTP server 验证 TLS 终止的登录/保存/初始化与 Secure cookie，纯传输测试覆盖外部/伪造地址拒绝。没有实际部署代理、重启服务或联系外部主机；通过这些测试不等于已完成公网部署验收。

写请求要求 JSON、同源和体积限制；静态文件使用白名单路由；动态文本不得作为 HTML 注入。演示管理页没有用户体系、TLS、分布式限流或公网抗攻击能力。

host.storageStats 与 GET /api/host/storage 是只读统计；SQLite 只读事务保持单次总数/分页一致，不返回业务值。它们不会自动清理 unknown、清空历史、释放容量或尝试重发；统计健康不能代替 retention、对账、备份与恢复策略。

## 发布检查

`npm run check` 只覆盖类型、源码规则和部分敏感模式，不是完整秘密扫描。发布前仍需检查实际差异、跟踪文件、依赖变化和配置样例，并确认没有扩大监听地址、授权范围或可访问资源。

框架尚未提供完整候选发布/失败回滚、业务状态迁移、可恢复长工作控制面及跨组件保留清理机制。新增这些挂载点不意味着自主迭代与自动发布已经完成，也不构成真实 QQ、网关扩展、外部 agent 或长期运行的生产验收。
