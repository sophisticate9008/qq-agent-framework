# 扩展开发

扩展通过功能定义、宿主服务、包贡献和生命周期进入框架。模型和 QQ 命令入口按真实调用者与当前 policy 核验；已安装的可信插件通过宿主内部服务执行任务，身份由加载器注入。bootstrap 在宿主进程内运行，安装扩展需要运维信任。

服务声明、类型化取得、内置能力目录及各项边界见 [服务规范](SERVICE_CONVENTIONS.md)。完整的稳定入口与实现重载示例见 [热重载插件](../examples/reloadable-plugin/README.md)。

能力名称与工具说明只描述功能，例如“启动工作”“发布动态”；身份、白名单和自主执行权限由宿主策略单独配置与检查，不写入能力定义或模型参数。SDK `contracts` 导出独立的 `NATIVE_TOOL_CAPABILITY_CATALOG`、`nativeToolCapabilityDefinition` 与 `NativeToolCapability`，供工具和界面复用。目录列出能力不等于能力已安装、就绪或获得授权。

## 本地框架插件的登记约定

框架插件使用下文的功能包机制，独立于 DSH 的 MCP 服务与 DSH 插件。本地未发布的 TypeScript 包也可以接入：由可信 bootstrap 的 `create()` 返回 `packages`，不要求发布到 npm，不自动扫描任意目录或执行其中的文件。

交给 Agent 编写插件时，至少约定：

- 稳定包标识、语义化版本及依赖，登记在 `NativePackageManifest`。新插件同时填写 `displayName`（用户可读名称）、`description`（实际用途）和 `toolNames`（本扩展拥有的完整工具名），不要让内部包标识充当产品名称。
- 需要提供的功能、服务、事件或输入贡献，在 manifest 声明后由 `install()` 注册。
- 配置使用 `packageConfigurations`，运行状态与持久数据由包自身管理，计时器、订阅等通过 `context.own()` 登记清理。
- 能力只描述动作；白名单、主人身份和实际执行权限仍由宿主判断。
- 模型可调用工具需要接入实际工具注册与投影通道；仅声明普通功能或提供服务不会自动变成模型工具。

`NativePackageManifest` 和直接注册的 `FeatureDefinition` 共用展示字段：`displayName` 最多 80 字符，`description` 最多 500 字符，均为非空、无控制字符的单行文本。用途说明应描述用户能完成什么，例如通用生图填写“按提示词和参考图生成图片并发送”，角色前置输入填写“准备角色设定、参考图和生图提示词”，不要填写“发送消息”等底层能力，也不要把权限条件写成用途。稳定 `id` 用于存储、依赖和授权关联，显示名称修改不改变 `id`。字段对旧插件保持可选；未填写用途时页面明确提示缺少说明，能力仅在详情中展示。

```ts
const metadata = {
  displayName: '通用图片生成',
  description: '按提示词和可选参考图生成图片，查询进度并发送到对应会话。',
  toolNames: ['generate_image', 'image_status'],
};
// 在 NativePackageManifest 或 FeatureDefinition 中展开 ...metadata。
```

`toolNames` 最多 128 个互不重复的完整工具标识，只用于声明工具归属，不注册工具、不授予执行权限。运行时注册记录优先于包声明；同名多包声明或与实际来源不一致时显示冲突。工具始终是其所属扩展的子项。

### 注册来源与接入方式

注册来源、DSH 注册范围、传输方式分别建模。`registrationSource` 包含 `origin`（`framework-builtin`、`dsh-builtin` 或 `extension`）、`ownerId`、`ownerName` 和 `transport`（`native` 或 `mcp`）。框架随版本提供的工具或 MCP 登记为框架内置；DSH 自带工具单列为 DSH 内置；后续安装的包、Agent 编写的插件或动态扩展登记为扩展。DSH 全局注册、会话注册以及 `mcp__` 前缀都不能单独证明工具属于哪一类。

框架投影工具在 `FrameworkToolDefinition.registrationSource` 中声明。直接在 DSH 注册工具时，使用桥接插件的 `@qq-bridge-framework/dsh-bridge-plugin/registration` 导出：

```ts
import { withToolRegistration, declareMcpToolRegistration } from '@qq-bridge-framework/dsh-bridge-plugin/registration';

ctx.tools.register(withToolRegistration(toolDefinition, {
  origin: 'extension', ownerId: 'image-generation', ownerName: '通用图片生成', transport: 'native',
}));

// MCP 客户端自行登记工具时，安装者为该服务声明来源，并随生命周期撤销。
ctx.effect(() => declareMcpToolRegistration('dsh-global', 'search', {
  origin: 'extension', ownerId: 'search-addon', ownerName: '联网搜索',
}));
```

纯框架默认装配的 MCP 使用相同接口，将 `origin` 登记为 `framework-builtin`；这项来源由装配代码声明，不是网页权限开关。MCP 服务声明匹配对应 DSH 范围和命名空间下的实际工具列表，支持服务动态增加或移除工具；声明本身不会连接服务或生成虚假的工具记录。简单命名空间限 1–32 个 ASCII 字母、数字、连字符或下划线，不包含双下划线；特殊名称应在具体工具定义上登记来源。同一范围同一命名空间重复声明时不采用推断结果。

旧工具缺少来源登记时，目录兼容 DSH `0.2.1-rc.2`：在同一实际注册范围内核对已加载的内置工具模块与该版本的精确工具目录；可配置名称读取已解析的 `toolName`。已加载 MCP 客户端按其实际 `serverName` 关联现有工具，默认归为外部扩展服务；框架内置 MCP 的显式声明优先。未加载、已停用或仅存在配置声明的模块不会补出工具来源，不执行配置表达式、连接请求或模型调用。该兼容目录用于补齐旧注册信息，并非 DSH 提供的逐工具来源证明；同名冲突保留未识别状态。

已运行扩展的精确 `toolNames` 仍可补充剩余缺失归属。只有上述来源均无法识别时才进入“来源待核对”；来源声明只影响目录展示，不扩大执行权限。


工具属于扩展的子项，扩展之间的运行依赖使用已有 `dependencies` 与 `requires` / `provides`，不能用工具前缀推断父子关系。例如“通用图片生成”提供输入材料服务，“自我形象与提示词前置输入”依赖它登记参考图并准备提示词；前置输入并不拥有通用生图能力。自拍、换装是提示词内容，不需要分别注册工具。包管理器按依赖顺序启动、逆序停止，运行快照 `dependencies` 用于控制台展示实际关系。角色资料按需准备，不应每轮重复注入。

