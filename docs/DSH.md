# DSH 接入与运行边界

本框架通过官方 DSH SDK 的 HTTP/WS 协议连接独立 DSH 实例。DSH 执行模型请求，本框架管理 QQ 来源、会话绑定、参与规则、权限、副作用和恢复证据。连接成功、请求受理、模型完成和 QQ 投递确认分别记录。

## 版本与安装

当前桥接插件是 `@qq-agent-framework/dsh-bridge-plugin` **0.2.0**，适配官方 DSH SDK **0.2.1-rc.2** 和 Cordis **4.0.5**。框架要求 Node.js **24.12.0 及以上**。插件清单中的 SDK peer dependencies 使用精确版本；升级 SDK 后需重新验证协议和运行行为。

插件当前通过本仓库构建的 tarball 安装，未提供公开 npm 发布安装承诺。在框架仓库根目录执行以下命令可生成安装包：

```sh
npm --prefix packages/dsh-bridge-plugin ci --ignore-scripts --no-audit --no-fund
npm --prefix packages/dsh-bridge-plugin run build
artifact_dir="$(mktemp -d)"
(cd packages/dsh-bridge-plugin && npm pack --ignore-scripts --pack-destination "$artifact_dir")
printf '安装包目录：%s\n' "$artifact_dir"
```

记下输出的 `.tgz` 绝对路径。在你管理的独立 DSH Node 项目目录中明确安装它，例如：

```sh
npm install --ignore-scripts /absolute/path/qq-agent-framework-dsh-bridge-plugin-0.2.0.tgz
```

安装前核对该实例的 SDK 版本与锁文件。安装包只包含公开清单及编译后的插件文件，不包含框架配置、凭据或会话数据。隔离打包验收会在临时项目中安装真实 tarball，核对既有依赖的版本和完整性，并运行官方 SDK 的加载及 owner 认证测试。

## 将插件加载到 DSH

安装 npm 包后，还需让独立 DSH 实例的 Cordis 启动过程加载它。已经实际验证的入口是官方 `@deepseek-ai/cordis-plugin-loader` **1.0.6**。若实例尚未提供 Loader，先在该独立项目中明确安装：

```sh
npm install --ignore-scripts @deepseek-ai/cordis-plugin-loader@1.0.6
```

然后在其启动装配中使用：

```ts
import type { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';

// 在独立 DSH 的启动代码中调用；ctx 是该实例已有的 Cordis Context。
// 此示例适用于尚未安装 Loader 的 ctx。
export async function loadFrameworkBridge(ctx: Context): Promise<void> {
  const loader = ctx.plugin(Loader);
  await loader.inertia;
  await ctx.loader.create({
    name: import.meta.resolve('@qq-agent-framework/dsh-bridge-plugin'),
  });
  await ctx.loader.await();
}
```

调用前，该 DSH Context 必须已经提供 `agents`、`agentPresets`、`tools` 和 `typertGateway` 服务。已有 Loader 的实例复用原 Loader，只执行 `create` 和 `await`；同一实例只加载一份桥接插件。实际集成测试还装配官方 session、projection、system prompt、LLM、registry、remote access、gateway、preset 和 agent loop 服务，覆盖了插件入口及真实 session controller。

上例是经过测试的程序加载 API。现有 DSH 实例如何持久保存这段启动装配，应由该实例自己的启动管理方式决定。本框架没有提供已验证的通用永久 Cordis YAML 插入方案，也不会在控制台连接或应用方案时自动安装 npm 包、加载插件或重启 DSH。

插件通过 owner 认证后的 `bridgePlugin/describe` 声明 `qq-agent-framework.dsh-bridge/1`、插件和 SDK 版本、当前 `issuerEpoch` 及证据保留能力。普通模型工具调用者不能借用这个管理身份。

对应实现与真实加载测试见 [插件入口](../packages/dsh-bridge-plugin/src/index.ts)、[官方 SDK 加载测试](../packages/dsh-bridge-plugin/test/sdk-entry.test.ts) 和 [隔离打包验收](../packages/dsh-bridge-plugin/scripts/verify-packed.ts)。

## 本机连接与鉴权

在控制台连接页选择“自动连接本机 DSH”。默认路径会寻找同一系统用户运行的 DSH web 服务，识别其 `DSH_HOME` 和回环地址，读取本机鉴权配置并验证服务。用户无需重复填写地址、令牌或凭据文件路径。

当前自动鉴权实现面向 Linux：从 `/proc` 有界读取同用户 DSH 进程信息，并尝试发现的地址及本机候选端口。候选验证有数量和总时间上限，不扫描任意远程地址。本机凭据文件必须是当前用户拥有、权限为 `0600` 或 `0400` 的普通单链接文件；实际读取拒绝路径替换、符号链接和不安全文件。认证材料只用于内部生成受限的 owner 连接凭据，不回传到浏览器。

