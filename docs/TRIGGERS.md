# 持久触发器

`createCalendarTriggerService` 是宿主可复用的持久调度组件，通过 `@qq-bridge-framework/sdk/host` 导出。它保存规则和发生记录，调用宿主提供的回调；调用方负责启动周期性 `tick`、停止服务以及执行时的当前权限检查。注册规则本身不会启动计时循环或授予任何外部操作权限。

## 时间与规则

规则包含稳定的 `id`、业务 `scope`、IANA `timeZone`、JSON `payload` 以及以下时间方案之一：

| schedule | 含义 |
| --- | --- |
| `{ kind: 'once', at }` | Unix 毫秒表示的绝对时间点，时区不改变该时间点 |
| `{ kind: 'daily', hour, minute }` | 指定时区中的每日本地时间 |
| `{ kind: 'weekly', dayOfWeek, hour, minute }` | 每周本地时间，周一为 1、周日为 7 |

`dst` 必须明确指定：重叠时间选择 `earlier` 或 `later`，不存在的本地时间使用 `skip`。一次性方案保留同一规则结构，`timeZone` 与 `dst` 仍会校验。`nextCalendarTriggerAt(input, after)` 返回严格晚于 `after` 的下一时间点；一次性方案不限于近期，已经到达的时间点返回 `null`。

`windowMs` 为 1 分钟至 8 天的执行资格窗口，右边界不包含在内。超过窗口的发生不会补跑。窗口内有多个周期发生时，只执行最新一个；`misfire: 'coalesce'` 通过 `coalescedCount` 报告窗口内被合并的旧发生数，`skip` 报告为零。窗口之前的历史不会枚举或补发。

每日随机计划可由插件在每日回调中确定若干绝对时间点，先持久保存业务计划，再逐条登记一次性规则。时间点应留在该业务计划允许的执行窗口中；调度器不决定随机数、发布内容或日程数量。

## 恢复与去重

发生标识由规则标识、规则代数和计划时间点计算。服务在调用回调之前先保存 `running` 发生，重复 `tick` 或同一持久存储的并发申领不会再次执行同一发生。终态为 `completed`、`failed` 或 `unknown`；失败和未知结果均不会自动重试。

启动新实例后，在首次 `tick` 前分页调用 `recoverInterrupted`，直到 `next` 为 `null`。上次中断时的 `running` 转成 `unknown`，保持执行可能已经发生的证据。尚未开始的一次性或周期任务只要仍在窗口内，就能在恢复后的 `tick` 执行；过期时间点跳过。正常关闭使用 `stop`，它会中止当前回调并等待本次调度结算。

回调需要遵守传入的 `AbortSignal`。超时、取消或中断不能证明外部副作用没有发生；宿主外部写服务还应使用发生标识作为自己的持久幂等键，保留真实回执。调度器不撤销已完成的外部写入。

回调默认期限为 30 秒，宿主可通过 `callbackTimeoutMs` 显式设置为最多 1 小时；实际期限同时受该发生的 `windowMs` 截止时间约束。长图文工作需要为规则预留完整执行窗口。即便配置较长期限，`stop` 仍会立即中止回调信号并结算未知结果，不等待忽略中止信号的底层 Promise 完成。

规则持久保存 `evaluatedThrough`，防止时钟回拨或发生记录保留期结束后重放旧发生。修改规则、启停规则会增加 `generation` 并从变更时刻重新开始计算，不追补启用前的发生。取消后的规则不能重新启用，应使用新的业务标识登记新规则。

尚未跨过下一计划时间点时，空闲检查不改写规则进度；处理或跳过实际发生时立即持久推进。日历计算使用有界纯计算缓存，规则、回调就绪状态与发生记录仍从当前存储和宿主读取。

## 宿主接入

```ts
const scheduler = createCalendarTriggerService({ store, callback: dispatch });
let after: string | undefined;
do {
  const page = scheduler.recoverInterrupted({ limit: 100, ...(after ? { after } : {}) });
  after = page.next ?? undefined;
} while (after !== undefined);
scheduler.register({
  id: 'example-operation', scope: 'example-scope', timeZone: 'Asia/Shanghai',
  schedule: { kind: 'once', at: Date.now() + 60_000 },
  dst: { overlap: 'earlier', nonexistent: 'skip' },
  misfire: 'skip', windowMs: 300_000, payload: { kind: 'example' }
});
await scheduler.tick();
await scheduler.stop();
```

