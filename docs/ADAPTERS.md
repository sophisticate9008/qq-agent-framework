# 适配器配置

在“适配器 → OneBot”分别配置 HTTP 发送和 WebSocket 接收。WebSocket 连接成功后自动识别机器人账号，不用手填 QQ 号。HTTP 与 WebSocket 的端口和密钥可能不同。

默认 CLI 已挂载协议连接控制器：保存后点击“连接 WebSocket”，断开使用独立按钮。保存参数不会自动更新已有连接，修改后需要重新连接。所有连接默认关闭，不发送测试消息或调用模型。

**协议已连接不等于聊天就绪。** CLI 管理服务已挂载原生聊天装配器，但构造、保存配置、预览或部署均不自动启动聊天。只连接协议时不保存正文或提交 agent，`chatReady` 保持 false；准备配置、有限授权及可信 DSH 部署后，必须显式启动原生运行时。

## 配置 API

`GET /api/chat/adapters` 和 `POST /api/chat/adapters` 管理框架自己的私有 `chat-adapters.json`。目录权限 `0700`、文件权限 `0600`、文档最多 64 KiB；写入共用目录锁、revision 条件更新、原子替换和目录同步，不读取其他项目配置。

响应为 `{ revision, adapters, status, connection? }`。原生适配器包括：

| 标识 | 配置字段 | 只写凭据 | 明确清除 |
| --- | --- | --- | --- |
| `onebotHttp` | `enabled, endpoint` | `secret` | `clearSecret` |
| `onebotWs` | `enabled, endpoint` | `secret` | `clearSecret` |
| `dshAgent` | `enabled, endpoint` | `auth` | `clearAuth` |
| `onebotWebhook` | `enabled, host, port, selfId` | `hmac` | `clearHmac` |

POST 接收 `{ revision, adapters }`，其中 adapters 是上述标识的非空子集。未指定的适配器保持原值。凭据省略或空字符串保留原值，只有明确清除标记为 true 才删除；清除与非空新值不能同时指定。读取只返回 `secretConfigured/authConfigured/hmacConfigured`，不返回原值或掩码字符串。凭据最多 4096 个非空白可见 ASCII 字符。

只包含原先三个条目的私有文档读取时补充关闭的 WebSocket 默认值，不因读取改写文件。未知字段与标识仍严格拒绝，不自动清除或重置私人扩展配置；需要迁移时先私有备份、协调写入者并重新读取 revision。

HTTP/DSH 地址只允许本机回环 HTTP 或 HTTPS；WebSocket 地址只允许本机回环 `ws://` 或远程 `wss://`。不接受 URL 内嵌凭据、查询参数、片段、空白、反斜线或超过 2048 字符的地址。启用时必须有非空地址。

## 接收方式

WebSocket 与 webhook 只能启用一种，避免重复收消息。页面默认使用 WebSocket 引导；webhook 收入“其他接收方式（高级）”。

HTTP webhook 是协议端主动推送事件的替代方式，不是测试功能。配置校验要求本机回环监听地址、1–65535 端口、机器人账号和 HMAC；默认 CLI 当前不挂载此监听器。关闭时可保留端口 0 与空账号。关闭且没有未保存修改时，页面隐藏这些字段，但不会清空已存设置。

## 连接控制

- `POST /api/chat/adapters/connect` 接收 `{ revision }`：在目录锁下读取并核对已保存配置，等待有界 WebSocket 登录握手。
- `POST /api/chat/adapters/disconnect` 接收 `{}`：关闭连接生命周期，再读取状态。
- 两者都要求管理认证与同源 JSON，不修改配置文件。并发控制被拒绝，期限有限；失败或未知时先读状态，不自动重试。

`status` 包含 `{ assembled, running, applyAvailable }`。assembled 表示注入了连接管理端口，不表示聊天服务已运行；running 只有真实连接且已识别账号才为 true。applyAvailable 只表示控制可用。

可选 `connection` 包含 `{ state, selfId, lastError, received, dropped, chatReady }`。state 为 disconnected、connecting、connected、reconnecting 或 error；错误为稳定脱敏代码，不包含地址、密钥或消息正文。chatReady 来自原生运行时实际状态，不由协议握手推断；只连接协议而未启动时的消息计入运行时 `ingress.droppedWhileStopped`。

## 原生聊天装配与授权

默认 `startGatewayAdmin`（也由 CLI 管理入口调用）装配 `createNativeChatRuntime`，内部使用 SQLite、`createBridgeHost`、持久 sessions/history/outbox/tasks/policy、OneBot normalizer/HTTP transport，以及 DSH adapter/JSON-RPC port。实例构造不联网，只有明确的连接、部署核验或启动操作才访问所选端点；不发现、导入或控制其他桥接项目。

