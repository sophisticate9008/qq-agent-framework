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
| 日历 | `createCalendarTriggerService` | daily/weekly、显式时区/DST、有限窗口及漏触发处理 |
| 归属 | `createMessageRouter` / `withMessageRoute` | 可信入站决策、响应处理器过滤，保留旁观者广播 |
| 资源 | `createResourceRegistry` | 版本、scope、来源、审批、撤销与解析 |
| 表达 | `createPresentationService` | 可选 selector、引用决策与 text/markdown-image/forward 内容准备 |
| 渲染 | `createMarkdownRenderer` / `createRenderedAssetPublisher` | 离线 PNG 与可选受控本地发布，不直接发送 |
| QQ | `createOneBotTransport` / `createOneBotReceiver` | OneBot HTTP 消息块转换、HMAC 入站和回执映射 |
| agent | `createDshAdapter` | 注入 client port，创建/提交/跟随/取消并规范化事件 |
| DSH 网络 | `createDshJsonRpcPort` | 显式端点与认证、有限网络请求/跟随，不发现其他桥接项目；指令需可信 preset 绑定 |
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

消息由有序 `MessageContent[]` 表示，可包含文本、图片/音频/文件资源引用、提及和回复。forward 必须独立发送，不能嵌套、混发或携带模型自报发送者；它额外受 messaging.forward 授权与 OneBot group/private 扩展开关约束。固定节点身份来自 operator 的可信配置。

资源块只携带 assetId，不能解释成路径。引擎从实际人格版本产生 OutboundScope，经 effect、durable outbox 到 OneBot resolver 传递；资源登记与解析比较完整人格键及按需绑定的 session/generation，expectedVersion 可额外锁定资源版本。历史资源可不绑 session，旧无 scope 请求仍兼容，不能据此宣称旧记录已自动获得身份隔离。资源 get/list 只暴露治理元数据，resolve 才解析受控来源。

表达链路分为选择/准备、渲染、受控发布、实际发送：prepare 返回规范内容，renderer 不下载 Markdown 图片、网络或字体，publisher 只审批这个可信文档 renderer 的 PNG，最终仍由功能 execution.send 经 policy 和出站完成发送。select 是受约束挂载点，没有硬编码人格或自动读取聊天推断意图；selectAgentMessage 另为同步 agent 输出过滤，默认 relay 不自动调用表达服务。

标准 relay 可显式配置 agentMessagePreparation，在引擎内用额外 capability 的 invoke/generate 做异步准备，再沿用原 send/outbox。hook 不拿 send/store，额外声明不等于授权；返回 null 跳过发送，普通格式可原样保留。只有启用 hook 才传递原始 metadata 到 event.data.agentData，由上层映射 DSH 元数据而非核心硬编码 Markdown 或自动识别意图。

renderer 依赖调用方注入 browser 及部署本地中文字体；本地 publisher 是依赖目录 fd（Linux 下 /proc/self/fd）的可选 Linux 适配器，而非整个框架的平台前提。其他平台可注入自己的受控发布器。完整装配与边界见 [文档表达](PRESENTATION.md)。

## 路由与触发

routeIncoming 位于 host 入站授权之后、历史写入与一次事件广播之前。规则只产生冻结的归属事实，不产生 grant。withMessageRoute 仅过滤包装功能的 message.received，其他订阅照常执行；未包装观察者不受影响。相同最高优先级冲突、selector 异常或异步结果均拒绝，不依赖安装顺序；这不是 NLU 或模型意图识别服务。

calendar 与持久 task queue 分离，必须由应用恢复并 tick；bridge 自带任务 timer 不会启动它。只支持 daily/weekly 与明确 IANA 时区、DST overlap/nonexistent 规则；窗口外跳过，窗口内只执行最新机会，coalesce 报告合并次数，不进行无界补发。callback 映射成普通事件后仍经过 policy。中断 occurrence 标 unknown、不自动重放；其终态 TTL 不是整个系统的保留治理。

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

可信装配根可通过 createBridgeHost 直接注入 eventValidators、effectAdapters、model 与 observer，无须绕开标准持久宿主。注册表创建后固定；扩展不能覆盖内置事件或 capability，host 还保留全部 agent.* 名称。功能只能订阅 manifest 声明的事件，并只能调用 manifest 与 policy 同时允许的 capability；observer 是脱敏诊断，不是授权关口。

## 运维视图

高频健康检查应读取轻量状态和计数，不应反复构造完整快照。完整管理视图可能包含大量功能、授权、审计和出站记录，只适合受认证的低频查询。

SQLite stats 使用只读事务，使一次返回的容量总数与 namespace 分页一致；host.storageStats 与 GET /api/host/storage 只转交这些脱敏统计，不返回正文。统计不回收配额、不删除 unknown、不对账、不重试；过期数据清理和记录保留仍是显式运维操作。

## 已知限制

- 取消与期限依赖协作，不能抢占 JavaScript 同步死循环、同步 OS I/O 或已经进入外部系统的动作。
- 功能包与适配器必须视为可信代码。
- SQLite 持久宿主按单活动实例设计；重启恢复不是多活租约或分布式所有权协议。
- 持久任务对 pending 索引作有界 cursor 扫描，而非 due 索引查询；大量未来或缺少 handler 的任务仍有发现延迟风险。终态不参与调度扫描，但仍占存储配额，部署必须制定保留与清理策略。
- 有界队列提供背压，不保证调用方已经持久接纳被拒绝的输入。
- 不同 transport 对顺序、并发、限速和回执的语义不同，必须单独验收。
- 当前演示应用不是远程多用户生产控制台。
- 尚无完整候选 release 分阶段切换/失败回滚与业务状态 schema 迁移；功能 setup 事务不等于版本发布事务。
- prompt accepted、首回复 watchdog 与有限任务队列不等于可恢复长 job 管理；远程进度、请求关联、取消确认与恢复控制面仍有缺口，不重建 DSH。
- storage stats、日历 TTL 和 publisher 文件上限不等于跨组件 retention、未知结果保全与容量自动治理已完成。
- 浏览器渲染或离线装配验证不代表真实 QQ 发送、DSH 集成、长时间运行和故障恢复已经验收。
- `createBridgeHost.receive()` 只接受协议层已认证和规范化的消息；宿主仍会调用 `authorizeIncoming` 做业务身份与会话授权。
