# 公共契约

本文描述当前框架的公共概念。具体字段与导出以 `src/core/types.ts`、`src/core/engine.ts` 和 `src/host/types.ts` 为准。

## 通用值

- 跨模块数据必须是 `JsonValue`，写入时复制并冻结。
- 标识符使用非空字符串；调用方不得依赖对象可变性。
- 可预期失败使用 `FrameworkError` 的稳定 `code`，错误消息不包含原始凭据或消息正文。
- `AbortSignal` 表示协作式取消；收到取消后仍需等待适配器实际结束。

## 事件

```ts
interface FrameworkEvent {
  id: string;
  type: string;
  conversationId: string;
  userId?: string;
  sessionId?: string;
  taskId?: string;
  data: JsonObject;
}
```

同一 `conversationId + id` 重复提交相同事件时复用结果；相同标识对应不同内容时拒绝。此保证受进程内历史保留窗口限制。

## 消息

`MessageContent` 是以下有序联合：

| `type` | 字段 | 含义 |
| --- | --- | --- |
| `text` | `text` | 文本 |
| `image` | `assetId` | 图片资源引用 |
| `audio` | `assetId` | 音频资源引用 |
| `file` | `assetId`, `name` | 文件资源引用与显示名 |
| `mention` | `userId` | 提及目标 |
| `reply` | `messageId` | 回复目标 |

`TransportAdapter.send` 接收会话、消息块、幂等键和取消信号，返回：

- `confirmed`：适配器确认并提供 `messageId`。
- `rejected`：明确未接受。
- `unknown`：无法确认是否已执行。

`unknown` 不得自动转换为可安全重试。

## 功能 SDK

```ts
interface FeatureDefinition {
  id: string;
  version: string;
  apiVersion: 1;
  capabilities: readonly string[];
  subscriptions: readonly string[];
  setup(context: FeatureSetup): void | (() => void);
}
```

`setup` 必须同步完成，并为每个声明事件注册一次处理器。处理器得到 `FeatureExecution`：

- `context`：冻结的人设、配置、偏好和来源快照。
- `state`：当前功能与会话隔离的 JSON 状态。
- `signal`：卸载或停止时触发的取消信号。
- `generate(prompt)`：调用 `model.respond`。
- `send(content)`：调用 `messaging.send`。
- `invoke(capability, input)`：调用宿主注册的 effect adapter。

manifest 声明只是静态需求。每次副作用仍需匹配有效授权并消耗尝试预算。

## 引擎生命周期

`createEngine(options)` 返回：

- `install(feature)`：事务式发布处理器；安装失败不留下 active 功能。
- `uninstall(id)`：停止新执行、触发取消、排空在途动作并清理。
- `emit(event)`：接受事件或给出稳定校验/背压错误。
- `metrics()`：轻量队列、保留和调度计数。
- `describe()`：完整管理快照。
- `stop()`：停止所有功能并等待队列结束。

默认最多 256 个未完成事件、512 个未完成副作用；默认发送并发为 1。每个事件默认有 30 秒总期限，包含同会话排队和副作用排队时间，可用 `eventTimeoutMs` 在 10–300000 毫秒内调整。期限前尚未开始的动作不会启动；已经调用外部适配器的动作超时后按结果未知处理。超时会释放框架逻辑槽，但不会假定底层 promise 已结束；引擎继续用 `maxPendingEffects` 限制这些 raw effects，并在满载时快速背压。宿主可显式调整这些边界，但必须根据实际 transport 的顺序和限速要求验证。

## 上下文

`createContextStore` 提供：

- `registerPersona`：登记不可覆盖的版本化人设。
- `setConfiguration`：写入 operator 来源配置。
- `setPreferences` / `removePreferences`：管理有来源和可选期限的偏好。
- `resolve`：按 global、persona、conversation、user、session、task 由低到高解析。
- `describe`：返回不含业务值的管理摘要。

上下文不包含权限。临时偏好过期后恢复较低优先级值，不修改持久默认。

## Policy

授权记录包含唯一 id、功能、会话、capability 列表、每项有限 `maxUses` 和可选 `expiresAt`。

副作用先 `reserve` 消耗尝试预算，真正调用适配器前再 `begin` 检查暂停、撤销和过期。已经开始的外部动作不能由撤销机制保证回滚。

## 宿主接口

`src/host/types.ts` 定义宿主层共同边界：

- `DurableStore`：按 namespace/key 读写，revision 条件更新、分页列举、过期清理和关闭。
- `SessionBinding`：会话到 agent session 的 generation 化绑定。
- `AgentAdapter`：创建会话、提交消息、跟随结构化事件和可选取消。
- `InboundMessage`：协议适配器规范化后的入站消息。

### 持久存储与会话