| API | 请求/响应要点 |
| --- | --- |
| `GET /api/chat/runtime`、`GET /api/chat/status` | state、chatReady、protocolConnected、canStart、canApplyDeployment、configurationIssues、missingReasons、revisions、activeRevisions、host/ingress 元数据 |
| `POST /api/chat/runtime/start` | `{ revisions }`，必须精确包含 plans/personas/access/adapters/providers/authorization/deployment 七个当前内容 hash |
| `POST /api/chat/runtime/stop` | `{}`；停止本进程 ingress、跟随与宿主，保留持久数据 |
| `GET/POST /api/chat/authorization` | `{ revision, version, grants: [{ conversationId, submitUses, sendUses, expiresAt }] }` |
| `GET/POST /api/chat/deployment` | `{ revision, deployment: { target, modelSettings, namespace } }`；完整配置与核验见 [DSH 适配器](DSH_ADAPTER.md) |
| `POST /api/chat/deployment/prepare`、`reconcile` | `{ revisions }`；准备或重新核验，不自动连接 OneBot/创建 agent session |
| `POST /api/chat/deployment/apply` | `{ revisions, targetRevision }`；targetRevision 必须为之前预览的 64 位 hash，与原生文档 revision 分开 |

`configurationIssues` 只包含启动准备阻断，`missingReasons` 还包含“未启动”“协议未连接”等运行诊断；界面使用 `canStart`，不能据 missingReasons 非空永久禁用启动。`modelExecutionVerified:false` 明确表示握手、可信配置核验及宿主装配没有验证付费模型推理；`credentialValueIdentityVerified:false` 表示只核验明确文件、官方 file 来源与加载配置，没有外部引擎实际所用密钥值相等的回执。临时目录下的替身验证也不等于真实 QQ/模型生产验收。

OneBot WebSocket 的 `get_login_info` 已验证身份自动用于规范化；HTTP 同时要求明确的 `status:ok / retcode:0` 和相同 self id。缺失 status、async、failed/0、身份不符均不能启动聊天。当前原生链支持文本与移除自身 @ 后的群文本；普通群消息不自动唤醒，不支持的媒体/消息块拒绝，不悄悄降级为授权能力。

allow/deny 在 session 创建与 agent 调用之前检查，owner 不豁免；宿主授权回调只有字面 `true` 才接受。允许会话不等于 grant：每个 scope 还需显式 agent.submit/messaging.send 有限尝试预算（0–1000000）和可选绝对 expiresAt。授权 version 首次使用后内容不可变，同版本重启沿用计数/期限；续额需 operator 明确发布新 version，不能通过普通保存或重启补充。未授予 forward、工具或模型直调权限。

配置变化使运行中的旧快照失效，需停止并核对后重新启动；已有 session 的完整定义或 DSH binding 不相容时拒绝启动，不自动换 session、清历史或重放 unknown。导入的人设标识可含目录契约允许的字符；仅内部 core persona 使用稳定 hash 标识，不重命名目录引用或扩大授权。运行时互斥持有 `.native-chat-runtime.lock`；崩溃遗留锁不能按年龄自动删除，须先人工确认实例已停止及持久 unknown。

## 原生会话与用量

`GET /api/chat/sessions?limit=100&after=...` 返回旧页面使用的 `{ sessions, revision }` 与原生 `{ items, next, resetAvailable:false }`。next 为会话键的排他升序 cursor；直到 null 才完成，不能因本地筛选无结果丢弃后续页。revision 是本页内容 hash，不是跨分页事务快照。默认100、最大1000项，响应上限1MiB。`/api/host/metrics|storage|sessions|tasks|outbox|replies` 提供实际宿主只读管理数据；未装配时返回 `503 runtime_not_connected`，不伪造空成功。显式停止后仍可检查本管理进程已打开的持久元数据。

用量 API 保留完整页面投影，并附 `native:true`：

