# 未决操作与恢复

恢复从原操作的持久证据开始。请求被接受、网页收到了响应、进程已退出和外部动作已结束是不同事实。`unknown` 表示已有动作的结果没有得到充分确认；它不会因为刷新页面、重新安装包或换一个 operationId 自动变成安全完成。

本文中的管理路径作用于当前账号。多账号应通过下文的 dispatch 使用同一账号的 API 身份；不要把根目录旧入口的返回值当成选中账号的状态。

## 先读取，再选择明确动作

| 状态或症状 | 首先核对 | 当前允许的恢复方向 |
| --- | --- | --- |
| 配置保存冲突 | 原文档 revision、当前值与本地草稿 | 重新读取，合并后明确提交新 CAS。 |
| 保存结果未知 | 原配置域的未决记录和服务端当前 revision | 保留原草稿和请求归属；先核对，不自动重复 POST。 |
| 应用 running/unknown | 原 operationId、phase、phaseState、reasons | 查询同一操作；明确 reconcile，不能另建请求绕开未决操作。 |
| DSH 部署 pending_reload/unknown | 托管文件、provider/preset、当前进程可见的核验结果 | 使用对应部署 reconcile；读回证据满足要求后才进入下一步。 |
| 执行 unknown/超时/丢流 | execution、session/generation、request/turn、取消状态 | 原执行只记录晚到结果；使用显式执行核对和恢复预览/提交。 |
| inbox blocked | 所属会话、原期限、队列阶段与错误 | 保留未决输入，不自动恢复投递。 |
| 包迁移/清理 unknown | owner、内容身份、operationId、页来源或生命周期证据 | 用包的明确只读核对接口检查，再选择后续动作。 |
| legacy 接管 unknown | 原库存清单、账号身份、全部既有 DB marker | 只读核对后 CAS 完成登记；缺少原库不能按空库处理。 |
| 私有存储不可读/损坏 | 文件身份、模式、owner、原数据库及 WAL | 恢复受信任的一致备份或修复外部条件后再读取，不改成缺省空状态。 |

这些方向不提供通用“清空 unknown”操作。具体领域可能没有可自动证明安全的恢复手段；这时保留 blocked/unknown，比重复外部副作用更符合原操作语义。

## 配置与持久应用

配置编辑使用各文档 revision CAS。HTTP 409 不证明保存成功，应重新读取确切领域；busy、冲突与结果未知分别处理。网页断线或账号切换保留原 API 身份下的未决写入证据；旧响应不能写入新账号草稿。

应用入口是 `POST /api/chat/application`，请求包含客户端生成的 UUID v4 `operationId`、当前八份 `revisions` 和明确的 `deploy`。服务端先保存 journal，再协调 `stop → prepare → apply → migrate → start`，每个阶段记录 pending/in-flight/confirmed。查询原操作：

```text
GET /api/chat/application?id=<原 operationId>
```

不传 id 时读取当前操作。重复提交同一 id 和相同意图会指向同一操作；不同意图复用 id 会冲突。浏览器关闭不会让服务端重新创建操作，进程重启也不会续跑 unknown 阶段。

`POST /api/chat/application/reconcile` 的 body 为 `{ "operationId": "<原 UUID>" }`。它核对当前配置与运行证据：确实已按原配置运行时才能确认 completed；确实停止且没有确认继续执行时，记录 blocked 并要求新的明确意图。reconcile 不替用户重新应用或重放尚未确认的阶段。GET 返回 200 只表示读到了快照，不是恢复许可。

应用中的 maintenance stop 保留持久运行意图，以便成功后启动；但 journal 为 running/unknown 时，重启恢复 gate 会阻止自动 start。否则一个未确认应用可能被旧 desiredRunning 意图绕过。见 [native-application.ts](../src/host/native-application.ts)、[native-chat-lifecycle.ts](../src/admin/native-chat-lifecycle.ts)、[native-application.test.ts](../test/native-application.test.ts)。

## DSH 部署与助手目标

主聊天部署通过 `/api/chat/deployment/prepare`、`/apply` 和 `/reconcile` 管理。准备结果绑定配置与外部目标 revision，应用只更新托管部分。写入、读回或 reload 结果不确定时保留 journal/backup 信息，先核对原操作，不盲目重复 apply 或覆盖外部非托管设置。

公开 reconcile DTO 中的 verified、missingReasons、verificationScope、unverified 和 preset 证据共同决定可继续条件。文件和托管 provider/preset provenance 通过，不等于外部进程已加载相同凭据值；公开 `credentialValueIdentityVerified` 保持 false。界面只在相应证据满足时提供明确的后续操作。

助手目标独立使用 `/api/chat/assistant/deployment` 及其 `/prepare`、`/apply`、`/reconcile`。保存 `chat-assistant` 的 provider/model/reasoning 只是选择，明确应用后才部署独立 target；target resolver 仍检查当前配置、已应用证据与模型元数据。unknown 不在工作启动时隐式部署。`fullAccess: true` 不被执行器用来放大 DSH 权限。

