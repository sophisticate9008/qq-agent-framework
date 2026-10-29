# 全框架服务规范

框架服务复用现有包依赖、服务注册器和 SDK。内置包与扩展使用同一套类型契约、声明和取得入口；模型工具、调用权限及外部执行证据分别管理。取得服务不会自动登记模型工具，也不授予 QQ 主人身份。

## 声明、发布与取得

公共契约使用 `defineServiceContract<T>({ id, version, description, methods })` 定义。`serviceDeclaration(contract)` 生成 manifest 中的服务声明，提供方用 `publishService(context, contract, value)` 发布，消费者用 `useService(context, contract)` 取得类型化接口。这些 helper 从 `@qq-agent-framework/sdk/host` 导出；纯契约类型也从 `contracts` 导出。

```ts
import { defineServiceContract, publishService, serviceDeclaration, useService }
  from '@qq-agent-framework/sdk/host';

interface TextService { summarize(text: string, signal: AbortSignal): Promise<string> }
const TEXT = defineServiceContract<TextService>({ id: 'example-text', version: 1,
  description: '整理插件提供的文字。', methods: ['summarize'] });

// 提供包：manifest.provides: [serviceDeclaration(TEXT)]
// install(context) 中发布实际实现：
// publishService(context, TEXT, implementation);
// 消费包同时声明 dependencies: ['提供包标识']、requires: [serviceDeclaration(TEXT)]。
// start(context) 中取得：const text = useService(context, TEXT);
```

包版本和服务接口版本分别维护。提供方与消费者引用同一个契约；校验覆盖契约格式及必需方法是否存在，参数和返回值仍由各方法的类型与边界解码负责。依赖缺失、循环、重复服务、接口版本不匹配、未声明取得在包管理器中明确拒绝。`requires` 没有可选标志；需要可选能力时，由可信装配决定安装哪些包，并显式处理服务不可用。

一般服务发布共享实现；需要绑定消费者身份的宿主服务通过 `publishScopedService(context, contract, factory)` 提供客户端工厂，接收宿主建立的 `{ owner, signal, assertActive }`；底层入口为 `context.publishScoped`。插件的模型、协议等客户端由 `plugin-runtime` 包发布；配置了 `runtimeServices` 工厂的宿主自动加入该包。消费者仍须声明 `dependencies: ['plugin-runtime']` 和实际使用的服务 `requires`。包上下文的 `context.runtime` 保留便利 getter，读取它也经过同一依赖校验和服务解析。

注册器 `services()` 与运行快照 `services` 返回 ID、版本、提供包、来源、用途、方法名、是否按消费者绑定及 `declared/registered/ready/unavailable` 状态。`ready` 表示提供包运行且服务已发布；它不证明所需协议动作受支持、模型已联网或当前调用有权限。可选宿主客户端缺失时取得服务明确报不可用。

## 已公开能力

下表服务均为版本 1。`PLUGIN_*_SERVICE_CONTRACT` 来自 `plugin-service-contracts`，其余常量来自 `framework-service-contracts`；SDK host 统一导出。契约目录包含可选提供方，目录本身不是安装清单。