目前没有独立的插件市场、目录自动发现或一站式工具插件注册器。控制台读取注册元数据和实际运行状态，不能把尚未接入的源码目录显示为已安装。工具页分别呈现声明、注册与会话加载状态，框架服务页展示基础设施。

## 插件定时任务与按需工具目录

插件通过 `PLUGIN_SCHEDULER_SERVICE_CONTRACT` 取得调度客户端，登记 once/daily/weekly 任务，日历和业务发生记录由宿主持久保存。使用它的包声明 `dependencies: ['plugin-runtime']` 与 `requires: [serviceDeclaration(PLUGIN_SCHEDULER_SERVICE_CONTRACT)]`，在 `start` 中调用 `useService(context, PLUGIN_SCHEDULER_SERVICE_CONTRACT)`。所有插件日程共用宿主的有界插件调度循环；提醒服务保留独立业务生命周期。先 `registerHandler`，再 `schedule`，构造插件本身不会执行任务。停止、错过窗口、重启及未知结果的语义见 [插件调度](TRIGGERS.md)。

同样声明 `PLUGIN_TOOLS_SERVICE_CONTRACT`，使用 `useService(context, PLUGIN_TOOLS_SERVICE_CONTRACT).register({ id, description, parameters, permission, readOnly, execute })` 将工具加入二级目录，返回撤销函数，应交给 `context.own` 管理。`context.runtime.scheduler/tools` 是同一客户端的便利 getter，也要求对应 `requires`。宿主固定插件身份，完整名称为 `extension.<插件标识>.<id>`。`permission` 在工具说明之外声明：`owner` 核验当前 QQ 主人，`autonomous` 仍经过当前会话准入；定时任务直接使用插件宿主服务，不伪造 QQ 发言者。写调用按事件身份持久去重，未确认结果保留且不自动重放。

模型通过 `qbf_capability_catalog` 查分类或搜索摘要，指定单个 `id` 才读取其参数，再用 `qbf_capability_call` 执行。二级目录条目不会额外投影到每轮顶层工具 schema；控制台仍显示其真实扩展来源。模型是否使用目录，需要结合实际会话及模型请求日志观察。

可选的 `image-generation` v1 服务使用 `ImageGenerationService` 契约：接受提示词、稳定幂等键、主体选择和取消信号，返回原始图片字节、类型与 SHA-256，不隐式发送。服务实现由扩展提供；依赖它的业务插件无需复制 QQ 发送或会话鉴权链路。实现、素材和模型配置由安装者自行提供。

本机私人、非通用扩展统一存放在 Git 忽略的 `private/extensions/<扩展标识>/`；专属文档、测试和素材随扩展保存，运行状态、会话和产物放在 `runtime/`。公开示例只演示通用框架接口，不包含安装者的私人业务实现。独立扩展接入已有可信 bootstrap，仍受原有身份、生命周期和 policy 约束。

## 插件代码重载与配置即时更新

包插件通过 `PLUGIN_EXTENSIONS_SERVICE_CONTRACT` 取得登记服务，将 `createReloadableService()` 或 `createReloadableExtension()` 的管理器交给 `extensions.register(manager)`；该包声明对 `plugin-runtime` 的依赖和服务 `requires`。可信 bootstrap 也保留 `context.extensions?.register(manager)` 入口。登记返回撤销函数，应随所属生命周期清理。只有主动接入该管理器并登记的插件出现在重载目录；已有插件需要完成这一接入。重载请求只接受登记的稳定插件标识，不接受模块路径或执行表达式。宿主维护入口和插件每次调用的真实主人、白名单检查分别执行，登记不扩大权限。

`createReloadableService({ contract, asyncMethods, load, ... })` 为显式选择的 Promise 方法提供稳定服务代理；每次调用租用当前实例，直到完整 Promise 结束才归还。`createReloadableHandler(manager, callback)` 为固定工具或调度入口持有同样的租约。候选公共契约核对 ID、版本和方法集合；参数及返回值语义仍由版本和边界校验负责。同步方法使用 `manager.withCurrent` 明确持有租约，不暗中改成异步接口。详细用法见 [稳定服务与可替换行为](RELOADABLE_SERVICES.md)。

`createExtensionModuleLoader({ entry, root })` 的路径由可信装配代码预先确定。加载器对本地 ESM `.ts`、`.mts`、`.js`、`.mjs` 源码快照计算 64 位小写十六进制指纹，并让同代本地依赖使用一致的模块身份；宿主 SDK 和已安装依赖保持共享。JSON、资源、配置、测试与安装依赖不属于源码快照，资源和配置仍通过原 `import.meta.url` 或宿主服务读取。每个固定入口在同一宿主进程中最多保留 64 个不同源码代次，失败导入也占用代次；达到上限后保留当前实例，需重启宿主才能继续加载新的代码。未变更模块的源码文本在代次间共享；每入口另设默认 64 MiB 的去重 UTF-8 源码总预算，可用 `maxRetainedSourceBytes` 调整（1 字节至 512 MiB）。此预算不等于进程堆内存上限，编译模块和业务对象另占内存。超预算候选不执行，保留当前实例；重新创建同入口加载器不能扩大已有预算。ESM 执行具有宿主进程权限，AbortSignal 不能强制终止已经开始的模块执行。

管理器异步工厂的 `load(signal)` 返回 `{ revision, value, dispose? }`。候选实例必须独立，准备和校验阶段不能发布注册、启动定时器或执行外部动作。新实例准备成功且宿主仍在运行时才切换；准备失败保留旧实例。`withCurrent(fn)` 的租约覆盖 `fn` 返回的 Promise，包括后台任务的实际完成期。切换后的新调用使用新实例，旧生图任务继续使用原实例完成，最后一项旧租约结束后才清理旧实例。直接 `current()` 仅用于同步检查，持续工作必须使用租约。

运行时最多允许一代旧实例排空；旧代尚有任务、清理尚未结束或清理失败时，后续重载明确拒绝。内容指纹相同返回 `changed: false` 并释放新准备的候选实例。清理失败会保留错误码和排空状态，`close()` 也会报告失败；关闭立即禁止新调用与版本切换，并等待进行中的准备、任务及清理。

