# 扩展功能

功能包通过 manifest 声明订阅和 capability，并在同步 `setup` 中注册处理器。

具体业务能力由使用者或 AI 编写独立功能包补充。框架不为每种业务预设服务接口或配置卡；使用现有的自定义事件、capability、资源和 UI 范式接入即可。功能包的配置与凭据自行管理，但仍须遵守授权和副作用边界，不能从消息直接加载代码或扩大权限。

## 最小功能

```ts
import type { FeatureDefinition } from '../core/types.ts';

export const noticeFeature: FeatureDefinition = {
  id: 'notice',
  version: '1.0.0',
  apiVersion: 1,
  capabilities: ['messaging.send'],
  subscriptions: ['trigger.fired'],
  setup(context) {
    context.on('trigger.fired', async (execution, event) => {
      if (event.data.kind !== 'notice') return;
      await execution.send([{ type: 'text', text: '通知已触发' }]);
    });
  },
};
```

宿主还需要安装功能，并为该功能、目标会话和 `messaging.send` 创建有限授权。代码声明、配置字段和消息内容都不能替代授权。

## 自定义事件和 capability

可信装配根可在 `createEngine` 或标准 `createBridgeHost` 创建时注入扩展。以下片段假设 `hostOptions` 已包含 store、agent、transport、context、persona 和 authorizeIncoming，model 与 observer 也由 operator 提供：

```ts
const host = createBridgeHost({
  ...hostOptions,
  model,
  observer,
  eventValidators: {
    'asset.ready': data => typeof data.assetId === 'string',
  },
  effectAdapters: {
    'asset.inspect': {
      execute({ input, signal }) {
        if (signal.aborted) throw new Error('cancelled');
        return { accepted: true, input };
      },
    },
  },
});
```

功能必须在 manifest 中声明 `asset.ready` 和 `asset.inspect`，并通过 `execution.invoke` 调用。扩展与内置副作用一样经过输入冻结、队列上限、取消、授权和审计。

事件校验器必须同步严格返回 `true`。effect adapter 得到冻结输入、引擎生成的 scope（含人格版本和可选 session/generation）与 `AbortSignal`；凭据、完整配置和存储句柄不会自动暴露给功能。model 调用仍需 `model.respond` 授权；observer 只看脱敏审计，不是 veto 或授权入口。

标准 host 拒绝替换 `message.received`、`trigger.fired`、`messaging.send`、`messaging.forward`、`model.respond` 以及所有 `agent.*` 注册项。不要从消息、人格或模型输出拼接模块名、注册表或新授权。

## 入站路由与响应归属

把同步 `createMessageRouter({ rules, defaultRoute })` 传给 `createBridgeHost` 的 `routeIncoming`。规则用唯一 id、数值 priority、route、relayToAgent 与 selector 描述，由上层提供匹配条件，不自带 NLU 或模型意图识别。例如在 host 创建前定义：

```ts
const routeIncoming = createMessageRouter({
  rules: [{ id: 'work-prefix', priority: 100, route: 'work', relayToAgent: false,
    selector: message => message.content.some(block => block.type === 'text' && block.text.startsWith('/work ')) }],
  defaultRoute: { route: 'chat', relayToAgent: false },
});
```

在上述 host options 中加入 routeIncoming，再分别用 `host.engine.install(withMessageRoute(chatFeature, 'chat'))` 与 `host.engine.install(withMessageRoute(workFeature, 'work'))` 安装响应者。旁观功能正常安装，不加包装。这样仍广播同一 message.received，只在响应处理器入口做归属过滤；包装功能的 trigger 等其他事件不受影响。

selector 收到冻结消息，必须严格返回 boolean。较大 priority 优先，最高匹配优先级同级多命中拒绝；异常、Promise、非 boolean 不能降级成默认成功，真正无命中才用 defaultRoute。若由内置 agent-relay 接管某 route，应明确设 relayToAgent 为 true，并避免同时安装该 route 的另一回复者；路由不代替 agent.submit/messaging.send 授权，也不改变 directed/isSelf 检查。

## 日历触发

`createCalendarTriggerService` 是需显式装配和驱动的 daily/weekly 服务，不是完整 cron。规则必须带 IANA timeZone、明确 DST overlap（earlier/later）与 nonexistent（skip）、windowMs、misfire（skip/coalesce）及 JSON payload，不能借用进程默认时区或无限补历史。

