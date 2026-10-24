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
| `forward` | `nodes: { content: BasicMessageContent[] }[]` | 独立发送的合并转发 |

普通消息最多 8 块，单个文本块最多 8000 个字符串长度单位，规范化后的整条 JSON 不超过 64 KiB。`forward` 必须是整条消息唯一的块，包含 1–32 个节点；每个节点只允许 `content`，按普通块限制校验，禁止嵌套 forward、混发外层文本/回复或自带发送人字段。`TransportAdapter.capabilities?()` 可返回 `{ contentTypes, maxForwardNodes? }`；未声明能力不代表支持所有协议扩展。

`SendRequest.scope?` 为 `{ persona: { id, version }, sessionId?, generation? }`。引擎从实际解析的人格版本及事件 session/generation 生成冻结 scope，并传入 effect 与 transport；普通内容不能覆盖它。generation 必须为正整数且同时有 sessionId。`createDurableTransport` 保存 scope，并把它纳入幂等指纹；同一键不能换人格或会话代次。直接调用适配器的旧请求仍可省略 scope，旧持久记录也可读取，但不会自动补出身份或获得新授权。

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

发送 forward 必须同时在 manifest 和 grant 中具备 `messaging.forward` 与 `messaging.send`，两者分别检查并消耗尝试预算。只授予 send 不能发送 forward；这两项检查不是预算的原子回滚事务，后续拒绝不会返还先前已消耗的尝试。

## 宿主接口

`src/host/types.ts` 定义宿主层共同边界：

- `DurableStore`：按 namespace/key 读写，revision 条件更新、分页列举、过期清理和关闭。
- `SessionBinding`：会话到 agent session 的 generation 化绑定。
- `AgentAdapter`：创建会话、提交消息、跟随结构化事件和可选取消。
- `InboundMessage`：协议适配器规范化后的入站消息。

### 持久存储与会话

`createSqliteStore({ filename, clock?, maxRecords?, maxValueBytes? })` 实现 `DurableStore`。写入支持 `expectedRevision: null` 的仅新建语义和指定 revision 的条件更新；读取与列举隐藏已过期记录，`purgeExpired` 显式清理。默认最多 100,000 条记录、单值 1 MiB、单页 1,000 条。文件数据库初始化为仅当前用户可读写；调用方负责选择安全目录并在停机时 `close()`。

SQLite 另提供只读 `stats({ limit = 100, after? } = {})`，返回 `maxRecords`、`totalRecords`、`expiredRecords`、`remainingRecords`、`namespaces` 与 `next`。namespace 项只有名称、总数、过期数和最早更新时间；总数包括尚未物理清理的过期记录。一次调用在 SQLite 只读事务中保持总数与当前分页一致，不代表多次请求共享快照。单页最多 1000 个 namespace，不包含记录正文，也不会执行清理或更改 `unknown`。通用 `DurableStore.stats` 为可选接口。

`createSessionRegistry({ store, agent, clock? })` 提供 `get`、`resolve`、`bind`、`retire` 和 `list`。每次新建或替换绑定推进 generation。进程中断留下的 `creating` 状态在恢复时转为 `unknown`，不会自动再次创建外部 session。

### 持久出站

`createDurableTransport({ store, transport, clock? })` 包装任意 `TransportAdapter`，提供：

- `send`：先持久化 `prepared`，再进入 `sending` 并保存终态。
- `recover`：把遗留的 `prepared` / `sending` 标记为 `unknown`。
- `reconcile`：只接受明确的 `confirmed` 或 `rejected` 对账结果。
- `list` / `metrics`：提供有限运维视图，不返回消息正文。

同一幂等键只能对应相同会话、内容和可选 scope。持久出站防止宿主把中断动作当作从未执行，但不能替下游提供 exactly-once。

### 持久任务

`createTaskQueue({ store, clock?, maxScan?, handlerTimeoutMs? })` 提供 `register`、`schedule`、`runDue`、`recover`、`recoverPage`、`cancel`、`retry`、`list` 和 `stop`。

