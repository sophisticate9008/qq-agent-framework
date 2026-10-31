# QQ Bridge Framework SDK

面向 TypeScript 扩展的功能、宿主、生命周期、适配器、持久状态与存储契约。SDK 包不包含管理服务器和网页。

## 构建与安装

在框架仓库根目录运行：

```sh
npm ci
npm run build:sdk
artifact_dir="$(mktemp -d)"
npm pack ./packages/framework-sdk --ignore-scripts --pack-destination "$artifact_dir"
printf '安装包目录：%s\n' "$artifact_dir"
```

在独立扩展项目中安装生成的 `qq-bridge-framework-sdk-1.7.0.tgz`。本版本通过本地 tarball 使用，不要求从 npm 公共注册表安装同名包。运行环境为 Node.js 24.12.0 或更新版本。


## 导出入口

| 导入路径 | 内容 |
| --- | --- |
| `@qq-bridge-framework/sdk` | 核心功能与上下文契约 |
| `@qq-bridge-framework/sdk/core` | 核心运行与策略 |
| `@qq-bridge-framework/sdk/host` | 宿主、功能包及生命周期 |
| `@qq-bridge-framework/sdk/contracts` | 公共 DTO 与运行时解码 |
| `@qq-bridge-framework/sdk/adapters` | 适配器接口与实现导出 |
| `@qq-bridge-framework/sdk/storage` | 持久存储与 CAS |

完整示例、内容指纹、状态迁移、权限和多账号接入见 [扩展开发](https://github.com/sophisticate9008/qq-bridge-framework/blob/main/docs/EXTENDING.md)。功能声明与安装不授予权限，可信本机扩展在宿主进程中执行；外部副作用仍经宿主与 policy。

## 服务与热重载

`host` 导出 `defineServiceContract`、`serviceDeclaration`、`publishService`、`publishScopedService` 和 `useService`，以及内置 `*_SERVICE_CONTRACT` 常量。包声明提供方依赖及需要的服务后，取得按生命周期检查的类型化接口。模型、协议、会话、日程、工具、媒体、用量、观察事件和重载登记均可通过 `plugin-runtime` 提供的契约接入。

`createReloadableService` 为异步方法维护稳定入口，`createReloadableHandler` 将工具及定时回调绑定到当前实现；旧调用结束后再释放旧版本。工具 schema、依赖或注册结构变化需要完整应用。参见[服务规范](https://github.com/sophisticate9008/qq-bridge-framework/blob/main/docs/SERVICE_CONVENTIONS.md)及[可运行的插件示例](https://github.com/sophisticate9008/qq-bridge-framework/tree/main/examples/reloadable-plugin)。

日程客户端支持可选 `presentation` 与 `registerDetailsProvider`，为任务列表登记友好名称、同步业务摘要、只读详情及明确支持的业务跳过回调；宿主管理暂停单独持久保存。`contracts` 导出 `PluginScheduleSnapshot`、`PluginScheduleDetail`、历史与管理动作 DTO，以及对应 `parsePluginSchedule*` 严格解码函数；`host` 导出详情提供方类型和 `createPluginScheduleReader`。见[持久定时任务](https://github.com/sophisticate9008/qq-bridge-framework/blob/main/docs/TRIGGERS.md)。

源码许可见随包 `LICENSE`，来源与第三方许可见随包 `NOTICE.md`。
