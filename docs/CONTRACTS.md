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

需要统一限速时，可把 transport 包装为 `createThrottledTransport({ transport, minIntervalMs?, maxPending? })`；它提供有限全局 FIFO 与协作停机，队列溢出、排队取消和停机取消返回 `rejected`，`unknown` 不会自动重试。

### 旧 OneBot HTTP egress 兼容服务

`createOneBotCompatGateway({ store, upstreamEndpoint, upstreamToken?, token, allowedConversations, persona, authorizationVersion?, fetch?, timeoutMs?, maxPending?, maxBodyBytes?, maxSendUses?, grantTtlMs? })` 返回 `{ handle, metrics, close }`。`handle` 只接受认证后的固定 OneBot HTTP read/write action；有目标的请求必须命中 `allowedConversations`。写入保存命令、params、状态与响应，使用 durable outbox；中断或无法确认的结果为 `unknown`，不自动重试。显式 `X-Idempotency-Key` 只能复用于完全相同的 action、target、params 与 persona；未提供时每次请求使用新 key。

写入 params 原样转发，显式 reply/mention/media segment 不由兼容层改写。普通写入校验 `messaging.send` grant，forward 还校验 `messaging.forward`。默认不添加日常服务次数和到期限制；限额与有效期可显式配置。grant 身份包含 persona、conversation 与 `authorizationVersion`：同版本重启沿用已有计数和期限；只有 operator 显式改变版本才创建新代 grant并撤销旧代。修改限额但不改版本会冲突而不是隐式续期。

`loadOneBotGatewayConfiguration` 只读取权限私有、非 symlink 的有限 JSON 文件；token 从独立私有文件读取。`startOneBotGateway` 仅监听 loopback，使用私有 SQLite，提供 Bearer 认证的 `/health`；`scripts/onebot-gateway.ts --health` 还校验配置 revision。该服务只代理旧 HTTP egress，不接管旧 OneBot WS、DSH session 或插件。完整 action、配置、接入与回退合同见 [旧 OneBot HTTP 出站兼容网关](LEGACY_GATEWAY.md)。

### 图片生成与自我表达服务

`createImageGenerationAdapter({ endpoint, authentication, publishImage, resolveWorkerReference?, fetch?, timeoutMs?, pollIntervalMs?, maxConcurrent?, maxPending?, maxImageBytes? })` 提供 `generate(input, context)` 与 `metrics()`。input 支持无 reference 的 `generate`，或使用 1–4 个受控 reference asset 的 `edit`；context 必须包含 conversation、可信 `OutboundScope`、幂等键和取消信号。job id 由 conversation 与幂等键稳定生成。worker dispatch 后的超时/网络异常以及发布结果不确定均为 `unknown`，不得自动重新提交。`publishImage` 必须返回受控 assetId；adapter 不直接发送消息。

`createImageGenerationEffect(adapter)` 只把 effect 的可信 scope 和稳定请求指纹接入 adapter，不创建权限，也不判断 owner 或普通群友。会话被 transport allowlist 允许，不等于获得通用画图 capability；业务来源授权必须由 composition 单独提供。

`createSelfExpressionService({ imagePack, generate, check, discard, chooseHistory, random?, timeoutMs?, maxPending?, maxHistoryCandidates? })` 编排最多两次候选生成/检查，并可回退到相同 image-pack 版本、相同 conversation/persona、候选已声明的 session/generation 也匹配且已批准的历史 asset。它返回 selected/none，不发送消息；callback 的 rejected/unknown 保持显式。`createSelfExpressionEffect(service)` 只接入可信 persona/conversation/session/generation scope。

自我表达服务不读取聊天上下文、不验证真实 source message、不识别自拍语境、不自带 identity manifest，也不代表候选已在线上复检。真实自拍业务仍需 composition 提供身份资源、语境与来源授权、生成、检查、丢弃、历史、发布和发送 callback。

### 管理路由

