# 架构

## 分层

```text
QQ / 管理入口
      ↓
协议适配器 ── 验证、规范化、回执映射
      ↓
宿主层 ───── 会话、持久任务、资源、出站与恢复
      ↓
核心引擎 ─── 功能生命周期、事件调度、上下文、权限
      ↓
功能包 ───── 通过 generate / send / invoke 使用显式服务
      ↓
agent / transport / 其他 effect adapter
```

`src/core/` 不连接外部系统。`src/host/` 负责跨重启语义和适配器编排。`src/adapters/` 把具体协议转换为框架契约。`src/features/` 只实现可装配行为。

当前实现入口：

| 层 | 入口 | 责任 |
| --- | --- | --- |
| 存储 | `createSqliteStore` | revision 条件写入、分页、过期和容量限制 |
| 会话 | `createSessionRegistry` | 会话创建意图、绑定、generation 和未知结果 |
| 出站 | `createDurableTransport` | 持久幂等键、发送状态、恢复与人工对账 |
| 任务 | `createTaskQueue` | 有限扫描、到期执行、取消、显式重试和恢复 |
| 资源 | `createResourceRegistry` | 版本、scope、来源、审批、撤销与解析 |
| QQ | `createOneBotTransport` / `createOneBotReceiver` | OneBot HTTP 消息块转换、HMAC 入站和回执映射 |
| agent | `createDshAdapter` | 注入 client port，创建/提交/跟随/取消并规范化事件 |
| 宿主 | `createBridgeHost` | 入站授权、agent relay、持久去重、follow 恢复和停机排空 |

这些模块提供装配基础，不代表任意 OneBot 或 DSH 部署已经兼容。端点、事件版本、网关限速和恢复行为仍需对目标环境集成测试。

## 核心引擎

`createEngine` 接收 transport、可选 model、上下文、状态、policy 和宿主扩展表。引擎负责：

- 校验并安装版本化 `FeatureDefinition`。
- 按会话串行事件，允许不同会话并行。
- 限制未完成事件与副作用数量，并周期性让出事件循环。
- 在副作用真正开始前再次检查授权。
- 卸载时中止新动作，等待已开始的处理器和副作用，再逆序清理。
- 保留有界的事件去重、出站视图和脱敏审计。

事件和副作用的有限历史只解决单进程重复调用。需要跨重启保证时，宿主必须使用持久任务或出站记录。

## 上下文与权限

上下文解析把版本化人设、配置和偏好组合成冻结快照。功能状态按 `featureId + conversationId` 隔离。

policy 的授权键至少包含功能、会话和 capability。每项授权有有限尝试预算，可设置期限、暂停或撤销。预算统计的是动作尝试，不代表外部系统已经成功处理。

## 消息与资源

消息由有序 `MessageContent[]` 表示，可包含文本、图片/音频/文件资源引用、提及和回复。资源块只携带 `assetId`；资源元数据、内容访问和清理由宿主资源目录负责。协议适配器决定哪些组合可发送，并必须对不支持的内容返回明确结果。

## 会话与恢复

宿主会话绑定应包含 `conversationId`、外部 `sessionId` 和单调 generation。替换绑定时，旧 generation 的跟随事件必须被忽略或终止。

首回复 watchdog 使用独立 timer 和持久等待记录，不依赖串行任务队列推进。它只报告从 prompt accepted 到首条 confirmed assistant 消息的等待状态，不强杀外部 agent 工作，也不把后续入站当作延长原期限的依据。

恢复流程遵循以下原则：

1. 先打开持久存储并读取记录。
2. 以最多四路并发重建当前会话绑定和有效跟随流。
3. 恢复未终结任务与出站记录。
4. 对 `unknown` 状态优先查询或人工对账，不直接重发。
5. 根据 `startupState` 区分完整恢复与超时降级；降级启动允许进程继续服务，但需要运维检查未恢复边界。

中断时，正在创建的会话、发送中的出站和运行中的任务都进入 `unknown`，不会由启动恢复自动重做。`unknown` 需要外部查询、显式对账或人工决策。

`createBridgeHost.start()` 先恢复出站、任务和处理中入站，再为 `ready` 会话恢复 follow，最后运行到期任务并启动周期扫描。出站、任务、agent event 和 inbox 恢复每处理 16 项让出事件循环。整体启动期限到达时它以 `degraded` 状态返回，避免单个失联 follow 无限阻塞其他会话；迟到 setup 会被清理且其 frame 不再进入宿主。`stop()` 先停止新工作和 follow，再排空任务与引擎副作用。持久存储由创建它的调用方在宿主停止后关闭。

## 扩展边界

宿主可以在创建引擎时注册新的事件校验器和 effect adapter。注册表创建后固定；扩展不能覆盖内置事件或 capability。功能只能订阅 manifest 中声明的事件，并只能调用 manifest 与 policy 同时允许的 capability。

## 运维视图

高频健康检查应读取轻量状态和计数，不应反复构造完整快照。完整管理视图可能包含大量功能、授权、审计和出站记录，只适合受认证的低频查询。

## 已知限制

- 取消与期限依赖协作，不能抢占 JavaScript 同步死循环、同步 OS I/O 或已经进入外部系统的动作。
- 功能包与适配器必须视为可信代码。
- SQLite 持久宿主按单活动实例设计；重启恢复不是多活租约或分布式所有权协议。
- 持久任务按 store cursor 有界扫描而非 due 索引查询；终态记录持续积累会增加到期任务的发现延迟，部署必须验证容量并制定清理策略。
- 有界队列提供背压，不保证调用方已经持久接纳被拒绝的输入。
- 不同 transport 对顺序、并发、限速和回执的语义不同，必须单独验收。
- 当前演示应用不是远程多用户生产控制台。
- `createBridgeHost.receive()` 只接受协议层已认证和规范化的消息；宿主仍会调用 `authorizeIncoming` 做业务身份与会话授权。
