# 命名统一与升级

从 v1.4.1 起，框架、SDK、DSH 桥接插件及本机接入统一使用 **QQ Bridge Framework** 名称。仓库为 [sophisticate9008/qq-bridge-framework](https://github.com/sophisticate9008/qq-bridge-framework)。

## 当前命名

| 范围 | 当前名称 |
| --- | --- |
| 仓库、安装目录 | `qq-bridge-framework` |
| SDK | `@qq-bridge-framework/sdk` |
| DSH 桥接插件 | `@qq-bridge-framework/dsh-bridge-plugin` |
| 应用 CLI | `qq-bridge-framework`，或 `npm run cli -- ...` |
| 服务运维 | `qqbridge-framework`，仓库入口 `ops/qqbridge-framework` |
| 环境变量 | `QQ_BRIDGE_FRAMEWORK_*` |
| 框架工具 | `qbf_*`，例如 `qbf_reply` |
| 通信及媒体协议 | `qq-bridge-framework.*`、`qbf.*` |
| 默认 DSH 配置命名空间 | `qqbf`、`qqbfwork` |

本版只提供新名称的 SDK、DSH 桥接插件两个安装包和 `SHA256SUMS`。运行时仅识别 1.4.1 桥接插件及新协议；工具、命令、环境变量与包名均采用上表名称。

## 已有部署升级

这次是完整命名迁移，框架、DSH 桥接插件及调用方需要一起更新。维护者明确指定本次版本为 `1.4.1`，并不代表可以把新旧协议混用。

1. 核对当前任务已结束，停止聊天及框架服务、DSH 和依赖安装目录的辅助进程。保存配置、数据库、DSH profile、凭据及会话目录的私有备份。
2. 更新 SDK 导入、桥接插件依赖与 Loader 名称，以及插件对框架工具名、来源标识和协议字段的引用。卸载旧名称的包和命令链接，安装本版两个新包。
3. 同步本机安装目录、服务清单、启动脚本、工作目录、扩展依赖链接、日志轮转及浏览器工具链配置。`boot` 调用 `qqbridge-framework`。
4. 将托管 DSH 配置中的框架命名空间、预设引用、工具名及系统提示词同步为当前名称；同步凭据引用而不替换凭据值。已有会话的配置元数据、工作目录和框架绑定必须与新配置对应，保留会话 ID 与历史正文。离线迁移 DSH v4 压缩日志时须保留独立头部帧及事件帧，重新压缩后核对解码内容，并通过 DSH 存储与历史读取接口验证全部会话。
5. 对已有配置基线与部署记录重新核对摘要。采用正常配置应用流程核验 DSH 实际加载状态；不能仅替换字符串后跳过配置身份、绑定和内容指纹检查。
6. 启动 DSH 与辅助服务，再启动框架；用 `qqbridge-framework doctor` 核对服务、QQ 登录、插件协议和聊天状态。检查会话绑定、后台工作、插件日程和模型用量仍可读取。

旧协议的未结执行必须先核对并处理，不能通过更名重发。历史发布记录、回退备份、会话 ID 和历史正文作为已有数据留存，不注册旧名称的运行入口。

## 生成发布包

准备根项目与桥接插件依赖后，在仓库根目录执行：

```sh
npm run build
npm run build:sdk
npm --prefix packages/dsh-bridge-plugin run build
npm run release:pack
```

两个组件的安装包与 `SHA256SUMS` 输出到 `runtime/releases/v<版本>/`，打包时核对文件白名单和版本。已发布历史版本仍由对应 GitHub Release 留存。
