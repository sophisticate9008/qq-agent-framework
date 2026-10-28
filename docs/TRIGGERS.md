# 持久触发器

`createCalendarTriggerService` 是宿主可复用的持久调度组件，通过 `@qq-agent-framework/sdk/host` 导出。它保存规则和发生记录，调用宿主提供的回调；调用方负责启动周期性 `tick`、停止服务以及执行时的当前权限检查。注册规则本身不会启动计时循环或授予任何外部操作权限。

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

默认保留完成或失败的发生 7 天，一次性和取消规则在对应保留期与历史结束后回收。未知发生无自动过期时间，对应规则保留。默认最多 512 条规则、1000 条发生历史；规则满时拒绝新登记，历史满时暂停新申领，避免删除未知结果换取继续执行。公开状态提供当前数量和容量。调度服务本身不建立会话白名单、QQ 来源或能力授权，外部副作用仍须使用当前宿主策略和受控服务。

本地可重复验证见 [triggers.test.ts](../test/triggers.test.ts)、[plugin-scheduler.test.ts](../test/plugin-scheduler.test.ts) 和 [native-reminders.test.ts](../test/native-reminders.test.ts)，覆盖 SQLite 关闭重开、一次性与每日触发、时区和夏令时、错过窗口、去重、容量、回调重载以及中断未知结果不重放。
