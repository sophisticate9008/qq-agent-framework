# 稳定服务与可替换行为

`createReloadableService` 复用现有扩展管理器，保持服务代理身份不变，在源码候选通过校验后切换实现。插件依旧使用 `createExtensionModuleLoader` 加载可信本机模块，使用宿主扩展登记服务接入现有 `qqagent extensions` 运维入口。

```ts
const { service, manager } = await createReloadableService({
  id: 'example', displayName: '示例行为', contract: EXAMPLE_CONTRACT,
  asyncMethods: ['execute'], signal: context.signal,
  load: signal => prepareCandidate(signal)
});
context.own('other', 'example-manager', () => manager.close());
context.own('subscription', 'example-registration', extensions.register(manager));
```

`load` 返回 `{ revision, contract, value, dispose? }`。`revision` 是现有加载器给出的源码指纹；`contract` 为候选自己声明的公共契约，`value` 为方法实现。宿主先固定预期契约，再比较标识、版本和排序后的方法集合指纹，并检查候选是否提供全部必需方法。契约描述的文案不参与兼容性指纹。参数与返回值的含义仍由接口类型和边界解码负责，修改语义或 schema 时需要维护相应契约版本。

候选准备与模块求值只声明行为，不能登记工具、启动循环或执行外部写入。导入或契约校验失败会保留原实现；校验失败的候选沿现有管理器的 `discard` 路径清理。清理失败保留错误与排空状态，后续重载继续服从原管理器的代数和清理限制。

## 异步方法的自动租约

`service` 只提供显式列入 `asyncMethods` 的 Promise 方法，其方法名同时受到 TypeScript 异步返回类型和公共契约方法集合约束。调用时借用当前实现，以该实现作为 `this` 执行方法，直到它返回的 Promise 实际兑现或拒绝后才归还租约。调用方停止等待或自行超时不会提前释放仍在运行的旧实现。

自动代理不会将同步方法暗中改成 Promise。声明为异步方法却在运行时返回同步值时，该调用明确失败。带同步方法的接口可以保留原类型，并用 `manager.withCurrent(value => ...)` 为一段工作手动持有实现；`manager.current()` 仅适合同步检查，不能保留后继续执行后台任务。

固定工具或调度入口可使用 `createReloadableHandler(manager, callback)`。回调收到租用的业务实现及原始调用参数，返回的 Promise 决定租约的实际结束时间：

```ts
const handler = createReloadableHandler(manager, async (behavior, occurrence) => {
  occurrence.signal.throwIfAborted();
  const result = await behavior.execute(occurrence.payload, occurrence.signal);
  await saveResult(result, occurrence.signal);
});
```

将完整任务 Promise 返回给包装器；脱离返回值另行启动的后台工作不在这份租约内。工具名称、参数 schema、权限、日程标识和回调登记保留在稳定入口，重载只替换方法行为。原有权限、幂等键、发生记录和 unknown 不重放语义仍由对应宿主服务执行。

## 装配与清理

功能包声明对 `plugin-runtime` 及所需具体服务契约的依赖，通过 `useService` 获取工具、日程与扩展登记服务。扩展登记标识应使用本包标识；登记只用于维护状态，不增加业务权限。

用 `context.own` 管理重载管理器、登记撤销函数、工具及调度 handler。停止时先撤销稳定入口，再等待已有调用排空并关闭管理器。模型工具 schema、依赖或注册结构的变化应完整应用插件装配；相同业务契约内的实现修改才使用代码重载。

可运行的 SDK 示例位于 [examples/reloadable-plugin](../examples/reloadable-plugin/README.md)，同时演示稳定服务发布、固定模型工具与每日调度入口。加载器最多保留 64 代源码，共享未变化的源码文本，默认去重源码总预算 64 MiB（`maxRetainedSourceBytes` 可配置，最大 512 MiB）；旧任务的延迟 import 仍读取所属代次，达到上限或清理未知时使用现有维护语义，不另建重载管理器。