`qqbridge-framework extensions` 查询已登记实例，`qqbridge-framework extensions reload <插件标识>` 读取当前指纹后提交 CAS 重载。状态仅包含标识、显示名、当前指纹、活动调用、排空、重载和关闭状态及错误码。返回的 `currentRevision`、`changed`、`draining` 区分版本切换和旧任务排空；网络中断后先查状态，不自动重放写操作。

配置有各自的即时应用约定。当前生图配置 `generationAccess` 接受 `owner` 或 `whitelist`，执行时热读，保存后对后续权限检查生效；当前配置缺省为 `whitelist`。代码重载用于保持同一工具协议的实现更新。工具名称、输入输出 schema、依赖或注册结构变化需要完整应用插件装配，不能仅替换实例后声称工具目录已同步。

## SDK 与示例运行方式

当前 SDK 包为 `@qq-bridge-framework/sdk`，要求 Node.js 24.12.0 或更新版本。以下子路径有公开 `exports` 和声明文件：


| 导入路径 | 用途 |
| --- | --- |
| `@qq-bridge-framework/sdk` | 核心类型、上下文、policy、engine 与 `defineNativeBootstrap`。 |
| `@qq-bridge-framework/sdk/core` | 核心运行接口。 |
| `@qq-bridge-framework/sdk/host` | bridge、bootstrap、包、配置、任务、日历、事件、服务与账号 registry。 |
| `@qq-bridge-framework/sdk/contracts` | 纯 DTO、ports、account scope、事件与包状态契约。 |
| `@qq-bridge-framework/sdk/storage` | SQLite、只读 SQLite、持久 policy/state 和账号 store 绑定。 |
| `@qq-bridge-framework/sdk/adapters` | 可复用的外部协议适配器，当前提供 OneBot 空间发布与删除。 |

源码中的其他路径不构成 SDK 承诺。SDK 包不包含管理服务器和网页。仓库可以本地生成 tarball；以下示例不依赖 npm 上已有公开发布：

QQ 空间的共用接口、能力声明及自主发布接入约定见 [空间适配](QZONE.md)。

```sh
# 在框架仓库中
npm ci
npm run build:sdk
npm pack ./packages/framework-sdk --pack-destination /tmp

# 在一个新的外部目录中
npm init -y
npm pkg set type=module
npm install --ignore-scripts /tmp/qq-bridge-framework-sdk-1.7.0.tgz
npm install --save-dev typescript@5.9.3
```

将下面三个完整代码块分别保存为标注的 `.ts` 文件，然后执行：

```sh
npx tsc feature-bootstrap.ts owned-state.ts accounts.ts --strict \
  --module NodeNext --moduleResolution NodeNext --target ES2023 \
  --outDir out --skipLibCheck false
node out/feature-bootstrap.js
node out/owned-state.js
node out/accounts.js
```

示例只使用临时私有目录和合成适配器，不连接 QQ 或模型服务。它们验证真实 host、SQLite、policy、包状态和账号 registry，而非手工模拟 SDK 返回值。完整外部 tarball 消费验收见 [verify-sdk-package.ts](../scripts/verify-sdk-package.ts)。

## 示例一：功能、bootstrap 与显式授权

`feature-bootstrap.ts` 展示安装功能后先被 policy 拒绝，再由可信宿主明确授予一次发送，最后确认额度已经消耗。功能只拿到 execution；grant 在宿主侧创建。

<!-- sdk-example: feature-bootstrap.ts -->
```ts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContextStore, defineNativeBootstrap,
  type FeatureDefinition } from '@qq-bridge-framework/sdk';
import { createBridgeHost, createNativeBootstrapMount,
  type LoadedNativeBootstrap } from '@qq-bridge-framework/sdk/host';
import { createSqliteStore } from '@qq-bridge-framework/sdk/storage';

const directory = await mkdtemp(join(tmpdir(), 'sdk-feature-'));
const store = createSqliteStore({ filename: join(directory, 'state.sqlite') });
const context = createContextStore();
const persona = context.registerPersona({ id: 'example', version: '1',
  name: 'Example', identity: {}, style: {} });
const controller = new AbortController();
let sends = 0;
const feature: FeatureDefinition = {
  id: 'example-notice', version: '1.0.0', apiVersion: 1,
  capabilities: ['messaging.send'], subscriptions: ['trigger.fired'],
  setup(services) {
    services.on('trigger.fired', async execution => {
      await execution.send([{ type: 'text', text: 'SDK example' }]);
    });
  },
};
const definition = defineNativeBootstrap({
  manifest: { id: 'example-bootstrap', version: '1.0.0', apiVersion: 1 },
  create() { return { features: [feature] }; },
});
const loaded: LoadedNativeBootstrap = {
  ...definition,
  metadata: { manifest: definition.manifest,
    codeFingerprint: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
    trust: 'trusted-operator-code', sandboxed: false,
    requiresSeparateAuthorization: true },
};
const mount = await createNativeBootstrapMount({ bootstrap: loaded,
  context: { directory, store, context, persona, signal: controller.signal } });
const host = createBridgeHost({ store, context, persona,
  ...mount.bridgeOptions, authorizeIncoming: () => false,
  transport: { async send() {
    sends++;
    return { status: 'confirmed', messageId: `example-${sends}` };
  } },
  agent: {
    async createSession() { return { sessionId: 'unused-session' }; },
    async submit() { return { status: 'accepted' }; },
    async follow() { return () => {}; },
  },
});
const fire = (id: string) => host.engine.emit({ id, type: 'trigger.fired',
  conversationId: 'private:123', data: {} });
try {
  await mount.install(host);
  await host.start();
  await mount.start(host);
  const denied = await fire('before-grant');
  assert.equal(denied.outcomes.find(item => item.featureId === feature.id)?.errorCode,
    'POLICY_DENIED');
  assert.equal(sends, 0);
  host.policy.grant({ id: 'operator-explicit-once', featureId: feature.id,
    conversationId: 'private:123', capabilities: ['messaging.send'],
    maxUses: { 'messaging.send': 1 }, expiresAt: Date.now() + 60_000 });
  await fire('after-grant');
  assert.equal(sends, 1);
  await fire('budget-exhausted');
  assert.equal(sends, 1);
  console.log('feature/bootstrap: denied -> granted -> one confirmed send');
} finally {
  controller.abort();
  await mount.stop(host);
  await host.stop();
  store.close();
  await rm(directory, { recursive: true, force: true });
}
```

