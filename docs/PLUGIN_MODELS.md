# 插件模型与持久会话

可信插件通过宿主注入的 `PluginModelClient` 调用 DSH 中已配置的供应商和模型。供应商凭据由宿主与 DSH 管理，模型列表只返回供应商和模型标识、显示名称。插件身份由加载器注入，不接受模型或 QQ 消息自报的插件身份。

## 插件调用

宿主通过 `createPluginModelService(options).forPlugin(packageId, lifetimeSignal)` 提供客户端。实际插件上下文中的服务入口见[扩展开发](EXTENDING.md)。

```ts
const models = await client.models()
const result = await client.run({
  name: 'daily-writing',
  conversationId: 'group:123456',
  prompt: '根据之前讨论的主题，起草一段新文案。',
  model: { provider: models[0]!.provider, model: models[0]!.model },
})
// result.text 返回插件；发布或发送由插件显式调用对应宿主能力。
```

`run` 默认使用持久会话。绑定键由插件身份、名称（默认 `default`）和可选 QQ 会话地址共同组成；第一次调用自动创建实际 DSH 会话并保存绑定，之后复用该上下文。地址用于区分插件自己的上下文，绑定固定指向一个实际会话 ID。QQ 解绑或换到新会话不会让插件跟随切换。

插件自建会话只使用插件任务指令与自身历史。模型请求组装时清空部署附加的人设、聊天方案和上下文贡献，避免带入 QQ 聊天身份；显式绑定已有会话时沿用该会话原本的上下文。

`client.bind({ sessionId, name?, conversationId? })` 可绑定已有实际会话，绑定时只读核验目标存在；`client.create(...)` 明确创建新会话并更换绑定；`client.unbind(...)` 解除绑定并保留旧历史，下一次持久调用自动创建新会话。`client.list()` 返回当前插件的绑定与本地状态。

`run({ mode: 'stateless', prompt, model? })` 每次创建独立实际会话，不更换持久绑定。宿主仍登记该会话的插件来源，供会话管理发现。插件业务数据应通过持久存储管理，不要求每次重复输入全部业务记录。

调用结果包含 `requestId`、`sessionId`、`text` 和实际 DSH 终态提供的 `usage`。返回正文不会自动发送到 QQ。默认正文上限 32000 个 UTF-16 码元，可指定 `maxOutputChars`（1 至 64000）；适配器原有正文容量也继续生效。输入最多 128000 个码元、256 KiB。默认期限五分钟，可指定 `timeoutMs`（一秒至一小时，包含排队时间）。超出正文容量仍保留终态用量，不返回截断正文冒充成功。

## 宿主装配与来源

宿主传入 `store`、`backend: dsh.pluginModels` 和 `withSessionLease`；统一会话队列必须覆盖 QQ、助手与插件对同一实际会话的写入。`defaultModel` 可提供固定选择或读取当前配置的函数；未指定时使用实际 DSH 模型目录的首项。`onUsage` 收到插件身份、执行标识、实际会话和有界终态用量，供账本记录。

DSH 桥接包提供 `pluginModels`、`createPluginModelSession`、`inspectPluginModelSession`、`startPluginModel`、`waitPluginModelIdle`、`inspectPluginModelRun` 六个管理 RPC，只接受已认证的 DSH owner 调用。插件输入持久标记 `source.kind: qaf-plugin`、插件 ID 与请求 ID，不产生 QQ 发言者或主人消息。已有会话沿用历史和原有组成；本次纯模型生成会移除模型输入中的全部工具 schema，并通过 SDK 的单调工具 guard 拒绝执行，包括历史和会话局部登记的工具。限制持续到实际 agent 完全空闲后才撤销。

宿主先建立结果监听，再提交请求；同一实际会话串行，生成结束并确认 DSH 排空后才释放队列。生命周期停止后拒绝新调用。临时连接失败、提交结果未知或中断均保留原绑定，阻止同一会话继续写入；不通过新建会话绕过未知结果，也不自动重放请求。

绑定与实际会话的服务内部队列分别串行，最多容纳 256 个执行或等待项，同一队列键最多 16 项，满载返回 `PLUGIN_MODEL_QUEUE_FULL`。等待支持调用方取消；取消项仍保留原来的队列位置，直到前序操作结清，避免后来的请求越过正在执行的操作。插件与管理入口均合并宿主生命周期信号，运行停止后取消等待并拒绝新管理写入。

若原执行已经结清，且下一次调用只读核验明确返回实际会话不存在，服务才会自动创建替代会话；绑定的 `contextRestartedFrom` 记录旧会话 ID，表明本次上下文重新开始。连接异常、鉴权异常或未取得确认结果均不视为会话删除。

## 会话管理

服务的 `listBindings(owner?)` 与 `listManagedSessions(owner?)` 只读本地持久记录；后者包含已解绑及单次生成创建的会话来源。绑定 DTO 提供实际存储 `revision`、`busy`、`state`、模型与使用时间。管理入口可调用 `models(signal)` 显式读取实际模型目录。

`bind(owner, request, signal)`、`create(owner, request, signal)`、`unbind(owner, key, signal)` 接受 `expectedRevision`；`null` 表示期望当前不存在绑定，数值表示精确版本。管理入口负责认证和选择插件目标，服务在绑定串行锁内核对版本；忙碌或执行未决时拒绝变更。已绑定的共享会话必须同时展示 QQ 和插件引用，删除会话历史前应核对这些引用。

`reconcile(owner, key, signal)` 核对未知状态，沿用相同的版本校验。执行对账只读实际 DSH 会话日志，核对插件身份、请求标识、被认领的消息与所属轮次；仅当该轮已有终态、整个会话实际空闲且没有待处理输入时才解除隔离，并记录实际用量。没有认领证据或仍在执行时保持未知，不重新调用模型、不发送旧输出。创建结果未知时只核验原会话 ID；确认存在后恢复可用，未确认存在时保留原记录。宿主可通过 `isSessionBusy` 合并 QQ 与插件的当前占用状态。

配置、协议与工具的额外副作用通过插件对应的宿主能力服务执行。可信本机 TypeScript 插件在宿主进程内运行，这些接口用于组织身份、生命周期和可管理状态。

独立助手的工作子会话由工作调度器专用，不接受插件或 QQ 换绑，避免影响助手工具和工作生命周期；需要共享上下文时绑定 QQ 主会话，或为插件建立独立会话。
