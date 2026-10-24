# QQ Agent Framework

一个独立、可组合的消息桥接与 agent 宿主框架。协议、会话、人设、配置、偏好、权限和外部副作用分别建模，功能包通过明确的挂载点扩展。

## 启动

```sh
npm ci
npm run cli -- init
npm start
```

首次初始化后即可一条命令启动管理界面和 OneBot HTTP 网关。默认访问 `http://127.0.0.1:3210/`；监听地址可在初始化时通过 `--host`、`--port` 设置，也可在运行设置中修改，不写死地址。

首次网页访问会生成私有管理员令牌文件，并提示本机读取位置。登录后使用独立的短期访问会话，刷新无需重新填写管理员令牌；主动退出撤销会话。管理员凭据不保存在浏览器持久存储中。

项目要求 Node.js 24.12+。浏览器回归依赖只在运行测试时按需安装，普通安装与启动无需 Playwright。

## 工作台

- **聊天方案**：直接创建、编辑和选择本框架自己的方案，管理模型路由、行为指令与关联人设。
- **适配器**：集中配置 OneBot HTTP/webhook 与 DSH，凭据只写不回显，配置与实际运行状态分开。
- **人设库**：身份与表达风格独立保存，不承担工具权限或临时偏好。
- **访问范围**：框架自身的访问策略与网关发送范围；默认拒绝未授权目标。
- **运行设置**：监听、凭据文件、请求期限、访问会话期限与可开关预算。
- **会话与用量**：保留会话、走势、逐轮与最近调用界面；只有实际装配聊天宿主与账本数据源后才可用。未接入时明确提示，不返回虚假的零数据。
- 日夜主题、页内目录、标题栏 `Ctrl/⌘K` 搜索；搜索不读取表单值、人设正文或秘密。

框架不读取其他桥接项目的目录或配置，也不代理其控制台。OneBot 和 DSH 是可显式接入的外部协议/agent 服务，不需要另一个桥接项目充当中间层。

## 能力与边界

已提供版本化功能生命周期、会话级串行与跨会话并发、有限队列、持久任务、SQLite 存储、generation 化会话、可恢复出站、审批资源和独立权限策略。适配器包含 OneBot HTTP 收发、可注入 client 的 DSH 与文档表达服务。生图等业务能力由使用者通过独立功能包补充，不预设专用接口或服务商。

`createBridgeHost` 是原生宿主装配入口；协议 ingress、agent client、授权与功能包必须显式装配。默认 CLI 启动管理端与出站网关，不会因为页面可用而自动创建完整聊天链路。保存或选择聊天方案也不等于外部 DSH 已部署、已有会话已更新。

默认网关请求期限为 60 秒，允许发送范围为空。预算可以开关，但关闭预算不绕过目标范围、认证或 capability 授权。写入结果为 `unknown` 时不自动重试；不能把重启视为外部副作用已经取消。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm start` | 自动构建并启动管理端与网关 |
| `npm run cli -- status` | 检查当前配置与服务状态 |
| `npm run cli -- start --admin-only` | 仅启动管理 UI/API |
| `npm run check` | 类型与公开文件检查 |
| `npm test` | 源码及编译后单元回归 |
| `npm run test:browser` | 按需安装浏览器依赖后执行 UI 回归 |

管理配置路径优先级为显式 `--config`、`QQ_AGENT_CONFIG`、`runtime/admin/config.json`。所有私有数据位于配置指定位置；不要提交令牌、会话、真实账号或素材。

## 来源与许可

本项目参考 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 的需求、接口经验与失败模式，是独立 TypeScript 重建，不是原项目官方版本、官方继任者或 Git fork。参考来源不构成运行依赖。原版权和 MIT 文本保留在 [NOTICE.md](NOTICE.md)，本项目许可见 [LICENSE](LICENSE)。

## 文档

- [管理工作台](docs/GATEWAY_ADMIN.md)
- [OneBot 网关](docs/ONEBOT_GATEWAY.md)
- [适配器配置](docs/ADAPTERS.md)与[DSH 网络适配器](docs/DSH_ADAPTER.md)
- [目标与范围](docs/GOALS.md)
- [架构](docs/ARCHITECTURE.md)与[公共契约](docs/CONTRACTS.md)
- [扩展功能](docs/EXTENDING.md)与[文档表达](docs/PRESENTATION.md)
- [UI 范式](docs/UI.md)
- [安全边界](docs/SECURITY.md)与[性能方法](docs/PERFORMANCE.md)
