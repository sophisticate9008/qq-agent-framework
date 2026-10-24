# 文档表达与最小装配

表达服务把正文准备成普通文本、Markdown PNG 或合并转发。它不决定人格、不会自动读取聊天推断意图，也不替功能发送。三层边界分别是：

1. `createPresentationService` 选择格式/引用并返回规范 content；可选 `select` 是显式挂载点。
2. `createMarkdownRenderer` 返回 PNG 页，受控 publisher 把可信文档 PNG 登记并批准为 assetId。
3. 功能通过 `execution.send` 交给引擎、policy、持久 outbox 与 transport；准备和批准不等于发送或授权。

## 装配前提

- 宿主自行启动并注入 Playwright browser，安装对应浏览器和本地中文字体，停机时在工作结束后关闭 browser。renderer 不下载字体或 Markdown 图片。
- 资源 registry 配置受限 rootDirectory；发布目录须为其中的 canonical 私有目录，父目录预先存在。不要把用户或模型提供的路径作为目录。
- 下列例子使用专门发布文档 PNG 的本地资源 registry。publisher 是可选 Linux 适配器，Linux 下依赖 `/proc/self/fd`；其他平台的 `/dev/fd` 检查可能拒绝，不能视为跨平台保证。框架与表达服务本身不要求 Linux，可替换 publishImage。
- `hostOptions` 是已有的可信 bridge 装配参数，含 store、agent、context、persona、authorizeIncoming 等。browser、endpoint、resourceRoot、renderDirectory 也由装配者提供，不来自待展示正文。

在项目根目录的装配文件中可使用以下接口：

```ts
import { pathToFileURL } from 'node:url';
import { createOneBotTransport } from './src/adapters/onebot.ts';
import { normalizeContent } from './src/core/content.ts';
import { isRecord } from './src/core/values.ts';
import { createBridgeHost } from './src/host/bridge.ts';
import { createPresentationEffect, createPresentationService } from './src/host/presentation.ts';
import { createRenderedAssetPublisher } from './src/host/rendered-assets.ts';
import { createResourceRegistry } from './src/host/resources.ts';
import { createMarkdownRenderer } from './src/rendering/index.ts';

const registry = createResourceRegistry({ store: hostOptions.store, rootDirectory: resourceRoot });
const transport = createOneBotTransport({ endpoint,
  resolveAsset: input => ({ file: pathToFileURL(registry.resolve(input)).href }),
});
const renderer = createMarkdownRenderer({ browser, maxPages: 6 });
const publisher = createRenderedAssetPublisher({ registry, directory: renderDirectory });
const presentation = createPresentationService({
  capabilities: transport.capabilities!(), renderer, publishImage: publisher.publish,
});
const bridgeOptions = { ...hostOptions, transport,
  effectAdapters: { ...hostOptions.effectAdapters, 'presentation.prepare': createPresentationEffect(presentation) },
};
```

示例不开启 OneBot forward，也不配置任何 grant。功能若使用 `presentation.prepare`，需在 manifest 声明并获得该 capability 与 messaging.send 的有限会话授权；forward 还需 messaging.forward。宿主选择的 effect 名称应避免与已有注册冲突。上述 OneBot resolver 保留完整人格版本及可选 session/generation；若还需锁资源版本，应从可信元数据给 registry.resolve 传 expectedVersion，而不是从正文推导。

要让标准 agent-relay 使用它，在创建 host 时添加通用异步准备 hook。例如约定适配端 metadata 中的 outputFormat/documentMarkdown 表达显式文档输出；这些字段是示例协议，不是内置 DSH 字段或自动意图识别：

```ts
const host = createBridgeHost({ ...bridgeOptions,
  agentMessagePreparation: {
    capabilities: ['presentation.prepare'],
    async prepare(execution, event) {
      const data = event.data.agentData;
      if (!isRecord(data) || data.outputFormat !== 'markdown-image' || typeof data.documentMarkdown !== 'string') {
        return normalizeContent(event.data.content);
      }
      const prepared = await execution.invoke('presentation.prepare', {
        body: data.documentMarkdown, format: 'markdown-image', reply: 'never',
      });
      if (!isRecord(prepared)) throw new Error('Invalid presentation result');
      return normalizeContent(prepared.content);
    },
  },
});
```

这个 hook 的额外 capabilities 合并到 agent-relay manifest，但必须另给 agent-relay 的 presentation.prepare 有限会话授权；没有该授权时渲染器不会启动。普通格式原样返回，文档格式经 invoke 准备，最后由原有 relay 的 execution.send/policy/outbox 发送；无需另装重复回复者，也不需要改核心来认识 Markdown。

