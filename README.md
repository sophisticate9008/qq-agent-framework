# QQ Agent Framework

QQ Agent Framework 是一个可组合的消息桥接与 agent 宿主框架。它把协议接入、会话、权限、功能生命周期和副作用执行拆成明确边界，便于在不修改核心调度器的情况下增加功能。

当前版本为 `0.1.0`。真实 QQ、外部 agent、持久恢复与生产运维能力仍应按实际部署分别验收。

仓库当前自带框架内核、协议适配器和 HTTP gateway，但不是安装后即可完成 QQ 收发、agent 会话、模型调用与业务功能的聊天成品。完整聊天仍需要可信宿主装配这些组件；现有线上聊天在完成并验收迁移前仍由原桥接部署承担。

## 来源与项目关系

本项目参考了开源项目 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 的需求、接口经验、运维边界和失败模式，并提供面向既有 qq-bridge 部署的兼容与迁移接线。它是独立的 TypeScript 重建，不是原项目的官方版本、官方继任者或 Git fork，也不受原作者背书；同时不把这些参考工作冒称为完全独立原创。

原项目采用 MIT 许可。必要的原版权、贡献者归属与完整 MIT 文本保存在 [NOTICE.md](NOTICE.md)，本仓自身许可见 [LICENSE](LICENSE)。

## 快速开始

要求 Node.js 24.12+ 与 npm。新项目无需安装 qq-bridge：

```sh
npm ci
npm run cli -- init
npm start
```

`init` 只需执行一次，默认创建私有的 `runtime/admin/config.json` 与 `runtime/gateway/` 配置、随机 gateway token 和存储位置；目录权限为 `0700`、文件权限为 `0600`，token 不会在 CLI 输出中回显。`npm start` 自动完成所需构建并启动 loopback gateway 与管理服务，随后访问 `http://127.0.0.1:3210/`。管理员令牌只在首次网页初始化时生成到私有文件，不由 CLI 或 HTTP 响应返回。

独立初始化默认把出站 OneBot HTTP upstream 设为 `127.0.0.1:3000`，gateway 监听 `127.0.0.1:3131`，初始允许发送范围为空，因此全部发送都会被拒绝；`budget=false` 不会扩大权限，默认请求超时为 60 秒。使用者仍需自行部署并认证外部 OneBot HTTP 服务，再在“访问范围 → 消息发送范围 → 允许发送的会话”中逐行填写 `group:群号` 或 `private:QQ号`。保存使用 CAS 并旋转授权版本，空列表始终表示全部拒绝。

该模式只提供框架内核、OneBot HTTP egress 兼容层和管理界面，不包含 OneBot WebSocket/其他入站、DSH、agent session、模型或业务功能，不能单独形成完整 QQ 聊天。完整生产使用仍需可信宿主组合协议 ingress、transport、agent client、持久存储、权限策略和功能包；现有线上聊天在完成并验收迁移前继续由原桥接部署承担。装配入口见[扩展功能](docs/EXTENDING.md)与[文档表达和最小装配](docs/PRESENTATION.md)。

## CLI

`init`、`start` 和 `status` 的管理配置路径优先级为显式 `--config`、`QQ_AGENT_CONFIG`、`runtime/admin/config.json`。`--host` 与 `--port` 只修改管理服务监听，不改变 gateway 或外部 OneBot upstream 端口。

管理员令牌只用于登录校验：浏览器把它作为 Bearer 令牌提交到 `POST /api/auth/login`，服务端成功后签发同源 `HttpOnly`、`SameSite=Strict`、`Path=/api` 的访问会话 cookie。提交后前端立即清空表单内存，不写入 `localStorage`、`sessionStorage`、cookie、URL 或日志。普通浏览器 API 请求只使用同源 cookie，不再发送 `Authorization`；刷新页面通过 `GET /api/auth/session` 恢复会话并读取数值型 Unix 毫秒 `expiresAt`。会话默认七天绝对有效，可在“运行设置 → 访问会话 → 访问令牌有效期（毫秒）”中调整为 300000 毫秒至 30 天；期限始终是绝对期限，服务重启也会立即使会话失效。只有 `POST /api/auth/logout` 成功或服务返回 `401` / `403` 时前端才清除连接态；网络错误保留当前会话并提示重试。管理员令牌与访问会话、gateway/OneBot 等协议 API token 相互独立，不能混用；既有受控脚本仍可直接使用管理员 Bearer 调用 API。