这里手工构造 `LoadedNativeBootstrap` 以展示 SDK 装配，指纹来自实际执行文件。正式原生入口由运维指定 bootstrap 文件，loader 在导入与启动阶段核对内容，不由模型选择代码路径。`create()` 可以准备声明，外部活动放入有期限和 signal 的 start/stop；未安装的 prepared mount 可用 `abandonPrepared()` 放弃，已安装或 unknown 不允许这样退出。

## 包注册、插入点与服务

bootstrap 的 `create()` 可返回 `packages`。每个包声明 `manifest`：`schema`、`id`、`version`、`dependencies`、`provides`、`requires` 和 `contributions`；需要持久状态时声明 `stateSchemaVersion`。重复包、服务或贡献、缺依赖、循环与服务版本不匹配在启动前拒绝。独立包按数组顺序、依赖包按依赖顺序装配。

包执行 `prepare → migrate → install → recover → start`。在 `install` 中通过 `publishService()` 发布类型化服务或调用 `context.contribute()`，其 kind/id 必须已经声明。通用贡献包括 `feature`、`effect`、`event-validator` 和带 capabilities/order 的 `input-provider`；保留的 core/agent 能力不能被替换。输入准备只变换内容，不得替换账号、会话、来源或授权上下文。

`context.own(kind, id, dispose)` 登记 task、timer、subscription 等清理责任，停止按逆序排空、释放与注销。长期任务不能捕获原消息 execution；触发时取得新的受控执行，并重新核验当前权限。未知 disposer 已调用一次就保留证据，不靠 stop 重放。

服务提供方与消费者共用 `defineServiceContract<T>`；`serviceDeclaration` 将契约转为 manifest 的 `provides/requires` 声明。取得服务还需要在 `dependencies` 声明提供包，不能仅凭服务 ID 绕过包依赖。发布和取得时检查必需方法形状；参数、结果和副作用边界仍由具体服务负责。

```ts
import { defineServiceContract, publishService, serviceDeclaration, useService }
  from '@qq-bridge-framework/sdk/host';

interface ExampleService { format(text: string): string }
const EXAMPLE = defineServiceContract<ExampleService>({
  id: 'example-format', version: 1, description: '整理传入的文字。', methods: ['format'],
});
// 提供包 manifest.provides: [serviceDeclaration(EXAMPLE)]
// 提供包 install(context)：publishService(context, EXAMPLE, { format: text => text.trim() });
// 消费包 manifest.dependencies: ['提供包标识']，requires: [serviceDeclaration(EXAMPLE)]
// 消费包 start(context)：const formatter = useService(context, EXAMPLE);
```

共享服务用 `publishService`。绑定消费者身份的服务用 `publishScopedService(context, contract, consumer => client)`；`consumer` 由宿主提供 `{ owner, signal, assertActive }`，不能取自模型参数。注册器缓存各消费者的客户端，并在取得、方法访问和调用时检查提供方及消费者生命周期。停止后旧服务句柄不能开始新调用。方法返回的新操作句柄或迭代器不被代理自动包装，提供方须自行绑定消费者 signal 和活动检查；进行中的外部工作是否可取消和如何排空由具体服务约定。底层 `context.publish/service/publishScoped` 仍可用，类型化 helper 是公共契约的常用入口。

包管理器 `services()` 与宿主运行快照 `services` 提供 ID、版本、owner、来源、用途、方法名、`scoped` 和 `declared/registered/ready/unavailable`。`ready` 仅表示提供包运行且服务已发布，协议动作与模型的实际支持仍需 `catalog/inspect` 等领域接口确认。

默认 `native-services` 包提供五个版本 1 的服务：`native-agent`、`native-interactions`、`native-executions`、`native-tools`、`native-work`。使用后台工作时，包声明 `dependencies: ['native-services']` 与 `requires: [serviceDeclaration(NATIVE_WORK_SERVICE_CONTRACT)]`：

```ts
import { NATIVE_WORK_SERVICE_CONTRACT, useService } from '@qq-bridge-framework/sdk/host';
// packageContext 来自本包 start；execution 来自本包功能回调。
const work = useService(packageContext, NATIVE_WORK_SERVICE_CONTRACT);
const status = work.status();
if (status.available) await work.start(execution, { task: '整理当前明确要求的资料' });
```

这是局部调用片段。work 写操作内部仍调用该 execution 的 `invoke('native.work.*', ...)`，需要调用方 capability、会话 policy 和实际 QQ 来源；服务版本不授予权限。插件自主模型任务使用 `plugin-models`。其余接口提供当前 binding、交互快照、执行读查和工具目录，不公开原始 DSH RPC 或凭据。全部内置契约可从 SDK host 的 `FRAMEWORK_SERVICE_CONTRACTS` 查找，该目录也包含可选提供方，不是运行就绪清单。

生命周期 hook 可在以下 12 个 checkpoint 声明 observe：`runtime.starting`、`runtime.ready`、`runtime.stopping`、`runtime.stopped`、`message.normalized`、`message.admitted`、`message.rejected`、`agent.submitting`、`agent.submitted`、`send.before`、`send.after`、`access.changed`。只有 starting/admitted/submitting/send.before 支持限制性 guard。hook 按 order 再按 id 排序，缺省期限 1 秒、单项最多 30 秒；guard 可以拒绝，不能授权。局部定义如下：

```ts
const hook = { id: 'example-send-guard', checkpoint: 'send.before' as const,
  kind: 'guard' as const, timeoutMs: 500,
  run({ signal }: { signal: AbortSignal }) { signal.throwIfAborted(); } };
```

把 hook 放到 bootstrap 的 `lifecycleHooks`；执行与关闭验收见 [lifecycle-hooks.test.ts](../test/lifecycle-hooks.test.ts)。模型提问与记忆 proposal 确认仍留在所属 QQ 会话，工具按白名单与敏感操作主人身份检查，不能用 hook 或管理 route 建网页审批旁路。

## 配置贡献与日历

