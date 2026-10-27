# 服务运维

`ops/qqagent` 是框架自己的服务入口，实现位于 `scripts/service-manager.ts`。Linux 环境需要 Node.js 24.12+、`screen`、`flock` 和 `tail`；图形 QQ 客户端还需要自身的显示环境。启动命令、目录、环境变量和健康检查由本机私有清单提供，配置不提交到 Git。

## 常用命令

| 命令 | 行为 |
| --- | --- |
| `qqagent start` | 按顺序启动当前协议端、框架和已启用的辅助服务；已有实例不重复启动 |
| `qqagent restart framework-admin` | 只重启框架宿主，保留 DSH 和协议端进程 |
| `qqagent restart dsh` | 重启模型宿主；正常聊天中优先使用网页的维护入口，以协调暂停和恢复 |
| `qqagent stop` | 按逆序停止受管服务，包括两套协议端中仍在运行的实例 |
| `qqagent status` | 查看进程与端口状态 |
| `qqagent doctor` | 核对服务健康检查及可选的 QQ 登录状态；不发送消息或模型请求 |
| `qqagent extensions` 或 `qqagent extensions list` | 查看已登记插件的版本、活动调用、排空及错误状态 |
| `qqagent extensions reload <插件标识>` | 读取当前指纹后提交 CAS 代码重载，旧任务使用原实例继续完成 |
| `qqagent logs [组件] [-f]` | 最近 100 行日志，默认组件为 `framework-admin` |
| `qqagent console` | 显示当前配置中的控制台地址 |
| `qqagent protocol` | 显示当前协议选择 |
| `qqagent protocol napcat` | 切换到 NapCat，保留另一套安装及配置 |
| `qqagent protocol snowluma` | 切换到 SnowLuma，保留另一套安装及配置 |

未安装系统命令时，在项目根目录使用 `./ops/qqagent` 或 `npm run ops -- status`。这些命令与前台 `npm start` 分工不同：前台 CLI 启动框架；运维入口管理配置中整组后台服务。

插件维护固定读取本项目 `runtime/live/framework-admin.json`，复用其中的管理地址和私有令牌文件；令牌只在内存中用于 HTTP 鉴权，不放入命令参数或输出。`extensions` 不需要另外填写地址、令牌或源码路径。重载只针对运行宿主中由 bootstrap 主动登记的插件；未接入管理器的旧插件不会自动获得重载能力。

重载命令先查询当前 64 位内容指纹，再提交带期望指纹的请求。版本冲突、已有重载或旧实例仍在排空时明确失败。命令不自动重试写操作；连接中断或超时后运行 `qqagent extensions` 查询真实状态，再决定下一步。返回 `changed: false` 表示内容版本相同，`draining: true` 表示旧实例的任务或清理仍未结束。清理失败保留错误码，阻止继续堆积实例。

每个固定模块入口在同一宿主进程中最多保留 64 个源码代次，运行实例最多保留一代旧实例排空；模块上限达到后可按需重启 `framework-admin`。普通实现更新保持同一工具协议，工具 schema、名称、依赖或注册结构变化需要完整应用。生图配置的 `generationAccess: owner | whitelist` 在执行权限检查时热读，配置即时更新不消耗源码代次。重载机制的开发约定见 [扩展开发](EXTENDING.md)。

## 私有服务清单

固定读取 `runtime/live/services.json`，文件须为当前用户所有的私有普通文件，建议权限 `0600`。下面展示字段结构；路径需要替换为实际安装位置，并补齐协议端、网关与管理服务。

```json
{
  "schema": 1,
  "activeProtocol": "napcat",
  "dshHome": "/srv/dsh/home",
  "logDirectory": "/srv/qq-agent-framework/runtime/logs",
  "lockFile": "/srv/qq-agent-framework/runtime/live/service-control.lock",
  "order": ["dsh"],
  "services": {
    "dsh": {
      "command": "/usr/local/bin/node",
      "args": ["/srv/dsh/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js", "web", "--host", "127.0.0.1", "--port", "3080", "--no-open"],
      "cwd": "/srv/dsh",
      "env": { "DSH_HOME": "/srv/dsh/home", "DSH_INSTALL_MODULES": "/srv/dsh/runtime/node_modules" },
      "screen": "qq-dsh",
      "group": "core",
      "port": { "host": "127.0.0.1", "port": 3080 },
      "ready": { "kind": "http", "url": "http://127.0.0.1:3080/" },
      "consoleUrl": "http://127.0.0.1:3080"
    }
  }
}
```

