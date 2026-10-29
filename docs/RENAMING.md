# 项目名称与兼容升级

从 v1.4.0 起，项目名称为 **QQ Bridge Framework**，仓库为 [sophisticate9008/qq-bridge-framework](https://github.com/sophisticate9008/qq-bridge-framework)。此前名称为 QQ Agent Framework。

## 仓库与安装目录

已有工作副本可以更新远程地址：

```sh
git remote set-url origin git@github.com:sophisticate9008/qq-bridge-framework.git
```

安装目录由部署者选择，已有目录可以继续使用。运行数据、服务清单、会话工作目录及系统日志轮转配置继续使用实际登记的路径；改项目名不要求搬迁目录。新安装默认克隆到 `qq-bridge-framework/`。

## SDK 与 DSH 桥接插件

Release 同时提供四个安装包，所有包均为 `1.4.0`：

| 用途 | 包名 | 安装包 |
| --- | --- | --- |
| SDK | `@qq-bridge-framework/sdk` | `qq-bridge-framework-sdk-1.4.0.tgz` |
| DSH 桥接插件 | `@qq-bridge-framework/dsh-bridge-plugin` | `qq-bridge-framework-dsh-bridge-plugin-1.4.0.tgz` |
| SDK 旧导入兼容 | `@qq-agent-framework/sdk` | `qq-agent-framework-sdk-1.4.0.tgz` |
| DSH 旧加载名兼容 | `@qq-agent-framework/dsh-bridge-plugin` | `qq-agent-framework-dsh-bridge-plugin-1.4.0.tgz` |

新项目使用新包名。已有扩展或 DSH 装配可以安装旧包名兼容包，保留原 import、依赖键与 Loader 配置；兼容包与对应新名包包含相同编译代码和公开导出。请先更新框架，再加载 1.4.0 桥接插件。

选择迁移包名时，SDK 的所有导入路径和依赖键一起更新；DSH 的安装依赖与 Loader 名称一起更新，同一实例只加载一份桥接插件。包名迁移可单独安排，不要求修改已有会话和数据。

## 稳定接口

`qaf_*` 工具名、`qaf.*` 与 `qq-agent-framework.*` 线协议和持久标识、内置工具的来源 ownerId、服务管理器的 `kind`、环境变量、浏览器偏好键继续使用已有值。它们用于协议协作、来源和数据身份，不随产品名称改写。

`npm run cli -- ...`、`qq-agent` 与运维命令 `qqagent` 继续可用；包清单另提供 `qq-bridge-framework` CLI 入口，指向同一命令行程序。现有 `boot` 与服务管理配置继续使用 `qqagent`。

## 生成发布包

准备根项目和桥接插件依赖后，在仓库根目录执行：

```sh
npm run build
npm run build:sdk
npm --prefix packages/dsh-bridge-plugin run build
npm run release:pack
```

打包器核对组件版本和插件报告版本，从包文件白名单生成新名与兼容安装包，并在 `runtime/releases/v<版本>/` 写入 `SHA256SUMS`。旧版本附件留存在对应 GitHub Release，历史发布记录中的文件名仍指向原安装包。
