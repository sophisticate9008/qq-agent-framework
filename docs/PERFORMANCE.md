# 性能方法

性能基准用于发现回归和解释容量边界，不提供生产 SLA。基准结果必须同时记录源码版本、Node 版本、负载参数、样本量、运行环境和未覆盖范围。

## 可复跑脚本

| 命令 | 主要负载 | 观察项 |
| --- | --- | --- |
| `npm run bench:core` | 事件调度、无关功能、慢发送 | 吞吐、p50/p95/p99、事件循环进展、发送并发 |
| `npm run bench:context` | 不同规模偏好解析 | 命中与未命中随数据量增长的成本 |
| `npm run bench:policy` | 不同规模授权查询与预算耗尽 | reserve/begin 延迟和错误语义 |
| `npm run bench:admin` | 回环管理 HTTP、不同并发 | 吞吐、分位延迟、响应字节与错误 |
| `npm run bench:soak` | 多窗口新会话与显式 GC | 保留对象、空状态和堆趋势 |
| `BENCH_ITERATIONS=200 node scripts/bench-host.ts` | 临时 SQLite、约 10 个稳定会话、假 agent/transport | 端到端确认延迟、吞吐、CPU/RSS、事件循环、数据库与队列占用 |

脚本输出结构化 JSON 到标准输出。不要把基准结果写入公开文档作为永久机器排名。

## 运行方法

先在干净构建和测试通过后运行候选版本：

```sh
npm ci
npm run check
npm test
npm run bench:core
npm run bench:context
npm run bench:policy
npm run bench:admin
npm run bench:soak
BENCH_ITERATIONS=200 node scripts/bench-host.ts
```

比较两个源码树时，使用同一 Node 版本、同一脚本参数和新鲜进程。`BENCH_ROOT` 指向另一个兼容源码根：

```sh
BENCH_ROOT=/path/to/baseline node --expose-gc scripts/bench-core.ts
node --expose-gc scripts/bench-core.ts
```

至少交替顺序运行三轮，例如 baseline/candidate、candidate/baseline、baseline/candidate，并报告中位数和每轮原始值，不挑选最好结果。

常用参数：

- `BENCH_ITERATIONS`：核心基准默认 2000；持久宿主基准默认 200，允许 100–2000。
- `BENCH_OPS`、`BENCH_WARMUP`：context/policy 操作与预热次数。
- `BENCH_REQUESTS`：每个管理 HTTP 场景请求数，范围 1–250。
- `BENCH_WINDOW`：soak 每窗口会话数，默认 4000。
- `BENCH_SEND_CONCURRENCY`：慢发送场景的发送并发。
- `BENCH_ONLY=slow-peer`：只运行核心慢发送场景。

核心与 soak 比较使用 `--expose-gc`；显式 GC 应在计时窗口外。绝对时延受共享主机负载影响，不能只根据单轮差异下结论。

持久宿主基准使用临时 SQLite、显式 relay grants 和进程内假 agent/transport，不访问网络；每次规范化入站后触发 agent message，并等待持久出站确认。源码可直接运行，构建后也可运行 `BENCH_ITERATIONS=200 node dist/scripts/bench-host.js`。其结果只描述当前模拟协议路径，不代表真实网关，也不用于宣称相对旧桥的性能。

## 正确性门槛

优化不能改变以下语义：

- 同会话事件有序；配置并行发送后，同会话发送仍有序。
- 队列达到上限时明确背压，不无限增长。
- 持续立即完成的工作会周期性让出事件循环。
- 取消、拒绝和异常最终释放队列与并发槽位。
- 授权、过期、撤销、预算和错误码不因缓存而失效。
- 未使用状态不应产生无界空命名空间。
- 管理快照、审计和完成历史遵守保留上限。

这些门槛适合放入自动化测试；共享 CI 不宜设置容易抖动的绝对微秒阈值。

## 结果解释

- 内核 synthetic benchmark 不包含协议解析、网络、模型、数据库刷盘或下游限速。
- 管理 HTTP 基准不等于完整页面渲染性能。
- RSS 不等于 JavaScript 活对象大小；短 soak 不能证明小时或天级无泄漏。
- 协作式让出不能抢占单个同步死循环。
- 并行发送会改变不同会话间的全局顺序，必须结合 transport 能力验收。
- 当前持久任务按通用 store cursor 扫描并每 64 项让出，不使用 due 索引；终态任务积累可能拉长待执行任务的发现时间，容量与清理策略必须按部署验收。
- SQLite 当前采用 WAL 与 `synchronous=FULL`，按单活动宿主恢复设计，不提供多活租约语义。
- 不同职责、不同入口层级或不同持久化语义的系统不能用简单倍率比较。
- 生产容量需要真实消息形态、资源大小、失败注入、恢复、长稳和速率限制测试。