`createSqliteStore({ filename, clock?, maxRecords?, maxValueBytes? })` 实现 `DurableStore`。写入支持 `expectedRevision: null` 的仅新建语义和指定 revision 的条件更新；读取与列举隐藏已过期记录，`purgeExpired` 显式清理。默认最多 100,000 条记录、单值 1 MiB、单页 1,000 条。文件数据库初始化为仅当前用户可读写；调用方负责选择安全目录并在停机时 `close()`。

`createSessionRegistry({ store, agent, clock? })` 提供 `get`、`resolve`、`bind`、`retire` 和 `list`。每次新建或替换绑定推进 generation。进程中断留下的 `creating` 状态在恢复时转为 `unknown`，不会自动再次创建外部 session。

### 持久出站

`createDurableTransport({ store, transport, clock? })` 包装任意 `TransportAdapter`，提供：

- `send`：先持久化 `prepared`，再进入 `sending` 并保存终态。
- `recover`：把遗留的 `prepared` / `sending` 标记为 `unknown`。
- `reconcile`：只接受明确的 `confirmed` 或 `rejected` 对账结果。
- `list` / `metrics`：提供有限运维视图，不返回消息正文。

同一幂等键只能对应相同会话和内容。持久出站防止宿主把中断动作当作从未执行，但不能替下游提供 exactly-once。

### 持久任务

`createTaskQueue({ store, clock?, maxScan?, handlerTimeoutMs? })` 提供 `register`、`schedule`、`runDue`、`recover`、`cancel`、`retry`、`list` 和 `stop`。

任务有 kind、scope、JSON payload、到期时间、可选过期时间和 1–10 次尝试上限。单 payload 最大 64 KiB；单次 `runDue` 最多执行 100 项，扫描量受 `maxScan` 限制。handler 默认期限为 30 秒，可在 10–300000 毫秒内调整；任务有 TTL 时，实际运行期限取 TTL 剩余时间与 handler 上限的较小值，排队期间过期的任务不执行。超时或恢复发现遗留 `running` 时任务进入 `unknown`，不能通过 `retry` 重放。只有明确 `failed` 且仍有预算的任务可以显式重试。

### 资源目录

`createResourceRegistry({ store, clock?, rootDirectory?, allowedOrigins?, maxFileBytes? })` 管理图片、音频和文件资源。`register` 创建带版本元数据的 `pending` 记录；只有 `approve` 后，`resolve` 才会按类型、会话 scope、可选 persona 与期限返回定位。`revoke` 立即使资源不可解析。

来源只允许：受限根目录内的真实文件、明确允许的 HTTPS origin，或安全格式的 gateway id。目录保存定位和治理元数据，不实现下载、生图或业务审核策略。

### OneBot 与 DSH

`createOneBotTransport` 支持 `private:<id>` / `group:<id>`，把文本、提及、回复以及经 resolver 解析的图片/音频转换为 OneBot 段。当前不发送 `file` 块；网络异常和无法解释的响应返回 `unknown`。

`createOneBotReceiver` 返回 Node HTTP `RequestListener`，验证原始请求体的 `X-Signature: sha1=…`，再规范化入站消息。宿主负责挂载固定路径、设置 HTTP 超时、提供 `allow` 鉴权和资源登记函数。

`createDshAdapter(client)` 不实现新的 DSH 客户端；它把注入的 `createSession`、`prompt`、`follow`、`cancel` port 转为 `AgentAdapter`，并规范化消息、完成、失败、问题和审批请求。适配器只上报问题/审批事件，不自动批准工具。

已有成熟 DSH SDK 时，先用 `createDshSdkPort({ client, subscribe, createSessionRequest?, cancel? })` 桥接其 sessions、事件订阅和 mux 边界，再把返回 port 交给 `createDshAdapter`；该组合不重新实现底层客户端。

需要统一限速时，可把 transport 包装为 `createThrottledTransport({ transport, minIntervalMs?, maxPending? })`；它提供有限全局 FIFO 与协作停机，队列溢出、排队取消和停机取消返回 `rejected`，`unknown` 不会自动重试。

### 管理路由

`createAdminServer` 可接收最多 64 个唯一 `AdminRoute`，每项声明 `GET` 或 `POST`、`/api/...` 路径和 `handle({ query, body, signal })`。扩展不能覆盖内建路由，共用 Bearer 认证；POST 另需同源 JSON 且请求体不超过 32 KiB，响应不超过 256 KiB，客户端断开会触发 `signal`。handler 默认期限为 10 秒，可在 10–300000 毫秒内调整；GET 超时返回 `504 / handler_timeout`，POST 超时返回 `504 / operation_unknown`，不会自动重试。`dispatchDemo` 可选，未提供时不开放演示事件处理。

