# QQ Agent Framework

一个独立、可组合的消息桥接与 agent 宿主框架。协议、会话、人设、配置、偏好、权限和外部副作用分别建模，功能包通过明确的挂载点扩展。

## 启动

```sh
npm ci
npm run cli -- init
npm start
```

首次初始化后即可一条命令启动管理界面、OneBot HTTP 网关和原生聊天运行控制。聊天默认停止，完成配置后手动启动。默认访问 `http://127.0.0.1:3210/`；监听地址可在初始化时通过 `--host`、`--port` 设置，也可在运行设置中修改。

首次网页访问会生成私有管理员令牌文件，并提示本机读取位置。登录后使用独立的短期访问会话，刷新无需重新填写管理员令牌；主动退出撤销会话。管理员凭据不保存在浏览器持久存储中。

登录后依次登记提供方、人设与聊天方案、访问范围及消息处理授权，在“适配器”预览并安全应用 DSH 设置，最后手动启动聊天。具体步骤见 [启动聊天教程](docs/GATEWAY_ADMIN.md#启动聊天)。

项目要求 Node.js 24.12+。普通安装、构建、启动和单元测试均无需 Playwright；浏览器测试工具只在显式请求后安装到 `runtime/testing/`，不加入项目依赖或锁文件。

## 工作台

- **聊天方案**：直接创建、编辑和选择本框架自己的方案，管理模型路由、行为指令与关联人设。
- **适配器**：集中配置 OneBot HTTP、WebSocket 与 DSH；支持显式连接和自动识别账号，协议连接与聊天处理状态分开。webhook 是高级替代方式。
- **模型提供方**：集中登记服务类型、地址、密钥与模型名称；聊天方案从目录选择，并分别设置群聊、私聊上下文。见 [配置说明](docs/MODEL_PROVIDERS.md)。
- **人设库**：身份与表达风格独立保存；可从内置小鲸鱼示例创建草稿，不承担工具权限或临时偏好。
- **访问范围**：框架自身的访问策略与网关发送范围；默认拒绝未授权目标。
- **运行设置**：监听、凭据文件、请求期限、访问会话期限与可开关预算。
- **会话与用量**：保留会话、走势、逐轮与最近调用界面；只有实际装配聊天宿主与账本数据源后才可用。未接入时明确提示，不返回虚假的零数据。
- 日夜主题、页内目录、标题栏 `Ctrl/⌘K` 搜索；搜索不读取表单值、人设正文或秘密。

框架不读取其他桥接项目的目录或配置，也不代理其控制台。OneBot 和 DSH 是可显式接入的外部协议/agent 服务，不需要另一个桥接项目充当中间层。

## 能力与边界

已提供版本化功能生命周期、会话级串行与跨会话并发、有限队列、持久任务、SQLite 存储、generation 化会话、可恢复出站、审批资源和独立权限策略。适配器包含 OneBot HTTP 收发、可注入 client 的 DSH 与文档表达服务。生图等业务能力由使用者通过独立功能包补充，不预设专用接口或服务商。

默认 CLI 已接入可手动启停的原生聊天宿主；`createBridgeHost` 则供自定义装配。保存方案、应用 DSH、连接协议和启动聊天是不同操作；已有会话不会因更换方案自动重置，就绪检查也不验证真实模型调用。

默认聊天链路尚未提供 GPT 工作委派、工具预设或完整媒体收发；长等待执行策略也未落地。可按实际需要通过 [独立功能包](docs/EXTENDING.md) 与 [适配器](docs/ADAPTERS.md) 扩展，不代表原桥的全部能力已内置。

默认网关请求期限为 60 秒，允许发送范围为空。预算可以开关，但关闭预算不绕过目标范围、认证或 capability 授权。写入结果为 `unknown` 时不自动重试；不能把重启视为外部副作用已经取消。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm start` | 构建并启动管理端、网关与手动聊天控制 |
| `npm run cli -- status` | 检查当前配置与服务状态 |
| `npm run cli -- start --admin-only` | 仅启动管理 UI/API |
| `npm run check` | 类型与公开文件检查 |
| `npm test` | 源码及编译后单元回归 |
| `npm run test:browser` | 按需安装独立浏览器工具，执行全部 UI、Markdown 和表达测试 |
| `npm run cli -- install --browser` | 预先安装浏览器测试工具及 Chromium |
| `npm run cli -- uninstall --browser` | 只卸载独立测试工具，保留配置、会话和测试证据 |

管理配置路径优先级为显式 `--config`、`QQ_AGENT_CONFIG`、`runtime/admin/config.json`。所有私有数据位于配置指定位置；不要提交令牌、会话、真实账号或素材。

只检查某个页面或能力可使用 `npm run test:management`、`npm run test:page-navigation`、`npm run test:activity`、`npm run test:usage`、`npm run test:markdown-smoke`、`npm run test:presentation-smoke`、`npm run test:virtual-list-perf` 或 `npm run test:native-chat-ui`；这些命令只执行对应浏览器测试。离线准备和系统库安装说明见 [命令行指南](docs/CLI.md)。Markdown 转图片仍是框架的可选能力，由宿主注入浏览器，不依赖测试工具目录。

## 来源与许可

本项目参考 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 的需求、接口经验与失败模式，是独立 TypeScript 重建，不是原项目官方版本、官方继任者或 Git fork。参考来源不构成运行依赖。原版权和 MIT 文本保留在 [NOTICE.md](NOTICE.md)，本项目许可见 [LICENSE](LICENSE)。

## 文档

- [安装、启动与命令行](docs/CLI.md)
- [管理工作台](docs/GATEWAY_ADMIN.md)
- [OneBot 网关](docs/ONEBOT_GATEWAY.md)
- [适配器配置](docs/ADAPTERS.md)与[DSH 网络适配器](docs/DSH_ADAPTER.md)
- [目标与范围](docs/GOALS.md)
- [架构](docs/ARCHITECTURE.md)与[公共契约](docs/CONTRACTS.md)
- [扩展功能](docs/EXTENDING.md)与[文档表达](docs/PRESENTATION.md)
- [UI 范式](docs/UI.md)
- [安全边界](docs/SECURITY.md)与[性能方法](docs/PERFORMANCE.md)