| 命令 | 用途 |
| --- | --- |
| `npm run cli -- init` | 创建拒绝式默认的独立 gateway 与管理配置，不依赖 qq-bridge。 |
| `npm start` | 使用默认、环境变量或显式配置启动管理端。 |
| `npm run cli -- init --gateway-config <文件>` | 高级入口：使用已有且通过严格校验的私有 gateway 配置。 |
| `npm run cli -- start` | 自动构建并启动兼容网关与同时提供页面/API 的管理服务；`npm start` 使用同一路径。 |
| `npm run cli -- start --admin-only` | 只启动管理 UI/API，不启动兼容网关；仍自动构建并由同一管理服务提供静态前端。 |
| `npm run cli -- status` | 只通过 GET health 读取当前服务状态，不写配置、不打印凭据。 |

普通初始化、启动和状态查询不依赖 Playwright。兼容网关未显式配置 `timeoutMs` 时，单次请求默认超时为 60 秒。

默认启动读取管理配置中的 `gatewayConfiguration`，并要求网关配置使用固定非零端口，以便管理端持续按同一配置探测。若 `gateway.port = 0`，CLI 会拒绝默认启动并提示改用固定端口或 `start --admin-only`。若目标网关端口已有服务，CLI 只在 authenticated `/health` 返回的配置 revision 精确匹配时复用；不匹配或无法认证就拒绝启动，不抢占端口，也不停止其他服务。若端口未监听，CLI 启动网关。退出时只关闭本次 CLI 自己启动的网关和管理端。

## 接入现有 qq-bridge（可选）

只有迁移或兼容现有部署时才需要桥接项目目录：

```sh
npm run cli -- init --bridge-dir /path/to/qq-bridge
npm start
```

初始化只准备私有 gateway 与管理配置，不激活接入、不修改现有端点，也不覆盖已有配置。需要由界面触发受控应用时，可在首次初始化命令末尾显式追加 `--service-manager /absolute/path/to/trusted-manager`；CLI 默认不猜测服务管理方式。该兼容路径保留原部署的 ingress、agent runtime、session、插件和业务状态，不应描述成 framework 已经独立替换了整套聊天后端。

## 已有基础能力

- 版本化功能安装、卸载、取消、在途排空和失败隔离。
- 同会话顺序处理、跨会话并行、有限队列和协作式事件循环让出。
- 人设、配置、偏好、功能状态与权限分离。
- 按功能、会话和 capability 授权，支持有限尝试预算、暂停、过期与撤销。
- 可信宿主注入自定义事件、effect、model 和审计 observer，不能覆盖框架内置入口。
- 可解释的入站路由与响应归属，保留事件广播和旁观功能。
- 文本、资源、引用回复与受独立授权的合并转发；可选文档表达服务准备 Markdown 图片或选择输出形式。
- SQLite 持久存储、generation 化会话、带人格版本作用域的出站与受审批资源目录。
- 有限任务队列，以及需显式驱动、带时区/DST 与漏触发策略的 daily/weekly 日历触发服务。
- OneBot HTTP 收发适配器与可注入成熟 client 的 DSH agent adapter。
- `createBridgeHost` 组装持久 policy/state、会话、follow、任务和出站恢复。
- React、shadcn/ui（Base UI）、Tailwind CSS 与 Vite 构建的中文管理工作台，支持日间、夜间和跟随系统主题。
- 六个基础页面承载框架与已接线兼容配置，保存与应用保持为不同操作；具体业务包页面不由框架内置。
- 管理页面提供自动目录和 `Ctrl/⌘K` 全局搜索；搜索仅使用页面、分组和字段名称，不读取表单值、秘密或正文，定位不会改写表单草稿。
- UI 模式使用互斥选择；关闭功能时隐藏依赖配置但保留已保存值，再次开启后恢复显示。

