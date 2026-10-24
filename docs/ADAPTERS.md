# 适配器配置

在“适配器 → OneBot”分别配置 HTTP 发送和 WebSocket 接收。WebSocket 连接成功后自动识别机器人账号，不用手填 QQ 号。HTTP 与 WebSocket 的端口和密钥可能不同。

默认 CLI 已挂载协议连接控制器：保存后点击“连接 WebSocket”，断开使用独立按钮。保存参数不会自动更新已有连接，修改后需要重新连接。所有连接默认关闭，不发送测试消息或调用模型。

**协议已连接不等于聊天处理已接入。** 当前控制器没有装配完整聊天流程，没有消息消费者时只累加接收/丢弃数量，不保存正文、不转发模型、不生成回复。界面明确分开显示，`/api/chat/status.runtimeConnected` 仍为 false。

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

可选 `connection` 包含 `{ state, selfId, lastError, received, dropped, chatReady: false }`。state 为 disconnected、connecting、connected、reconnecting 或 error；错误为稳定脱敏代码，不包含地址、密钥或消息正文。聊天处理未装配时 chatReady 保持 false。

## 宿主扩展

`createNativeRuntimeRoutes({ directory, adapterRuntime? })` 支持可信代码注入端口，不从 JSON 加载代码：

- 原有只读 `status(): { running }` 端口仍可用，但不提供连接控制。
- 控制端口可提供 `connect(configuration, signal)`、`disconnect()`、`connectionStatus()`。
- CLI 使用 `createOneBotConnectionManager()`；构造不联网，显式连接才访问配置端点，管理进程关闭时释放连接。

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
