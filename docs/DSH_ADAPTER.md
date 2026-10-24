# 独立 DSH 网络 Client Port

`src/adapters/dsh-jsonrpc.ts` 提供真正的 HTTP/WebSocket 客户端，返回 `DshClientPort`，可交给 `createDshAdapter`。纯 port 不启动 DSH、不读取本机配置或凭据、不访问其他桥接项目，也不自行装配 native host；CLI 默认原生宿主使用此 port，由 operator 显式启动聊天。保存适配器配置不代表客户端或聊天链路已经运行。

独立部署规划器 `src/adapters/dsh-deployment.ts` 与安全 profile 回调 `src/adapters/dsh-profile-deployment.ts` 供原生管理宿主使用。保存提供方或目标配置不等于部署；仅明确选择目标、预览并确认 apply 才写入目标文件，不自动重启 DSH。

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

返回值是 `DshJsonRpcPort`（含 `DshClientPort`、`verify`、`inspectDeployment` 与 `close`）。`sessionDefinition` 可为 `ChatSessionDefinition`，或同步的 `(request: DshCreateSessionRequest) => ChatSessionDefinition`；resolver 是可信宿主代码，不是模型工具。固定定义与 preset bindings 在创建 port 时校验并复制；resolver 在每次创建会话前重新执行。

**原生 session/create 不支持直接覆盖系统指令。** 精确请求结构仅有 `workspaceId?`、`cwd?`、`sessionId?`、`agentPreset?`；没有 `systemPrompt`、`instructions`、`agentOptions` 或模型字段。

因此 `presetBindings` 是可信宿主对**已在外部 DSH 部署的 preset**的显式声明：其 definition 必须逐项匹配当前 `ChatSessionDefinition` 的 planId、personaId、instructions、persona.identity、persona.style、model.provider、model.name 和 reasoningEffort。绑定最多128个，preset标识不得重复。本实现将匹配项的 `agentPreset` 交给原生创建 API，并核对返回 preset；不会把指令、人设混进用户消息，不尝试部署 preset 或写 DSH 文件。

- 没有 definition：`{ ok: false, error: { code: 'DSH_SESSION_DEFINITION_REQUIRED' } }`。
- 没有精确 preset 绑定：`{ ok: false, error: { code: 'DSH_INSTRUCTIONS_UNSUPPORTED' } }`，且不发生网络调用。
- 匹配成功：先创建，再 `selectModel`，映射 `model.provider → provider`、`model.name → model`、`model.reasoningEffort → reasoningEffort`，要求返回模型选择精确匹配；不猜测 off/max 等值的替代语义。
- 已创建后 preset/模型不匹配、选择失败或响应丢失：抛出结果未知错误，不宣称“安全拒绝”，不创建替代会话或自动删除已创建会话。

**创建 API 的验证缺口：** 仅 `session/create/selectModel` 不能读取 preset 的系统指令。本 port 的会话创建流程只核对 preset id 与模型选择；绑定内容必须由部署方另行核验，不能把“创建成功”当作完整方案已忠实应用。现有会话不会随方案保存自动更新。

独立部署回调通过官方 `agentPresets/read` 读取原始组合 YAML，并与本地生成的完整 persona/plugins 严格比较，补充上述 port 本身不做的核验。它同时读取 provider 设置和 credential 配置状态；不会把 operator 手填的 `loaded`、snapshot 或绑定当作实际部署证据。

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

## 显式部署与准备

`prepareDshDeployment(input)` 是无副作用规划器；`createNativeDshDeploymentRuntime()` 是实际文件和只读网络核验实现，符合 `NativeChatDeploymentRuntime`，供管理宿主装配。后者不依赖其他桥接项目、其 runtime、控制台、环境配置或凭据发现。

管理配置必须显式选择：

