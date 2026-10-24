# TypeScript 开发契约

日期：2026-10-24。已从首轮并行约定更新为当前 TS 接口入口；历史分工不构成后续文件锁。

所有手写程序用 TypeScript，类型入口为 `src/core/types.ts`。TS5.9 strict 检查覆盖 src、web、scripts、test。
Node24 直接执行源 TS；`npm run build` 同时生成编译 JS 和浏览器静态产物。不要直接给浏览器发送 TS。

## 核心值工具（主线程）

`src/core/values.ts` 导出 `FrameworkError(code, message)`、`snapshot(value)`（JSON 数据深复制并冻结）、
`assert(condition, code, message)`。禁止在错误消息中插入原始输入或凭据。

## 数据服务（工作者 A）

`src/core/context.ts` 导出 `createContextStore({ clock = Date.now } = {})`：

- `registerPersona({ id, version, name, identity, style })` 返回 `id@version`，相同版本不可覆盖。
- `setConfiguration({ scope, values, source })`，scope 是 `{ kind, id }`；global 的 id 省略。
- `setPreferences({ id, scope, values, source, expiresAt = null })`；source 仅 operator 或 confirmed-user。
- `removePreferences(id)`。
- `resolve({ persona, conversationId, userId, sessionId, taskId })` 返回冻结的
  `{ persona, configuration, preferences, provenance }`，不含权限、能力或运行状态。
- `describe()` 返回安全的演示管理视图，不含方法或可执行对象。
- 优先级：global < persona < conversation < user < session < task；同作用域持久默认先、临时覆盖后；
  临时过期后恢复默认，不把覆盖写回默认值。persona 作用域 id 使用 `id@version`。

同文件导出 `createFeatureState()`：`scope(featureId, conversationId)` 返回仅该命名空间的
`get(key, fallback = null)`、`set(key, value)`、`delete(key)`；`describe()` 仅返回命名空间与条目数，
不泄露业务内容。数据首轮在内存中；宿主调用这些写接口，普通聊天不能直接更新固定定义。

## 功能 SDK（主线程）

`engine.install(feature)` 接收类型化 `FeatureDefinition`：`{ id, version, apiVersion: 1, capabilities: [], subscriptions: [], setup(ctx) }`。
setup 同步，通过 `ctx.on(eventType, async (execution, event) => ...)` 注册声明事件，可返回同步清理函数。

每次执行对象 execution 包含：

- `context`：上述 resolve 的数据快照（persona/configuration/preferences/provenance）。
- `state`：本功能/本会话私有状态接口。
- `signal`：功能卸载时取消的信号。
- `generate(prompt)`：受 `model.respond` 权限与预算约束，返回 `{ text }`。
- `send(content)`：受 `messaging.send` 权限与预算约束，返回 `{ status, messageId? }`。
- `invoke(capability, input)`：调用宿主挂载的具名适配器，受同样的声明、授权、预算和生命周期约束。

content 是 `[{ type: 'text', text: '...' }]`，首轮不支持图片/文件。事件是冻结的
`{ id, type, conversationId, userId?, sessionId?, taskId?, data }`；type 首轮允许 message.received、trigger.fired。
context.persona 是完整版本化人设对象，可读 `.name`。功能不获得网关、完整配置或授权写接口。
能力声明不等于授权。事件按会话串行、跨会话可并行；功能失败隔离、无自动重试。

宿主 `EngineOptions.eventValidators` 扩展事件，`effectAdapters` 扩展能力，不可覆盖内置同名路径。
校验器同步显式返回 true；适配器接收冻结 JSON input、必要 scope 和 AbortSignal，返回 JSON。
默认未结束事件上限256、副作用上限512；超出时给出稳定 backpressure 错误，不隐式扩大预算。
出站回执区分 confirmed/rejected/unknown；功能处理完成并不等于送达成功。

迭代002的 EngineOptions 增加 yieldEvery（默认64）、yieldAfterMs（默认8）与 maxConcurrentSends（默认1，保留全局顺序）。
计数或累计时间达到任一阈值时在调度边界让出，不是单个插件执行的抢占超时。
并发数大于1时，发送按会话有序且全局活动数不超过上限；真正取得槽位后再检查功能与授权。
卸载/停止仍排空发送与待取槽位动作。metrics() 返回队列、历史保留数量、让出周期及发送槽位计数，
不复制审计正文；完整 describe() 只用于显式管理查询。不使用状态时不创建空状态命名空间。

## 演示适配器与示例（工作者 C）

- `src/adapters/demo.ts` 导出 `createDemoTransport()`：`send(request)` 返回确认回执；
  `describe()` 返回只在内存的演示消息快照。request 为 `{ conversationId, content, idempotencyKey }`。
- 同文件 `createDemoModel()`：`generate({ prompt, signal })` 返回确定性 `{ text }`，无网络。
- `src/features/conversation.ts` 导出 `conversationFeature`，id conversation，能力 model.respond/messaging.send，
  订阅 message.received；仅 data.directed === true 且非 data.isSelf 时回应，消息取 data.text。
- `src/features/reminder.ts` 导出 `reminderFeature`，id reminder，能力 messaging.send，订阅 trigger.fired，
  仅处理 data.kind === reminder，以 data.text 或默认值构造提醒；不创建真实定时器。
- 功能执行通过上面 SDK，使用 preference/configuration，不修改 persona。测试可用独立 SDK 替身。

## 管理 API 与 UI（工作者 B）

`src/admin/server.ts` 导出 `createAdminServer({ token, snapshot, dispatchDemo })` 返回原生 http.Server。
绑定地址由 CLI 负责，仅回环。token 至少 24 字符；不打印、不放 URL、不写入前端代码。

- GET /health：无认证，仅 `{ ok: true, mode: 'demo' }`。
- GET /api/snapshot：Bearer 认证，调用 snapshot()。
- POST /api/demo/events：Bearer 认证和 JSON，调用 dispatchDemo(body)，限制体积与类型；同源检查。
- GET /、/app.js、/style.css：自己的静态界面；所有数据使用 textContent，不信任 HTML。
- 不支持任意静态路径、任意外链、模型 URL 或网关 URL；失败只返回稳定脱敏错误。
- UI 首轮展示 snapshot 的 overview/features/context/policy/outbox/audit 字段，提供显式手动演示。
- `web/app.ts` 编译成 `dist/web/app.js`，`/app.js` 只提供编译产物，`/app.ts` 不提供。
- 管理端不依赖第三方运行库；开发依赖在 package-lock.json 固定。
- 静态缓存仅三个白名单路由，每条至多256KiB并合并并发读取；需重建server刷新，动态快照不缓存。

## 主线程装配

主线程负责 values、policy、engine、demo CLI、package.json、总体文档及集成测试。
子代理不修改这些文件，不操作 GitHub，不修改旧 qq-bridge。未完成能力必须如实写明。
