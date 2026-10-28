# 安装、运行与诊断

## 安装和首次配置

从零安装见 [安装教程](INSTALL.md)，日常操作见 [使用教程](USAGE.md)。使用 Node.js `>=24.12.0`，依赖由锁文件固定。项目目录中执行：

```sh
npm ci
npm run build
npm run cli -- init
npm start
```

`init` 创建管理配置与独立 OneBot HTTP 网关配置，默认管理地址为 `127.0.0.1:3210`，网关地址为 `127.0.0.1:3131`，OneBot 上游为 `http://127.0.0.1:3000`。初始化的允许会话列表为空。首次访问管理网页生成管理令牌；不要把令牌、真实账号、会话内容或 `runtime/` 放入版本库。

接着配置外部 OneBot 与 DSH，选择模型方案和人设，填写主人与允许范围，再核对应用结果并启用聊天。本机 DSH 默认自动发现；远程和手动参数属于高级接入。详见 [DSH](DSH.md) 与 [控制台](UI.md)。

管理配置路径优先级为 `--config`、`QQ_AGENT_CONFIG`、`runtime/admin/config.json`。复用已有网关可在初始化时显式传 `--gateway-config <文件>`；仅在信任并需要该程序时传 `--service-manager <程序>`，不会自动猜测运维脚本。

## 常用命令

| 命令 | 行为 |
|---|---|
| `npm start` | 启动管理端并启动或复用配置匹配的网关 |
| `npm run cli -- start --admin-only` | 仅启动管理界面 |
| `npm run cli -- start --config /绝对路径/config.json` | 使用明确的管理配置 |
| `npm run cli -- start --bootstrap /绝对路径/extension.ts` | 本次启动选择可信本机扩展；未指定时读取管理配置旁的固定版本选择 |
| `npm run cli -- status` | 查看当前配置对应的服务状态 |
| `npm run cli -- doctor --conversation group:123456` | 对一个合成示例群会话执行已鉴权只读诊断 |
| `npm run cli -- doctor --conversation private:123456 --account <64位注册ID>` | 在明确账号下诊断会话 |
| `npm run cli -- --help` | 查看当前参数说明 |

将示例会话替换为需要诊断的会话。doctor 不发送消息，也不在输出中展开凭据。多账号注册 ID 可从账号管理状态取得，不是 QQ 号。

停止进程使用 Ctrl+C、SIGINT 或 SIGTERM，等待清理结果；CLI 没有 `stop` 子命令。控制台的停止聊天只控制聊天运行状态，不等于停止管理进程。若关闭或取消结果未知，按 [恢复手册](RECOVERY.md) 处理，不能直接把未知记录当作已清理。

## 本机 boot 接入

本机 `boot` 通过本框架的 `qqagent start` 启动所选协议端、DSH、已启用的辅助服务及框架网关和宿主。入口为 `ops/qqagent`，实现为 `scripts/service-manager.ts`，服务清单位于私有的 `runtime/live/services.json`。NapCat / SnowLuma 两套安装与登录数据保留，`qqagent protocol napcat|snowluma` 管理当前选择。框架宿主沿用已选择的部署入口和私有配置，按已保存的运行意图恢复原生聊天。

`qqagent restart framework-admin` 单独重启框架；`boot logs qqagent`、`boot logs framework-admin` 和 `qqagent logs` 均查看框架日志。`boot logs qqbridge` 保留为日志别名。`qqagent status` 展示当前选中的服务，`qqagent doctor` 只读核对配置的健康检查与 QQ 在线状态。启动或停止失败时返回非零退出码，停止未完成时不继续重启。服务安装目录可以独立配置，运维命令不调用其他项目的启动脚本。配置格式、安装与常用命令见 [服务运维](SERVICE_MANAGER.md)。

## 需要区分的默认值

| 项目 | 默认行为 |
|---|---|
| 主聊天总期限 | 120 秒；超时尝试取消，通知默认关闭 |
| 独立出站请求期限 | 60 秒；发送额度控制默认关闭，访问范围仍须授权 |
| 输入参与 | 群聊、私聊开启；@ 和引用唤醒开启；续聊窗口 90 秒，可设 0–300 秒 |
| 昵称 | 显式列表默认空；当前人设名称也参与有效昵称解析 |
| 输出 | 分气泡开启；长文合并转发关闭，阈值 3500 字符；媒体按协议端支持发送 |
| 转发 | 随会话白名单开放，仍需要可用协议能力和相应输出设置 |
| 模型容量 | 优先读取实际模型元数据与已应用值；未知已应用容量显示未知 |
| 无元数据的方案容量回退 | 群聊、私聊各 128000；不是所有模型的容量声明 |

默认输入启用与白名单授权是不同条件。模型有完整容量元数据时，方案建议按实际窗口生成：群聊取窗口的 40%，私聊取 70%，向下取整且至少超过输出预算，压缩预留取剩余空间的 5% 与 8192 中较小值。应用前仍需核对所选方案和模型限制。

