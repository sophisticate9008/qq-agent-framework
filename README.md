# QQ Bridge Framework

面向 QQ 群聊与私聊的可扩展智能体框架，提供中文控制台、连续聊天、按需媒体读取、后台助手及持久执行记录。OneBot 接入 QQ，DSH 管理模型会话，框架负责上下文、访问权限、工具调用和结果回传。

AI许愿生成的，目前自用

控制台用于配置、统计和维护。模型提问发到所属 QQ 会话，由实际配置的主人在 QQ 内答复；工具随会话白名单开放，敏感操作核验真实主人身份。
<img width="1917" height="933" alt="image" src="https://github.com/user-attachments/assets/0817d566-594b-40f7-8565-3521cd9a2eab" />
<img width="1900" height="940" alt="image" src="https://github.com/user-attachments/assets/a3e4f7bb-90cf-4f02-a360-2d002f73eec0" />



## 安装与开始使用

需要 **Node.js 24.12.0 或更新版本**、npm、已登录 QQ 的 OneBot v11 协议端，以及与桥接插件兼容的独立 DSH 实例。Linux 支持本机 DSH 自动发现；Windows/macOS 需要按高级接入方式配置，当前未提供同等运行验收保证。

```sh
git clone https://github.com/sophisticate9008/qq-bridge-framework.git
cd qq-bridge-framework
npm ci
npm run build
npm run cli -- init
npm start
```

打开 `http://127.0.0.1:3210`，完成管理令牌初始化。依次配置 QQ 与 DSH 连接、模型服务、人设和聊天方案、主人及会话白名单，最后应用并启用聊天。

首次安装请完整阅读 [安装教程](docs/INSTALL.md)，其中包含外部依赖、端口、QQ 收发连接和 DSH 桥接插件的准备步骤。初始化只创建框架配置，不安装协议端或 DSH；允许会话列表初始为空。

## 当前功能

| 功能 | 当前行为与条件 |
| --- | --- |
| 会话任务 | 会话动态创建定时、事件或依赖任务，触发后回到原会话接续执行，支持检查点、子任务与结果核对；见 [会话任务与续聊](docs/CONVERSATION_TASKS.md) |
| 日常聊天 | @、昵称、引用和短时续聊进入参与判断，群聊合并未读后选择性发言；提供可编辑的“小鲸鱼”人设与日常聊天方案模板 |
| 图片、文件与转发 | 按需读取当前会话资源；图片需要模型支持看图，语音转写需要外接服务 |
| GIF 与视频 | GIF 与视频可固定选择 V1 单帧或 V2 四宫格均匀抽样；视频观察默认关闭，需 FFmpeg/FFprobe，均不分析音轨 |
| QQ 回复与交互 | 文字、图片、语音、文件、QQ 表情、收藏表情、分气泡、长文转发，以及协议支持的戳一戳、撤回和修改自身群名片 |
| Markdown 图片 | 本机排版中文、表格、代码和公式，生成最多六页 PNG，无需浏览器 |
| 后台助手 | 配置并启用独立助手后，主人可从 QQ 委派、追加、查询和停止工作，结果与实际附件回传原会话 |
| 空间说说 | 依据协议实际能力登记发布、删除工具；支持文字、图片和图文，未知结果不自动重试 |
| 记忆、偏好与提醒 | 提供内置持久服务，由扩展接入业务、工具和上下文；默认不向模型注册记忆及提醒工具 |
| 扩展与多账号 | TypeScript SDK、功能包、宿主服务、可登记的扩展热重载及独立账号数据目录 |
| 任务与日程 | 插件任务与执行记录、持久暂停／恢复、支持的单次任务跳过，以及业务结果详情 |
| 运行维护 | 会话与执行记录、用量估算、逐会话诊断、未知结果核对和后台记录维护 |

安装、注册、就绪与授权分别显示。实际能力以所选模型、协议端、DSH 插件和已加载扩展为准。使用示例和限制见 [使用教程](docs/USAGE.md)。

当前版本为 **v1.6.0**（框架、SDK 与 DSH 桥接插件统一为 `1.6.0`），安装包、兼容范围与限制见 [发布说明](docs/RELEASE_NOTES.md)。

## 文档

| 需要做什么 | 文档 |
| --- | --- |
| 从零安装、准备依赖和首次连接 | [安装教程](docs/INSTALL.md) |
| 聊天、媒体、助手、权限与日常设置 | [使用教程](docs/USAGE.md) |
| 运行命令、升级、备份与诊断 | [运行手册](docs/OPERATIONS.md) |
| 后台服务、日志与协议切换 | [服务运维](docs/SERVICE_MANAGER.md) |
| 控制台页面、草稿与应用 | [控制台](docs/UI.md) |
| DSH 兼容版本、插件安装与加载 | [DSH 接入](docs/DSH.md) |
| 本机模拟 QQ 消息 | [本机 QQ 模拟](docs/SIMULATION.md) |
| 排版、视频、动图与空间 | [图片排版](docs/MARKDOWN.md) · [视频](docs/VIDEO.md) · [GIF](docs/GIF.md) · [空间](docs/QZONE.md) |
| QQ 协议基础能力与尚未接入项目 | [QQ 能力清单](docs/QQ_CAPABILITIES.md) |
| 插件能力分层与会话服务设计 | [设计文档](docs/PLUGIN_CAPABILITIES_AND_SESSIONS.md) |
| 框架服务契约、依赖与生命周期 | [服务规范](docs/SERVICE_CONVENTIONS.md) |
| 插件热重载与完整示例 | [热重载服务](docs/RELOADABLE_SERVICES.md) · [示例](examples/reloadable-plugin/README.md) |
| 编写扩展及使用 SDK | [扩展开发](docs/EXTENDING.md) · [SDK](packages/framework-sdk/README.md) |
| 插件调度与业务示例 | [持久定时任务](docs/TRIGGERS.md) · [可选扩展示例](examples/README.md) |
| 理解目标、接口与模块职责 | [目标](docs/GOALS.md) · [契约](docs/CONTRACTS.md) · [架构](docs/ARCHITECTURE.md) |
| 处理未决执行、会话和恢复 | [恢复手册](docs/RECOVERY.md) |
| 判断版本与发布 | [版本规则](docs/VERSIONING.md) · [发布记录](docs/RELEASE_NOTES.md) |
| 统一命名与配套升级 | [命名统一与升级](docs/RENAMING.md) |
| 参与开发与报告问题 | [贡献指南](CONTRIBUTING.md) · [安全说明](SECURITY.md) |
| 了解验证范围与阶段记录 | [验收记录](docs/VALIDATION.md) · [2026-10-26 交付快照](docs/IMPROVEMENT_CHECKLIST_2026-10-25.md) |

源码采用 [MIT 许可](LICENSE)。第三方来源、致谢及独立素材许可集中在 [NOTICE.md](NOTICE.md)；上游许可证原文保留原语言。


聊天资源清理与容量规则见 [资源回收契约](docs/CONTRACTS.md#聊天资源回收)。运维命令 `qqbridge-framework maintenance` 可预览可回收内容，加 `--apply` 执行；当前部署、仍被历史引用的附件及未核清的执行证据受保护。