- `group` 为 `core`、`napcat`、`snowluma` 或 `optional`。默认启动 core 与当前协议；optional 需 `enabled: true`。`enabled: false` 排除默认启动，仍可显式管理。
- `order` 决定启动顺序；未列出的服务按清单顺序追加，停止采用逆序。
- `command`、`cwd`、`logFile` 为绝对路径；`args` 是参数数组，不执行 shell 表达式。`env` 只覆盖该服务的环境。
- `screen` 是精确的会话名。`screenAliases` 可接管同一组件已有的历史名称；不同服务不能共享名称。不会按模糊进程名批量终止程序。
- `ready` 可为回环 HTTP 地址，或 `{ "kind": "command", "command": "/绝对路径", "args": [], "cwd": "/目录" }`。健康命令须只读，以退出码 0 表示就绪，其原始输出不会回显。
- `port` 用于避免重复启动和核对停止。HTTP 就绪不代表模型调用成功或 QQ 已登录。
- `prepare` 可配置 `{ command, args, cwd? }`，仅创建新服务进程前执行，用于启动必要依赖。
- `logFile` 可沿用已运行组件的原日志；未指定时使用 `logDirectory/<组件>.log`。
- 顶层 `accountCheck` 可配置只读 QQ 在线检查命令。`doctor` 报告其结果；整套 `start` 遇到待登录只提示，不把已启动的服务判成启动失败。

本机的 `scripts/service-health.ts dsh|qq|image-worker` 提供鉴权健康检查，读取私有 `runtime/live/service-health.json`：

```json
{
  "schema": 1,
  "nativeDirectory": "/srv/qq-agent-framework/runtime/admin/runtime",
  "accountId": "需要核验的机器人账号",
  "imageWorker": {
    "url": "http://127.0.0.1:17865/health",
    "tokenFile": "/srv/image-worker/token"
  }
}
```

DSH 和 QQ 鉴权从框架已保存的适配器配置读取；生图令牌从指定私有文件读取，不输出令牌或响应正文。`imageWorker` 仅生图检查使用，`accountId` 仅 QQ 检查使用。

## 安装与 boot

先准备私有服务清单，再执行：

```sh
node scripts/install-service-manager.ts --admin-config /绝对路径/framework-admin.json
```

默认创建 `/usr/local/bin/qqagent`，并把管理配置的 `serviceManager` 指向本项目 `ops/qqagent`。可以用 `--bin-dir` 改变命令安装目录。已有进程继续运行，管理服务下次启动后使用新维护入口。

本机已有 `boot` 分发器时，可明确指定：

```sh
node scripts/install-service-manager.ts --boot /绝对路径/service-boot.sh --admin-config /绝对路径/framework-admin.json
```

安装器只识别已有的 `qqbridge` 启动、停止、状态和日志分发结构；其他格式不会猜测修改。原管理配置与 boot 备份在 `runtime/ops-backups/`。已安装的协议端、DSH、凭据和会话不移动，原项目入口保留。

本机 `boot` 的其他系统服务保持原有管理方式。`boot logs qqagent` 与 `boot logs framework-admin` 查看框架日志，历史 `boot logs qqbridge` 作为框架日志别名保留。

## 生命周期与日志

启停与协议切换持有互斥锁，后台服务不继承该锁。启动等待最多 90 秒，停止等待最多 30 秒；先发送终止信号，超时仅对已确认属于受管会话、且进程身份未变化的后代清理。停止未确认时不继续启动同一组件。

协议切换先核对目标可执行文件和目录，再停止原协议端。启动失败时恢复原选择，并尝试恢复原来运行的协议端；不会删除安装或账号数据。自动回滚失败会返回非零状态，需要查看组件状态和日志。

`logs` 显示本机服务原始日志，应只向受信任的本机操作者开放。日志使用 `ops/logrotate.conf` 的轮转规则，部署时将实际日志目录加入系统 logrotate 配置；建议保留 7 天，并按大小轮转。服务清单本身不安装定时任务。
