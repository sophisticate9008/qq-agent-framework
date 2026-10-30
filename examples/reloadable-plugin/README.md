# 可重载服务示例

本示例把工具、服务发布、日程和资源清理固定在 `index.ts`，将可替换行为放入 `behavior/`。行为模块只声明方法，不登记工具、不启动计时器、不执行外部动作。示例只保存本地执行结果。

在本目录安装当前框架构建的 SDK 包，再将 `index.ts` 作为可信 bootstrap 显式装配。宿主需要提供 `plugin-runtime` 包；本示例声明依赖其中的工具、日程和扩展登记服务。SDK 的准备方式见 [SDK 说明](../../packages/framework-sdk/README.md)。

```sh
npm install /本机路径/qq-bridge-framework-sdk-1.5.1.tgz
```

启动后通过二级能力目录查找 `extension.reloadable-example.status` 或 `extension.reloadable-example.run`，读取具体参数后调用。每日 UTC 09:00 的固定日程也会调用同一行为。两种入口都在本地保存结果，不发送 QQ 消息。

修改 `behavior/index.ts` 中的文案或业务处理，保留契约标识、版本和方法集合，再通过已有运维入口应用：

```sh
qqbridge-framework extensions
qqbridge-framework extensions reload reloadable-example
```

新调用进入新行为；已经开始的工具或日程调用保留旧代直到完整 Promise 结束。导入、契约或方法校验失败时旧实现继续使用，重载状态记录错误。清理失败仍通过原扩展管理器保留排空状态，不能据此盲目重试写操作。

`contract.ts` 与固定入口中的 schema、依赖和注册结构属于稳定装配。改变这些内容后应完整应用插件；仅重载 `behavior/` 不更新工具目录或调度规则。异步服务代理只提供明确列在 `asyncMethods` 中的 Promise 方法；同步接口通过 `manager.withCurrent` 手动借用，不改变原方法的同步返回类型。详见 [服务重载契约](../../docs/RELOADABLE_SERVICES.md)。