hook 只接收 context/signal/invoke/generate，不含 send/state/store。返回 null 时不发送、不消耗发送预算，也不表示已确认回复；异常不静默回退原内容。只在启用 hook 时原始 AgentEvent.data 进入 event.data.agentData，缺失时为空对象；metadata 字段需要按实际 DSH port 协议映射，不是授权，不能直接公开原始 data 或写正文审计。未配置 hook 时原 relay 流程和格式不变，selectAgentMessage 继续是先行的同步内容过滤点。

普通功能也可以声明并调用同一准备 effect，再对准备结果调用 execution.send，并分别处理 confirmed、rejected、unknown。直接调用 presentation.prepare 时要自行提供可信 conversationId、scope、idempotencyKey、signal；使用 effect 包装时来自实际引擎执行。unknown 不能盲目重试，可信 hook 也不应在闭包里直调 renderer 绕开 policy。

## 格式与引用

显式 format 可选 text、markdown-image、forward；省略或 auto 时，document 且支持 PNG 则优先图片，否则正文长度超过 8000 时优先选 forward、其次选可用图片，其余选文本。图片需要 transport image 能力、renderer 和 publishImage 同时存在。selector 只能从可用格式中选择，不能暗改显式 format；只有显式 fallback: 'text' 允许文本降级，且仍受普通文本长度限制。默认不静默回退。

`replyTo` 接收可信 messageId 与可选 distance/ageMs；默认 nearDistance 为 6、nearAgeMs 为 120000。两项都已知且不超阈值是 near；任一超阈值是 far，其余是 uncertain。auto 下近消息不引、远消息默认引、不确定且无 selector 不引；有 selector 时 uncertain 可选是否引用，far 也可选择不引。reply: 'never' 始终不引，always 必须有目标和可引用格式；forward 不能附引用块。没有自动读取历史、判断指代或调用模型补 timing 的机制。

select 接收冻结的 request、available、suggested、replyTiming 及取消信号，可返回 `{ format, quote }` 或其 Promise。它是策略挂载点，不是授权入口，不内置任何人格或默认模型。无论选择结果如何，最终 send/forward 授权都不变。

## 边界与运维

| 组件 | 当前默认值 | 额外边界 |
| --- | --- | --- |
| presentation | 15 秒、最多 2 个真实未结 prepare | body 64 KiB、title 200 个字符串长度单位、图片最多 6 页 |
| Markdown renderer | 输入 256 KiB、1200×1600、8 页、累计 PNG 32 MiB、15 秒、2 个未结渲染 | 输入可配至 1 MiB、宽 320–2048、页高 256–4096、1–32 页、输出 64 MiB、10–120000 毫秒、并发 1–16 |
| 本地 publisher | 256 个文件、单文件 20 MiB、最多 4 个待处理 publish | 最多 10000 文件、64 MiB/文件、256 个待处理；单边 8192、总像素 16,777,216；registry 上限也生效 |

示例将 renderer 页数设为 6，避免其默认 8 页超出 presentation 页数限制；没有一个组件能隐式取消其他组件的更严格限制。renderer 的输入字节包含标题，输出上限为各页累计字节。forward 每节点最多 4000 个 Unicode 码点，整体还受 32 节点及 64 KiB 规范消息限制；启用它必须另行配置可信固定发送人，以及 OneBot group/private 扩展开关并验收网关，模型不能冒充节点发送人。

renderer 不接受原始 HTML、禁用页面 JavaScript/下载/service worker，离线 context 配合 CSP 与所有网络请求拦截；链接与图片以文字展示。宿主只运行自身布局测量脚本。超时/取消会请求关闭 context，但底层操作结束前仍占并发额度；这不是浏览器进程级隔离或物理内存硬上限。

publisher 复制输入并校验 PNG 签名、IHDR、CRC、末尾 IEND、尺寸及落盘字节，使用目录 fd、0700 目录与 0600 文件，拒绝路径替换、symlink/hardlink 和覆盖。内容哈希作为文件名与资源版本；资源标识按会话、完整人格版本、幂等键确定，同一请求可复用，元数据直接通过 registry.get 查询。批准资源默认不绑 session，便于历史资料复用；pending/revoked 或内容冲突不复活，取消与失败不会返回未批准资源。

崩溃遗留锁、文件保留/配额恢复和 pending 冲突需 operator 检查，不自动清锁、重批或删除未知结果。可信文档 PNG 可以走此审批流程，不代表用户上传图或外部 AI 图自动批准。只读 storage stats/admin 统计不清理 unknown，也不完成跨组件 retention 治理。

这些接口不包含候选 release 激活/回滚、业务 schema 迁移或完整可恢复长 job 控制面；离线渲染与装配也不代表真实 QQ、DSH、网关扩展或长期运行已经验收。更完整接口见 [公共契约](CONTRACTS.md)，可信边界见 [安全说明](SECURITY.md)。