远程实例或手动接入放在“手动连接/远程DSH”高级设置。地址和认证需要属于同一个受管理实例。交互答复需要能够建立 `interactions: answer` 的 owner 连接；仅有旧 cookie 的连接不能据此承诺模型提问和工具确认可用。Windows/macOS 的本机自动鉴权尚无本实现的验收保证，可使用明确的高级接入方式。

实现见 [本机发现](../src/host/local-dsh-discovery.ts)、[本机鉴权](../src/adapters/dsh-local-auth.ts) 和 [DSH 端口工厂](../src/adapters/dsh-jsonrpc.ts)。

## 应用方案与实际模型元数据

先保存提供方、模型和人设，再在方案页选择“更新聊天”。这一操作保存当前编辑方案并选择启用，再创建一次应用；无更改且已启用的方案不会重复保存。其他页面保留对应应用入口。宿主读取保存后的实际 revision，自动识别 DSH 静态配置层、目标路由和模型元数据，生成受管理配置；用户不需要重新填写内部路径或已经可读的模型容量。

应用过程核对保存 revision、文件来源和备份，保留非托管内容。配置包含实际支持的推理档位、输入模态及上下文/输出保留参数；缺少或矛盾的模型元数据会阻止相关应用或迁移，不从模型名称猜测能力。独立助手使用单独核验和部署的目标预设。

思考强度查询与应用流程采用相同的来源选择：在相同规范服务地址和模型标识的真实声明中，优先匹配所选 API 类型；没有该类型的声明时，使用其余一致的声明。声明相互冲突或缺失时保持未知。框架生成的会话路由不作为模型原始能力来源，避免把会话容量限制误当作模型窗口。

浏览器只提交一个应用 operation，后台按持久阶段执行停止、准备、应用、会话衔接和启动。关闭页面后可只读查找原操作。丢失回包时按原 operationId 核对；不会因轮询或重新打开页面再次提交相同应用。

`pending_reload` 表示配置已经写入、尚未核验被 DSH 加载。正常应用会在有界时间内只读等待加载，核验通过后继续原操作；仍未加载时显示等待核对。框架不自动重启 DSH。必要时按实例运维方式使配置加载，再明确选择“核对并继续更新”：原配置和实际加载证据通过后，只沿原操作继续会话衔接与启动，不再次写入或应用。文件来源和预设核验成功仍不证明模型服务可调用，也不证明凭据当前加载值的身份一致；控制台保留这些未验证项。

启动检查只核对连接与配置，不发送模型请求。当前原生状态的 `modelExecutionVerified` 固定为 `false`，表达这一检查范围，不会在后台等待一次模型核验后自动变更。实际请求与回复结果请在会话及执行记录中核对。

## 明确重启本机 DSH

普通“更新聊天”和生效检查不自动重启 DSH。需要维护时，宿主可提供 `/api/chat/dsh/restart`：GET 只读返回可用性及原操作；POST 携带新的 `operationId` 和当前八份 `revisions`，建立持久维护操作。服务先停止并排空聊天，再重启已确认归属的本机 DSH，核验连接与配置，最后按原运行意图恢复聊天；已有待加载应用则核对并继续原应用，不重复 apply。没有待续行应用时，原来停止的聊天保持停止；已有等待加载的应用按原更新意图继续。维护完成提示不根据 `wasRunning` 推测聊天最终状态，会话历史保留。

当前实际进程适配器只支持服务端配置的受控本机 `qqbridge` 管理入口，并核验文件权限、归属及该管理器的 DSH 凭据目录与自动发现目标一致。浏览器不能指定命令或参数。本机实例必须能被识别并核验进程归属；进程缺失、完全宕机无法识别目标时，页面说明需先恢复服务，不承诺用重启入口盲目启动。远程 DSH、未配置管理器、目标不匹配、其他账号仍在使用同一实例或存在未排空工作时，入口不可用或拒绝维护。

重启响应丢失或进程中断时，保留原操作；查询原 ID 或明确 POST `/api/chat/dsh/restart/reconcile`，body 为 `{ "operationId": "<原 UUID>" }`。核对不会再次执行 restart；证据允许时只继续验证与恢复，证据不足时保持未知。`restartExecutionVerified` 只记录重启命令是否已确认执行，不代表模型调用成功。 普通空查询不会解除未知状态；明确核对证实未受理并原子封存旧 ID 后，才允许新的明确重启，迟到旧请求保持拒绝。

## 工具、媒体与 QQ 交互

框架工具通过受控的 SDK projection lease 安装到具体 session/generation。每次调用关联当前 execution、requestId、真实 SDK claim 和原 QQ 来源，再经功能事件及 policy 执行。模型输入不能指定可信来源或扩大 scope。撤销权限后，下一次投影和实际调用都会重新核验。

DSH 原有工具清单单独核验。检查时只排除当前框架 lease 实际安装的工具名，不按任意名称前缀豁免其他工具。观察到外部工具清单不表示本框架核验了该工具的具体外部动作权限。

入站图片、音频、文件和合并转发先登记为所属会话的 opaque 资源；不会把原始 URL、本机路径或任意协议数据作为模型已读内容。显式媒体读取还需对应权限与当前后端能力：