`createAdminServer` 可接收最多 64 个唯一 `AdminRoute`，每项声明 `GET` 或 `POST`、`/api/...` 路径和 `handle({ query, body, signal })`。扩展不能覆盖内建路由，共用管理认证；POST 另需同源 JSON 且请求体不超过 32 KiB。响应默认不超过 256 KiB，可信宿主可逐路由声明 `maxResponseBytes`（1024–4194304 的安全整数），按序列化后 UTF-8 字节数检查，超限返回 `413 / response_too_large`，不改变其他路由的限制。客户端断开会触发 `signal`。handler 默认期限为 10 秒，可在 10–300000 毫秒内调整；GET 超时返回 `504 / handler_timeout`，POST 超时返回 `504 / operation_unknown`，不会自动重试。`dispatchDemo` 可选，未提供时不开放演示事件处理。

`createHostAdminRoutes(host)` 提供只读 metrics、storage、sessions、tasks、outbox 和 replies 路由。集合列表使用 `limit`（默认 100，最大 1000）与可选 `after`，返回 `{ items, next }`；只暴露现有管理元数据，不返回消息正文，也不提供授权或其他写操作。`GET /api/host/storage` 返回 store.stats 的统计形状；存储未实现 stats 时为 null。它不会清理过期记录、删除 unknown、对账或重试。replies 项仅包含 id、会话/session、generation、request id、期限、状态、更新时间和 cursor。

显式接入聊天后端的 `createLegacyAdminRoutes({ legacyRoot, fetch?, timeoutMs?, beforeAccessSave? })` 使用固定回环管理端点，不接受浏览器提供上游地址或凭据。用量接口均受管理认证保护，查询参数拒绝重复键和未知键，响应按白名单解析，不返回账本文件路径或凭据：

| 路由 | 查询 / 请求体 | 响应范围 |
| --- | --- | --- |
| `GET /api/legacy/usage` | `limit=200`，1–500 | 全局累计、会话汇总、revision、可选价目与账本统计；最多 2 MiB。 |
| `GET /api/legacy/usage/series` | `hours=24`，1–2160；`buckets=48`，6–120 | 实际时间桶、窗口总量与图外历史；最多 1 MiB。buckets 是桶数上限，不保证恰好返回该数量。 |
| `GET /api/legacy/usage/turns` | 必填 `key`；`limit=200`，1–1000 | 指定会话的累计与可追溯轮次；最多 4 MiB。无对应会话返回 404。 |
| `GET /api/legacy/usage/recent` | `limit=40`，1–500 | 保留的最近调用样本；最多 2 MiB。 |
| `POST /api/legacy/usage/reset` | `{ revision, confirm: '清空用量账本' }` | 发起前版本预检；受理后返回 `{ ok: true, resetAccepted: true }`。 |

summary 缺少整块价目或账本元数据时，`unavailable` 标明 `pricing` / `ledger`，不补造配置；部分提供但不合法的块拒绝。`revision` 覆盖全局累计、价目配置和可用账本统计，不包含分页列表、生成时间或当前价档。累计投影与保留样本不一定可加和，不能要求逐轮已归属费用与仅累计历史之和恰好等于权威累计。所有费用均为价目表估算，不是平台账单。reset 预检不能提供跨进程原子删除保证，预检后的并发记录仍可能被清空；冲突不调用清空，写入结果不明返回 `usage_reset_unknown`，不自动重试。受理不证明旧后端文件持久截断成功。

`startGatewayAdmin(configuration)` 提供真实 HTTP 网关的管理 UI。私有配置的 `host`、`port`、`tokenFile`、`gatewayConfiguration` 分别控制监听、独立认证和数据源。它通过精确 revision 的 authenticated gateway health 与只读 get_status 获取状态，不打开生产 SQLite、不创建演示会话，不提供消息发送或授权创建操作；配置管理和可选聊天后端管理通过受控路由接入。UI 使用同源相对 API，管理员凭据只用于登录，访问会话由有限有效期的 HttpOnly cookie 保持，退出撤销；正式网关模式隐藏演示控件。监听非回环地址必须由部署方显式配置，HTTP 不提供链路加密。初始化、令牌与各管理操作的边界见 [管理界面教程](GATEWAY_ADMIN.md)。

### Bridge host