任务有 kind、scope、JSON payload、到期时间、可选过期时间和 1–10 次尝试上限。单 payload 最大 64 KiB；单次 `runDue` 最多执行 100 项，扫描量受 `maxScan` 限制。handler 默认期限为 30 秒，可在 10–300000 毫秒内调整；任务有 TTL 时，实际运行期限取 TTL 剩余时间与 handler 上限的较小值，排队期间过期的任务不执行。超时或恢复发现遗留 `running` 时任务进入 `unknown`，不能通过 `retry` 重放。只有明确 `failed` 且仍有预算的任务可以显式重试。

调度只扫描持久 pending 索引，并在执行前重新读取权威任务记录；终态任务从索引移除，但仍保留任务历史。已有数据库首次打开时按版本建立索引，`recoverPage({ limit, after? })` 可分批修复缺失或孤立索引，不把索引当作重放未知动作的依据。

### 日历触发

`createCalendarTriggerService({ store, callback, clock?, maxScan?, callbackTimeoutMs?, maxPendingCallbacks?, retentionMs? })` 是独立服务，不由 bridge 自动启动，也不是完整 cron。它提供 `register`、`update`、`setEnabled`、`cancel`、`tick`、`recoverInterrupted`、`list`、`listOccurrences`、`metrics` 和 `stop`。

规则必须显式给出 `{ id, scope, timeZone, schedule, dst, misfire, windowMs, payload, enabled? }`：

- `schedule` 只支持 `{ kind: 'daily', hour, minute }` 或 `{ kind: 'weekly', dayOfWeek, hour, minute }`；周一为 1、周日为 7，不支持秒级、cron 表达式或节假日日历。
- `timeZone` 为运行环境 Intl 支持的 IANA 时区。`dst` 必须给出 `{ overlap: 'earlier' | 'later', nonexistent: 'skip' }`：重复本地时刻只选择一次，不存在的时刻跳过。
- `windowMs` 为 1 分钟至 8 天；超出窗口的历史机会不补发。每次 tick 对一条规则最多执行窗口内最新一次：`misfire: 'skip'` 丢弃更早机会，`coalesce` 同样只调用一次，但以 `coalescedCount` 记录窗口内额外合并的次数，不统计窗口外全部停机历史。
- payload 最大 64 KiB；`enabled` 默认 true。登记、更新或重新启用从当前时间建立评估起点；修改及启停推进 generation，并协作取消旧代 callback。取消后的规则不能重新启用。

callback 接收冻结的 `{ id, ruleId, generation, scope, scheduledAt, deadlineAt, coalescedCount, payload, signal }`，其中 id 由规则、generation 和计划时间稳定生成。调用方可把它映射成 `trigger.fired`；服务自身不创建 grant，也不直接发送消息。

默认 `maxScan = 1000`（1–10000）、`callbackTimeoutMs = 30000`（10–300000）、`maxPendingCallbacks = 16`（1–256）、`retentionMs = 30 天`（1 分钟–366 天）。callback 期限还受窗口剩余时间限制；真实未结 promise 继续占并发额度。`tick({ limit = 16 })` 最多尝试 100 次，并复用当前在途 tick；规则扫描有 cursor，不保证每次扫描所有规则。

启动时由 operator 分页调用 `recoverInterrupted({ limit = 100, after? })`，把遗留 running occurrence 标为 unknown，不重放；随后由宿主定时驱动 `tick()`，停机时 `stop()`。终态 occurrence 使用上述 retention TTL，这不是全局数据保留策略，也不会清理其他组件的 unknown 或外部副作用。

### 资源目录

`createResourceRegistry({ store, clock?, rootDirectory?, allowedOrigins?, maxFileBytes? })` 管理图片、音频和文件资源，默认单个本地文件最大 20 MiB。`register({ id, type, scope, persona?, version, source, expiresAt?, sessionId?, generation? })` 创建 pending 记录，只有 `approve(id)` 后可解析；`revoke(id)` 使资源不可解析，不能再次 approve 已撤销资源。`get(id)` 与分页 `list` 只返回治理元数据，不返回来源路径或内容。