- `target.profilePath`：绝对、规范化的 `cordis.patch.yml` 文件路径。
- `target.credentialsPath`：该独立 DSH 的 credentials-local 实际文档路径；不从 profile 路径猜 home。
- `target.layerPaths`：所选 profile **之前**实际生效的 bundle patch 文件，按官方顺序排列；不执行依赖、插件或表达式来发现这些文件。缺少必要 base 声明时返回 `dsh_explicit_layers_required`。
- `target.schemaVersion: '0.2.1-rc.2'`、`modelSettings.contextWindow/maxTokens/reasoningEfforts` 和短 `namespace`。窗口能力必须由 operator 核实；目录里的模型名并不证明模型能力。

`prepare` 只读并返回 `state`、`targetRevision`、`summary.missingReasons`、可选群/私聊 preset 元数据及 `preview`。预览只含新 provider routes、persona/preset 组合和 credential **引用名**；不含密钥或继承配置中的秘密。默认 API 不接受手写隐藏绑定。

`apply(configuration, signal, targetRevision)` 要求同一实例已有当前配置的预览，且提交其精确 revision；管理路由还检查原生配置的完整 revisions。再次预览、配置变化或文件 CAS 冲突需要重新确认，不能自动重试。底层 `DshDeploymentApply` 的私有 proposal 才含密钥，只能交给可信宿主部署代码，不能返回浏览器。

实际应用步骤：

1. 拒绝 symlink/hardlink、非普通文件、过大文档、可被其他用户写入的目标目录；credentials 已存在时必须 owner-only。显式目录必须已存在，不自动创建或发现安装位置。
2. 使用 `yaml@2.9.1` AST，限制字节/节点/深度，拒绝别名、重复键、不支持标签、merge key 和危险对象键。`!!js` 仅作不透明文本保留，绝不执行；provider config 自身依赖动态表达式时明确拒绝。
3. 按官方插入/整行 config 替换语义合成所选层；复制整个有效 provider config 再只增加本任务新 routes，保留其他 providers/presets。未知 group 整体替换等未支持语义拒绝，不靠猜测继续。
4. 获取与官方写者兼容的 `<profile目录>/package.json.lock` 和 `<credentialsPath>.lock`，用 `wx`、`0600` 与 PID 记录；对 profile、credentials 和全部所选层重新进行内容 CAS。
5. 为两个目标文件保存 `0600` 的 `.qqaf-backup-<backupId>`；原来不存在的文件以 `.absent` 标记。只在显式 apply 创建缺失 profile/credentials，不在预览创建；credentials 使用官方 `version: 1 / refs` 格式并保留 records/其他字段。
6. 先写 credentials、后写 profile；同目录独占临时文件、fsync、原子 rename 和目录 fsync。**这不是两个文件的原子事务**；中断或部分失败返回 unknown 并保留备份，不自动回滚或删除外部会话。与不遵守官方锁的外部编辑器之间没有无条件 CAS 保证。
7. 读回文件，向所选 DSH 的固定只读 API 核验实际加载状态；不创建 session，不 prompt/selectModel，不调用模型、不重启。

文件备份包含秘密，operator 必须按私有凭据管理；不存在自动清理/恢复按钮。孤立锁不会被本实现猜测为失效后删除，需停写后人工检查。恢复 `.absent` 记录表示原目标应不存在；已有文件的备份保存原字节，不要把凭据备份放入公开目录。

### 实际映射及限制

原生 provider id 是目录身份，不是 DSH provider route。规划器为群/私聊分别生成外部 route/preset，绑定保留原始 `ChatSessionDefinition`，由 `DshPresetBinding.externalProvider/conversationKind` 映射实际 `selectModel`。模型窗口分别取 `contextLimits.group/private`，并使用隔离的自动 compaction；这是容量/压力配置，不是逐条消息的精确硬裁剪承诺。模型最大输出须小于两个窗口且不得超过已核实能力。

OpenAI 类型当前明确映射 `openai-completions`，Anthropic 映射 `anthropic-messages`；不冒充支持 OpenAI Responses。API URL 与密钥真正写入 DSH provider/credential schema。reasoning wire 映射需要明确提供；非推理模型用 `false`，不把 off/max 自动改成其他语义。密钥变化生成新引用/route，避免旧缓存的 configured 状态冒充新密钥已加载。