`createBridgeHost({ store, agent, transport, context, persona, authorizeIncoming, routeIncoming?, agentMessagePreparation?, model?, observer?, eventValidators?, effectAdapters?, clock?, taskTickMs?, maxConcurrentSends?, eventTimeoutMs?, timeouts?, replyTimeoutMs?, replyTimeoutNotice?, selectAgentMessage?, onFault? })` 组装持久 policy、功能状态、会话、出站、任务、首回复监视和会话历史，并安装内置 `agent-relay` 功能。

扩展只由可信装配根注入。eventValidators 必须同步严格返回 true；effect adapter 通过执行 SDK 受 capability/policy 约束，model 仍需 model.respond 授权。禁止覆盖内置 message.received/trigger.fired、messaging.send/messaging.forward/model.respond，以及全部 agent.* 事件或 capability；重复名称不是替换机制。observer 接收脱敏 AuditRecord，其异常被隔离，不是 veto 或授权回调。注册表不能通过普通消息或模型输出修改。

返回对象公开 `engine`、`policy`、`sessions`、`outbox`、`tasks`、`history`、`replies`，以及：

- `receive(message)`：接收协议层已认证、规范化的 `InboundMessage`，先执行 `authorizeIncoming`，再持久去重并投递。
- `start()`：恢复中断状态、已有 session follow 和到期任务；整体超时会正常返回并把启动状态标为 `degraded`。
- `metrics()`：返回轻量宿主与引擎计数，包括 `startupState`、超时次数和最后故障码。
- `storageStats(options?)`：转交可选 store.stats，未提供时返回 null，只读。
- `stop()`：停止新工作、取消 follow 并排空任务和引擎副作用。

宿主不会自动创建 grant。转发一个会话前，操作者必须显式给 `agent-relay` 授予该会话的 `agent.submit` 与 `messaging.send` 有限预算。只有定向且非自身的入站消息会提交给 agent；prompt 必须返回 `accepted`。agent 事件先以稳定映射、单调序号和 `deadlineAt` 持久登记，再进入同 TTL 的任务；旧 session/generation、重复事件或排队期间已过期事件不会发送。

配置 routeIncoming 时，入站先通过 authorizeIncoming，再同步路由，成功后才写历史并广播一次 message.received；路由异常则拒绝，不能把 Promise 当作命中。内置 relay 还要求 routing.relayToAgent 为 true；未配置路由则保留既有 directed/isSelf 行为。agent 输出包含 forward 时还需单独授予 agent-relay 的 messaging.forward。

`createMessageRouter({ rules, defaultRoute })` 接受最多 256 条 `{ id, priority, route, relayToAgent, selector }` 同步规则，id 唯一、priority 为安全整数，值越大优先。selector 只接收脱离原对象的冻结规范消息并严格返回 boolean。最高匹配优先级多命中返回 ROUTING_CONFLICT，selector 抛错/异步或非 boolean 也拒绝；未命中用显式 defaultRoute，不依赖功能安装顺序。决策仅含冻结的 `{ route, ruleId, relayToAgent, reasonCode }`，reasonCode 为 ROUTING_RULE_MATCHED 或 ROUTING_DEFAULT，不带授权或正文。

`withMessageRoute(feature, route)` 仅在 message.received 上按 event.data.routing.route 过滤该功能的处理器，其他订阅照常执行；未包装的旁观者仍收到广播。它不让事件变为单播，也不保证多个绑定同一 route 的响应功能互斥。createRoutedMessageEvent 与 routedMessageRelaysToAgent 为可信 host 的纯辅助件，不能把普通入站自报的 routing 当成授权。NLU/模型意图识别由上层提供规则或数据，不内置于路由器。

`message` 事件可以进入受 policy 约束的持久出站；`question` 和 `approval` 仅作为事件记录，不会自动回答问题或批准工具。启动恢复把遗留 `processing` 入站、`running` 任务和未决发送标为 `unknown`，不会自动重放。

`selectAgentMessage(event, binding)` 是可选同步挂载点，可根据包含原始 `data` 的 `AgentEvent` 返回待发送 `MessageContent[]`，或返回 `null` 跳过出站且不消耗发送预算；未配置时普通 message 按默认 relay。框架不假定每个 `assistant/message` 都表示 turn 完成或都适合公开发送，operator 应按所接 SDK 的事件语义显式过滤内部工作文本，而不是依赖内置人格或工具隐藏规则。