`resolve({ assetId, type, conversationId, persona?, expectedVersion?, sessionId?, generation? })` 校验批准状态、类型、会话（或显式 global）、期限及所有已绑定维度。人格键应使用完整 `id@version`，而非仅 id；`expectedVersion` 可锁定资源内容版本。绑定了 session/generation 的资源必须精确匹配；省略这些绑定的历史资料可跨 session 复用。旧的无 persona/session 绑定资源仍按原契约解析，不会自动变成版本隔离资源。

来源只允许：受限根目录内的真实文件、明确允许的 HTTPS origin，或安全格式的 gateway id。目录保存定位和治理元数据，不实现下载、生图或业务审核策略。

### 文档表达与 PNG 发布

`createPresentationService({ capabilities, renderer?, publishImage?, select?, nearDistance?, nearAgeMs?, timeoutMs?, maxPending? })` 提供 `availableFormats`、`metrics()` 与 `prepare(request, context)`。request 包含 `body`、可选 `title`、`format: 'auto' | 'text' | 'markdown-image' | 'forward'`、`purpose: 'conversation' | 'document'`、`fallback: 'none' | 'text'`、`reply: 'auto' | 'never' | 'always'` 和 `replyTo: { messageId, distance?, ageMs? }`。context 必须给出 conversationId、OutboundScope、idempotencyKey 和 signal。

body 最大 64 KiB、title 最多 200 个字符串长度单位。省略 format 等同 auto：document 优先选择可用 markdown-image，否则 `body.length > 8000` 时优先选择 forward、其次选择可用 markdown-image，其余选择 text。不可用格式默认拒绝，不自动降级；只有显式 `fallback: 'text'` 才可回退，文本仍须满足消息块长度限制。图片结果最多 6 页；forward 按每节点最多 4000 个 Unicode 码点拆分，并遵守 transport 声明的节点上限（默认 32）。

默认 `nearDistance = 6`、`nearAgeMs = 120000`、`timeoutMs = 15000`、`maxPending = 2`。两项 timing 信息都已知且均不超阈值才算 near；任一超阈值算 far，其余为 uncertain。auto 回复中 near 不引用，far 默认引用，uncertain 无 selector 时不引用；有 selector 时 uncertain 可选择引用。缺少目标不能引用，`never` 禁止引用，`always` 要求明确目标与可引用格式；forward 不引用。timing 由调用方提供，没有自动读聊天记录或模型推断。

`select({ request, available, suggested, replyTiming }, signal)` 可同步或异步返回 `{ format, quote }`，但不能越过可用格式、显式请求、reply 约束或 policy。`prepare` 返回冻结的 `{ format, quote, content, fallbackFrom? }`，不发送。`createPresentationEffect(service)` 把准备操作接成 effect adapter，其 scope 来自可信引擎；capability 名由宿主选择，需单独声明和授权。最终仍由功能调用 `execution.send`，经 send/forward policy 与出站处理；标准 agent-relay 须显式配置 agentMessagePreparation 才会使用该准备流程。

`createMarkdownRenderer({ browser, maxInputBytes?, width?, pageHeight?, maxPages?, maxOutputBytes?, timeoutMs?, maxPending? })` 的 `render({ markdown, title?, signal? })` 返回 PNG 页。必须注入由调用方启动并关闭的 Playwright browser，并在运行环境部署本地中文字体。默认输入（正文加标题 UTF-8）256 KiB、宽 1200、页高 1600、最多 8 页、累计输出 32 MiB、15 秒、最多 2 个真实未结渲染。可配置上限分别为 1 MiB、宽 2048（最小 320）、页高 4096（最小 256）、32 页、64 MiB、120 秒（最小 10 毫秒）、16 个未结渲染；presentation 的 64 KiB/6 页限制仍另外生效。