| 能力 | 服务与契约 | 实际范围 |
| --- | --- | --- |
| 协议、发消息与收藏表情 | `plugin-protocol` / `PLUGIN_PROTOCOL_SERVICE_CONTRACT` | `catalog/call`，读取实际协议支持并执行动作；发送、转发、收藏表情使用同一协议目录 |
| 插件模型 | `plugin-models` / `PLUGIN_MODELS_SERVICE_CONTRACT` | `models/list/create/bind/unbind/run`，持久或单次调用，不自动发 QQ |
| QQ 会话绑定 | `plugin-sessions` / `PLUGIN_SESSIONS_SERVICE_CONTRACT` | `resolve/bind/unbind`，实际绑定版本与具体 DSH 会话 ID |
| 插件日程 | `plugin-scheduler` / `PLUGIN_SCHEDULER_SERVICE_CONTRACT` | `registerHandler/schedule/list/cancel/history`，按插件隔离，持久发生记录 |
| 模型二级工具登记 | `plugin-tools` / `PLUGIN_TOOLS_SERVICE_CONTRACT` | `register`，固定插件来源、权限分类和注销生命周期 |
| 会话原图读取 | `plugin-media` / `PLUGIN_MEDIA_SERVICE_CONTRACT` | `readImage`，当前账号和 QQ 会话已登记图片，不接收任意 URL 或路径 |
| 实现重载登记 | `plugin-extensions` / `PLUGIN_EXTENSIONS_SERVICE_CONTRACT` | `register/list`，只管理本插件已接入的可替换实现 |
| 插件用量 | `plugin-usage` / `PLUGIN_USAGE_SERVICE_CONTRACT` | `list/summary`，只读实际账本中归属于本插件的调用 |
| 插件观察事件 | `plugin-events` / `PLUGIN_EVENTS_SERVICE_CONTRACT` | `read/subscribe`，公共生命周期和有可靠归属证据的执行元数据 |
| 空间底层操作 | `qzone` / `QZONE_SERVICE_CONTRACT` | `describe/inspect/execute`，类型化协议入口；协议目录可提供同源原子动作 |
| 输入配置 | `chat-input` / `CHAT_INPUT_SERVICE_CONTRACT` | `read`，聊天唤醒配置；输入准备仍使用包贡献 |
| 媒体 | `media` / `MEDIA_SERVICE_CONTRACT` | 登记、模型读取、出站解析及媒体效果适配器；GIF、视频、语音能力取决于实际适配器 |
| 回复准备 | `chat-output` / `CHAT_OUTPUT_SERVICE_CONTRACT` | `prepare/context/split/clear`，排版与分组，不执行协议发送 |
| 提醒业务 | `reminders` / `REMINDERS_SERVICE_CONTRACT` | 规则、CAS、发生记录、启停和调度；发送仍经过当前 policy |
| 记忆 | `memory` / `MEMORY_SERVICE_CONTRACT` | `query/context/propose`，建议写入与确认来源分开 |
| 聊天状态 | `native-agent` / `NATIVE_AGENT_SERVICE_CONTRACT` | `status/binding`，当前代理与绑定只读状态 |
| 模型交互状态 | `native-interactions` / `NATIVE_INTERACTIONS_SERVICE_CONTRACT` | `snapshot`，有界快照 |
| 执行记录 | `native-executions` / `NATIVE_EXECUTIONS_SERVICE_CONTRACT` | `read/list`，实际执行查询 |
| 模型工具目录 | `native-tools` / `NATIVE_TOOLS_SERVICE_CONTRACT` | `catalog`，只读；与 `plugin-tools` 的注册用途分别处理 |
| 后台工作 | `native-work` / `NATIVE_WORK_SERVICE_CONTRACT` | 状态、读查、启动、追加、停止及核对；写操作需要真实 `FeatureExecution` |
| 可选生图 | `image-generation` / `IMAGE_GENERATION_SERVICE_CONTRACT` | `generate`，实际图片字节、类型和 SHA-256，不隐式发送 |

`native-*` 五个服务由 `native-services` 包提供，其余内置领域服务依赖各自提供包。插件配置与状态保持包上下文基础设施：`configuration` 只访问本包声明的配置域，`state` 使用包 schema 和 CAS；`context.store(store)` 只包装可信装配已提供的 store，不自动授予原始宿主数据库。业务数据优先使用包状态。

## 发送、表情和输出组合

插件发送使用协议目录中的 `send_group_msg`、`send_private_msg` 及支持的转发动作；收藏表情使用 `fetch_custom_face`、`fetch_custom_face_detail`、`add_custom_face`、`delete_custom_face`、`set_custom_face_desc`。先读取实际动作的参数与支持状态，再提交调用，不另建发送或表情客户端。