本机接入优先自动发现实际 profile、凭据层与所选模型元数据，不要求重复填写已知路径或容量。修改受管配置之外的文件，不应通过“重新生成全部配置”来修复。实现与核对见 [dsh-profile-deployment.ts](../src/adapters/dsh-profile-deployment.ts)、[native-assistant-target.ts](../src/host/native-assistant-target.ts)。

## 会话迁移、重置与执行核对

历史会话不因配置目录保存自动换 ID。兼容基线记录原定义与身份，用于说明冲突及可恢复值；敏感内容、容量上限或旧基线缺失时，会明确显示无法提供原值，不能凭当前配置捏造历史基线。

**`GET /api/chat/sessions/migration` 是准备操作。** 它读取外部 DSH 的迁移预览证据，并持久保存带 migrationId/revision 的 prepared 计划，不是纯历史查询。计划提交仍需显式 `POST /api/chat/sessions/migrate`，携带预览所得计划与 revision。迁移中断后使用原计划核对，不重做 child fork 或换 operationId 掩盖已有结果。

重置要求聊天停止、确切绑定 revision/generation 且没有未排空执行。永久 sessionId ownership 保留旧 ID；不能把同一外部 sessionId 重新分配给另一会话或 generation。迁移后尚未再次启动就重置，也不能丢掉旧 ownership。

执行 journal 保留 request、外部 claim receipt、userMessage、turn、期限、取消和晚到结果。`GET /api/chat/executions/recovery?id=<id>` 读取已保存恢复计划；`POST .../preview` 和 `POST .../commit` 分别准备与明确提交，commit 要求计划 revision 和 `confirm: true`。该流程在检查外部执行证据后建立后续绑定边界，不代表原 prompt 会重新提交。普通历史读取不实例化 executor 或发起恢复。

停止或超时会阻止新投递，但不能证明外部模型已经停止。晚到 final 只进入原执行记录，默认不发回 QQ。特别是取消处于 requesting/unknown 时，旧 session 地址仍可能被迟到取消命中，不能直接复用给后继请求。见 [native-session-migration.ts](../src/host/native-session-migration.ts)、[native-execution-recovery.ts](../src/host/native-execution-recovery.ts)、[sessions.ts](../src/host/sessions.ts)。

## 队列、工作、提醒与交互

`GET /api/chat/inbox` 返回每个会话 idle/pending/dispatching/blocked、pending 数量、期限和错误，以及 `automaticReplayAvailable: false`。正常忙碌队列可以在同一已运行实例内继续处理新输入；重启未完成队列会转为 blocked，dispatching/unknown 不自动重放。全局 follow 池满导致的新会话拒绝也不等于已加入普通忙碌队列。

`GET /api/chat/work` 和带 id 的详情查询只读取持久工作记录，包括交付和文件回执。网页不提供工作 start/followup/interrupt/reconcile 写入口。工作指令仍通过所属 QQ 来源和功能 policy；SDK 封装也必须使用调用方 execution。

提醒规则和 occurrence 分开持久化。显式停止 runtime 不删除规则；下次 start 恢复规则服务。发生时核验当前访问规则与发送授权，unknown 发送不自动重试，相应规则可保留阻断证据。配置提醒不会顺带授权模型工具或开启主动话题。日历和持久任务同样先保存发生记录，重启不会把原 running/unknown 当成尚未执行。

模型问题和工具确认会发到所属 QQ 会话，实际配置主人在原问题上下文中答复。网页只读问题摘要，没有代答或批准接口。记忆 proposal 的确认也在 QQ 中完成：`/确认记忆 memory-...`；撤销使用 `/撤销记忆 memory-...`。`/记住` 默认绑定来源会话，`/记住群` 要求群来源，`/记住全局` 是主人明确共享。网页手工管理、纠正或撤销不会自动确认模型 proposal。

## bootstrap、包状态与关闭

bootstrap `create()` 返回的 mount 在安装前处于 prepared。如果 HTTP 身份核对等安装前步骤失败，资源排空会调用 `abandonPrepared()`，即使没有 host 或还持有上次的 host，也不会误调用 stop。该接口只允许尚未安装、无 pending start/stop 的 prepared mount；abort 其 lifetime 后标 stopped，后续可创建新 mount。已安装、pending 或 unknown 不能用此接口清除状态。未 settle 的 create 会继续阻止重叠创建。

已安装扩展的 stop 有明确期限和未决标记。一次 raw hook/disposer 未结束时，不因再次 stop 而重复调用。包生命周期只读核对有独立期限，不复用已经 abort 的运行 lifetime；超时保留 unknown，晚到核对结果不能自行改写 journal。