渲染禁用输入 HTML、页面 JavaScript、下载和 service worker，启用离线 context、CSP 与全部请求拦截；链接和图片转换为文字展示，不联网下载 Markdown 图片或字体。宿主自身的受信任布局测量脚本不属于输入脚本。取消/超时触发 context 关闭，但底层 promise 未结束前不会释放渲染额度；这些限制不等于浏览器进程级沙箱或物理内存硬限额。

`createRenderedAssetPublisher({ registry, directory, maxFiles = 256, maxFileBytes = 20 MiB, maxPending = 4 })` 提供 `publish({ png, width, height, conversationId, scope, idempotencyKey, signal }): Promise<string>` 和 `metrics()`。它仅用于可信文档 renderer：复制并校验 PNG 签名/IHDR/CRC/IEND，单边尺寸最多 8192、总像素最多 16,777,216；文件数最多可配置 10000、单文件 64 MiB、并发待处理数 256。

publisher 用内容哈希命名、版本采用内容哈希；私有 canonical 目录 0700、文件 0600，独占创建并核验完整落盘后才 register/approve。资源默认绑定 conversation 与人格完整版本、不绑 session；通过 registry.get 按标识直接查询脱敏元数据，不扫描整个资源列表。同键变内容、pending/revoked 冲突、symlink/hardlink、文件损坏或配额满均拒绝，不覆盖或复活资源。directory 必须位于 registry 的 rootDirectory 内，registry 的文件上限也同时有效。遗留锁不会自动清理；文件保留与恢复由 operator 管理。

该本地 publisher 是可选的 Linux 文件适配器：Linux 使用 `/proc/self/fd` 锚定目录，其他平台仅尝试 `/dev/fd` 并在无法满足检查时拒绝，不能据此保证跨平台可用。这不是整个框架的 Linux 要求；其他部署可注入自己的受控 publishImage。可信文档 PNG 可由该适配器审批，不意味着 AI 生成图或任意外部图片自动批准。最小装配见 [文档表达](PRESENTATION.md)。

### OneBot 与 DSH

`createOneBotTransport` 支持 `private:<id>` / `group:<id>`，把文本、提及、回复以及经 resolver 解析的图片/音频转换为 OneBot 段。当前不发送 `file` 块；网络异常和无法解释的响应返回 `unknown`。

OneBot 默认不启用 forward。operator 必须显式配置 `forward: { senderId, senderName, group?: true, private?: true }`，并确认目标网关支持 `send_group_forward_msg` / `send_private_forward_msg` 扩展；两种目标分别开关，未开启的目标拒绝。节点 `user_id` 与 `nickname` 只能来自这份可信配置，不能由模型输出人名/QQ 号冒充发送者。`capabilities()` 只描述适配器配置支持，不代表任何会话已获授权或所有目标都已开启。

图片/音频 resolver 接收 assetId、类型、conversationId，以及 scope 中传来的完整人格键、可选 sessionId/generation。旧的无 scope 请求可使用 transport 的 `persona` 配置；若 scope 与显式配置的人格不符则拒绝。`expectedVersion` 是 registry resolve 的可选参数，不由只有 assetId 的消息块自动推断；需要锁版本的宿主应在 resolver 中提供可信预期值。

`createOneBotReceiver` 返回 Node HTTP `RequestListener`，验证原始请求体的 `X-Signature: sha1=…`，再规范化入站消息。宿主负责挂载固定路径、设置 HTTP 超时、提供 `allow` 鉴权和资源登记函数。

`createDshAdapter(client)` 不实现新的 DSH 客户端；它把注入的 `createSession`、`prompt`、`follow`、`cancel` port 转为 `AgentAdapter`，并规范化消息、完成、失败、问题和审批请求。适配器只上报问题/审批事件，不自动批准工具。