在 `defineNativeBootstrap({ packageConfigurations: [...] })` 顶层提供配置贡献，使管理端在未执行 create/start 时就能读取 schema、默认值和受控字段。运行包通过 `configurationIds` 引用同一贡献；不要复制另一份 schema。`context.configuration.read/inspect` 限于本 owner，`migrate` 限于本包迁移阶段。管理端支持 boolean、integer、string-list 声明式字段；保存使用文档 revision CAS，应用影响另行声明，配置保存不创建 grant。见 [package-configuration.ts](../src/contracts/package-configuration.ts)、[package-configuration.test.ts](../test/package-configuration.test.ts)。

常规插件优先使用上文的 `plugin-scheduler` 服务。下层 SDK 日历服务提供 daily/weekly、IANA 时区、DST 与 misfire 策略；由宿主调用 tick，不在注册时暗中启动计时循环。下面是使用已有私有 `store` 和受控 `dispatchOccurrence` 的局部片段：

```ts
import { createCalendarTriggerService } from '@qq-bridge-framework/sdk/host';
const calendar = createCalendarTriggerService({ store,
  callback: occurrence => dispatchOccurrence(occurrence) });
calendar.register({ id: 'daily-report', scope: 'private:123', timeZone: 'UTC',
  schedule: { kind: 'daily', hour: 10, minute: 0 },
  dst: { overlap: 'earlier', nonexistent: 'skip' },
  misfire: 'coalesce', windowMs: 3_600_000, payload: {} });
await calendar.tick({ limit: 16 });
calendar.setEnabled('daily-report', false);
await calendar.stop();
```

weekly 的 dayOfWeek 为 ISO 1–7。occurrence 在回调前持久化；中断结果为 unknown，不在重启时重放。宿主 `reminders` 服务在此基础上提供 once/delay/daily/weekly、规则 CAS、启停、next/history，并在发生时走当前 guard 与发送 policy。插件可以通过声明依赖并取得 `reminders` v1 服务注册定时规则；通用日历钩子也可直接用于插件任务。控制台不提供提醒规则表单，默认不向模型注册提醒工具。记忆与偏好同样通过 `memory` v1 服务接入，插件负责工具及上下文贡献。完整可重复验收见 [triggers.test.ts](../test/triggers.test.ts)、[native-reminders.test.ts](../test/native-reminders.test.ts)、[native-bootstrap-example.ts](../test/fixtures/native-bootstrap-example.ts)。

## 示例二：实际内容指纹、稳定键与 CAS 迁移

`owned-state.ts` 用一个实际内容文件演示身份核验，写入 65 个稳定键，验证过期 CAS 被拒绝，再把 schema 1 转为 schema 2。迁移页上限 60 条，因此会保存两个原子检查点；SQLite 重开后原键和新 schema 均保留。

<!-- sdk-example: owned-state.ts -->
```ts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativePackageState } from '@qq-bridge-framework/sdk/host';
import type { NativePackageStateIdentity } from '@qq-bridge-framework/sdk/contracts';
import { createSqliteStore } from '@qq-bridge-framework/sdk/storage';

const directory = await mkdtemp(join(tmpdir(), 'sdk-state-'));
const filename = join(directory, 'state.sqlite');
const contentFile = join(directory, 'package-content.txt');
const signal = new AbortController().signal;
const fingerprint = async () => createHash('sha256')
  .update(await readFile(contentFile)).digest('hex');
let store = createSqliteStore({ filename });
const state = (identity: NativePackageStateIdentity) => createNativePackageState({
  owner: 'example', store, identity,
  async verifyIdentity(expected) {
    assert.equal(await fingerprint(), expected.contentFingerprint);
  },
});
try {
  await writeFile(contentFile, 'schema=1\n', { mode: 0o600 });
  const old = state({ packageVersion: '1.0.0', stateSchemaVersion: 1,
    contentFingerprint: await fingerprint() });
  await old.initialize(signal);
  for (let index = 0; index < 65; index++) {
    await old.compareAndSet(String(index).padStart(3, '0'), null,
      { count: index }, signal);
  }
  await assert.rejects(old.compareAndSet('000', null, { count: 99 }, signal),
    { code: 'STORE_CONFLICT' });
  await writeFile(contentFile, 'schema=2\n', { mode: 0o600 });
  const identity = { packageVersion: '2.0.0', stateSchemaVersion: 2,
    contentFingerprint: await fingerprint() };
  const newer = state(identity);
  const previous = old.status();
  assert(previous.revision !== null);
  let progress = await newer.prepare(previous.revision, signal);
  let pages = 0;
  while (progress.migration) {
    assert(progress.revision !== null);
    progress = await newer.applyPage(progress.revision,
      progress.migration.operationId, entries => entries.map(entry => {
        assert(entry.value !== null && typeof entry.value === 'object'
          && !Array.isArray(entry.value) && typeof entry.value.count === 'number');
        return { key: entry.key, value: { count: entry.value.count + 1 } };
      }), signal);
    pages++;
  }
  assert.equal(pages, 2);
  assert.equal(progress.ready, true);
  assert.deepEqual(newer.read('000')?.value, { count: 1 });
  store.close();
  store = createSqliteStore({ filename, requireExisting: true });
  const reopened = state(identity);
  assert.equal(reopened.status().ready, true);
  assert.equal(reopened.read('064')?.stateSchemaVersion, 2);
  assert.deepEqual(reopened.read('064')?.value, { count: 65 });
  assert.equal(store.list('package.example.state', { limit: 100 }).length, 65);
  console.log('owned state: stale CAS rejected; 65 stable keys migrated in two pages');
} finally {
  store.close();
  await rm(directory, { recursive: true, force: true });
}
```

生产包应提供覆盖其实际代码的 `content`，或使用原生 bootstrap 的内容 driver。示例的单文件 hash 只演示 `verifyIdentity`，不声称覆盖依赖树。原生 loader 支持入口旁的 `<entry>.manifest.json`：

```json
{
  "schema": 1,
  "entry": "extension.ts",
  "dependencies": [
    { "specifier": "@qq-bridge-framework/sdk/host", "lockFile": "package-lock.json" }
  ]
}
```