callback 可把 occurrence.id 映射为事件 id、scope 映射为 conversationId，`await host.engine.emit` 投递 `trigger.fired`，并传递取消信号与合适的有效期；功能仍通过 SDK 和既有 grant 发送。窗口外不执行，窗口内每规则只处理最新一次，coalesce 额外报告被合并次数。具体默认值和窗口限制见 [公共契约](CONTRACTS.md#日历触发)。

启动时循环调用 `recoverInterrupted` 直到 next 为 null，再由应用自己的 timer 调用 `tick`；bridge 的 taskTickMs 不会自动驱动 calendar。停止 timer 后调用服务 stop，再停止 host/关闭 store。更改规则或启停会推进 generation，旧 callback 只有协作取消，不代表已开始的外部发送被回滚。遗留 running 变 unknown，不自动重放。

## 管理挂载点

宿主可把受限管理路由显式交给管理服务器：

```ts
const server = createAdminServer({
  token,
  snapshot,
  routes: createHostAdminRoutes(host),
});
```

自定义 `AdminRoute` 仅支持 `GET` / `POST` 的 `/api/...` 路径，不能覆盖内建入口。处理器接收解析后的 query、POST JSON body 和断连取消信号；认证、同源检查、请求/响应大小限制由服务器统一执行。`createHostAdminRoutes` 只读返回宿主计数、sessions/tasks/outbox/replies 分页元数据及 `GET /api/host/storage` 统计；后者通过 host.storageStats 转交可选 store.stats，未实现时返回 null。不提供权限变更、正文、自动清理 unknown 或重试入口。

## Agent 消息筛选

不同 SDK 的 `assistant/message` 可能包含中间工作文本，并不天然等于 turn 完成或可公开回复。宿主可配置同步 `selectAgentMessage(event, binding)`，读取事件原始 `data` 后返回允许发送的消息块，或以 `null` 跳过出站和发送预算；未配置时保留普通 relay。具体筛选策略由 operator 按外部协议定义，不应把旧业务人格或工具隐藏规则硬编码进框架。

需要异步准备时，另外配置 `agentMessagePreparation: { capabilities, prepare(execution, event) }`。它在标准 agent-relay 的引擎处理器中运行，允许 await execution.invoke/generate，返回内容后继续原 send/outbox 流程，null 则不发送；不必卸载 relay 或在同步 selector 中塞 Promise。额外 capabilities 只是 manifest 声明，仍需给 agent-relay 对应的有限 grant。只向 hook 提供 context/signal/invoke/generate，不提供 send/state/store；可信 hook 应通过受控 invoke 接入 presentation，不直接绕过授权调用 renderer。

仅配置该 hook 时原始 AgentEvent.data 进入 event.data.agentData，DSH metadata 的字段映射由适配端/上层约定并校验，不是框架自动 NLU，也不是授权依据。无文档表达标记时原样返回规范 event.data.content 即可保持普通格式；无准备 capability 授权时 invoke 不会触发渲染。hook 返回 null 不是已回复，不能靠它清除首回复等待；异常也不代表可安全重放。

## 资源消息

功能发送图片、音频或文件时只提交已经登记的 `assetId`。功能不应传递任意绝对路径、读取资源内容或猜测 transport 支持情况。资源目录与 transport 负责解析、类型校验、大小限制和生命周期。

新引擎自动携带实际人格 `{ id, version }` 的 OutboundScope，经 durable outbox 传给 OneBot resolver；不要在功能 body 中伪造 persona。资源登记使用完整 `id@version`，按需绑定 sessionId/generation，并在需要时由 resolver 传 expectedVersion。默认不绑 session 的批准历史资料可以复用；旧请求 scope 可选只是兼容，不会把旧资源自动升级为隔离资源。`registry.get` 只看脱敏元数据，读取真实定位仍走 resolve。

forward 是唯一外层块，节点只含普通 content，不能混发、嵌套或指定发送者。除了 messaging.send，manifest 和有限 grant 都必须有 messaging.forward；operator 还须在 OneBot `forward` 配置中固定 senderId/senderName，并分别显式开启 group/private 扩展。模型不能决定伪造的发送者姓名或 QQ 号，网关兼容性仍须单独验收。

## 文档表达

用 `createPresentationService` 准备 text、markdown-image 或 forward，再由功能 `execution.send` 发送；需要 SDK 授权入口时将 `createPresentationEffect(service)` 注册为自定义 capability。prepare 可渲染与发布图片，但无发送副作用。不可将该 effect 的授权当作 messaging.send 或 messaging.forward 授权。

选择器 `select` 是可选挂载点，不是固定人格、模型或聊天推断器。显式 format 不能被偷偷改写，仅 `fallback: 'text'` 允许明示文本降级；reply 的 near/far/uncertain 由调用方提供距离与年龄，近消息 auto 不引，不确定且无 selector 不引。标准 relay 可用上述 agentMessagePreparation 调用准备 effect；`selectAgentMessage` 仍只负责同步过滤。具体最小接线、browser/字体与 Linux publisher 限制见 [文档表达](PRESENTATION.md)，不要另外安装重复发送相同 agent.message 的响应者。

## 生命周期规则

- `setup` 和清理函数保持同步；异步准备工作放在宿主装配阶段完成。
- 处理器应 `await` 每个副作用并处理 `confirmed`、`rejected`、`unknown`。
- 收到 `signal.aborted` 后尽快停止本地工作，但不要假定外部动作已撤销。
- 处理器返回后不要保存并复用 `FeatureExecution`。
- 不要从自己的处理器等待自身卸载或引擎停止。
- 状态值必须是 JSON 数据，并在读取后按业务 schema 校验。

## 开发流程

1. 明确输入、输出、状态、资源、授权和失败终态。
2. 优先写独立功能；只有多个功能共同需要时才扩展宿主或核心。
3. 用替身测试功能，再用真实引擎验证授权拒绝、背压、取消、重复与卸载。
4. 外部适配器分别验证认证、序列化、限速、回执和恢复。
5. 运行：

```sh
npm run check
npm test
npm run test:built
```

管理演示页不是代码上传、授权审批或生产部署入口。

候选 release 激活/回滚、业务 schema 迁移、可恢复长 job 控制面与完整 retention 治理仍需独立建设；不应把新增功能或表达挂载点称为已经完成自主迭代发布。
