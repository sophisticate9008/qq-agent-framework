# OneBot HTTP 出站网关

`createOneBotCompatGateway`、`startOneBotGateway` 和 `scripts/onebot-gateway.ts` 提供标准 OneBot HTTP action 服务。名称中的 Compat 表示协议形状兼容，不表示依赖另一个桥接项目。

```text
经授权的 OneBot HTTP 调用方
          ↓
本框架持久化出站网关
          ↓
部署方的 OneBot HTTP 协议服务
```

网关独立运行，不读取其他项目的配置、会话或插件。它不是 QQ ingress 或模型服务；要处理聊天，需要显式装配原生 `createBridgeHost`、入站适配器和 agent client。

## 请求与权限

除 `/health` 外，请求必须为带 Bearer 认证的 `POST /<action>`，body 为有限 JSON object，拒绝 query 和未知 action。

读取 action：`fetch_custom_face_detail`、`fetch_face_entity`、`fetch_ptt_text`、`get_forward_msg`、`get_friend_list`、`get_group_list`、`get_group_member_info`、`get_group_member_list`、`get_group_msg_history`、`get_image`、`get_login_info`、`get_msg`、`get_status`、`get_stranger_info`。

写入 action：`send_group_msg`、`send_private_msg`、`send_msg`、`send_group_forward_msg`、`send_private_forward_msg`。

带 group/private 目标的请求必须命中 `allowedConversations`；空数组拒绝全部目标。无目标的状态读取也需要认证。写入保留显式 reply、at 与媒体段，不自行加引用或改变内容。forward 额外要求 `messaging.forward` 权限。

## 幂等与恢复

写入可携带 `X-Idempotency-Key`。同键同内容复用在途或持久结果，同键异内容拒绝；缺少 key 时每次生成新键，不提供跨请求去重保证。

命令、状态与响应保存在私有 SQLite，可能包含消息数据，不可公开。恢复将中断的准备/发送记录标为 `unknown`，不补发。未知不能自动视为未执行，更不能盲目重试。

## 配置

使用非 symlink、权限私有的有限 JSON 配置；相对路径按配置目录解析。凭据只从私有普通文件读取，不放在命令行或公共配置中。

| 字段 | 用途 |
| --- | --- |
| `port` | 回环监听端口；部署使用固定非零端口 |
| `upstreamEndpoint` | 固定回环 HTTP 上游，禁止 URL 凭据、query、fragment 和自指 |
| `tokenFile` | 调用本框架网关的 Bearer 凭据文件 |
| `upstreamTokenFile` | 上游协议凭据文件，省略时复用网关凭据 |
| `storeFilename` | 本框架私有 SQLite |
| `allowedConversations` | 唯一的 `group:编号` / `private:编号` 允许列表 |
| `persona` | 进入持久授权和幂等作用域的 id/version |
| `authorizationVersion` | 显式授权代次；重启不充值或续期 |
| `timeoutMs` | 请求期限，默认 60000 ms |
| `maxPending` | 有限在途请求上限 |
| `maxBodyBytes` | 请求/响应和持久值边界 |
| `maxRecords` | 存储记录容量 |
| `budgetEnabled` | 可开关预算；关闭不绕过认证和允许范围 |
| `maxSendUses` | 启用预算后的可选发送尝试上限 |
| `grantTtlMs` | 启用预算后的可选有效期，null 为不设到期 |

修改预算时同时更换授权代次，管理 UI 保存会完成该步骤。相同代次重启继续已有消耗和期限；不能用重启隐式扩大授权。

## 启动与健康检查

普通部署使用 `npm start`。独立网关高级入口：

```sh
node scripts/onebot-gateway.ts --config "$PRIVATE_GATEWAY_CONFIG"
node scripts/onebot-gateway.ts --config "$PRIVATE_GATEWAY_CONFIG" --health
```

`--health` 使用认证并校验配置 revision；`--listening` 只验证 TCP，不证明业务就绪。健康模式为 `onebot-egress`。

停机为协作式：已发往上游但未取得明确回执的写入仍为 unknown。管理员凭据、网关凭据与上游协议凭据相互独立。管理教程见 [管理工作台](GATEWAY_ADMIN.md)。

按 [OneBot HTTP 响应约定](https://github.com/botuniverse/onebot-11/blob/master/communication/http.md#响应)，`status: async` / `retcode: 1` 只是异步受理，不是确定失败。本框架保留原 HTTP 响应，但将命令与持久出站标为 `unknown`，同一幂等键不会再次发送。只有一致的 `ok/0` 且带有效消息 ID 才确认发送；矛盾状态或缺失消息 ID 也不伪造确认。取得外部确定回执后才能对账，不能把未知当作可安全重试。