`agentMessagePreparation` 是另一个可选挂载点：`{ capabilities: readonly string[], prepare(execution, event) }`。额外 capability 列表最多 32 项且不可重复，合并到内置 agent-relay manifest，但不会创建 grant。prepare 在引擎的 agent.message 处理器内执行，可同步或异步返回规范内容或 null；null 不发送、不消耗发送预算，也不产生 confirmed 首回复。返回内容仍走原有 execution.send、policy 与持久 outbox；异常不会偷偷退回原消息发送。

hook 的 execution 只含 `context`、`signal`、`invoke`、`generate`，没有 send、state 或 store 句柄。通过 invoke('presentation.prepare', …) 或 generate 调用的准备/选择工作仍受各自 capability 声明及授权约束；没有额外授权不会启动相应 renderer/model。可信 hook 应使用这些受控入口，不在闭包中绕开 policy 直调渲染器。只有配置 hook 时，原 AgentEvent.data 才随 message 进入 event.data.agentData（缺失时为空对象）；它是待校验的 metadata，不是权限或自动可公开内容。框架不内置 Markdown、DSH 字段规则或 NLU；未配置 hook 时保留原 relay，配置后可对普通格式原样返回 event.data.content。最小接线见 [文档表达](PRESENTATION.md)。

`timeouts` 的 `createSessionMs`、`followMs`、`submitMs`、`sendMs`、`authorizeMs`、`startMs` 均允许 10–300000 毫秒，默认依次为 10 秒、10 秒、10 秒、10 秒、3 秒和 15 秒。授权超时返回 `rejected / INBOUND_AUTH_TIMEOUT` 且不写历史；真实未结 authorization promise 最多保留 256 个，超时不释放其占用，满载时新入站快速返回 `rejected / INBOUND_BACKPRESSURE`，实际 callback settle 后才释放，当前数量见 `metrics.unsettledAuthorizations`。create/follow 未决采用保守 `unknown`，submit 返回 `unknown`，send 持久记录为 `unknown`，这些结果都不会自动重试。迟到的 follow setup 会执行 disposer，迟到 frame 会被过滤。

宿主 bounded agent 与 transport 默认各最多保留 16 个尚未结束的底层 promise。期限到达只让上层有限返回，不代表底层已结束；迟到 promise 继续占用该上限，满载后新调用快速返回保守背压结果，而不是继续无界堆积。

agent prompt 返回 `accepted` 后，宿主默认等待 30 秒内出现该会话首条 confirmed assistant 消息；`replyTimeoutMs` 可在 10–300000 毫秒内调整。等待记录持久化，更多入站不会延长当前期限，启动会恢复仍在等待的 timer，正常 confirmed 回复会清除它。超时只把记录标为 `timed-out`，增加 metrics 并上报 `AGENT_REPLY_TIMEOUT`；不会取消或重新提交 agent 工作。

`replyTimeoutNotice` 默认是中性状态说明，可改为有界字符串或 `null`。非空时，独立 watchdog 通过 `agent.reply-timeout` 和既有 `agent-relay / messaging.send` 授权尝试发送一次，不绕过撤销或预算，也不把超时表述为任务完成或失败。等待状态为 `waiting`、`responded`、`timed-out` 或 `responded-late`。当前 agent message 不携带原 prompt request id，因此 `responded-late` 只表示活动会话在超时后出现 confirmed assistant 消息，不能可靠归因所有迟到远程任务已经完成；该消息仍按普通 agent 消息处理。

上述实现尚需针对具体 QQ 网关、DSH client、持久目录和故障场景做集成验收；公共接口存在不代表生产部署已经通过。

候选 release 的分阶段激活/失败回滚、业务状态 schema 迁移、可关联和恢复的长 job 控制面，以及跨任务/出站/资源的 retention 与容量治理仍不完整。只读 stats、calendar occurrence TTL 或准备文档图片，均不能代替这些能力的端到端验收。