完整覆盖标记为 `package-tree-and-dependency-locks-v1`：相对导入必须落在根目录内的已计入文件，外部运行时导入按准确 specifier 声明 npm lock v2/v3 的 version/integrity。树最多 256 个文件、总 8 MiB、单文件 1 MiB、深度 8；排除 runtime、node_modules、密钥与数据库等运行数据，拒绝链接、目录外导入和不可核验的动态加载。内容变更要求新进程加载。缺少 sidecar 的兼容入口标记为 `entry-only`，内置包为 `builtin-host-files`；这些范围不升级成完整依赖验证。指纹不是代码签名、授权或沙箱。规则与样本见 [bootstrap-content.ts](../scripts/bootstrap-content.ts)、[bootstrap-content.test.ts](../test/bootstrap-content.test.ts)。

状态元数据记录 packageVersion、stateSchemaVersion、contentFingerprint。`prepare()` 固定目标和 operationId；`applyPage()` 在 converter 前写 applying，再原子检查并更新该页。converter 保持键集合，只返回新 JSON 值，不执行网络或其他外部副作用。超时留下 unknown，晚回结果不提交；核对与明确后续动作见 [RECOVERY.md](RECOVERY.md)。旧 raw 状态必须显式 `prepareLegacyAdoption()`，其来源 schema 为 0，不能猜测为当前版本。完整迁移、冲突和旧键 TTL 验收见 [native-package-state.test.ts](../test/native-package-state.test.ts)。

## 示例三：同步协议工厂与真实账号隔离

`accounts.ts` 注册合成协议，以同步 factory 为两个账号构造真实独立的 bridge/SQLite。两个账号可以拥有相同 conversation、外部 session 和 grant ID；A 的发送和额度不影响 B，错误 scope 被拒绝。异步初始化属于 `start(signal)`，factory 不返回 Promise。

<!-- sdk-example: accounts.ts -->
```ts
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContextStore, type FeatureDefinition } from '@qq-bridge-framework/sdk';
import { createBridgeHost, createNativeAccounts,
  type NativeAccountProtocol } from '@qq-bridge-framework/sdk/host';
import type { AccountScope } from '@qq-bridge-framework/sdk/contracts';
import { createSqliteStore, assertAccountStore } from '@qq-bridge-framework/sdk/storage';

const directory = await mkdtemp(join(tmpdir(), 'sdk-accounts-'));
const signal = new AbortController().signal;
const hosts = new Map<string, ReturnType<typeof createBridgeHost>>();
const delivered: string[] = [];
const feature: FeatureDefinition = {
  id: 'example-send', version: '1.0.0', apiVersion: 1,
  capabilities: ['messaging.send'], subscriptions: ['trigger.fired'],
  setup(services) {
    services.on('trigger.fired', async execution => {
      await execution.send([{ type: 'text', text: 'account-local' }]);
    });
  },
};
const protocol: NativeAccountProtocol = {
  id: 'example',
  create({ directory: accountDirectory, accountScope }) {
    const store = createSqliteStore({ filename: join(accountDirectory, 'state.sqlite') });
    const context = createContextStore();
    const persona = context.registerPersona({ id: 'example', version: '1',
      name: 'Example', identity: {}, style: {} });
    const host = createBridgeHost({ store, context, persona, accountScope,
      authorizeIncoming: () => false,
      transport: { async send() {
        delivered.push(accountScope.accountId);
        return { status: 'confirmed', messageId: 'same-message-id' };
      } },
      agent: {
        async createSession() { return { sessionId: 'same-external-session' }; },
        async submit() { return { status: 'accepted' }; },
        async follow() { return () => {}; },
      },
    });
    host.engine.install(feature);
    assertAccountStore(store, accountScope);
    hosts.set(accountScope.accountId, host);
    return {
      async start(startSignal) { startSignal.throwIfAborted(); await host.start(); },
      async stop() { await host.stop(); },
      async close() { await host.stop(); store.close(); },
    };
  },
};
const accounts = createNativeAccounts({ directory, protocols: [protocol] });
const scopeA: AccountScope = { protocolId: 'example', accountId: 'a' };
const scopeB: AccountScope = { protocolId: 'example', accountId: 'b' };
try {
  let snapshot = await accounts.read();
  assert.equal(hosts.size, 0);
  for (const accountScope of [scopeA, scopeB]) {
    snapshot = await accounts.create({ revision: snapshot.revision,
      label: accountScope.accountId, accountScope }, signal);
  }
  assert.equal(hosts.size, 0);
  for (const account of snapshot.accounts) await accounts.start(account.id, signal);
  for (const [accountId, host] of hosts) {
    const binding = await host.sessions.resolve('private:123', signal);
    assert.equal(binding.sessionId, 'same-external-session');
    assert.equal(binding.accountScope?.accountId, accountId);
    host.policy.grant({ id: 'same-grant-id', accountScope: host.accountScope,
      featureId: feature.id, conversationId: 'private:123',
      capabilities: ['messaging.send'], maxUses: { 'messaging.send': 1 } });
  }
  const a = hosts.get('a');
  const b = hosts.get('b');
  assert(a && b);
  assert.throws(() => a.policy.reserve({ accountScope: scopeB,
    featureId: feature.id, conversationId: 'private:123', capability: 'messaging.send' }),
    { code: 'ACCOUNT_SCOPE_MISMATCH' });
  await a.engine.emit({ id: 'same-event-id', type: 'trigger.fired',
    accountScope: scopeA, conversationId: 'private:123', data: {} });
  assert.deepEqual(delivered, ['a']);
  assert.equal(b.policy.describe().grants[0]?.used['messaging.send'], 0);
  await b.engine.emit({ id: 'same-event-id', type: 'trigger.fired',
    accountScope: scopeB, conversationId: 'private:123', data: {} });
  assert.deepEqual(delivered, ['a', 'b']);
  console.log('accounts: synchronous construction; independent stores, scopes and budgets');
} finally {
  await accounts.close();
  await rm(directory, { recursive: true, force: true });
}
```

原生 gateway 的 OneBot factory 还核验实际 WS/HTTP selfId 与 accountScope.accountId 一致。同步 factory 返回 thenable 时立即拒绝为非法工厂，不等待永不 settle 的 Promise，也不声称能回收它偷偷创建的资源；close 有界、每个 runtime 只调用一次，超时保留 unknown。账号接管、HTTP dispatch 与重启意图见 [RECOVERY.md](RECOVERY.md)；真实默认 gateway 验收见 [native-account-gateway.test.ts](../test/native-account-gateway.test.ts)。


