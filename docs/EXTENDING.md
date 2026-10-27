# 扩展开发

扩展通过功能定义、宿主服务、包贡献和生命周期进入框架。声明入口后，实际副作用仍由调用方的 `FeatureExecution` 和当前 policy 核验。bootstrap 是可信运维代码，在宿主进程内运行；安装扩展需要运维信任，运行扩展还需要独立的会话授权。

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

框架投影工具在 `FrameworkToolDefinition.registrationSource` 中声明。直接在 DSH 注册工具时，使用桥接插件的 `@qq-agent-framework/dsh-bridge-plugin/registration` 导出：

```ts
import { withToolRegistration, declareMcpToolRegistration } from '@qq-agent-framework/dsh-bridge-plugin/registration';

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

目前没有独立的插件市场、目录自动热加载或一站式工具插件注册器。控制台读取注册元数据和实际运行状态，不能把尚未接入的源码目录显示为已安装。工具页分别呈现声明、注册与会话加载状态，框架服务页展示基础设施。

## SDK 与示例运行方式

当前 SDK 包为 `@qq-agent-framework/sdk`，要求 Node.js 24.12.0 或更新版本。以下子路径有公开 `exports` 和声明文件：

| 导入路径 | 用途 |
| --- | --- |
| `@qq-agent-framework/sdk` | 核心类型、上下文、policy、engine 与 `defineNativeBootstrap`。 |
| `@qq-agent-framework/sdk/core` | 核心运行接口。 |
| `@qq-agent-framework/sdk/host` | bridge、bootstrap、包、配置、任务、日历、事件、服务与账号 registry。 |
| `@qq-agent-framework/sdk/contracts` | 纯 DTO、ports、account scope、事件与包状态契约。 |
| `@qq-agent-framework/sdk/storage` | SQLite、只读 SQLite、持久 policy/state 和账号 store 绑定。 |
| `@qq-agent-framework/sdk/adapters` | 可复用的外部协议适配器，当前提供 OneBot 空间发布与删除。 |

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
npm install --ignore-scripts /tmp/qq-agent-framework-sdk-0.1.0.tgz
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
  type FeatureDefinition } from '@qq-agent-framework/sdk';
import { createBridgeHost, createNativeBootstrapMount,
  type LoadedNativeBootstrap } from '@qq-agent-framework/sdk/host';
import { createSqliteStore } from '@qq-agent-framework/sdk/storage';

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

包执行 `prepare → migrate → install → recover → start`。在 `install` 中调用 `context.publish()` 或 `context.contribute()`，其 kind/id 必须已经声明。通用贡献包括 `feature`、`effect`、`event-validator` 和带 capabilities/order 的 `input-provider`；保留的 core/agent 能力不能被替换。输入准备只变换内容，不得替换账号、会话、来源或授权上下文。

`context.own(kind, id, dispose)` 登记 task、timer、subscription 等清理责任，停止按逆序排空、释放与注销。长期任务不能捕获原消息 execution；触发时取得新的受控执行，并重新核验当前权限。未知 disposer 已调用一次就保留证据，不靠 stop 重放。

默认 `native-services` 包提供五个版本 1 的服务：`native-agent`、`native-interactions`、`native-executions`、`native-tools`、`native-work`。消费者必须在 manifest 中声明 `requires: [{ id: 'native-work', version: 1 }]`。例如，在已装配包中获取服务：

```ts
import { requireNativeHostService } from '@qq-agent-framework/sdk/host';
// packageContext 来自本包 install；execution 来自本包功能回调。
const work = requireNativeHostService(packageContext, 'native-work');
const status = work.status();
if (status.available) await work.start(execution, { task: '整理当前明确要求的资料' });
```

这是局部调用片段。work 写操作内部仍调用该 execution 的 `invoke('native.work.*', ...)`，需要调用方 capability、会话 policy 和实际 QQ 来源；服务版本不授予权限。其余接口提供当前 binding、交互快照、执行读查和工具目录，不公开原始 DSH RPC、凭据或可直接产生副作用的 executor。见 [native-services.ts](../src/host/native-services.ts)、[native-services.test.ts](../test/native-services.test.ts)。

生命周期 hook 可在以下 12 个 checkpoint 声明 observe：`runtime.starting`、`runtime.ready`、`runtime.stopping`、`runtime.stopped`、`message.normalized`、`message.admitted`、`message.rejected`、`agent.submitting`、`agent.submitted`、`send.before`、`send.after`、`access.changed`。只有 starting/admitted/submitting/send.before 支持限制性 guard。hook 按 order 再按 id 排序，缺省期限 1 秒、单项最多 30 秒；guard 可以拒绝，不能授权。局部定义如下：

```ts
const hook = { id: 'example-send-guard', checkpoint: 'send.before' as const,
  kind: 'guard' as const, timeoutMs: 500,
  run({ signal }: { signal: AbortSignal }) { signal.throwIfAborted(); } };
```

把 hook 放到 bootstrap 的 `lifecycleHooks`；执行与关闭验收见 [lifecycle-hooks.test.ts](../test/lifecycle-hooks.test.ts)。模型提问与记忆 proposal 确认仍留在所属 QQ 会话，工具按白名单与敏感操作主人身份检查，不能用 hook 或管理 route 建网页审批旁路。

## 配置贡献与日历

在 `defineNativeBootstrap({ packageConfigurations: [...] })` 顶层提供配置贡献，使管理端在未执行 create/start 时就能读取 schema、默认值和受控字段。运行包通过 `configurationIds` 引用同一贡献；不要复制另一份 schema。`context.configuration.read/inspect` 限于本 owner，`migrate` 限于本包迁移阶段。管理端支持 boolean、integer、string-list 声明式字段；保存使用文档 revision CAS，应用影响另行声明，配置保存不创建 grant。见 [package-configuration.ts](../src/contracts/package-configuration.ts)、[package-configuration.test.ts](../test/package-configuration.test.ts)。

SDK 日历服务提供 daily/weekly、IANA 时区、DST 与 misfire 策略；由宿主调用 tick，不在注册时暗中启动计时循环。下面是使用已有私有 `store` 和受控 `dispatchOccurrence` 的局部片段：

```ts
import { createCalendarTriggerService } from '@qq-agent-framework/sdk/host';
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
import { createNativePackageState } from '@qq-agent-framework/sdk/host';
import type { NativePackageStateIdentity } from '@qq-agent-framework/sdk/contracts';
import { createSqliteStore } from '@qq-agent-framework/sdk/storage';

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
    { "specifier": "@qq-agent-framework/sdk/host", "lockFile": "package-lock.json" }
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
import { createContextStore, type FeatureDefinition } from '@qq-agent-framework/sdk';
import { createBridgeHost, createNativeAccounts,
  type NativeAccountProtocol } from '@qq-agent-framework/sdk/host';
import type { AccountScope } from '@qq-agent-framework/sdk/contracts';
import { createSqliteStore, assertAccountStore } from '@qq-agent-framework/sdk/storage';

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
