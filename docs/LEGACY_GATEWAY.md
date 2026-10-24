# 旧 OneBot HTTP 出站兼容网关

本文描述 `createOneBotCompatGateway`、`startOneBotGateway` 与 `scripts/onebot-gateway.ts` 的公开部署边界。

## 用途

兼容网关用于把旧 bridge 的 OneBot HTTP action 经受控、持久化的 framework egress 转发到原 OneBot HTTP upstream。接入只修改旧部署的 `snowluma.httpUrl`，其余组件保持原样：

```text
旧 bridge / 旧 DSH 插件 / 旧 MCP
              │ OneBot HTTP
              ▼
      compatibility gateway
              │ OneBot HTTP
              ▼
        原 OneBot upstream
```

这是 **HTTP 出站兼容接入**，不是完整 newhost 接管：

- 旧 OneBot WebSocket ingress、旧 DSH runtime、既有 DSH session、GPT 委派、图片队列、自拍插件和 bridge 业务状态仍由旧后端负责。
- 网关不创建或迁移 DSH session，不重放会话，不实现 GPT、图片生成或自拍身份逻辑。
- 旧代码直接通过 OneBot WebSocket SDK 发送或查询的动作绕过本网关。部署方不能把网关指标解释成全部 QQ 流量。
- 旧后端或插件一旦停用，其能力不会因为启用网关而自动出现在 framework 中。

## HTTP 合同

除 `/health` 外，请求必须是带 Bearer 认证的 `POST /<action>`，body 必须是 JSON object；query string 和未列入 allowlist 的 action 被拒绝。

当前读取 action：

- `fetch_custom_face_detail`
- `fetch_face_entity`
- `fetch_ptt_text`
- `get_forward_msg`
- `get_friend_list`
- `get_group_list`
- `get_group_member_info`
- `get_group_member_list`
- `get_group_msg_history`
- `get_image`
- `get_login_info`
- `get_msg`
- `get_status`
- `get_stranger_info`

当前写入 action：

- `send_group_msg`
- `send_private_msg`
- `send_msg`
- `send_group_forward_msg`
- `send_private_forward_msg`

有明确 group/private target 的读写请求必须命中固定 `allowedConversations`。无目标的状态或列表读取仍要求认证和严格参数校验，但不映射到某个 conversation。

写入请求的原始 OneBot params 会按原结构转发。网关不会添加、删除或改写消息中的显式 `reply`、`at`、图片、语音或文本段；旧调用方明确要求引用时保持该语义，不能由兼容层擅自改成普通回复或自动引用。网关只校验 action、目标、边界和权限。

upstream 的 HTTP status 与 JSON body 在成功取得时原样返回。网关自身的拒绝使用 OneBot 风格 `{ status: 'failed', retcode, data: null, wording }`。无法确认写入是否已经执行时返回 `unknown` 对应的失败响应，**不会自动重试**。

### 幂等与恢复

- 写入可携带 `X-Idempotency-Key`。相同 key 与相同 action/target/params/persona 共享在途结果或已保存响应；同 key 换内容返回冲突。
- 旧调用方未提供 key 时，网关为每次 HTTP 请求生成新 key；这种请求之间没有端到端去重保证。
- 写入命令、params、状态和响应保存在私有 SQLite store。记录可能包含消息或媒体 payload，store 必须按敏感运行数据保护，不能提交或公开。
- 启动恢复把遗留的 prepared/authorized/dispatching 结果保守标为 `unknown`，不补发。
- `confirmed`、`rejected` 和 `unknown` 不可互换；外部对账必须有明确证据。

## 私有配置

CLI 接受一个严格 JSON 配置文件。配置文件、token 文件必须是非 symlink 的普通文件，且不得向 group/other 开放权限；相对文件名以配置文件所在目录解析。

| 字段 | 必填 | 合同 |
| --- | --- | --- |
| `port` | 是 | 本地监听端口；生产切换应使用固定非零端口。 |
| `upstreamEndpoint` | 是 | 固定 loopback HTTP endpoint；禁止凭据、query、fragment，且不能指回 gateway 自身。 |
| `tokenFile` | 是 | 旧 HTTP 调用方访问 gateway 的 Bearer token 文件。只改旧 `httpUrl` 时，其内容必须匹配旧调用方已经发送的 token。 |
| `upstreamTokenFile` | 否 | gateway 访问 upstream 的 Bearer token；省略时复用 `tokenFile`。 |
| `storeFilename` | 是 | 私有 SQLite 状态文件。父目录由服务以私有权限创建。 |
| `allowedConversations` | 是 | 0–1000 个唯一 `private:<decimal-id>` / `group:<decimal-id>`。这是固定拒绝式 allowlist，不是旁路列表；空数组表示拒绝全部带目标的请求。 |
| `persona` | 是 | `{ id, version }`，进入持久状态、幂等与授权作用域。 |
| `authorizationVersion` | 否 | 显式授权代次，默认 `1`；只允许 1–64 位字母、数字、点、下划线或短横线。 |
| `timeoutMs` | 否 | 单次请求期限；host 配置范围 10–120000 ms，默认 60000 ms。 |
| `maxPending` | 否 | upstream 在途上限；host 配置范围 1–64，默认 16。 |
| `maxBodyBytes` | 否 | 请求、响应及相关持久值边界；host 默认 28 MiB，范围 1 KiB–32 MiB。 |
| `maxRecords` | 否 | SQLite 最大记录数，范围 100–100000，默认 10000。 |
| `budgetEnabled` | 否 | 预算开关。`false` 时保留但忽略 `maxSendUses` 与 `grantTtlMs`，有效发送上限为安全整数且 grant 不过期；`true` 时启用已配置的限额/期限。省略时保持兼容，按两个预算字段生效。 |
| `maxSendUses` | 否 | 可选发送尝试限额；不配置时不增加日常服务次数限制，内部计数上界为安全整数。 |
| `grantTtlMs` | 否 | 可选 grant 有效期，显式设置范围 1 秒–7 天；默认或 null 不设到期日。 |

