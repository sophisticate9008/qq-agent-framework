# 独立 DSH 网络 Client Port

`src/adapters/dsh-jsonrpc.ts` 提供真正的 HTTP/WebSocket 客户端，返回 `DshClientPort`，可交给 `createDshAdapter`。它不启动 DSH、不读取本机配置或凭据、不访问其他桥接项目、不接管理控制台，也不装配 native host。保存适配器配置不代表此客户端或聊天链路已经运行。

本次只交付独立 client port、假服务测试和能力文档：**未为 production 建立或验证 presetBindings，未装配 native host，未部署或创建真实会话**。

## 已核对的协议

核对基线是 DeepSeek 官方发布包 `0.2.1-rc.2` 的 `dsh-client-connection`、`dsh-api-session-controller`、`dsh-api-gateway` 及 `dsh-sdk-jsonrpc-server`。

这是 Connection/Typert Remote 网络协议，**不是** stdio SDK 的 JSON-RPC 2.0 行协议。`dsh-sdk-jsonrpc-server` 的 `initialize`、`session/prompt` 等方法不能替代网络端的会话创建、取消和跟随。

| 操作 | 固定端点 | request 字段 |
| --- | --- | --- |
| 创建 | `POST <endpoint>/api/session/create` | 本实现只发送 `{ agentPreset }` |
| 模型选择 | `POST <endpoint>/api/session/selectModel` | `{ sessionId, provider, model, reasoningEffort }` |
| 用户消息 | `POST <endpoint>/api/session/prompt` | `{ sessionId, requestId, mode: 'queue', content }` |
| 协作取消 | `POST <endpoint>/api/session/cancel` | `{ sessionId }` |
| 跟随 | WebSocket `<endpoint>/api/remote.mux` | `session/follow` 逻辑流 |

HTTP 请求包是 `{ type: 'client-request', rpcId, method, payload: { args: { request } } }`。响应必须是同一 `rpcId` 的 `{ type: 'server-response', rpcId, result: { ok, value? , error? } }`；不接受任意 RPC 方法、路径或其他上游模型 URL。

跟随的打开包为 `{ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId } } } } }`；停止发送 `{ type: 'cancel', streamId }` 并关闭物理连接。每次 follow 使用独立 socket 和 streamId，不做隐式重连。

官方客户端源码入口：[Connection](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/client/connection)、[Session Controller](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/api/session-controller)、[Gateway](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/api/gateway)。本地安装的发布源码是本次核对依据；主分支以后可能变化，不承诺其他版本兼容。

## 认证与依赖