- `GET /api/chat/usage?limit=200`：totals、按会话汇总、当前价目与账本元数据；同时提供 knownTokens/missingTokens/knownCosts/partial 等覆盖信息。
- `GET /api/chat/usage/series?hours=24&buckets=48`：固定时间窗走势，hours 1–2160，buckets 1–120；空或未知样本保持 null，不以零绘制已知消耗。
- `GET /api/chat/usage/turns?key=private%3A123&limit=200`：该会话逐轮、逐步归属及已知费用；`GET /api/chat/usage/recent?limit=40` 返回最近流水。
- 原生审计查询可用 `since/until` 毫秒、conversationId/provider/model、limit/after；`series?bucketMs=...` 为有界原始汇总，turns 未给 key 时为原始逐步列表。分页 limit 最大 1000，汇总会话最多 500，最近流水最多 500；扫描超过 10000 记录明确 partial，不宣称全量。
- 汇总/走势/逐轮响应各自最多4MiB，最近流水最多1MiB；不扩大其他管理路由。附带 policy 元数据最多1000项并显式标记 limited，不把截取列表当完整授权历史。
- `GET/POST /api/chat/usage/pricing` 为 `{ revision:number|null, prices:[{ provider,model,currency,inputPerMillion,outputPerMillion,cacheReadPerMillion,cacheWritePerMillion }] }`。在首次显式启动打开 SQLite 后使用；数字 revision 独立 CAS，冲突为 `409 usage_pricing_revision_conflict`，未知写入为 `500 usage_pricing_operation_unknown`，不自动重试。

DSH 只在实际观察的终态 turn 上提供逐步用量：uncached input、cache read/write、output、可选 total/reasoning 分别记录，reasoning 不重复加到 output。缺失计数、跟随中途、断线丢失及混合币种不推算为完整总量；观察范围为 `observed-terminal-turns-only`，不是服务商账单。stream/error 不是模型 turn，不创建虚假用量。费用只记录明确报告值，或用当时 operator 单价估算；每条记录固定其价格 revision，调价不追溯重算旧轮。固定单价标记 flat，不冒充高峰/空闲档；币种分别累计，不自动兑换。当前无自动压缩/删除/清空，用量和 session reset 返回 405，不改变历史 unknown。

## 已知执行等待边界

当前原生装配仍是 DSH/HTTP 操作期限 5 秒、宿主外部动作 6 秒、回复 watchdog **30 秒且不发送通知**。watchdog 只标记 timed-out，不调用 agent.cancel；不断 progress 可继续刷新 DSH 默认 5 分钟 idle follow 期限。因此，终止流失效后重新跟随的修复**不等于**长时间无最终回复、外部任务取消或用户要求的默认 60 秒执行策略已经完成。

停止只确认本地资源排空，不确认已接受的外部模型工作停止；不自动重发旧 prompt。下一阶段需独立、可配置且 revision 保护的 60 秒 turn 执行策略、通知授权、协作取消、未知隔离和迟到归因，并验证无 final、持续 progress、半开与后续消息可用。此处为尚未交付的设计边界，不修改现有七 revision 请求为未审批的新协议。

## 宿主扩展

`createNativeRuntimeRoutes({ directory, adapterRuntime?, chatRuntime?, deploymentRuntime? })` 支持可信代码接线，不从 JSON 加载代码：

- 原有只读 `status(): { running }` 端口仍可用，但不提供连接控制。
- 控制端口可提供 `connect(configuration, signal)`、`disconnect()`、`connectionStatus()`。
- 原生运行时内部使用 `createOneBotConnectionManager({ onEvent })`；构造不联网，显式连接才访问配置端点，管理进程关闭时释放连接。独立 connect/disconnect 与聊天 start/stop 互斥，不能在聊天运行时抢占连接。
- chatRuntime 必须来自框架自己的工厂；任意注入 test host 或只读 running=true 端口不能报告聊天就绪。

缺少运行端口时报告未装配，控制返回 `503 adapter_runtime_unavailable`。详情见 [WebSocket 客户端](ONEBOT_WEBSOCKET.md)。

## 业务扩展

生图等使用者自补能力不属于默认协议/agent 目录。通过通用 `FeatureDefinition`、`EffectAdapter`、资源与 policy 接入，使用者自行定义服务、凭据和业务流程。配置不能创建权限，也不能直接安装或加载代码。

## 失败语义

- `400 invalid_adapter_configuration`：字段或值不合法；错误不包含凭据。
- `400 invalid_query`：不支持查询参数。
- `409 chat_revision_conflict`：重新读取后再决定。
- `409 chat_storage_busy`：其他写入持锁；废弃锁需人工检查，不自动抢锁。
- `409 adapter_runtime_busy`：连接控制正在进行。
- `503 adapter_runtime_unavailable/adapter_connection_failed`：控制不可用或连接失败。
- `504 adapter_runtime_timeout`：控制超时，先核对实际状态。
- `500 chat_storage_invalid/chat_storage_write_failed`：存储校验或替换前写入失败。
- `500 chat_write_unknown`：替换已发生但持久性或验证未知，先读取，不自动重复写入。

条件写保证要求所有写入者遵守锁协议。HTTP 取消不能回滚已经开始的存储事务或外部操作。