## 定位不回复或应用受阻

先看“概览”和“连接”中的 QQ、DSH、聊天状态，再使用逐会话 doctor。检查账号是否正确、真实 selfId 是否匹配、主人与访问范围、功能触发条件、模型和能力依赖、选中配置是否已应用，以及是否存在未结或未知执行。总体在线不能证明某一会话获准或可运行。

配置写入冲突时刷新并核对期望版本。写入、迁移或发送结果未知时，保留 operationId 和会话关联，只读取原操作证据；不要连点保存、重置或重试。历史恢复、单会话重置、账号旧数据接管都有明确范围和版本，不能用删除数据库来替代。

备份和维护应保留配置、账号目录、数据库及关联资源的一致性。运行中不要直接替换 SQLite 或 JSON 文件；按对应服务停止与排空结果操作。包含会话、密钥或素材的备份属于私有运行数据。

## 开发检查与测试

```sh
npm run check
QQ_TEST_CONCURRENCY=1 npm test
QQ_TEST_CONCURRENCY=1 npm run test:built
npm run test:sdk
```

`check` 包括服务端与网页严格类型检查、AST 依赖边界、显式 `any` 与屏蔽指令检查。`npm test` 构建后递归发现源码与编译后测试，排除 fixture 与隐藏目录；`test:built` 只运行编译后测试。两条命令不是两个必须连续重复执行的独立产品操作，按改动和验证缺口选择。并发可设 1–32，默认 4；本轮完整验收与 CI 使用 1。

| 测试入口 | 用途 |
|---|---|
| `npm run test:fast` | 排除独立集成与六十秒真实时限的常规测试 |
| `npm run test:deadline` | 真实墙钟期限场景，不能用短时间模拟代替 |
| `npm run test:integration` | 独立集成与实际 CLI 生命周期 |
| `npm run test:sdk` | 打包 SDK，在临时外部项目严格编译并运行 |
| `npm run test:browser` | 完整十组浏览器场景 |

浏览器工具按需安装到 `runtime/testing/`，普通安装、构建、启动和单元测试不需要 Playwright。需要预装时执行 `npm run cli -- install --browser`；系统库不足时可加 `--with-deps`。`--skip-browser-download` 只安装工具包。`npm run cli -- uninstall --browser` 只清理浏览器工具，不清业务数据和证据。

单组浏览器命令为 `npm run cli -- test --browser --target <名称>`，名称包括 `browser`、`management`、`page-navigation`、`activity`、`usage`、`markdown`、`presentation`、`virtual-list-perf`、`native-chat-ui`、`execution-journal`。这些测试使用隔离配置与协议替身；真实模型质量另行记录。插件测试命令与加载方法见 [DSH](DSH.md)，最终结果及历史失败处理见 [验收记录](VALIDATION.md)。

## 升级与备份

升级前核对本地修改，并按部署方式停止框架管理进程；使用 `qqagent` 的部署执行 `qqagent stop framework-admin`，前台 CLI 等待 Ctrl+C 完成。停止结果未知时先核对排空，不继续覆盖运行文件。

备份私有配置、账号目录、SQLite 与其有效 WAL、关联资源和外部 DSH 配置，保留文件权限。不要只复制单个数据库文件；运行中备份使用支持一致快照的工具。

工作树可安全快进时执行：

```sh
git pull --ff-only
npm ci
npm run build
```

继续使用原管理配置启动；受管部署使用 `qqagent start framework-admin`，前台使用原 `npm start` 命令及参数。升级不重新运行 `init`，不重置会话。DSH 桥接插件是独立安装，按 [DSH 接入](DSH.md) 重新构建、安装并加载相应版本。版本记录与已知限制见 [发布说明](RELEASE_NOTES.md)。

## 自动保留

原生数据库的运行记录自动保留 7 天，后台分批清除过期临时数据并在容量高水位提前回收已结束记录。状态在会话页“自动维护”详情查看。未知任务、会话历史、用量账本及必要去重状态保留；需要处理提示应核对这些记录，不手工删除数据库。

文件日志由进程管理器轮转。仓库提供 `ops/logrotate.conf` 模板：将 `@LOG_DIRECTORY@` 替换为私有日志目录，通过 cron 每分钟调用 logrotate；采用每日或超过 10MiB 轮转，当前文件加最多四份历史、历史最多 7 天。持续写入日志通过 copytruncate 轮转，检查间隔内可能短暂超过大小阈值，截断交接有标准 copytruncate 的短暂丢行窗口。框架数据库的执行结果不依赖文本日志。

本机使用独立的 `/etc/cron.d/qq-agent-framework-logrotate` 和 `/etc/logrotate.d/qq-agent-framework` 管理本框架及沿用的服务日志；进程无需重启即可启用轮转。部署到其他机器时由其进程管理器安装同等规则，模板见 `ops/logrotate.conf`。
