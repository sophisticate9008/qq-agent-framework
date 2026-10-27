# QQ Agent Framework

面向 QQ 会话的可扩展智能体框架。OneBot 负责消息接入与发送，DSH 负责模型会话和工作执行，框架负责输入上下文、权限、扩展生命周期、持久任务及执行恢复。网页控制台用于配置、统计和维护；模型提问在所属 QQ 会话内完成。工具随会话白名单开放，敏感操作核验真实主人身份，无需逐次批准。

当前提供昵称和引用唤醒、有界连续聊天、按需媒体读取、后台工作与结果回传、记忆与偏好、带时区的提醒、富媒体输出、多账号隔离，以及独立 TypeScript SDK。每项能力同时受实际安装状态、依赖和授权限制，界面会显示缺失条件。

## 本机启动

需要 Node.js **24.12.0 或更新版本**、npm，以及独立运行的 OneBot 服务和 DSH。在项目目录执行：

```sh
npm ci
npm run build
npm run cli -- init
npm start
```

首次打开 `http://127.0.0.1:3210` 完成管理令牌初始化。随后按“连接 → 模型与人设 → 主人与访问范围 → 核对并启用”配置。初始化不会允许任何会话发送消息。默认 OneBot 上游为 `http://127.0.0.1:3000`，独立网关监听 `127.0.0.1:3131`；这些地址不表示外部服务已经安装或启动。

本机 DSH 优先自动发现并使用本机鉴权。应用聊天方案会识别实际配置层与模型元数据；远程接入在高级设置。DSH 插件的安装与加载见 [DSH 接入](docs/DSH.md)。

## 文档入口

| 需要做什么 | 文档 |
|---|---|
| 安装、运行、诊断、测试 | [运行手册](docs/OPERATIONS.md) |
| 后台服务、boot、日志与协议切换 | [服务运维](docs/SERVICE_MANAGER.md) |
| 模拟QQ消息、主人与群友真实链路验证 | [本机QQ模拟](docs/SIMULATION.md) |
| Markdown 排版、公式与图片回复 | [内置图片排版](docs/MARKDOWN.md) |
| 开启视频抽帧与了解观察范围 | [视频观察](docs/VIDEO.md) |
| 观看动图与原样发送 GIF | [GIF 观看与发送](docs/GIF.md) |
| 了解配置入口与操作流程 | [控制台](docs/UI.md) |
| 接入 DSH、工具与工作会话 | [DSH 接入](docs/DSH.md) |
| 接入空间发布与跨协议扩展 | [空间适配](docs/QZONE.md) |
| 理解产品目标与边界 | [目标](docs/GOALS.md) |
| 修改公共接口、权限或持久状态 | [契约](docs/CONTRACTS.md) |
| 理解模块职责和依赖 | [架构](docs/ARCHITECTURE.md) |
| 编写扩展、服务、协议与多账号适配 | [扩展开发](docs/EXTENDING.md) |
| 处理超时、未知执行、迁移与恢复 | [恢复手册](docs/RECOVERY.md) |
| 查看本轮测试结果及验证范围 | [验收记录](docs/VALIDATION.md) |
| 核对本轮交付的 80 项需求 | [迭代清单](docs/IMPROVEMENT_CHECKLIST_2026-10-25.md) |

开发前阅读 [AGENTS.md](AGENTS.md)、目标与契约。修改对应公开行为时同步更新文档，并按范围执行检查。许可见 [LICENSE](LICENSE)，来源与致谢见 [NOTICE.md](NOTICE.md)。
