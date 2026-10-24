# 管理界面：初始化与访问

管理页可以连接演示后端或真实 HTTP 出站网关。真实网关模式只提供状态查看，不发送 QQ、不修改授权、不展示会话正文，也不假装已经接管旧 DSH。旧后端的会话、工具和审批操作仍使用原控制台。

## 1. 准备私有配置

先完成 [OneBot 网关配置](LEGACY_GATEWAY.md)，并确认网关健康。以下命令在仓库根目录执行；路径、监听地址和端口均可自行选择，不需要修改源码。

```sh
npm ci
npm run build

export PRIVATE_GATEWAY_CONFIG=/absolute/private/path/gateway.json
export PRIVATE_ADMIN_CONFIG="$PWD/runtime/admin/config.json"

node scripts/configure-gateway-admin.ts \
  --config "$PRIVATE_ADMIN_CONFIG" \
  --gateway-config "$PRIVATE_GATEWAY_CONFIG"
```

将第一条路径替换为已有的真实网关配置路径。初始化工具默认监听 `127.0.0.1:3210`，生成独立的随机管理令牌；只输出配置文件和令牌文件的**路径**，不输出令牌值。配置与令牌文件权限为 `0600`，所在目录必须为私有目录。已存在的配置不会被覆盖，已存在且合规的令牌不会被轮换。

如需局域网访问，在首次初始化时显式指定：

```sh
node scripts/configure-gateway-admin.ts \
  --config "$PRIVATE_ADMIN_CONFIG" \
  --gateway-config "$PRIVATE_GATEWAY_CONFIG" \
  --host 0.0.0.0 \
  --port 3210
```

上述两条初始化命令二选一。`--host` 也可指定本机的具体 IPv4/IPv6 地址或 `localhost`；`--port` 可换为任意可用端口。`--token-file` 可指定另一个私有令牌文件；省略时使用管理配置目录内的 `gateway-admin.token`。

## 2. 配置字段与令牌

生成的管理配置包含：

| 字段 | 用途 |
| --- | --- |
| `host` | 管理 UI 的监听地址；开放全部 IPv4 网卡时为 `0.0.0.0`。 |
| `port` | 管理 UI 的实际监听端口，不是协议端口。 |
| `tokenFile` | 独立的管理令牌文件，至少 24 字符；浏览器使用其中的令牌认证。 |
| `gatewayConfiguration` | 已有 OneBot 网关配置文件路径，用于读取真实健康信息。 |

相对文件路径以管理配置文件所在目录解析。`tokenFile` 与 `gatewayConfiguration` 的内容不会通过 UI 公开。

**管理令牌与 OneBot token 不同：** 管理令牌由初始化工具生成，只用于管理 API；OneBot token 是已有协议服务/网关的凭据，必须保持与原调用方和 upstream 一致，不能为了登录 UI 随机替换它。不要将任何真实 token 写进源码、Git、URL 查询参数或截图。

## 3. 启动并首次连接

```sh
node scripts/gateway-admin.ts --config "$PRIVATE_ADMIN_CONFIG"
```

在另一个终端检查：

```sh
node scripts/gateway-admin.ts --config "$PRIVATE_ADMIN_CONFIG" --health
node scripts/gateway-admin.ts --config "$PRIVATE_ADMIN_CONFIG" --address
```

打开输出的管理地址。如果监听 `0.0.0.0`，同机可访问 `127.0.0.1`；其他设备应使用这台机器的**实际局域网 IP** 和配置端口，而不是把 `0.0.0.0` 当作浏览器地址。UI 的 API 请求使用当前页面的同源相对路径，没有内置固定 IP 或端口。

在你自己的本机终端或编辑器打开 `tokenFile` 指向的文件，把其中的令牌粘贴到页面“管理 Token”，点击连接。页面会清空输入框，令牌只保留在当前页面内存；刷新/关闭页面后需要重新输入，不写入浏览器本地或会话存储。无需在聊天中发送令牌。

真实网关连接后页面显示正式接入状态，隐藏手动演示入口。指标仅覆盖 HTTP 网关本进程观察到的流量；旧 WS 直发不在统计内，进程计数也不是全部历史。后端不可达时显示不可用，而不是用演示数据顶替。

## 4. 修改监听地址、端口或令牌

编辑已有私有管理配置中的 `host` / `port` / `tokenFile`，再重启**管理 UI 组件**即可，不需要改源码或重启 QQ、DSH、bridge。不要再次初始化覆盖已有配置。

需要轮换管理令牌时，在本机生成新的私有文件：

```sh
umask 077
export NEW_ADMIN_TOKEN_FILE=/absolute/private/path/new-admin.token
node --input-type=module -e 'import {randomBytes} from "node:crypto"; import {writeFileSync} from "node:fs"; writeFileSync(process.env.NEW_ADMIN_TOKEN_FILE, randomBytes(32).toString("hex") + "\n", {mode: 0o600, flag: "wx"})'
```

然后把配置的 `tokenFile` 改为新路径，重启管理 UI，使用新令牌重新连接。旧令牌文件是否删除由管理员自行决定，不要覆盖协议服务的 token。

## 5. 预算开关与其他运行配置

预算属于**网关配置**，不是管理 UI 的认证配置。网关的 `budgetEnabled` 是独立开关：

- `false`：不执行次数或有效期限制，但保留已经填写的 `maxSendUses`、`grantTtlMs`，以后可以再打开。
- `true`：启用已经配置的次数/有效期；未配置的限制项仍不限制。
- 省略：兼容原配置，按 `maxSendUses`、`grantTtlMs` 是否存在决定相应限制。

额度与有效期的值由部署方选择，没有写死的业务预算。并发、队列、请求大小和超时等健壮性限制是另外的配置，不随预算开关一起失效。预算关闭不等于关闭认证、白名单或 capability 授权。

预算开关或数值改变后，按[网关服务授权说明](LEGACY_GATEWAY.md#服务授权)显式更新 `authorizationVersion` 并重载网关，避免把普通重启变成自动充值。管理 UI 重载后读取新的网关配置，显示实际开关、配置值和有效状态；当前界面只读，不能点击修改生产预算。

## 安全与故障排查

- 开放 `0.0.0.0` 不会关闭认证；但普通 HTTP 不加密令牌，只适合可信本机/局域网。需要跨不可信网络时使用 HTTPS 反向代理或受控隧道，不要裸露到公网。
- `401`：检查粘贴的是管理 `tokenFile` 的值，而不是文件路径或 OneBot token；令牌轮换后需重新连接。
- 配置拒绝：检查路径、合法监听 IP、端口范围、文件不是符号链接，配置/令牌 `0600`、私有目录 `0700`。
- 端口占用：修改配置中的 `port`；程序不会自动夺占或静默换端口。
- 页面不可达：确认进程已启动、监听地址允许该网卡、访问的是实际 IP、主机防火墙允许配置端口。
- 网关不可用：使用原网关 `--health` 排查。管理 UI 不会自动重启业务、补发 unknown 消息或创建替代会话。