| 内容 | 当前读取方式与限制 |
| --- | --- |
| 图片 | 获取受控来源的实际字节，核对模型输入模态后以官方 SDK `ImageBlock` 提供；工具回包上限为 512 KiB，当前原始图片字节上限为 383 KiB，为 base64 编码与封装预留空间，超限明确返回不可读。 |
| 文件 | 提供有界、有效 UTF-8 正文；二进制文件或超限文件明确不可读，不将 `FileBlock` 当成已理解正文。 |
| 音频 | 宿主可注入受控转录器；默认未配置时明确 `contentRead=false`，不会声称听懂。 |
| 合并转发 | 按明确读取动作展开有界节点；节点自述 sender 不作为当前 QQ 身份或主人证明。 |

协议服务器未实现所需读取动作时，读取会失败并保留原因，不承诺所有 OneBot 实现都支持相同文件接口。媒体输出消费已登记资源；普通消息保留真实 `message_id`，独立文件上传保留真实文件上传回执，不伪造 QQ 消息 ID。结果未知不自动重发。

模型提问与工具确认发到所属 QQ 会话，答复再回送该 SDK 交互。工具确认只认实际配置主人，并核对会话、账号、代数和期限。独立工作子会话的提问也映射回其可信父 QQ 会话。控制台仅显示只读状态，不提供模型答复或工具批准入口。

## 独立工作通道

工作通道默认停用，启用后仍需明确目标、主人来源和独立 policy 授权。当前后端使用 SDK 可续接子代理，子会话不自动继承父会话上下文；任务输入由宿主按范围组织。目标 provider、model、reasoning 和 agent preset 来自已核验部署，不借用聊天模型名称推断另一后端可用。

开始前先持久记录任务及子会话绑定，再执行一次实际启动。结果、投递状态和关联证据分别持久化；结果读取与列表不会启动任务。追加和停止走受控 `followup` / `interrupt`，保持原父会话、generation 和固定 child。跨进程恢复只读核对既有工作，不重放 `start`，结果未知时也不自动补发。

SDK 图片和文件结果通过受控附件分页读取、注册为框架资源后投递；读取有单页及总量上限。后端缺少 subagent、continuation 或持久查询能力时会明确不可用。当前 SDK 目标不支持请求 `fullAccess: true`，返回权限不支持，不自动提升执行权限。

## 会话迁移与未知执行恢复

模型、推理档位和容量改变可通过受控 `forkPreview` / `forkWithPreset` 迁移到新 session/generation。目标必须来自已验证的 provider/model/preset 和实际 `contextWindow`、`maxTokens`、`headroomTokens` 元数据。迁移验证 lineage、上下文检查点与新会话读回，保留源会话；创建 child 成功本身不算迁移完成。

迁移要求原执行、收件队列、子工作和外部副作用均满足静止条件。能力范围、工具/插件结构和其他不支持的配置变化仍可能阻止迁移。未知状态不通过清空上下文解决；旧 session ID 保留归属，不能换个会话复用。丢失 fork 回包时，只读检查原请求，不创建第二个 fork。

连接中断、事件序列缺口或插件 epoch 改变会影响证据可信度。当前 session follow 不自动重连并继续未知执行。管理对账读取实际 SDK claim/turn/checkpoint，只记录已核验结果；它不会重新请求模型、取消、发送 QQ 回复或补发旧 final。插件 claim 表示“收件已认领”，不是任务已完成；claim 窗口有界，插件声明 `durableReceipts: false`。

取消结果未知的旧执行仍保留风险证据。只有实际终态证明和其他副作用条件满足时，才允许明确预览、提交新地址恢复；提交丢回包仍沿原 ID/revision 核对。恢复完成后要求显式重启，再接收新消息。证据不足时保持阻断，并给出原因。

连接、执行、工具和工作事件以版本化元数据观察，包含可信关联标识，不包含完整消息或凭据。读取使用有界游标与过滤器；epoch/retention 缺口和订阅背压都有显式结果，不把丢事件视为连续成功。

## 开发验收入口

以下命令在框架仓库根目录运行。官方 SDK 集成使用隔离会话与离线模型替身，不请求真实模型、不发送真实 QQ 消息：

```sh
npm --prefix packages/dsh-bridge-plugin run check
npm --prefix packages/dsh-bridge-plugin test
QQ_FRAMEWORK_DSH_PORT_MODULE="$PWD/src/adapters/dsh-jsonrpc.ts" npm --prefix packages/dsh-bridge-plugin run test:framework
npm --prefix packages/dsh-bridge-plugin run test:pack
```

当前完整验收包含插件单元 8 项、实际框架端口与官方 SDK 集成 10 项、tarball 隔离安装 2 项，另有默认 native HTTP/WS、迁移、恢复、交互、媒体和工作测试。准确轮次、耗时和失败修复记录见 [验收记录](VALIDATION.md)。有限版本上的通过结果不代表其他 SDK 版本、协议服务或模型都具备相同能力。