## 使用边界

- 功能包和适配器是可信宿主代码，不是不可信代码沙箱。
- 功能声明不等于授权；外部副作用必须经过宿主 policy。
- 进程内事件去重和审计保留窗口有限，不能代替持久恢复验收。
- 持久组件能保存状态和标记中断结果，但不会把 `unknown` 自动重放为成功或失败。
- `confirmed`、`rejected` 与 `unknown` 必须分开处理；结果未知不能直接视为失败并盲目重发。
- 管理端的“重启已受理，需要重连”不等于服务已应用；应在新地址重新连接并核对状态。
- 资源块只携带资源标识，不代表任意本机路径或 URL 可被访问。
- 文档图片需要注入浏览器、受控发布器及本地字体；准备或批准图片不等于获得发送权限。
- 候选版本发布/回滚、业务状态迁移、可恢复长工作管理与全局保留清理策略尚未形成完整流程。
- HTTP compatibility gateway 保留旧部署并治理其出站路径，不替换旧 OneBot WebSocket、DSH runtime、现有 session、插件或完整宿主。
- 框架只提供业务无关的 UI 页面范式与共享组件，不继续内置具体业务包页面；业务 UI 缺失不是框架待完成能力。
- UI 与管理 API 必须作为可信源码显式审核、导入、构建和装配；不会从 QQ 消息、模型输出或任意路径动态加载代码，也没有插件或页面自动注册机制。
- 尚未经过对应集成与故障恢复测试的适配器，不应标记为生产可用。

<details>
<summary><strong>开发与回归</strong></summary>

用户启动不需要先运行这些命令。修改框架源码后再按范围执行：

```sh
npm run typecheck
npm run check
npm run build
npm test
npm run test:built
npm run test:browser
```

同一回归入口也可通过统一 CLI 运行：

```sh
npm run cli -- build
npm run cli -- test
npm run cli -- test --browser
npm run cli -- test --browser --with-deps
```

`build` 执行完整构建。`test` 会构建并运行源码与 `dist` 回归；`test --browser` 会按需准备浏览器、执行 browser TypeScript 检查和构建，再依次运行 browser、management、page-navigation、markdown、presentation smoke。浏览器检查是可选回归入口，不是普通启动前置条件。

只有显式使用 `test --browser` 且本机缺少浏览器依赖时，CLI 才按需执行不写 lockfile 的 `npm install --no-save --package-lock=false playwright@1.61.1` 和 `playwright install chromium`；只有再给出 `--with-deps` 才安装操作系统依赖。Playwright 不属于普通 `devDependencies` 或 lockfile，普通启动和非浏览器回归不依赖它。

</details>

## 项目结构

```text
src/core/       功能 SDK、调度、上下文与权限
src/host/       宿主持久化、会话和恢复基础件
src/adapters/   外部协议与 agent 适配器
src/rendering/  可选的离线 Markdown 渲染
src/features/   可独立装配的功能包
src/admin/      认证、配置与受控应用接口
web/            中文管理工作台与共享界面组件
test/           自动化回归测试
scripts/        构建、检查和运维入口源码
docs/           公共设计与使用文档
```

## 文档

- [目标与范围](docs/GOALS.md)
- [架构](docs/ARCHITECTURE.md)
- [公共契约](docs/CONTRACTS.md)
- [旧 OneBot HTTP 出站兼容网关](docs/LEGACY_GATEWAY.md)
- [管理工作台指南](docs/GATEWAY_ADMIN.md)
- [管理界面与扩展约定](docs/UI.md)
- [扩展功能](docs/EXTENDING.md)
- [文档表达与最小装配](docs/PRESENTATION.md)
- [安全边界](docs/SECURITY.md)
- [性能方法](docs/PERFORMANCE.md)
- [架构决策](docs/decisions/0001-independent-engine.md)
- [来源与第三方声明](NOTICE.md)

MIT License。参见 [LICENSE](LICENSE) 与 [NOTICE.md](NOTICE.md)。