需要运行依赖 `ws@8.22.0`，类型依赖 `@types/ws@8.18.2`。Node 的浏览器兼容 global WebSocket 不能通过标准构造器传入 Cookie 请求头，因此这里使用 `ws`，而非把凭据放入 WebSocket URL。[Node 文档](https://nodejs.org/api/globals.html#class-websocket)、[ws API](https://github.com/websockets/ws/blob/master/doc/ws.md#new-websocketaddress-protocols-options)。

`endpoint` 必须由可信宿主显式传入，允许 HTTPS 或回环 HTTP，允许显式挂载路径；禁止 URL 用户名、密码、query 和 fragment。客户端只在此固定挂载下通信，禁止自动跟随 HTTP/WebSocket 重定向。

`auth` 必须是 1–4096 字节的无空格可打印 ASCII：

- 无前缀：显式 launch token。调用 `GET <endpoint>/connect?token=<encoded>&interactions=none`，只接受返回本挂载 `api/remote.mux` 的 `302` 和一个 Set-Cookie；不实际跟随重定向。之后的 HTTP 和 WebSocket 均携带该 operator Cookie。token exchange 允许并发复用，但不在会话请求失败后自动重新认证或重放请求。
- `cookie:<name>=<value>`：显式、已签发的 operator cookie；不进行 token exchange。只接受单一安全格式 cookie pair，不接受任意 header 列表。

这不是 Bearer 认证。客户端不请求 `interactions=answer`、不回答问题、不批准工具、不替宿主扩大权限。launch token 在官方 exchange 协议中必然进入该请求 query；部署者必须禁止代理/access log 记录该 query。客户端本身无请求日志，错误不包含 URL、凭据、原始远端错误或消息正文。浏览器 cookie 与 API operator cookie 权限不同，宿主须提供正确的 operator 凭据。

## Factory 与聊天方案

```ts
createDshJsonRpcPort({
  endpoint,
  auth,
  sessionDefinition,
  presetBindings: [{ agentPreset: 'deployed-preset-id', definition: sessionDefinition }],
  timeoutMs: 60_000,
  followIdleTimeoutMs: 300_000,
  maxPendingEvents: 64,
  maxFollows: 16,
})
```

返回值是 `DshClientPort & { close(): Promise<void> }`。`sessionDefinition` 可为 `ChatSessionDefinition`，或同步的 `(request: DshCreateSessionRequest) => ChatSessionDefinition`；resolver 是可信宿主代码，不是模型工具。固定定义与 preset bindings 在创建 port 时校验并复制；resolver 在每次创建会话前重新执行。

**原生 session/create 不支持直接覆盖系统指令。** 精确请求结构仅有 `workspaceId?`、`cwd?`、`sessionId?`、`agentPreset?`；没有 `systemPrompt`、`instructions`、`agentOptions` 或模型字段。

因此 `presetBindings` 是可信宿主对**已在外部 DSH 部署的 preset**的显式声明：其 definition 必须逐项匹配当前 `ChatSessionDefinition` 的 planId、personaId、instructions、persona.identity、persona.style、model.provider、model.name 和 reasoningEffort。绑定最多128个，preset标识不得重复。本实现将匹配项的 `agentPreset` 交给原生创建 API，并核对返回 preset；不会把指令、人设混进用户消息，不尝试部署 preset 或写 DSH 文件。

- 没有 definition：`{ ok: false, error: { code: 'DSH_SESSION_DEFINITION_REQUIRED' } }`。
- 没有精确 preset 绑定：`{ ok: false, error: { code: 'DSH_INSTRUCTIONS_UNSUPPORTED' } }`，且不发生网络调用。
- 匹配成功：先创建，再 `selectModel`，映射 `model.provider → provider`、`model.name → model`、`model.reasoningEffort → reasoningEffort`，要求返回模型选择精确匹配；不猜测 off/max 等值的替代语义。
- 已创建后 preset/模型不匹配、选择失败或响应丢失：抛出结果未知错误，不宣称“安全拒绝”，不创建替代会话或自动删除已创建会话。

**验证缺口：** 网络 API 无法读取并证明 preset 的系统指令与宿主声明一致。本客户端只能核对 preset id 与模型选择；绑定内容必须由部署方独立核验。未完成该核验不能声称完整聊天方案已忠实应用。现有会话不会随方案保存自动更新。

**官方副作用：** `session/selectModel` 除安装会话模型外，还会后台保存 DSH 部署默认模型。本客户端没有原子“创建并配置”接口；这两个请求之间不提交用户消息，但配置失败可能留下空会话。`createSession.requestId` 没有可忠实映射的官方创建幂等字段；不把它冒充幂等保证，也不自动重试创建。

## 限界、恢复与能力

- unary/auth/握手/首个 snapshot/每个事件 callback 的期限默认 60 秒，范围 1–300000 毫秒；follow 有效事件空闲期限默认 5 分钟，范围 1–3600000 毫秒。安静会话也可能因空闲关闭，宿主必须显式决定是否重新 follow。
- 最多 32 个在途 unary 请求、16 个 follow（可配置 1–128）、每 follow 最多 64 个排队事件（可配置 1–1024），另有一个执行中的 callback。HTTP 响应和 WebSocket 单帧最多 1 MiB，不启用 WebSocket 压缩。
- callback 串行；达到排队限额、callback 拒绝/超时、流结束、序号跳跃或坏帧均终止该流，尽可能报告脱敏 `stream/error`，不静默丢掉新事件继续运行。已经开始的 callback 无法被 JavaScript 强制撤销；未实际结束的 callback 仍占全局有限容量，不通过超时释放槽来累积无限 raw 工作。宿主 callback 必须自身支持有界执行。
- 首个 snapshot 必须属于请求 session；snapshot 的 cursor 是**包含式水位**（空日志可为 -1），仅跟随 cursor 之后的 durable events。历史记录不重放、不发送历史助手消息；每次 follow 更换 streamId，过滤其他流、重复/过期序号，严格检查连续性。结束后不再启动旧流的新 callback。
- 当前实现仅支持纯文本 prompt；assetId 不是 DSH attachment，也不是路径或 URL，媒体、转发、引用等未经资源适配的块明确拒绝。未订阅 `$events` 的问题/审批请求，也不接 process-local assistant chunks；只报告 durable session events，不假装具备交互响应能力。
- `cancel` 只是官方 `accepted: true` 的协作取消收据，不是 agent 已停止的证明。HTTP 失败、超时、错误 correlation、内部/未知远端错误保持 unknown；仅有限的已知前置业务拒绝转为 `ok:false`。不将未知结果转换为可安全重试。
- `close()` 取消本 port 的网络生命周期和所有跟随，不关闭外部 DSH、不重置/删除会话。Abort/close 不回滚已被 DSH 接受的动作。

## 验证

`test/dsh-jsonrpc.test.ts` 使用本机临时 HTTP/WebSocket fake 服务，覆盖官方字段/认证交换、挂载路径、模型映射、无绑定拒绝、坏响应/未知结果、超时/abort、快照水位、迟到/重复事件、序号跳跃、背压与清理。没有调用真实 DSH，没有创建真实 session，没有调用模型或发送 QQ。

安装上述依赖后，定向执行 `node --test test/dsh-jsonrpc.test.ts test/dsh.test.ts`。测试通过仅证明客户端与已核对 wire contract 的假服务兼容；不等于已经验证某个运行中 DSH 的兼容性、外部 preset 内容或生产长连恢复。