`createHostAdminRoutes(host)` 提供只读 metrics、sessions、tasks、outbox 和 replies 路由。列表使用 `limit`（默认 100，最大 1000）与可选 `after`，返回 `{ items, next }`；只暴露现有管理元数据，不返回消息正文，也不提供授权或其他写操作。replies 项仅包含 id、会话/session、generation、request id、期限、状态、更新时间和 cursor。

### Bridge host

`createBridgeHost({ store, agent, transport, context, persona, authorizeIncoming, clock?, taskTickMs?, maxConcurrentSends?, eventTimeoutMs?, timeouts?, replyTimeoutMs?, replyTimeoutNotice?, selectAgentMessage?, onFault? })` 组装持久 policy、功能状态、会话、出站、任务、首回复监视和会话历史，并安装内置 `agent-relay` 功能。

返回对象公开 `engine`、`policy`、`sessions`、`outbox`、`tasks`、`history`、`replies`，以及：

- `receive(message)`：接收协议层已认证、规范化的 `InboundMessage`，先执行 `authorizeIncoming`，再持久去重并投递。
- `start()`：恢复中断状态、已有 session follow 和到期任务；整体超时会正常返回并把启动状态标为 `degraded`。
- `metrics()`：返回轻量宿主与引擎计数，包括 `startupState`、超时次数和最后故障码。
- `stop()`：停止新工作、取消 follow 并排空任务和引擎副作用。

宿主不会自动创建 grant。转发一个会话前，操作者必须显式给 `agent-relay` 授予该会话的 `agent.submit` 与 `messaging.send` 有限预算。只有定向且非自身的入站消息会提交给 agent；prompt 必须返回 `accepted`。agent 事件先以稳定映射、单调序号和 `deadlineAt` 持久登记，再进入同 TTL 的任务；旧 session/generation、重复事件或排队期间已过期事件不会发送。

`message` 事件可以进入受 policy 约束的持久出站；`question` 和 `approval` 仅作为事件记录，不会自动回答问题或批准工具。启动恢复把遗留 `processing` 入站、`running` 任务和未决发送标为 `unknown`，不会自动重放。

`selectAgentMessage(event, binding)` 是可选同步挂载点，可根据包含原始 `data` 的 `AgentEvent` 返回待发送 `MessageContent[]`，或返回 `null` 跳过出站且不消耗发送预算；未配置时普通 message 按默认 relay。框架不假定每个 `assistant/message` 都表示 turn 完成或都适合公开发送，operator 应按所接 SDK 的事件语义显式过滤内部工作文本，而不是依赖内置人格或工具隐藏规则。

`timeouts` 的 `createSessionMs`、`followMs`、`submitMs`、`sendMs`、`authorizeMs`、`startMs` 均允许 10–300000 毫秒，默认依次为 10 秒、10 秒、10 秒、10 秒、3 秒和 15 秒。授权超时返回 `rejected / INBOUND_AUTH_TIMEOUT` 且不写历史；真实未结 authorization promise 最多保留 256 个，超时不释放其占用，满载时新入站快速返回 `rejected / INBOUND_BACKPRESSURE`，实际 callback settle 后才释放，当前数量见 `metrics.unsettledAuthorizations`。create/follow 未决采用保守 `unknown`，submit 返回 `unknown`，send 持久记录为 `unknown`，这些结果都不会自动重试。迟到的 follow setup 会执行 disposer，迟到 frame 会被过滤。

宿主 bounded agent 与 transport 默认各最多保留 16 个尚未结束的底层 promise。期限到达只让上层有限返回，不代表底层已结束；迟到 promise 继续占用该上限，满载后新调用快速返回保守背压结果，而不是继续无界堆积。

agent prompt 返回 `accepted` 后，宿主默认等待 30 秒内出现该会话首条 confirmed assistant 消息；`replyTimeoutMs` 可在 10–300000 毫秒内调整。等待记录持久化，更多入站不会延长当前期限，启动会恢复仍在等待的 timer，正常 confirmed 回复会清除它。超时只把记录标为 `timed-out`，增加 metrics 并上报 `AGENT_REPLY_TIMEOUT`；不会取消或重新提交 agent 工作。

`replyTimeoutNotice` 默认是中性状态说明，可改为有界字符串或 `null`。非空时，独立 watchdog 通过 `agent.reply-timeout` 和既有 `agent-relay / messaging.send` 授权尝试发送一次，不绕过撤销或预算，也不把超时表述为任务完成或失败。等待状态为 `waiting`、`responded`、`timed-out` 或 `responded-late`。当前 agent message 不携带原 prompt request id，因此 `responded-late` 只表示活动会话在超时后出现 confirmed assistant 消息，不能可靠归因所有迟到远程任务已经完成；该消息仍按普通 agent 消息处理。

上述实现尚需针对具体 QQ 网关、DSH client、持久目录和故障场景做集成验收；公共接口存在不代表生产部署已经通过。
