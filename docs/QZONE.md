# QQ 空间适配

## 已实现范围

框架提供 `QzonePort` 和 `createOneBotQzonePort`，通过 SDK 的 `contracts`、`adapters` 子路径导出。NapCat 与 SnowLuma 使用同一个 OneBot 扩展适配器；兼容相同参数和回执的实现也可直接复用。空间操作不属于 OneBot v11 标准能力，不能仅凭连接成功判断可用。

当前交付是供可信宿主装配的适配器及契约。默认聊天尚未注册空间工具，也未增加自主发布配置或自动任务；导入 SDK、创建端口不会联网或发布。协议端更新和实际发布由运维单独执行。

## 接入方式

```ts
import { createOneBotQzonePort } from '@qq-agent-framework/sdk/adapters';
import type { QzonePort } from '@qq-agent-framework/sdk/contracts';

export function createAccountQzone(endpoint: string, accessToken: string): QzonePort {
  return createOneBotQzonePort({
    endpoint,
    accessToken,
    supportedActions: ['publish', 'delete'],
  });
}
```

账号宿主复用已经配置的 OneBot HTTP 地址和鉴权，每个账号单独持有端口。`supportedActions` 由宿主依据实际部署版本或可信能力声明填写；它不是用户授权，也不证明账号在线。老版本或未确认支持时传空数组，对应调用会在联网前返回 `QZONE_UNSUPPORTED`。不通过试发或试删探测能力。

| 框架方法 | OneBot 扩展 | 输入与输出 |
| --- | --- | --- |
| `publish` | `send_qzone_msg` | 正文、可选图片、明确的可见范围；返回 `postId` 和可选的服务端时间 |
| `delete` | `delete_qzone_msg` | 已知 `postId`；确认回执不包含正文 |

`visibility.kind` 为 `public`、`friends`、`self`、`allow` 或 `deny`；后两项必须提供 `userIds`。适配器统一转换为 `ugc_right` 与数值 `target_uins`。可见范围必填，避免依赖协议端默认值。`publishedAt` 为服务端报告的 Unix 秒数；未报告或无效时为 `null`，不补本机时间。

图片只接受宿主已解析并核验使用范围的 `file://`、HTTP(S) 或 `base64://` 来源。模型工具应接收资源句柄，由宿主转换；不能直接开放任意本机路径和网址。使用远程协议端时，本机文件路径不共享，应传受控字节或协议端能够访问的来源。发布图片不复用模型视觉输入的缩略压缩结果。

适配器请求上限为正文 32768 个 JS 字符、32 张图片、16 MiB JSON，每张 Base64 图片最多 8 MiB；这些是框架内存边界，不代表平台承诺支持这些数量。读取响应最多 64 KiB，默认请求期限 60 秒，可配置为 1–300000ms。

## 自主发布的宿主接入约定

启用能力和逐条触发分开建模。后续空间功能包应支持由主人开启自主发布，允许 Agent 决策或已授权的插件任务发起，发布时无需存在一条主人消息。是否发布、发布内容及任务安排由功能包负责；协议适配器不要求主人消息，也不自己决定授权。

可信宿主必须在副作用前检查当前账号、功能包和已启用的发布权限。自主任务使用宿主记录的任务来源与启用状态，不伪造主人发言；关闭后尚未提交的操作失去权限。普通用户消息、提示词或模型输出不能自行开启自主发布。发布授权不隐含删除授权，删除单独声明。界面不增加逐条批准流程。

插件通过框架现有 effect/service 与日历任务钩子使用端口，不另建轮询服务，也不修改聊天转发主链路。接入非兼容协议时只实现同一 `QzonePort`，上层功能包无需判断协议端品牌。

## 回执

结果为 `confirmed`、`rejected` 或 `unknown`。发布必须拿到有效 `tid` 才确认成功；删除必须收到成功信封及 `data: null`。超时、连接中断或不完整回执保留未知，不自动重试、不切换另一实现补发，不暂停普通聊天。

宿主应在提交前持久记录操作，成功后关联账号与 `postId`；同一任务触发不得重复提交。该端口不提供跨请求幂等保证，不伪造远端支持幂等键。源码与协议参考集中列在 [NOTICE.md](../NOTICE.md)。