人设 identity、style、方案 instructions 按该顺序用空行连接，进入 scoped `dsh-persona.prefix`，使用 `complete:true/includeRuntimeContext:false`，不是伪造用户提示词。严格模板 `{{…}}` 当前拒绝，避免 DSH 对人格文字做未知变量插值。生成组合只主动挂载 persona 和隔离 compaction，不为框架授予 shell、文件或其他工具权限。**这不证明外部 DSH 没有工具**：官方 tools 会继承 global/祖先 scope 并支持 scoped shadow；外部插件的实际工具可见性和执行权限必须独立核实，框架发送/提交 grant 不能替代该授权。旧组合和旧会话不被重置，新设置仅影响随后创建的会话。

### 加载和只读核验

官方 HMR 已启用时会监视 profile/home patch 和 profile manifest，串行 recompose；源码没有提供本实现可安全假设始终开启的远程 restart/reload API。应用后最多等待默认 5 秒，读取：

| 固定 RPC | Typert args | 核验 |
| --- | --- | --- |
| `settings/describe` | `{}` | `namespaces[].ns/value` 中实际 provider/model/api/baseURL/窗口/reasoning/ref |
| `agentPresets/list` | `{}` | 目标 preset 存在且无 broken |
| `agentPresets/read` | `{ agentPreset }` | 原始 plugins YAML 与完整生成组合相符 |
| `credentials/describe` | `{ refs }` | 官方 file 来源的配置状态；本地文件相等单独检查，不据此推断远端秘密值相等 |

`credentials/describe` 必须使用官方 `source:'file'`，并且 configured/writable 均为 true；`env/project-env/user-env`、缺失 ref 和未知来源都不能通过。只读 settings 中 credentials-local 的实际 entry id 必须存在，且显式绝对 `path`（或显式绝对 dshHome 推导的 `.credentials.yaml`）与所选目标一致。没有有效路径证据时返回 `dsh_credential_target_unverified`，不从本机默认环境猜测远端 home。

该只读协议**不提供加载中秘密的值、摘要、文件 revision 或刷新 receipt**。因此本地文件精确相等和远端 file 来源，只证明配置/来源，不证明 DSH 内存里的 key 与刚保存的 key 完全相同。成功结果明确携带 `verificationScope:'provider-preset-and-managed-file-provenance'`、`credentialValueIdentityVerified:false`、`unverified:['credential_loaded_value_identity']`；`verified` 和 bindings 只适用于该狭窄配置范围，不能宣传成“密钥值已核验/模型已可用”。旧内存仍持有同一 ref 的其他值时，这一部分始终未验证；不读取或记录远端 plaintext 来让状态变绿。

只有该范围的文件与网络证据全部相符才返回配置范围内的 `verified` 和 bindings。未加载、来源不符、网络失败或 HMR 未启用时保留文件和备份，返回 **`pending_reload`**；operator 自行检查所选独立 DSH 的 HMR/加载诊断，必要时在另行授权维护窗口重启**该独立实例**，随后调用 `reconcile`。本实现不会主动 restart，也不会把 pending 当作可聊天。

`port.verify(signal)` 仅认证并读取 settings；它不是模型可达、preset 生效或 QQ 已连接的证明。`inspectDeployment` 仅开放上述固定只读调用，不提供任意 RPC/URL 透传。

### 独立安装操作边界

下列由 operator 显式执行；目录应新建且与既有部署分离：

```sh
mkdir -p /srv/independent-dsh
cd /srv/independent-dsh
npm install --save-exact @deepseek-ai/dsh@0.2.1-rc.2
DSH_HOME=/srv/independent-dsh-home ./node_modules/.bin/dsh --profile web --host 127.0.0.1 --port 43121 --no-open
```

这是官方 Node launcher 的 web profile，不是 `sdk` stdio profile。由该独立实例生成其 profile manifest，按 manifest 的 bundle 顺序选择该安装的 `dsh.bundle.patch` 文件列表（base、web-app 及 web-app 声明的 preset layers），再选择新 home 的 profile 与 credentials 目标。不要使用 `--from-default-profile` 覆盖已有实例；启动 token 只在私有管理入口填入，不复制到示例、日志或公开文档。