已有成熟 DSH SDK 时，先用 `createDshSdkPort({ client, subscribe, createSessionRequest?, cancel? })` 桥接其 sessions、事件订阅和 mux 边界，再把返回 port 交给 `createDshAdapter`；该组合不重新实现底层客户端。

需要直接网络接入时可使用 `createDshJsonRpcPort`。它只连接显式端点，使用有限请求/跟随、明确认证和未知结果语义，不发现其他项目配置。当前 DSH 网络协议不支持直接覆盖 system 指令：必须有完整匹配的可信部署 preset 绑定，否则在联网前拒绝；不把人设和指令偷渡成用户消息。该 port 的导出不等于运行时已启动；CLI 已有显式手动装配，限制与部署副作用见 [DSH 网络适配器](DSH_ADAPTER.md) 和 [适配器管理](ADAPTERS.md)。

需要统一限速时，可把 transport 包装为 `createThrottledTransport({ transport, minIntervalMs?, maxPending? })`；它提供有限全局 FIFO 与协作停机，队列溢出、排队取消和停机取消返回 `rejected`，`unknown` 不会自动重试。

### OneBot HTTP 出站服务

`createOneBotCompatGateway({ store, upstreamEndpoint, upstreamToken?, token, allowedConversations, persona, authorizationVersion?, fetch?, timeoutMs?, maxPending?, maxBodyBytes?, maxSendUses?, grantTtlMs? })` 返回 `{ handle, metrics, close }`。`handle` 只接受认证后的固定 OneBot HTTP read/write action；有目标的请求必须命中 `allowedConversations`。写入保存命令、params、状态与响应，使用 durable outbox；中断或无法确认的结果为 `unknown`，不自动重试。显式 `X-Idempotency-Key` 只能复用于完全相同的 action、target、params 与 persona；未提供时每次请求使用新 key。

写入 params 原样转发，显式 reply/mention/media segment 不由兼容层改写。普通写入校验 `messaging.send` grant，forward 还校验 `messaging.forward`。默认不添加日常服务次数和到期限制；限额与有效期可显式配置。grant 身份包含 persona、conversation 与 `authorizationVersion`：同版本重启沿用已有计数和期限；只有 operator 显式改变版本才创建新代 grant并撤销旧代。修改限额但不改版本会冲突而不是隐式续期。

`loadOneBotGatewayConfiguration` 只读取权限私有、非 symlink 的有限 JSON 文件；token 从独立私有文件读取。`startOneBotGateway` 仅监听 loopback，使用私有 SQLite，提供 Bearer 认证的 `/health`；`scripts/onebot-gateway.ts --health` 还校验配置 revision。该服务处理标准 OneBot HTTP action，不依赖其他桥接项目；它不是聊天 ingress 或 agent session 宿主。完整 action 与配置见 [OneBot 网关](ONEBOT_GATEWAY.md)。

### 业务扩展边界

框架不预设生图接口、服务商、技能或专用配置项。开发者或 AI 按实际使用方式编写独立功能包，通过现有 `FeatureDefinition`、`EffectAdapter`、资源和 policy 机制接入；新增能力不要求修改核心协议。具体生成、检查与回退流程由功能包自行实现，不作为框架契约。允许会话收发消息不等于授予其他副作用权限。

### 管理路由

`createAdminServer` 可接收最多 64 个唯一 `AdminRoute`，每项声明 `GET` 或 `POST`、`/api/...` 路径和 `handle({ query, body, signal })`。扩展不能覆盖内建路由，共用管理认证；POST 另需同源 JSON，请求体默认不超过 32 KiB。可信宿主可为 POST 声明 `maxRequestBytes`（1024–1048576 的安全整数）；先认证再按 UTF-8 字节数检查，包括流式上传，超限返回 `413 / request_too_large`。原生配置文档路由使用 128 KiB 请求上限以容纳 revision、凭据占位与 JSON 转义，持久文档仍限 64 KiB，不改变其他路由限制。

