# 安装、启动与命令行

## 首次启动

需要 Node.js 24.12 或更新版本与 npm。在项目目录执行：

```sh
npm ci
npm run cli -- init
npm start
```

`init` 创建本框架自己的私有配置，已有文件不会被覆盖。默认管理地址是 `http://127.0.0.1:3210/`，OneBot HTTP 网关监听 `127.0.0.1:3131`，外部 OneBot 上游默认是 `http://127.0.0.1:3000`。首次访问网页时才生成管理员令牌，按页面提示在本机读取并登录。CLI 已提供原生聊天控制，但不会自动启动聊天；需完成提供方、方案与授权配置，安全应用 DSH 设置后手动启动，详见 [启动聊天教程](GATEWAY_ADMIN.md#启动聊天)。

```sh
npm run cli -- init --host 127.0.0.1 --port 3210
npm run cli -- start --admin-only
npm run cli -- status
npm run cli -- help
```

上面的 `init` 示例用于尚未初始化的目录。`start` 默认构建页面并启动或复用配置匹配的网关；`--admin-only` 只启动管理界面和 API。`status` 只读检查，不重启服务。

管理配置选择顺序是 `--config <文件>`、环境变量 `QQ_AGENT_CONFIG`、`runtime/admin/config.json`。高级装配可用 `init --gateway-config <文件>` 指定已有 OneBot 网关配置，或 `--service-manager <可信可执行文件>` 指定服务管理程序；初始化不会执行该程序。

## 普通开发检查

```sh
npm run check
npm run build
npm test
npm run test:built
```

`check` 检查源码类型和公开文件；`build` 生成服务代码与网页；`npm test` 构建后执行源码和编译后的全部单元测试；`test:built` 构建后只执行编译后的单元测试。这些命令均不安装、导入或运行 Playwright，也不下载测试浏览器。

## 可选浏览器测试

只有明确请求以下命令时，才会准备浏览器测试工具：

```sh
npm run cli -- install --browser
npm run test:browser
```

`install --browser` 只安装工具，不执行测试；`test:browser` 自动准备工具、检查浏览器测试类型、构建，再依次执行全部浏览器测试。首次需要 npm 包和 Chromium 下载网络，后续复用已有安装。它们不改变根目录的 `package.json`、`package-lock.json` 或 `node_modules`。

所有测试工具位于 `runtime/testing/`：

- `package.json` 和 `package-lock.json`：独立固定版本的 Playwright、TypeScript 及安装锁。
- `node_modules/`：浏览器测试包，不借用根目录的 Playwright。
- `browsers/`：测试用 Chromium 下载位置，不修改共享浏览器缓存。
- `tsconfig.json`：把浏览器测试类型映射到独立安装目录。

浏览器测试脚本仍保留在 `scripts/`。命令通过 TypeScript 编写的 Node 模块解析钩子，把它们的 Playwright 导入定位到独立工具目录；不需要全局模块、临时 JavaScript 或修改模块缓存。

### 只运行一项

| 命令 | 实际执行 |
| --- | --- |
| `npm run test:browser` | 以下全部项目及基础工作台测试 |
| `npm run test:management` | 管理页面 |
| `npm run test:page-navigation` | 页面导航 |
| `npm run test:activity` | 会话与活动 |
| `npm run test:usage` | 用量页面 |
| `npm run test:markdown-smoke` | Markdown 转图片 |
| `npm run test:presentation-smoke` | 文档表达与图片发布 |
| `npm run test:virtual-list-perf` | 大列表虚拟滚动性能 |
| `npm run test:native-chat-ui` | 原生聊天授权、启动控制与 DSH 应用表单 |

也可用 `npm run cli -- test --browser --target markdown` 指定项目；合法项目为 `browser`、`management`、`page-navigation`、`activity`、`usage`、`markdown`、`presentation`、`virtual-list-perf`、`native-chat-ui`。省略 `--target` 执行全部，未知项目报错，不会悄悄执行其他测试。

### 浏览器与系统库

只安装测试包、不下载浏览器：

```sh
npm run cli -- install --browser --skip-browser-download
```

包下载可以复用 npm 缓存；完全离线时缓存必须已具备所需版本。可以通过 npm 的 `npm_config_offline=true` 使用离线模式。这个选项只影响下载，不会使缺失的包自动可用。

如果已有兼容 Chromium，可以设置 `CHROMIUM_EXECUTABLE` 为其绝对路径再执行浏览器测试，命令将不下载 Chromium。此时浏览器版本、系统库和本地中文字体由调用方提供。

Linux 缺少浏览器系统库时，显式执行：

```sh
npm run cli -- install --browser --with-deps
```

该选项会调用 Playwright 的系统包安装，可能需要管理员权限并修改系统库；普通安装和测试不会自动执行此操作。`test --browser --with-deps` 也可先安装系统库再测试。`--with-deps` 不能与 `--skip-browser-download` 同时使用。

## 卸载测试工具

```sh
npm run cli -- uninstall --browser
```

只删除 `runtime/testing/` 内的测试包、锁文件、类型检查配置和下载的浏览器。不会删除其他 `runtime/` 配置、会话、截图、报告或公共测试脚本，不会卸载系统库和调用方提供的 Chromium。之后仍可正常启动、构建和运行单元测试；再次请求浏览器测试时会重新安装工具。

卸载只接受本工具创建的普通 `package.json` 安装标记：名称为 `qq-agent-browser-testing`、`private: true`、`type: module`，文件不能是符号链接且不超过 4 KiB。标记缺失、被修改或目录中是其他工具的数据时拒绝清理并保留文件，请手动核对；不会根据目录名称猜测所有权或自动恢复被删除的标记。

Markdown 转图片不是测试专属功能。框架渲染器接收宿主注入的浏览器接口；实际生产宿主自行管理浏览器、中文字体与进程生命周期，不应依赖此测试目录。装配方式见 [文档表达](PRESENTATION.md)。

## 原生聊天页面测试数据

`scripts/native-chat-ui-smoke.ts` 使用真实静态网页和测试登录服务，所有聊天接口均由脚本内的假管理 API 提供。运行前应构建当前网页；脚本直接执行时不会自动构建。它不会读取生产配置、协议账号或模型密钥，也不会连接真实 DSH、QQ 或模型服务。

测试数据需要满足以下接口形状：

| 接口 | 必要数据与行为 |
| --- | --- |
| `GET /api/chat/authorization` | `revision` 为 64 位十六进制；`version` 为授权版本；`grants` 含会话范围、提交次数、发送次数及可空有效期 |
| `POST /api/chat/authorization` | 只接收 `revision`、`version`、`grants`，核对旧版本后返回新版本；可模拟冲突或结果未知 |
| `GET/POST /api/chat/deployment` | `{ revision, deployment }`；deployment 含明确的目标配置与凭据文件路径、模型容量、最大输出、推理档位映射和命名前缀；保存只更新测试数据 |
| `GET /api/chat/runtime` | 状态、`canStart`、明确的 `canApplyDeployment`、`chatReady`、`protocolConnected`、`configurationIssues`、`missingReasons`、`lastError`、当前与已应用版本；当前版本包含 plans、personas、access、adapters、providers、authorization、deployment 七项 |
| `POST /api/chat/runtime/start` | 核对完整 `{ revisions }`，只切换假运行状态；停止接收空对象 |
| `POST /api/chat/deployment/prepare` | 核对 `{ revisions }`，返回 `{ state: 'prepared' \| 'blocked', targetRevision, summary: { ready, missingReasons }, preview }`；目标版本为 64 位十六进制，不改引擎 |
| `POST /api/chat/deployment/apply` | 核对 `{ revisions, targetRevision }`，目标版本必须等于确认过的预览；返回 `{ state, missingReasons, backupId? }`，模拟 pending_reload、unknown 或 conflict，不访问文件或重启服务 |
| `POST /api/chat/deployment/reconcile` | 核对 `{ revisions }`，返回 `{ verified, missingReasons, presets: [{ agentPreset }] }`，只模拟已验证状态 |
| 网关配置与运行设置 | `createConfigurationRoutes` 与 `createSettingsRoutes` 绑定脚本生成的私有临时配置，提供完整 schema 和真实版本比较保存；不提供应用回调、不启动网关 |
| 搜索与页面读取 | chat/status、chat/access、chat/adapters 使用测试响应；原生允许名单来自独立临时文件，所有假外部服务使用 `.invalid` 域名 |

保存冲突使用 `409 / chat_revision_conflict`，未知结果使用 `504 / operation_unknown`；应用也覆盖 HTTP 成功但 `state` 为 unknown 或 conflict 的响应。测试核对每次实际写入次数，失败后只有重新读取才能解除阻断，不自动重放。授权和应用都要求单独确认；应用前配置版本变化必须重新预览，其他窗口替换了已批准预览时不能误用新预览。

浏览器把专用 `.invalid` 主机映射到本机随机端口，以真实的非安全 HTTP 上下文验证 `crypto.randomUUID` 不可用时的随机 ID 回退；不修改浏览器全局 API。所有外域 HTTP 和 WebSocket 请求均被阻止。截图与计数报告保存在 `runtime/native-chat-ui-smoke/`。

测试还从标题栏搜索进入“消息发送范围”，通过本页目录定位并保存真实临时网关文件。保存仅改变 `allowedConversations` 和网关 `authorizationVersion`；原生允许名单、处理授权、管理配置与凭据文件必须保持不变。“HTTPS 反向代理”的公开来源和可信回环代理字段通过同一份完整 schema 展示，只读取、不保存或应用代理。

运行状态测试提供 `modelExecutionVerified: false`，核对“聊天已启用”不被解释为已验证真实模型调用。额度耗尽或过期、引擎跟随中断、配置等待应用与协议连接中断分别展示；授权问题指向访问范围，不误报协议断开，也不建议重复启动。

DSH 应用还检查服务端明确返回的 `canApplyDeployment`：已确认预览但新读取的能力为 false 时，只显示本地阻止提示，不提交写入，也不误报结果未知；运行中即使确认预览，应用按钮仍不可提交。