如另有 home/`--patch` 后置覆盖、禁用/动态 provider 或不同版本 schema，必须核实实际层顺序和运行结果；本实现不会执行这些覆盖，也不会声称已支持任意 DSH 启动拓扑。网络核验失败保持不可用。保存提供方、安装 npm 包、写出文件、认证成功和端到端 QQ 聊天是不同验收阶段。

## 最终回复与真实用量

官方 `assistant/message` 是**单个 step**的 durable 记录，不是最终回答：它可能含 reasoning、tool-call、private replayState 或 `interrupted:true`。`normalizeDshEvent` 不再单独把它作为回复；`createDshAdapter.follow` 仅缓冲最后一个合法 text candidate，遇到同 turn 的 `turn/end.reason.kind === 'completed'` 才先发布 message、再发布 completed。工具调用、未知/媒体块、私有 channel/visibility、中断前缀、失败或 max-tokens 结束不发送；只保留正文 text 与最小标识，不把 reasoning/stream/source.replayState 填入回复 data。跟随始于快照中途时仍不重放历史。

`stream/error` 产生 `failed.data.terminal:true`，便于宿主使该 follow 失效；普通失败 turn 不标为流终止。此修复不自动重连或重发旧 prompt。

`assistant/message.usage` 才携带 TokenUsage，`turn/end` 原生没有 usage。completed/failed 的 `data.usageSteps` 保留实际逐步 provider/model 和计数，事件 id 去重，最多 256 步；只有观察到 turn/start、同一 turn 的所有助手记录用量有效且有记录时 `usageComplete:true`。中途跟随、缺失用量或超界明确 false。inputTokens 是**未命中缓存的输入**，cacheReadTokens/cacheWriteTokens 单列；totalTokens/reasoningTokens 仅在实际提供时保留，不补零、不推算缺失 total/cost，不把 partial steps 当整轮总量。

## 核对来源与新增测试

版本锁定的本地发布源码（仅用于研究，不是产品运行依赖）：

- `@deepseek-ai/dsh/README.md` 的 Profiles/Entry modes 与 `package.json` 的 bin/version。
- `dsh-app-boot/lib/types/profile.d.ts:5`、`dsh-app-boot/lib/index.js:61`：layer/whole-config 合成。
- `dsh-config-editor/lib/index.js:64`、`dsh-atomic-write/lib/index.js:6`：profile 锁、AST 编辑与重对账。
- `dsh-credentials-local/lib/index.js:135` 及 `lib/types/index.d.ts`：version 1、refs、owner-only、hot-publish。
- `dsh-hmr/lib/index.js:835`：watch/recompose 与 pending/restart 诊断。
- `dsh-llm-pi-ai/lib/index.js:1035`、`dsh-persona/lib/index.js:29`、`dsh-web-app/presets/minimal.patch.yml:4`：实际配置 schema。
- `dsh-agent-loop/lib/index.js:1098`、`:1156`；`dsh-session/lib/types/types.d.ts:263`；`dsh-llm/lib/types/types.d.ts:160`：中断/工具 step、turn end 与 disjoint token counters。

官方仓库：[CLI](https://github.com/deepseek-ai/deepseek-harness/tree/main/apps/cli)、[配置编辑](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/boot/config-editor)、[YAML parser API](https://eemeli.org/yaml/)。本地已核对发布源码优先于未来可能变化的 main。

定向执行：`node --test test/dsh.test.ts test/dsh-jsonrpc.test.ts test/dsh-deployment.test.ts test/dsh-profile-deployment.test.ts`。覆盖实际临时 YAML/CAS/备份/缺失文件/不透明 !!js/拒绝危险解析、本机 HTTP 验证、pending_reload→reconcile、群私路由、final-only 和逐步用量。没有真实 DSH/模型/QQ 验收，不得据此声称已完成生产迁移。