响应默认不超过 256 KiB，可信宿主可逐路由声明 `maxResponseBytes`（1024–4194304 的安全整数），按序列化后 UTF-8 字节数检查，超限返回 `413 / response_too_large`。客户端断开会触发 `signal`。handler 默认期限为 10 秒，可在 10–300000 毫秒内调整；处理期间 socket 空闲期限覆盖 handler 期限及响应余量，不延长收取请求头和正文的期限。GET 超时返回 `504 / handler_timeout`，POST 超时返回 `504 / operation_unknown`，不会自动重试。`dispatchDemo` 可选，未提供时不开放演示事件处理。

配置目录与基本设置 API 对同一规范化文件共用写队列与私有排他锁，持有到 revision 检查、替换与目录同步结束。冲突不会合并旧快照；其他进程持锁返回 `configuration_write_busy`。进程崩溃遗留的 `.<配置文件名>.admin-write.lock` 不自动删除：运维须确认所有使用该配置的管理进程已经停止并核对文件后再移除，不能仅凭锁的年龄判断可重试。

`createHostAdminRoutes(host)` 提供只读 metrics、storage、sessions、tasks、outbox 和 replies 路由。集合列表使用 `limit`（默认 100，最大 1000）与可选 `after`，返回 `{ items, next }`；只暴露现有管理元数据，不返回消息正文，也不提供授权或其他写操作。`GET /api/host/storage` 返回 store.stats 的统计形状；存储未实现 stats 时为 null。它不会清理过期记录、删除 unknown、对账或重试。replies 项仅包含 id、会话/session、generation、request id、期限、状态、更新时间和 cursor。

原生管理资源通过 createNativeRuntimeRoutes({ directory }) 提供，使用框架自己的私有文档和 revision 条件写入，不读取其他项目目录或代理控制台。

- GET/POST /api/chat/plans：方案目录与 activePlanId；方案包含名称、行为指令、模型路由及人设引用。
- GET/POST /api/chat/personas：独立身份和表达风格。
- GET/POST /api/chat/model：当前方案的模型路由，不建立第二份模型配置真源。
- GET/POST /api/chat/providers：集中提供方与模型目录，密钥只写不回显；方案引用与目录变更在同一目录写锁下校验，见 [模型提供方](MODEL_PROVIDERS.md)。
- GET/POST /api/chat/access：独立允许、拒绝与所有者策略；默认拒绝。
- GET /api/chat/status 与 /api/chat/features：报告原生宿主实际装配状态；源码中导出能力不等于 installed。
- 没有原生宿主时，会话/用量返回 runtime_not_connected，不代理第三方桥接项目，也不以零值表示成功。

保存方案不等于外部 DSH 部署或已有会话已更新；工具权限与偏好不进入人设。CAS 冲突、写入未知和未装配应分别处理，不自动重试。

方案的 `contextLimits.group` 与 `contextLimits.private` 分别表示群聊、私聊 token 上限；不表示外部引擎已经执行裁剪，也不能绕过实际模型窗口约束。

### 原生运行时与真实用量

`createNativeChatRuntime({ directory, loadConfiguration, resolveDeployment })` 构造不联网或启动宿主，显式 `start(revisions, signal)` / `stop()` / `status()` / `close()` 控制其生命周期。默认 CLI 管理服务实际挂载该工厂及可信 DSH 文件/网络核验 callback，不是仅导出未接线的能力。内部创建 SQLite、bridge host、sessions/outbox/history/tasks/persistent policy、OneBot normalizer/transport 与 DSH port/adapter。

启动 API `POST /api/chat/runtime/start` 的 body 为 `{revisions:{plans,personas,access,adapters,providers,authorization,deployment}}`，七键均为当前内容 hash，不接受自动读取旧值后重试。stop 接收 `{}`。status 分开报告 protocolConnected 与 chatReady；configurationIssues/canStart 用于准备阶段，missingReasons 还包含未启动等运行诊断。modelExecutionVerified 始终 false，不能把配置/身份核验当成付费推理验收。HTTP 启动身份响应必须与共享 OneBot 分类一致：只有 `status:ok` 且 `retcode:0` 及匹配的已验证 self id 才成功。