token 去除首尾空白后至少 16 字符、不得包含换行；不要把 token 写进配置 JSON、命令行、日志或仓库。

### 服务授权

gateway 为每个 allowlisted conversation 创建 `messaging.send` 和 `messaging.forward` 服务授权，默认不添加按天或按次数停服的限制。可按部署需要显式设置限额和到期日；普通发送记录 send 尝试，forward 同时记录 send 与 forward 尝试。拒绝或结果未知不保证返还已经开始的尝试。

预算关闭但保留数值的配置示例：

```json
{
  "budgetEnabled": false,
  "maxSendUses": 5000,
  "grantTtlMs": 86400000,
  "authorizationVersion": "operator-2"
}
```

此时两个数值仍保留在配置中，但有效授权不限制发送次数且不设置到期日。改为 `true` 后才启用已填写值；显式 `true` 但未填写某一项时，该项仍不限制。管理工作台可编辑开关和数值；保存预算更改时会生成新的 `authorizationVersion`，应用网关后才建立新一代授权。

grant 身份包含 persona、conversation 与 `authorizationVersion`：

- 使用相同 `authorizationVersion` 重启会继续读取已有 grant，不充值已消耗预算，也不延长原期限。
- 修改 `budgetEnabled`、`maxSendUses` 或 `grantTtlMs` 而不改变版本，会与已有 grant 冲突并拒绝启动，不会偷偷改写预算或期限。
- operator 完成复核后显式提升 `authorizationVersion`，才会创建一代新 grant；旧代 gateway grant 会被撤销。
- 从 allowlist 移除 conversation 后，其旧 gateway grant 会在下次启动时撤销。

因此重启不是续期操作。只有显式设置限额或期限的部署，才需要监控对应剩余值并在耗尽前复核授权；默认持续服务不要求周期续期。

手工启用、关闭或调整预算时，必须同时更新 `authorizationVersion` 并重载 gateway 才会生效；只修改预算字段而沿用原版本会安全拒绝启动。通过管理工作台保存时会自动更新该版本。

### 管理工作台接入

管理工作台提供六页中文配置，可编辑真实人设、旧 bridge 功能、访问范围、模型与回复、预算和运行参数。它通过私有配置选择监听地址和端口，首次网页访问自动创建固定的私有管理令牌文件并显示文件路径；无需预先手工生成管理令牌。完整部署和操作结果语义见[管理工作台教程](GATEWAY_ADMIN.md)。

允许群聊和允许私聊可以同时清空。保存访问范围时，工作台先把过滤后的目标同步到 gateway，再保存旧 bridge 白名单；同步后的 `allowedConversations: []` 会拒绝全部带群聊或私聊目标的读取、写入和发送。它不影响无目标的受认证状态读取，也不能拦截绕过 HTTP gateway 的旧 WebSocket 路径。

工作台将“写入配置”和“应用到运行服务”分开。gateway 或 bridge 的应用成功表示服务管理操作已经完成；管理端修改监听地址或端口时只表示重启请求已接受，用户仍需在新地址重新连接。超时或响应不确定显示为 `unknown`，不得据此自动重复应用。

## 启动与健康检查

使用环境变量指向私有配置文件，避免把凭据写入公共脚本：

```sh
node scripts/onebot-gateway.ts --config "$PRIVATE_GATEWAY_CONFIG"
```

CLI 还提供：

```sh
node scripts/onebot-gateway.ts --config "$PRIVATE_GATEWAY_CONFIG" --listening
node scripts/onebot-gateway.ts --config "$PRIVATE_GATEWAY_CONFIG" --health
```