包 owned state 使用稳定 namespace。迁移先固定目标身份，保存 operationId、cursor、来源 revision/checksum，再以最多 60 个键的页调用 converter；结果与元数据在一次 CAS batch 中提交。迁移中断/超时为 unknown，重新打开不会自动调用 converter。`reconcile(expectedRevision, operationId, signal)` 只读核对原页来源未变化，再以 CAS 转回可继续的 prepared 检查点；之后仍需明确 `applyPage()`。来源已漂移则拒绝核对，不能以目标新值盖掉冲突数据。

旧 raw 状态要显式 `prepareLegacyAdoption()`。其旧 schema 为未知的 0，原键与 TTL 保留；不能用新 namespace 假装迁移完成。内容指纹变化也不能用假的 hash 或静默更新版本绕过。完整规则与 SDK 示例见 [EXTENDING.md](EXTENDING.md)。

`runtime.close()` 返回单次缓存 Promise。即使 stop 抛出原 bootstrap unknown，仍继续关闭独立协议连接、提醒、记忆、事件与 hooks，最后向上返回原错误。未排空运行的主 store 和 lease 保留，raw control command 的 store 等 drain 后关闭。退出码为失败不意味着需要重跑 stop；关闭连接也不清除外部执行未知状态。

账号 manager 的 close 同样逐个 runtime 单次、有界执行。一个账号关闭不确认时，其他账号仍会进行独立关闭，未确认实例保留 unknown；再次 close 返回同一结果，不重复调用底层 close。见 [native-bootstrap.test.ts](../test/native-bootstrap.test.ts)、[native-package-state.test.ts](../test/native-package-state.test.ts)、[native-accounts.test.ts](../test/native-accounts.test.ts)。

## 多账号选择、接管与重启

全局 `GET /api/accounts` 读取账号清单；`POST /api/accounts` 使用 action 和 registry revision 管理 create/start/stop。创建 body 包含 `action: "create"`、revision、label 和 `{ protocolId, accountId }`，只登记账号，不连接。start 还要求当前八份原生配置 revisions；stop 是明确停止意图。

账号内请求使用真实 dispatch URL，例如在 JavaScript 中：

```js
const query = new URLSearchParams({
  account: selectedAccountId,
  path: '/api/chat/runtime',
});
const response = await fetch(`/api/accounts/dispatch?${query}`,
  { credentials: 'same-origin' });
```

这是使用现有认证会话和选中账号 ID 的局部片段。路径只接受该账号 bundle 的明确 `/api/chat/` 路由，额外 query 作为领域参数转交；POST 保持同样 URL、使用该领域原 body。不要把 path 写成任意 URL 或把全局设置通过 dispatch 转发。账号记录 ID 是 scope 哈希，不能直接用 QQ 号替换 account 参数。

旧单账号目录接管步骤如下：

1. 明确停止旧聊天，保留原目录和既有数据库。
2. 用 `POST /api/accounts` 的 `preview-legacy-adoption` action 和目标 accountScope 获取 revision、sourceFingerprint、数据库清单。
3. 明确提交 `adopt-legacy`，携带原 preview 和 label。服务端重新核对清单与 revision，并通过真实协议身份核对确认归属，然后关闭旧 runtime。
4. 接管先保存 unknown claim 和原库存，再写账号 marker/身份；完成后才转 ready。中断时使用原账号 id、当前 registry revision 和 `reconcile-legacy-adoption`，只读检查所有原库 marker 后 CAS 完成登记。

该过程保留原目录与旧业务键，不静默搬移文件。原库缺失、身份不一致或清单变更时拒绝核对，不创建替代空库。已接管后全局 legacy 原生路由返回 `native_legacy_account_adopted`，不能再启动旧未分账号 runtime。

进程重启先读取 registry；新隔离账号使用 `accounts/<scope 哈希>/`，接管账号继续使用原根目录。只有 ready 且 desiredRunning 为 true 的账号才尝试恢复，显式 stop 的账号保持停止。每个账号独立核验身份、配置 revision 和应用/包恢复 gate；某个账号失败不让其他账号共用它的会话或授权。真实双账号、错误身份、接管与重启测试见 [native-account-gateway.test.ts](../test/native-account-gateway.test.ts)。

## 存储与备份边界

不要删除 lease、journal、outbox、ownership 或 adoption inventory 来“解锁”；这些记录是防止外部动作重放和跨账号误用的证据。普通读取失败会明确报告 unavailable，不能改成空 sessions、空 grants 或默认运行成功。

现有 SQLite 查询采用只读连接和一致快照，保留 WAL 中的已提交数据。SQLite 可能使用 WAL/SHM 协调文件，所以管理“只读”不保证原目录字节完全不变，但不会借查询创建业务库、业务记录或调度恢复。备份应在明确停止并确认排空后取得，或使用能保证 DB/WAL 一致的 SQLite 备份方式；不能只复制 `.sqlite` 而忽略仍有有效数据的 WAL。

管理写入现有历史使用 `requireExisting: true`，先校验私有目录、文件身份及既有 schema，不创建 missing 库、不通过 chmod 修补任意文件。备份与恢复时保留文件权限及账号 marker，并在服务读取成功后再执行明确的业务操作。