`GET/POST /api/chat/authorization` 为独立 revision 文档，记录 version 与每会话 submitUses/sendUses/绝对 expiresAt；每次调用仍走 agent-relay 的 agent.submit/messaging.send policy。允许名单和 owner 不能创建 grant。version 使用后同版内容变更冲突，重启不续额、不续期。已有 session 定义或绑定变化时拒绝，不自动重置；unknown 不重放。内部 core persona 的 hash 映射不改变原生目录标识或权限作用域。

`GET/POST /api/chat/deployment` 管理明确 target（profilePath、credentialsPath、可选有序 layerPaths、schemaVersion）、modelSettings 与 namespace；不接受 operator 自报 loaded 的 snapshot。prepare/reconcile 接收同一七键 revisions；apply **额外且仅额外**要求前次预览的 targetRevision 64 位 hash。真实文件 CAS、备份、配置/官方 file 凭据来源和只读加载核验成功才生成配置就绪 binding，pending_reload 不等于 ready；没有自动连接、模型调用、加载代码或服务重启。官方只读 API 没有实际所用密钥值身份回执，因此运行时明确 credentialValueIdentityVerified:false，不把本地值相符制造成外部运行时密钥相等的证据。

`stream/error` 通过 failed.data.terminal=true 标识终止流，宿主立即使缓存 follow 失效并取消旧订阅。下一条新消息须成功建立新 follow 后才能 submit；不重新提交旧 prompt，迟到旧流不能发消息。authorizeIncoming 只有字面 true 才通过，非法 truthy 在 history/session/agent/transport 之前拒绝。

`createNativeUsage({store,clock?,maxScan?})` 在 native-usage 命名空间持久化已观察终态 turn 的逐步 token、覆盖状态及价格快照，按 conversation/session/generation/turn/step 去重；同标识不同数据冲突。input 是未命中缓存输入，cacheRead/cacheWrite 单列，reasoning 只是 output 中可选子项，不重复相加；缺失 total/cost 不推算，不补零。单次扫描默认 10000，饱和明确 partial，不能把扫描页当总账。

完整页面 HTTP 投影由 `createNativeUsageProjection` 提供并标记 native:true：usage 汇总、series?hours&buckets 走势、turns?key 会话逐轮、recent 最近流水与固定价目。保留成熟页面结构，未知字段为 null，knownTokens/missingTokens/knownCosts 单列；多币种不相加，高峰/空闲不凭空推断，固定价目为 flat。会话 API 同时提供页面 sessions/revision 和原生 items/next；未装配时仍 503，不伪造空成功。

用量价目 GET/POST `/api/chat/usage/pricing` 为 `{revision:number|null,prices:[{provider,model,currency,inputPerMillion,outputPerMillion,cacheReadPerMillion,cacheWritePerMillion}]}`，使用 SQLite 自身 CAS；旧记录不随调价追溯重算。价格只来自 operator，不发现生产凭据或查询付费服务。冲突返回409 usage_pricing_revision_conflict，未知写入返回500 usage_pricing_operation_unknown，禁止自动重试。当前 session/usage reset 为禁用，不删除 unknown。

这些统计只覆盖 observed-terminal-turns-only，不代表服务商全部账单；进程失联前尚未收到终态的模型工作不能被补成零。当前执行等待仍为原生外部请求5秒、宿主边界6秒、回复watchdog30秒且关闭通知；watchdog不取消外部工作，stop也不证明已经接受的模型工作被取消。可配置默认60秒 turn 策略、通知、协作取消、未知隔离和迟到归因属于下一阶段，现有七键 API 尚未增加第八个 execution revision。替身测试和流恢复修复不构成该长期卡住问题已经彻底解决的证据。