日历组件不建立模型会话，也不发送消息。原生提醒服务单独组合任务队列和日历组件，维护提醒配置、发生历史及发送权限；其他业务由自己的插件和宿主服务组合。

## 插件调度服务

原生宿主为可信插件提供 `runtime.scheduler`。插件身份由宿主固定，规则、回调和历史按该身份隔离。插件先登记回调，再保存规则；宿主装配完成后启动一套共享计时循环。

```ts
const remove = runtime.scheduler.registerHandler('daily-plan', async occurrence => {
  occurrence.signal.throwIfAborted();
  await preparePlan(occurrence.payload, occurrence.id, occurrence.signal);
});
runtime.scheduler.schedule({
  id: 'daily-plan', handler: 'daily-plan', payload: { purpose: 'example' },
  timeZone: 'Asia/Shanghai', schedule: { kind: 'daily', hour: 0, minute: 5 },
  windowMs: 23 * 3_600_000, misfire: 'skip'
});
// 在插件停止时移除回调；持久规则保留供下次装配。
remove();
```

`registerHandler(kind, handler)` 返回移除函数；移除或插件生命周期结束时中止旧回调信号。尚未登记回调时，服务不申领该规则的发生，规则在有效窗口内可由重新加载后的回调接手。旧回调已开始而结果未知时保留该发生，后续加载不会重复执行。

`schedule(input)` 对相同标识和相同内容幂等返回已有规则。改变内容需要传入第二参数 `{ expectedRevision }`；版本不符或取消后复用标识明确返回冲突。`list()` 返回配置、业务 `payload`、版本、状态与下次时间，方便插件恢复已经保存的计划；`cancel(id, { expectedRevision })` 取消规则。`history({ id })` 查看某规则的发生状态。列表均支持 `limit` 与 `after`，以最后一项的 `cursor` 继续读取。

`schedule` 可附 `presentation: { title, description, ownerLabel }`。这些字段单独持久保存，只修改展示文字不会推进规则代数、重置计算进度或重放任务。插件也可按回调名称登记默认展示与只读业务详情；旧规则同样可以使用默认展示：

```ts
const removeDetails = runtime.scheduler.registerDetailsProvider('daily-plan', {
  presentation: { title: '每日安排', description: '查看当天的安排与执行结果。', ownerLabel: '示例插件' },
  summarize(rule, occurrence) {
    const business = readStoredPlan(rule.id, occurrence?.scheduledAt);
    return business ? { stage: business.stage, summary: business.summary } : null;
  },
  read(rule, occurrence, signal) {
    signal.throwIfAborted();
    const business = readStoredPlan(rule.id, occurrence?.scheduledAt);
    return business ? { stage: business.stage, summary: business.summary, sessionId: null,
      canSkip: false, result: null } : null;
  },
});
// 插件停止时移除；宿主也会在该插件生命周期结束时自动撤销。
removeDetails();
```

`summarize` 同步读取少量持久业务状态，为列表和历史返回 `{ stage, summary }`；不读取大图、不调用模型、不启动工作。`read` 只在打开详情时调用，最多等待五秒，可返回 `steps`、关联 `sessionId` 与 `result: { title, body, images }`。图片项为 `{ dataUrl, alt }`，只接收 PNG、JPEG 或 WebP 的 Base64 数据 URL，每张解码后最多 256 KiB、最多四张，整个详情最多 2 MiB；不接受远程图片 URL 或文件路径。无详情提供方时仍可查看持久调度证据。历史详情通过可选 `occurrenceId` 读取该次实际业务记录，不能用今天的记录替代旧发生。

只为明确支持跳过的业务登记 `skip(rule, signal)`：回调必须先持久同步业务的“已跳过”状态，确认完成后宿主才取消未开始的一次性规则。宿主先以有界只读检查核验 `read` 中的 `canSkip`，明确拒绝时不创建写入意图；允许后再以 CAS 重新核对规则、发生记录与管理版本，保存管理意图并阻止新申领。写入开始后的失败、中断或版本冲突保留未知结果，不自动重放。已经开始的发生和周期规则不能通过此入口跳过。

## 任务与日程管理

控制台使用 `GET /api/chat/schedules` 查看跨插件的有界投影，使用 `GET /api/chat/schedules/history` 查看调度发生记录。两者接受 `owner`、`id`（须同时指定 `owner`）、`limit`（默认 100，最多 200）与 `after`；`next` 为下一页游标。摘要统计当前身份筛选范围的全部规则，不受分页游标影响。列表不返回业务 `payload`；运行中的 `running`、结果未知的 `unknown` 与插件报告的业务阶段分别展示，调度 `completed` 只表示回调正常结束。

