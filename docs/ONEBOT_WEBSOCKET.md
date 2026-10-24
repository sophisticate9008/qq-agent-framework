# OneBot WebSocket

在“适配器 → OneBot”启用 WebSocket 收消息，填写协议端的正向 WebSocket 地址与该服务的访问密钥。保存后点击“连接 WebSocket”，账号通过登录信息自动识别，不用手填 QQ 号。

HTTP 地址用于发送 API，WebSocket 用于接收事件；二者的端口和密钥可能不同，不要混用。地址由部署配置决定，不会跟随其他项目或猜测账号。

## 实际边界

默认 CLI 已挂载协议连接控制器，但未装配完整聊天处理流程。界面把“协议已连接”和“聊天处理尚未接入”分别显示；后者为未接入时不会自动生成回复，也不能据连接成功宣称会话或用量服务可用。

当前连接器不发送 QQ 测试消息、不调用模型、不自动批准操作。没有消息消费者时，只累加接收和丢弃数量，不保存消息内容。保存参数不修改已运行连接，重新连接才应用新参数；管理进程关闭会释放连接。

## 开发接口

`createOneBotWebSocketClient` 接收固定 `endpoint`、可选 `accessToken`、可选 `onEvent` 和有界生命周期选项，返回 `connect(signal?)`、`status()`、`close()`。构造不联网，连接只向配置端点建立正向连接。

- `ws://` 只允许本机回环，远程使用 `wss://`。禁止 URL 内嵌凭据、查询参数、片段及重定向。
- 认证使用 Bearer 请求头；只发送只读 `get_login_info` 并等待匹配回执。成功发现合法账号后才报告 connected。
- 仅把该账号的消息事件交给消费者；RPC、其他账号事件及畸形内容不会误作为用户消息。
- 单帧最多 1 MiB，回调具有有界队列、期限、取消及未完成底层操作数量上限。超时不会伪装底层回调已停止。
- 重连次数和退避有限，认证失败不会无限重试。显式关闭、取消和代次变更会阻止迟到事件或旧计时器复活连接。
- 心跳探测用于发现半开连接；连接状态不代表 QQ 实际账号在线或聊天模型已运行。

`onEvent` 收到冻结的协议事件与可信连接账号、取消信号，但不是业务授权。接入聊天宿主前仍需规范化消息、校验访问范围、注册受控资源、建立会话和执行 capability/policy；不能从事件直接扩大权限。

协议依据：[OneBot 11 WebSocket](https://github.com/botuniverse/onebot-11/blob/master/communication/ws.md)、[鉴权](https://github.com/botuniverse/onebot-11/blob/master/communication/authorization.md)、[登录信息 API](https://github.com/botuniverse/onebot-11/blob/master/api/public.md)。