协议调用返回 `confirmed/rejected/unknown`，写操作使用稳定幂等键和宿主持久回执。直接协议发送按协议参数执行，不自动经过聊天输出排版、聊天 outbox 或历史追加。QQ 功能回调的 `FeatureExecution.send` 与模型 `qaf_reply` 则走聊天 policy、outbox、历史及输出流程。插件选择入口时应按所需语义组合，不能把生成了输出产物等同于已送达。

## 身份、生命周期与恢复

宿主注入插件 owner、账号和生命周期，模型参数不能覆盖它们。QQ 工具与命令入口仍核验实际发言者及当前权限；定时任务以已登记插件身份执行。`native-work` 写方法继续通过调用方 execution 的 `invoke` 核验能力和实际 QQ 来源，不能仅凭取得服务启动主人工作。

服务代理在取得、方法访问和调用时检查提供包及消费者生命周期；停止后的旧服务句柄不能开始新调用。代理保护已发布服务对象的方法，不自动包装方法返回的任意新值；返回的操作句柄或迭代器须由提供方绑定消费者的 signal 和活动检查，`plugin-events` 订阅已按此处理。外部调用的取消、期限、实际排空及恢复由具体服务负责，代理不能强行终止任意 Promise 或外部操作。可信 TypeScript 插件仍在宿主进程运行，服务边界不是恶意代码沙箱。

外部写入保持稳定幂等键，取消本机等待不等于外部已停止。未知执行保存证据，不自动重放；每个领域分别规定核对、保留和容量。插件模型共享同一实际会话时串行执行，绑定不会随 QQ 地址换绑漂移。自动建会话仅加载插件任务和自身历史，不加载 QQ 人设、聊天方案或工具。

插件调度共用宿主的有界插件调度循环；提醒服务有独立业务生命周期和循环，两者复用日历计算。业务事件订阅仍使用功能 `subscriptions` 与 `services.on`，输入准备仍使用贡献机制，观察流不替代业务事件投递。

## 用量、观察与热重载

插件用量读取现有账本中 `plugin:<owner>` 的逐轮归属，允许按 session/provider/model/时间和游标筛选；共享同一会话不会获得 QQ 或其他插件用量。旧绑定解除后，已归属自己的账本记录仍可读。未知 token 和成本保持未知，多币种分别汇总；读取遵守宿主扫描上限，调用方应检查 `partial` 与 `next`。插件客户端不提供清账、改价或补记入口。

插件事件复用宿主实际有界观察流，保留原 epoch、游标、缺口和背压语义。公共 runtime 生命周期不含会话关联；执行事件必须能从实际插件请求 ID 或终态 turn 证明归属，不能只凭共享 session 推断。无法证明归属的事件不返回，QQ 正文与地址等关联信息不向该客户端开放。这是有限的状态观察，不是完整私有协议追踪，也不是持久审计日志；缺口不能解释为没有发生操作。

同一接口内的行为实现可用 `createReloadableService` 和 `createReloadableHandler` 保持稳定登记，活动调用通过租约留在旧实例排空。契约 ID、版本和方法集合不兼容时拒绝替换；参数语义变化仍需维护版本。工具 schema、依赖和注册结构变化需要完整应用装配。用法及完整例子见 [扩展开发](EXTENDING.md)、[稳定服务与可替换行为](RELOADABLE_SERVICES.md) 和 [热重载插件示例](../examples/reloadable-plugin/README.md)。

源码入口：[契约 helper](../src/host/service-contract.ts)、[包注册器](../src/host/native-packages.ts)、[宿主服务包](../src/host/plugin-runtime-package.ts)、[内置契约](../src/host/framework-service-contracts.ts)、[插件契约](../src/host/plugin-service-contracts.ts)。安装、构建、真实协议和真实模型验证分别记录，服务接口存在不代表所有提供方组合已经实测；当前验收范围见 [VALIDATION.md](VALIDATION.md)。