任务先按执行中、待执行、未知、失败、暂停等状态分组，同组按下一时间升序与稳定标识排序后再分页；发生历史先按计划时间倒序与稳定标识排序再分页。管理 API 的 `next` 是包含排序边界的不透明复合游标，须原样作为 `after` 发送；即便原边界记录已过期，也可按时间与标识继续读取。插件 SDK 原有 `list`、`history` 的标识游标保持不变。

`GET /api/chat/schedules/detail?owner=...&id=...` 打开详情，可附 `occurrenceId`。停机后从当前账号已经存在的数据库只读查看计划、管理覆盖和历史；GET 不恢复中断、不创建数据库或启动调度。旧历史缺少实际开始时间时 `startedAt` 为 `null`，不能由计划时间推算执行耗时。

`POST /api/chat/schedules` 接受严格动作之一：

```json
{ "action": "set-paused", "owner": "example", "id": "daily-plan", "paused": true, "revision": "12:0" }
```

```json
{ "action": "skip", "owner": "example", "id": "once-plan", "revision": "12:17" }
```

`revision` 是列表提供的不透明规则与管理联合版本，必须原样提交；并发变化返回冲突。暂停覆盖独立于插件期望配置，重复 `schedule`、插件更新或重启不会将它清除。暂停仅控制后续申领，已经运行的回调保留真实结果；恢复后仍按原规则的有效窗口判断，过期任务不补跑。成功跳过响应表示插件业务同步和宿主取消均已确认；未知管理结果锁住危险重复操作，刷新仅读取原证据。管理覆盖和展示元数据随实际规则回收，未知跳过意图及其规则保留。

默认保留完成或失败的发生 7 天，一次性和取消规则在对应保留期与历史结束后回收。未知发生无自动过期时间，对应规则保留。默认最多 512 条规则、1000 条发生历史；规则满时拒绝新登记，历史满时暂停新申领，避免删除未知结果换取继续执行。公开状态提供当前数量和容量。调度服务本身不建立会话白名单、QQ 来源或能力授权，外部副作用仍须使用当前宿主策略和受控服务。

后台规则回收每分钟检查一次，登记规则时立即检查并释放已经到期的规则容量；到期发生历史仍遵循存储自身的过期可见性。回收频率不改变任务触发和未知结果保留规则。

本地可重复验证见 [triggers.test.ts](../test/triggers.test.ts)、[plugin-scheduler.test.ts](../test/plugin-scheduler.test.ts) 和 [native-reminders.test.ts](../test/native-reminders.test.ts)，覆盖 SQLite 关闭重开、一次性与每日触发、时区和夏令时、错过窗口、去重、容量、回调重载以及中断未知结果不重放。

## 手动立即执行

任务与日程页对明确支持的插件日程显示“立即执行”。`POST /api/chat/schedules` 接受 `{ "action": "run-now", "owner": "example", "id": "once-plan", "revision": "12:0" }`。同一 CAS 事务核对规则和管理版本、保存独立的手动发生记录及执行占用；响应表示后台任务已接收，关闭页面或请求断开不取消该任务。执行记录和详情标注手动来源，原失败记录保留。

单次日程在受理时消费原计划时间点，之后不再到点重复触发；周期日程消费截至当前的发生，后续时间点继续按原规则运行。插件只在业务可安全执行时开放入口；未接入该能力的插件、暂停、取消、停机、正在执行或管理结果未知时不开放。业务拒绝、执行期限、停止中断和外部结果未知分别保留证据；重启不重放已开始的手动执行。历史及后台并发仍有上限。

插件在 `registerDetailsProvider` 中同时提供 `canRunNow(rule)` 与 `runNow(rule, occurrence)`：前者同步只读核验业务状态，后者持有插件生命周期并重新检查资格，使用发生 ID 和原业务幂等键执行。宿主不把强制重置未知记录当作立即执行，也不替插件推断外部结果；业务资格由插件依据自身的持久证据确认。

## 规划与后续日程关联

业务详情可以返回可选 `relatedSchedules: [{ id, label }]`，最多八条同插件日程引用。框架使用当前详情所属插件身份，通过既有日程查询读取被引用任务，展示其真实业务阶段与调度状态；详情和“立即执行”共用原管理接口、联合版本 CAS、未知结果锁定和后台生命周期，不增加插件专用管理写接口。关联读取不取完整图片、不递归展开，也不启动任务；已回收任务显示不可用。
