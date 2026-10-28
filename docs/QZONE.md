# QQ 空间说说

框架内置 `qzone` 服务（版本 1），供可信宿主和扩展调用。控制台“功能与扩展 → 框架内置 → 空间说说”展示当前协议端提供的操作、接口参数和能力来源。页面只读取状态，不发布或删除。

底层服务只做协议能力适配，没有会话、主人或聊天方案参数。原生聊天另将协议端支持的发布、删除注册为框架内置工具，复用当前会话白名单和真实消息来源校验，不增加逐条审批。何时发布、自主任务及其访问策略由框架使用者安排；能力清单不承担权限判断。

## 聊天工具

启动聊天时只读核对一次协议能力，支持时登记以下工具，并在后续 QQ 请求中投影到对应 DSH 会话。更新工具不清空已有会话。

| 工具 | 参数与结果 |
| --- | --- |
| `qaf_qzone_publish` | `content` 正文、`images` 当前会话图片 assetId 数组、明确的 `visibility`；确认后返回真实 `postId` 与可选发布时间 |
| `qaf_qzone_delete` | `postId` 必须来自实际发布或读取结果；根据协议回执返回删除结果 |

发布支持纯文字、纯图片和图文。`visibility` 可为 `public`、`friends`、`self`、`allow`、`deny`，后两种必须另给 `userIds`。模型入口只接收图片资源编号，复用普通 QQ 发送的原图解析与会话隔离，不直接接收路径或网址；本机文件可先通过已有助手文件资源链路登记。原始图片发送，不使用模型观察缩略图。

同一次工具调用的写操作持久去重；未知结果保留证据并禁止自动重试。不同调用仍是不同操作，模型必须按真实回执陈述结果，不能把未知结果当失败重复发布。正常模型工具受当前消息来源与白名单约束，底层服务继续供宿主、扩展独立使用。框架不默认创建自主发布定时任务，也不修改现有聊天方案。

## 获取服务

扩展声明依赖内置包 `qzone`，并声明 `requires: [{ id: 'qzone', version: 1 }]`，在安装时获取：

```ts
import type { QzoneToolPort } from '@qq-agent-framework/sdk/contracts';

const space = context.service('qzone', 1) as QzoneToolPort;
const available = await space.inspect(context.signal);
// 仅在 available.tools 中存在对应操作时调用。
const result = await space.execute({
  name: 'send_qzone_msg',
  input: { content: '今天的记录', ugc_right: 4 },
  signal: context.signal,
});
```

每个账号持有自己的协议端地址、鉴权和服务实例，服务停止后其调用信号同时取消。该基础服务没有会话、主人或聊天方案参数。

独立宿主可以通过 SDK `adapters` 导出的 `createOneBotQzoneTools` 创建同一服务。构造不联网；`describe()` 返回上次观测的清单，`inspect(signal)` 仅做只读能力核对。`execute()` 使用 OneBot 原接口名称与参数，保留协议端返回的数据字段。

## 按协议端开放能力

空间操作不是 OneBot v11 标准能力，连接成功不代表可用。支持范围有两种来源：

- 宿主或协议适配器提供安装实例的真实接口名称清单：`supportedActions` 或 `readSupportedActions(signal)`。清单与框架支持的空间接口取交集；动态来源可再次 `inspect` 更新。SnowLuma 等提供更丰富接口的协议端可采用这一方式，不能根据品牌名直接全部开启。
- 没有真实接口清单时，只读取 `get_version_info`。已核对的 NapCat 4.18.14 起提供 `send_qzone_msg` 和 `delete_qzone_msg`，框架将这两项标注为“版本映射”；不由版本推断更多操作。其他实现、无法确认的版本或读取失败保留未知，不试发或试删探测。

自定义原生宿主装配 `createNativeChatRuntime` 时，可通过 `qzoneSupportedActions` 提供当前协议实例的接口清单读取器。原生聊天按启动时读到的清单选择发布、删除工具，不据此增加授权或自动开放其他模型工具；变更注册结构需重新应用聊天。

| 底层接口 | 用途 |
| --- | --- |
| `send_qzone_msg` | 发布文字或多图说说 |
| `delete_qzone_msg` | 按真实 `tid` 删除说说 |
| `get_qzone_msg_list` | 分页读取自己或指定账号的说说 |
| `get_qzone_msg_detail` | 读取说说及一页评论、服务端内联回复 |
| `get_qzone_feeds` | 读取好友动态，保留服务端游标和未知值 |
| `set_qzone_msg_right` | 修改已发布说说的可见范围 |
| `like_qzone` / `unlike_qzone` | 点赞、取消点赞 |
| `comment_qzone` | 评论或回复指定一级评论 |

不支持的操作在联网前返回 `QZONE_UNSUPPORTED`。接口已声明不代表账号在线、平台一定允许操作或已经实机验证；特别是取消点赞等协议端标明待验证的操作，需要调用方自行验收。

## 参数与回执

`send_qzone_msg` 的 `content` 在有图片时可为空，支持只发图片；正文与图片不能同时为空。必须明确给出 `ugc_right`：1 公开、4 好友、16 指定好友、64 仅自己、128 排除指定好友；16/128 另需 `target_uins`。删除与详情使用发布或列表返回的真实 `tid`。评论回复的 `comment_id`、`comment_uin` 必须同时提供，编号字符串 `"0"` 有效；指定回复人还需 `reply_uin`、`reply_name`，回复评论不支持图片。

图片来源为协议端支持的 `file://`、HTTP(S) 或 `base64://`。这是供可信宿主调用的低层入口，路径和资源的组织由调用方负责；远程协议端不能读取本机未共享的路径。框架不为发布图片使用模型视觉缩略压缩。

正文最多 32768 个 JS 字符、32 张图片、16 MiB 请求 JSON，每张 Base64 图片最多 8 MiB。读取响应最多 4 MiB，写操作响应最多 64 KiB。默认操作期限 60 秒，可配置为 1–300000ms；自动版本读取另受 5 秒上限约束。这些是本地资源边界，不代表 QQ 平台承诺的数量限制。

结果是 `confirmed`、`rejected` 或 `unknown`。发布必须取得有效 `tid` 才确认；删除、点赞、取消点赞要求成功信封及 `data: null`；兼容 NapCat 已知 void 处理器省略 `data` 的返回形式，其他操作不以缺失数据确认成功。超时、连接中断或不完整回执保持未知，框架不自动重试、不切换协议端补发，也不冻结普通聊天。调用方需要避免自己的重复任务产生重复发布。

兼容入口 `createOneBotQzonePort` 继续保留 `publish`、`delete` 两个类型化方法及原回执结构。它与新工具服务共用同一有界 HTTP 传输。

## 控制台接口

`GET /api/chat/qzone` 只返回当前账号的能力清单：`schema`、`state`、`source`、`implementation`、`tools`、`reason`。服务未运行时返回未知及 `QZONE_SERVICE_NOT_RUNNING`；读取不能创建空间内容。没有对应的管理写接口。

协议源码与版本参考见 [NOTICE.md](../NOTICE.md)。