### OneBot 扩展媒体解析

启动扩展的 `onebot.resolveAsset` 接收 `OneBotAssetResolutionRequest`。其中 `persona` 是包含版本的完整键 `id@version`，应与 `personaKey({ persona: scope.persona })` 比较；不要与裸 `scope.persona.id` 比较，也不要去掉版本后放行。还须核验原会话、session、generation、资源归属和当前权限。图片解析完成后再提交协议端；解析被拒绝也会产生未发送回执，不能仅凭 `rejected` 判定是协议服务拒绝。

跨轮复用的扩展参考图登记应通过宿主 `DurableStore` 保存，设置明确有效期、容量及会话、人设、用户归属，随宿主过期维护清理。关闭扩展不等于撤销尚有效的登记；会话解绑、人设版本变化和跨用户使用仍需重新登记。模型只传 opaque 标识，不能指定本机路径。

工具客户端应读取有界错误响应，保留已知原因码及可执行的恢复说明。参考图失效是提交前的素材错误，应明确告知“未提交，重新准备参考图后再生成”；权限拒绝、队列已满与外部提交结果未知分别处理。只有服务明确确认未提交时才能据此恢复，网络中断或无法识别的结果不自动重试生图。

扩展的内部生成模板和固定参考素材可直接在服务端组合，不必作为模型可读工具结果或 skill 提供。自身形象生成只接收主体选择与本次附加要求，通用生图继续接收普通内容要求；角色档案、基础提示词和固定参考图不返回聊天上下文。工具回包应区分排队、生成、发送与确认送达，只报告已观察状态，未提供成图就不能让模型把模板细节当作视觉结果。

可信启动扩展可将异步结果交回原聊天会话，由当前 AI 结合人设与历史组织回复。待原会话空闲并重新核验原绑定和当前访问权限后，调用 `host.notifyAgent({ binding, id, content, signal, presentation: 'reply' })`；`content` 应明确说明这是宿主观察到的结果资料，要求本轮只输出面向用户的正文，不调用工具、不重试业务。传入有界失败事实和原请求者身份，具体语气交给当前人设，不固定称呼或套用话术。

`presentation: 'reply'` 为该条宿主通知持久登记一次正文呈现资格；模型文本、普通用户消息和普通最终正文不能自行取得资格。返回 `accepted` 只表示已提交给原模型会话。`host.agentNotificationDelivery(binding, id)` 返回 `pending`、`confirmed`、`rejected` 或 `unknown`，只有实际 QQ 回执确认后才是 `confirmed`。呈现期限为九十秒，仍经过原输出准备、绑定和权限检查；记录存在时同一通知 ID 不重复提交，参数改变拒绝，未知结果不重放。已确认或拒绝的送达记录保留七天，未知和未结清记录保留；业务永久去重由调用方保存。AI 处理失败时保留未知或拒绝状态，不直接发送原始错误作为兜底。调用方负责有界等待空闲、业务去重及停止排空。

## 空间底层服务

内置包 `qzone` 提供 `QzoneToolPort`。扩展在 manifest 中声明 `dependencies: ['qzone']` 与 `requires: [serviceDeclaration(QZONE_SERVICE_CONTRACT)]`，通过 `useService(context, QZONE_SERVICE_CONTRACT)` 取得；`inspect` 核对当前协议能力，`execute` 按原 OneBot 名称与参数调用。原生聊天会按实际协议能力另行登记发布与删除工具，复用会话白名单和真实消息来源校验；扩展直接调用底层服务时，自行通过宿主 policy 确认触发与访问范围。完整示例与边界见 [空间说说](QZONE.md)。


## 插件直接使用协议能力和模型会话

配置了宿主 `runtimeServices` 工厂时，包管理器自动加入内置 `plugin-runtime` 包。插件声明包依赖和所需服务，用 `useService` 取得带宿主身份及生命周期的客户端。以下是一个包定义片段：

```ts
import { PLUGIN_MODELS_SERVICE_CONTRACT, PLUGIN_PROTOCOL_SERVICE_CONTRACT,
  serviceDeclaration, useService } from '@qq-bridge-framework/sdk/host';
import type { NativePackageDefinition } from '@qq-bridge-framework/sdk/host';

export const writingPackage: NativePackageDefinition = {
  manifest: { schema: 1, id: 'example-writing', version: '1.0.0',
    displayName: '文案起草', description: '在插件会话中起草文案。',
    dependencies: ['plugin-runtime'], provides: [], contributions: [],
    requires: [serviceDeclaration(PLUGIN_MODELS_SERVICE_CONTRACT),
      serviceDeclaration(PLUGIN_PROTOCOL_SERVICE_CONTRACT)] },
  start(context) {
    const models = useService(context, PLUGIN_MODELS_SERVICE_CONTRACT);
    const protocol = useService(context, PLUGIN_PROTOCOL_SERVICE_CONTRACT);
    // 在已登记的任务回调中执行，不在安装时自动调用模型或发布：
    const draft = async () => {
      const result = await models.run({ name: 'daily-writing',
        prompt: '接着之前的主题，起草今天的短文案。' });
      return result.text; // 只交回业务，不自动发到 QQ。
    };
    // 将 draft 接入本包任务；protocol.catalog/call 用于明确的协议动作。
  },
};
```

`context.runtime` 是同一组服务的便利 getter；读取 `models/capabilities/sessions/scheduler/tools/media/extensions/usage/events` 分别要求对应契约的 `requires`。不要依赖未声明的 getter，或把可选宿主能力缺失当作成功。可信 bootstrap 保留由宿主注入的 runtime 便利入口。

协议客户端的 `catalog({ id })` 读取具体参数；`call({ id, input, idempotencyKey })` 调用协议动作。写操作必须给稳定幂等键，重启后相同动作仍使用原键，不能为绕过未知结果换键重发。当前适配器按实际协议版本与能力清单开放；插件获得 `confirmed`、`rejected` 或 `unknown` 回执。插件可用协议原生本机文件参数处理自己生成的素材，不必伪造 QQ 发言或会话媒体资源。

