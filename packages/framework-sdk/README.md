# QQ Agent Framework SDK

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

在独立扩展项目中安装生成的 `qq-agent-framework-sdk-1.1.0.tgz`。本版本通过本地 tarball 使用，不要求从 npm 公共注册表安装同名包。运行环境为 Node.js 24.12.0 或更新版本。

## 导出入口

| 导入路径 | 内容 |
| --- | --- |
| `@qq-agent-framework/sdk` | 核心功能与上下文契约 |
| `@qq-agent-framework/sdk/core` | 核心运行与策略 |
| `@qq-agent-framework/sdk/host` | 宿主、功能包及生命周期 |
| `@qq-agent-framework/sdk/contracts` | 公共 DTO 与运行时解码 |
| `@qq-agent-framework/sdk/adapters` | 适配器接口与实现导出 |
| `@qq-agent-framework/sdk/storage` | 持久存储与 CAS |

完整示例、内容指纹、状态迁移、权限和多账号接入见 [扩展开发](https://github.com/sophisticate9008/qq-agent-framework/blob/main/docs/EXTENDING.md)。功能声明与安装不授予权限，可信本机扩展在宿主进程中执行；外部副作用仍经宿主与 policy。

源码许可见随包 `LICENSE`，来源与第三方许可见随包 `NOTICE.md`。