- `--listening` 只检查回环端口能否建立 TCP 连接，不代表业务可用。
- `--health` 使用私有 token 请求 `/health`，并校验运行实例的配置 revision 与当前配置文件一致；部署 readiness 应使用该命令。
- `/health` 只监听 loopback 且要求 Bearer 认证，返回模式、配置 revision、进程信息及不含消息正文或凭据的管理 metrics。
- `SIGTERM`、`SIGINT`、`SIGHUP` 触发协作停机。已经发往 upstream 但未取得确定回执的写入仍按 unknown 处理。

## 接入与回退

切换 `httpUrl` 是全局 HTTP endpoint 切换，不天然是单群 canary。所有仍读取旧配置的 HTTP 调用都会先进入 gateway；固定 allowlist 必须覆盖所有应继续工作的 HTTP target，并与旧白名单变更流程同步。

建议顺序：

1. 启动 gateway，确认 authenticated `--health` 与配置 revision。
2. 验证读取 action、普通文本、显式 reply、图片/语音 payload 和 unknown 行为。
3. 原子修改旧部署的 HTTP endpoint，只重载确实缓存该配置的旧 bridge 组件；保留旧 WS endpoint、DSH 和全部插件。
4. 观察 gateway 授权状态、unknown、backpressure 与旧 WS 链路。

回退顺序必须是：

1. 先把旧部署的 `httpUrl` 恢复为原 OneBot HTTP upstream。
2. 只重载需要重读该配置的旧 bridge 组件并验证直连。
3. 最后停止 gateway。

不得先停 gateway 再恢复 URL；否则仍指向 gateway 的旧 HTTP 调用会中断。回退不重置、不迁移 DSH session，也不重启 DSH。

`scripts/legacy-gateway-switch.ts` 为旧 QQ Bridge 配置提供 `prepare`、`activate`、`rollback` 操作，均要求显式 `--legacy-root` 与 `--runtime-directory`。prepare 仅创建私有备份、凭据文件和网关配置；activate 检查精确配置的健康实例，只修改 HTTP endpoint；rollback 恢复该字段并保留其他并发配置修改。三者都不代替服务管理器重载进程，不会重置会话。端点被其他维护操作改动时拒绝覆盖。

## 绕过网关的旧 WS 路径

保留旧 WS endpoint 时，以下类型不会经过 HTTP compatibility gateway：

- QQ 私聊、群聊、notice、heartbeat 和 bot status 入站。
- 旧 bridge 通过 WS SDK 发出的自动/system 消息、审批/提问提示、白名单回执和控制台测试消息。
- WS `raw` / `request` / helper 执行的 poke、forward 读取、图片/face、群成员、消息和贴纸管理动作。
- DSH session create/prompt/follow/cancel、owner delegation、权限插件、bridge 内部控制面和图片 worker 本身。

因此 HTTP gateway 不能作为 WS 发送的安全闸门。若未来要求统一出站治理，必须另行迁移这些 WS 调用。

## 图片生成与自我表达边界

### `createImageGenerationAdapter`

图片 adapter 是独立 worker 客户端，不是旧图片插件的替代开关。它支持：

- `generate`：无 reference asset；`edit`：1–4 个由 `resolveWorkerReference` 解析的受控 reference asset。
- 有界 prompt、size、quality、并发、队列、轮询、超时和输出字节数。
- 由 conversation 与 idempotency key 派生稳定 job id。
- worker 完成后校验图片格式，再调用可信 `publishImage` callback 返回 assetId。
- dispatch 后超时、网络异常、状态或发布结果不确定时返回 unknown 语义，不自动重新提交。

`createImageGenerationEffect` 只把可信 effect scope 接入 adapter。它不判断消息发送者是不是 owner，也不为群友创建 capability grant。群友能向 allowlisted conversation 发消息，或 gateway 能向该群发送图片，都不等于群友获得通用画图授权；业务宿主必须另行验证来源、会话与 capability。

旧普通生图和旧自拍能否继续工作，仍取决于旧 DSH plugin、来源授权、worker、资源与 delivery 后端是否保留。兼容 gateway 只代理它们最终发出的 OneBot HTTP action。

### `createSelfExpressionService`

自我表达服务是待接业务 callback 的选择流程，不是已接入线上自拍能力。它要求调用方注入版本化 image pack，以及：

- `generate`：生成候选 asset；
- `check`：批准或给出问题；
- `discard`：确认丢弃不合格候选；
- `chooseHistory`：从同 image-pack 版本、同 conversation/persona、候选已声明的 session/generation 也匹配、已批准且未被本轮拒绝的历史候选中回退。

服务最多尝试两次，并返回 `selected/generated`、`selected/history` 或带明确原因的 `none`；它不直接发送 QQ。`createSelfExpressionEffect` 只传递可信 persona/conversation/session/generation scope，仍需单独 capability 授权。

该 API 不读取聊天记录、不验证 source message、不判断“明确要求自拍”的语境、不提供固定 identity manifest，也不证明候选已在线上复检。要形成真实自拍业务，composition 仍需提供身份资源、语境/来源授权、生成、审核、丢弃、历史、发布和发送 callback。文档不得把仅创建该服务描述为线上语境自拍已启用。