发送和收藏表情沿用这一客户端：`send_group_msg/send_private_msg` 及实际支持的转发动作；`fetch_custom_face/fetch_custom_face_detail/add_custom_face/delete_custom_face/set_custom_face_desc`。先读取实际参数，再提交稳定幂等键。直接协议发送不自动执行聊天排版、聊天 outbox 或历史追加；`chat-output` 只准备内容和分组。需要聊天发送语义的功能回调使用 `FeatureExecution.send`，模型使用 `qbf_reply`，这些入口继续走聊天 policy 与真实发送回执。

以下是已声明协议服务的任务回调片段；目标与业务操作标识来自插件自己的可信配置和持久业务记录：

```ts
const protocol = useService(context, PLUGIN_PROTOCOL_SERVICE_CONTRACT);
const sendSupport = await protocol.catalog({ id: 'send_private_msg' });
const stickers = await protocol.call({ id: 'fetch_custom_face_detail', input: { count: 10 },
  signal: context.signal });
// 业务已要求发送，并核实当前协议支持：
if (sendSupport.capabilities.some(item => item.id === 'send_private_msg')) {
  const receipt = await protocol.call({ id: 'send_private_msg',
    input: { user_id: configuredUserId, message: [{ type: 'text', data: { text: draftText } }] },
    idempotencyKey: savedOperationId, signal: context.signal });
  // 持久保存 receipt；unknown 时核对原动作，不换键重发。
}
```


`runtime.models` 提供 `models/list/create/bind/unbind/run`；`run` 首次自动建会话，默认持续复用。插件自建会话不加载 QQ 人设、聊天方案或工具，绑定已有会话沿用已有历史；模型服务细节见 [插件模型与持久会话](PLUGIN_MODELS.md)。插件业务数据仍放在包持久状态中，模型上下文仅保存必要任务历史。

`runtime.sessions.resolve('group:123456')` 或 `private:123456` 返回实际 QQ 绑定及可直接用于管理的 `target` 版本；`bind(target, sessionId, signal)`、`unbind(target)` 要求完整当前版本，保留 DSH 历史。插件可以解析 QQ 绑定后把该实际 ID 交给 `runtime.models.bind`。插件固定绑定该 ID，QQ 后来换绑不会自动改变插件上下文。

通过 `PLUGIN_MEDIA_SERVICE_CONTRACT` 取得原图客户端，其 `readImage({ conversationId, referenceId, signal })` 读取当前账号与 QQ 会话已登记的原图，返回 `{ assetId, data: Uint8Array, mediaType, sha256, expiresAt }`。图片最大 8 MiB，支持 PNG、JPEG、WebP、GIF；`sha256` 是返回原图字节的 SHA256。插件在实际工具调用中使用宿主核验的所属会话，不接受模型另指定的目标会话。该接口不接收 URL 或文件路径，只从对应登记取得协议来源；每次读取及返回前重新核验访问规则和插件生命周期。

`referenceId` 优先使用 `media-<64 位十六进制>` 登记编号；也兼容图片附件的 SHA256（可带 `sha256:` 前缀）。模型实际读取的静态图片可能经过缩放压缩，框架把该附件字节的指纹保存为原图登记的别名，每图最多四个、每次最多扫描一千条登记，账号、会话和原有效期均保持一致；指纹本身不授予跨会话访问。不存在别名的旧指纹不会触发扫描下载或猜测匹配。读取原图供生成、编辑等插件使用，不把原图读取等同于已交给模型理解。

读取错误通过 `FrameworkError.code` 区分：`NATIVE_IMAGE_REFERENCE_NOT_FOUND` 表示当前会话找不到登记或附件别名（记录可能已清理），`NATIVE_IMAGE_REFERENCE_SCOPE_MISMATCH` 表示登记账号或会话不符，`NATIVE_IMAGE_REFERENCE_EXPIRED` 表示可读取元数据中的原有效期已到，`NATIVE_IMAGE_REFERENCE_READ_FAILED` 表示登记、原图下载、大小或格式不符合读取要求。存储已隐藏或清理的过期登记按 `NOT_FOUND` 返回，插件应据实际错误说明原因，不把所有失败归为登记过期。

对 QQ 命令开放这些内部接口时，插件入口负责校验真实发言者；定时任务以已登记插件身份执行，不需要伪造主人消息。生命周期结束后旧实例不能继续提交调用。对模型开放的管理动作使用框架二级能力目录，由宿主核验实际主人。

## 插件用量与事件读取

声明 `plugin-runtime` 依赖及 `PLUGIN_USAGE_SERVICE_CONTRACT`、`PLUGIN_EVENTS_SERVICE_CONTRACT` 后，可在包 `start` 或业务回调中读取：

```ts
import { PLUGIN_USAGE_SERVICE_CONTRACT, PLUGIN_EVENTS_SERVICE_CONTRACT, useService }
  from '@qq-bridge-framework/sdk/host';
// context 来自本包生命周期回调，manifest.requires 已声明两个契约。
const usage = useService(context, PLUGIN_USAGE_SERVICE_CONTRACT);
const page = usage.list({ limit: 20 });
const totals = usage.summary();
const events = useService(context, PLUGIN_EVENTS_SERVICE_CONTRACT);
const recent = events.read({ limit: 20 });
// 在受管理任务内订阅，signal 结束或退出循环后关闭底层订阅。
// for await (const item of events.subscribe({ signal: context.signal })) { ... }
```

用量直接查询现有宿主账本，按逐轮保存的 `plugin:<owner>` 归属过滤；支持 session/provider/model/时间和游标筛选。插件绑定共享会话不获得该会话其他调用者的用量；旧绑定的本插件记录仍可查。未知 token/成本保持未知，多币种分别统计；读取结果须检查 `partial/next`，不能把扫描上限内的结果当作完整账本。没有清账或改价接口。

事件读取和订阅复用宿主实际有界观察流，仅提供公共 runtime 生命周期和能从插件请求 ID 或已确认 turn 核实归属的元数据。共享 session 本身不是归属证明，无法证明的事件不返回；不提供 QQ 正文、地址或完整私有协议追踪。宿主游标、epoch 与缺口继续保留，缺口和过滤后的空页不能解释为没有发生动作；流不替代持久账本、业务 `subscriptions/services.on` 或未知执行核对。

## 会话任务执行器

框架内置持久会话任务，SDK 可注册版本化执行器、发出相关事件，承接时间与条件触发的工作。接口、恢复与预算要求见 [会话任务与续聊](CONVERSATION_TASKS.md#扩展执行器)。
