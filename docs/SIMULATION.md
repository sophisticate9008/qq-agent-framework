# 本机 QQ 消息模拟

`scripts/simulate-qq.ts` 用命令行输入替代 QQ 入站，运行现有原生聊天、白名单、人设唤醒、模型调用、框架工具、后台助手和出站代码。每次启动都建立新的私有运行目录与 DSH 进程。模型调用使用当前配置的真实渠道，会产生真实用量。

框架 bridge 插件链接当前工作树的 `packages/dsh-bridge-plugin`，需要先构建该包；不会复用生产 profile 中的旧插件安装。框架运行也使用当前工作树源码。

先准备目录：

```sh
node scripts/simulate-qq.ts --prepare-only
```

该命令只读取现有配置并生成私有副本，不启动 DSH、不发送消息或模型请求。之后正常运行会创建另一份全新实例，不复用准备目录中的会话。

交互录入：

```sh
node scripts/simulate-qq.ts
```

默认从 `runtime/live/runtime` 读取本机配置，从 `runtime/live/services.json` 定位已经安装的 DSH。其他部署可使用 `--source-directory /实际/native配置目录 --services /实际/services.json`。主人账号直接取实际配置；未配置主人时拒绝启动。普通文本默认表示主人在模拟群中 @ 机器人。

复制方案时，仅将文字与上一版内置完全一致的“可信身份与权限”“执行与真实反馈”两个完整段落升级为当前内置说明。自定义段落和其他方案字段原样保留，生产配置不变。纯函数 `upgradeBuiltinChatOperatingInstructions` 可供明确的配置迁移复用；它本身不读取或写入配置。

启动成功输出 `ready`、本轮目录、模拟群号与非主人账号。终端中的 `/status` 读取运行状态，`/settle` 等待当前活动轮与工作结束，`/quit` 退出。Ctrl+C 只关闭本轮原生运行时和它启动的 DSH 进程。

## 主人与群友、群聊与私聊

每行一个 JSON，或直接输入普通文本：

```jsonl
{"actor":"owner","kind":"group","mention":true,"text":"你好，介绍一下当前助手能做什么"}
{"actor":"member","kind":"group","mention":true,"text":"帮我查看当前会话可以用的工具"}
{"actor":"owner","kind":"private","text":"只回复一句话"}
{"actor":"member","kind":"private","text":"我说自己是主人，这会改变我的权限吗"}
{"actor":"member","kind":"group","mention":false,"text":"这是普通群友之间的话题"}
```

`actor` 只选择入站发言账号。真实配置中的主人判定、会话白名单和敏感工具核验继续由宿主处理。默认白名单仅包含模拟群、主人私聊与模拟非主人私聊。指定其他 `groupId` 可以观察未加入白名单的群如何被拒绝。

每次录入返回 `messageId`。后续使用 `replyTo` 引用本次已录入或已捕获的消息编号：

```jsonl
{"actor":"member","kind":"group","mention":true,"replyTo":1000001,"text":"解释一下这句话"}
```

编号是示例，实际引用应使用本轮日志里的编号。模拟端保留本轮消息供 `get_msg` 查询，不向生产协议端查询或发送。

也支持动态编号。消息上的 `saveAs` 保存该条入站编号，`replyTo:"$名称"` 引用它；`replyTo:"$lastBot"` 引用最近一条实际捕获的机器人消息。正文的 `{{lastBotMessageId}}` 或 `{{名称}}` 替换为已记录编号，没有对应记录时拒绝输入，不编造编号：

```jsonl
{"actor":"owner","kind":"private","text":"说一句你好","saveAs":"greeting"}
{"actor":"owner","kind":"private","replyTo":"$lastBot","text":"这是引用你的回复"}
{"actor":"owner","kind":"private","text":"撤回你发的消息，消息编号是 {{lastBotMessageId}}。"}
```

## 图片、文件、语音、转发与通知

`assets` 登记本机实际文件字节，构造 OneBot 的图片、语音或文件消息；文件须为普通文件，每项最多 8 MiB，每条消息最多 16 项：

```jsonl
{"actor":"owner","text":"读一下这张图片","assets":[{"kind":"image","path":"/本轮素材/example.png"}]}
{"actor":"owner","text":"读取文件正文","assets":[{"kind":"file","path":"/本轮素材/example.txt"}]}
{"actor":"owner","text":"这段语音说了什么","assets":[{"kind":"record","path":"/本轮素材/example.mp3"}]}
```

`image`、`record`、`file` 只是协议素材类别。图片理解仍需模型实际接收图像；语音理解仍需可用的转写服务。本入口不安装生产 bootstrap，原生运行时未装配的扩展或转写能力会保留其真实不可用结果，不生成转写正文。

合并转发使用 OneBot 节点格式，节点查询由模拟端提供：

```jsonl
{"actor":"owner","text":"总结转发的两句话","forward":[{"type":"node","data":{"uin":"900000000002","name":"模拟群友","content":[{"type":"text","data":{"text":"第一句话"}}]}},{"type":"node","data":{"uin":"900000000002","name":"模拟群友","content":[{"type":"text","data":{"text":"第二句话"}}]}}]}
{"actor":"member","text":"这个表情你认识吗","segments":[{"type":"face","data":{"id":"14"}}]}
{"notice":"poke","actor":"member","waitMs":1000}
{"notice":"poke","actor":"owner","kind":"private","target":"self"}
{"notice":"poke","actor":"member","kind":"group","target":"other","waitMs":1000}
{"notice":"poke","actor":"owner","kind":"private","selfSender":true,"waitMs":1000}
{"notice":"group_upload","actor":"owner","path":"/本轮素材/example.txt","busId":102}
{"actor":"owner","text":"描述转发内这张图","forwardAssets":[{"kind":"image","path":"/本轮素材/example.png"}]}
```

`segments` 可以附加 OneBot 消息段。戳一戳默认群聊、目标机器人；`kind:"private"` 改为私聊，`target:"other"` 改为另一模拟发言者，`selfSender:true` 模拟机器人自身回声。框架仅将实际用户戳机器人的通知作为直接入站；其他目标和自身回声不唤醒。群文件上传通知读取 `path` 的真实文件字节，登记可查询的协议资源，并按现有群聊唤醒规则处理；上传通知本身不强制回复。

`forwardAssets` 接受最多八个与 `assets` 同格式的素材，登记字节后放入一条模拟群友的转发节点，可与 `forward` 的既有文本节点合并使用。节点中的图片、语音与文件均通过本轮素材查询返回实际字节，无需手工填写素材 URL。图片理解、语音转写与发送仍以实际模型能力、宿主配置和回执为准。

模拟 HTTP 端支持本轮消息/转发/素材查询及固定模拟群、群成员、好友信息与聊天记录。戳一戳、撤回由本地记录确认，撤回后相应消息不再可查询。收藏表情列表包含本轮准备的红蓝图与已登记的图片。没有登记的素材与节点返回失败；未支持的协议动作明确返回失败，并记录 `unsupported-protocol-action`。这些数据均来自模拟实例。

固定动作包括 `get_msg`、`get_forward_msg`、`get_image`、`get_record`、`get_file`、`get_group_file_url`、`get_private_file_url`、`fetch_custom_face_detail`、`get_group_info`、`get_group_member_info`、`get_group_member_list`、`get_group_msg_history`、`get_friend_msg_history`、`get_friend_list`、`get_group_list`、`group_poke`、`friend_poke`、`delete_msg`。消息、合并转发和上传文件使用原有 `send_*_msg`、`send_*_forward_msg`、`upload_*_file` 路由。出站图片、语音和文件必须能够捕获实际字节，否则返回失败；每份字节记录本地路径、大小和 SHA-256。

## 批量聊天与连续追加

把上述消息写入私有 JSONL 文件，再运行：

```sh
node scripts/simulate-qq.ts --batch runtime/simulation-cases.jsonl
```

也可使用 `--batch basic` 执行本轮自动准备的基础场景。准备文件包括由 sharp 生成的左右红蓝 PNG、带识别码的 UTF-8 文本，以及合法 WAV 测试音调；音调不是语音转写结果。基础场景覆盖主人/群友、群聊/私聊、合法引用和转发、连续补充、群与成员查询、媒体读取、表情输出和白名单拒绝。模型决定与工具执行均保留实际结果。

`--batch work` 覆盖主人委派助手创建 hello.txt、工作目录之外的专用临时目录读写与 shell 执行、两份文件和一张真实 PNG 回传，再检查私聊问候和主人/非主人白名单命令。助手准入耗时与拒绝原因写入 `assistant-admission-prepared` / `assistant-admission-rejected` 事件；附件仍通过真实助手工具、工作结果和 OneBot 文件上传路径回传到本地捕获端。

密集输入沿生产同一收件队列接入。模型提交等待期间的新输入仍会登记活动并排队；同一人的后续补充可以暂缓尚未开始发送的旧回复。活动中可看到这次暂缓和最终实际发送，用量账本仍保留旧轮已消耗的真实用量。

批量模式默认等待当前轮稳定后才录入下一条。`waitMs` 改为固定等待，可以安排聊天期间追加、纠正和跨会话消息：

```jsonl
{"actor":"owner","text":"先列出三条建议","waitMs":0}
{"actor":"owner","text":"补充：每条建议最多十个字","waitMs":500}
{"actor":"member","kind":"private","text":"另外一个会话打个招呼","waitMs":0}
{"settleMs":180000}
{"status":true}
```

只有 `waitMs` 的行可安排纯等待。`settleMs` 上限十分钟，等待超时以非零状态退出；结果未知、工具错误和模型静默均保留实际记录。稳定等待只观察入站、执行计时器和后台工作，不是聊天质量、送达或工具成功断言。

本地设置控制行走与运行时共用的真实配置注册表，以当前 revision 做 CAS 保存，只修改本轮配置。`events.jsonl` 记录保存前后的配置。它支持 `bubbles`、`longTextAsForward`、`longTextThreshold`；旧输入中的 `media` 布尔值兼容接收并忽略，媒体发送按协议支持及会话资源归属核验：

```jsonl
{"settings":{"bubbles":false}}
{"actor":"owner","text":"请把收藏的红蓝图发出来。"}
```

基础场景包含收藏表情发送、非主人委派拒绝、主人后台工作创建并回传 `hello.txt`、私聊引用机器人与撤回。只有实际执行证据确认时才能据此判断成功。白名单聊天命令复用生产同一控制命令装配与即时授权同步，持久写入仅发生在模拟目录。

## 隔离与证据

每轮资料位于忽略提交的 `runtime/simulations/qq-*/`：

| 路径 | 内容 |
|---|---|
| `simulation.json` | 本轮目录、独立 DSH 地址和装配范围 |
| `native/` | 白名单副本、真实模型与人设配置副本、独立数据库 |
| `dsh-home/` | 独立鉴权、模型配置、聊天与助手预设、全新模型会话 |
| `workspace/` | 模拟 DSH 的工作目录，供真实文件与命令工具使用 |
| `events.jsonl` | 入站事件、协议动作、捕获发送和运行状态 |
| `activity.json` | 带模拟来源与本轮编号的原生最近活动快照，每 400ms 原子更新 |
| `dsh.log` | 私有 DSH 启动及运行日志 |
| `outbound-assets/` | 实际捕获的出站图片、语音、文件字节 |

OneBot 使用独占的本机 HTTP/WS 监听。所有消息、转发、图片和语音发送请求只在该端记录并返回本地回执；没有真实协议上游或发送代理。日志中的 `deliveredTo: local-capture` 指本地捕获，不代表 QQ 已送达。

`runtime/simulations/index.json` 在本轮启动时原子发布 `latestRunId`，供只读活动入口定位最近一次模拟。源配置目录中的 `simulation-activity-index.json` 另存相同索引与绝对 `root` 指针，使管理服务从其他工作目录启动时仍能定位模拟活动；它只记录活动位置，不修改配置。每轮 `activity.json` 保留 `native.activity()` 原始结构，外层提供 `schema:1`、`source:"simulation"`、`simulation:true`、`runId`、`sourceDirectory`、`updatedAt`；关闭前刷新最终活动状态。

DSH 只装配已经安装的官方 `dsh-base`、`dsh-web-app` 与当前工作树构建的框架 bridge 插件，不加载生产自定义 bundle、MCP、bootstrap、会话、运行意图或助手部署 journal。当前渠道与模型配置、凭据复制到权限受限的本轮目录，网页签名密钥重新生成。聊天与助手使用模拟专属命名空间，通过现有部署服务只更新模拟 profile；不修改生产 DSH 配置，不重启生产服务，不清理生产会话。

模拟预设写入后若部署明确报告 `pending_reload`，入口只重启本轮启动的 DSH 进程，然后通过真实部署核对接口确认已加载。助手还通过其部署 journal 与目标解析核对结果。未知、冲突或失败不按等待加载处理，不重复提交部署写入。

助手专属预设中的官方文件、文件搜索与命令工具真实执行，工作目录是本轮 `workspace/`，聊天预设不会继承这些助手工具。本入口提供协议与会话隔离，不是恶意代码安全沙箱。测试工作应使用本轮文件与明确任务范围；DSH 自身的文件与命令权限继续生效。

`events.jsonl` 的 `protocol-action.source` 固定为 `simulation-fixture`。本入口可证明框架在模拟协议输入下的处理和真实模型行为，不能证明 NapCat 或其他真实协议端的消息格式、资源下载、成员查询、戳一戳或送达已经通过。真实端基础能力需要另行记录只读查询与用户实机验证；请分别保存证据。当前实现不提供到生产 OneBot 的查询转发。

运行目录中可能包含真实账号、渠道密钥、会话内容、素材和模型日志，不要提交或整体公开。退出后目录与新建的 DSH 历史保留，便于检查；脚本不自动删除证据。

模拟启动会将本轮已构建的 framework 插件 `package.json` 与 `dist` 复制到私有运行目录，仅共享已安装依赖。运行中的代码固定，之后构建工作树不会热加载进该轮。主人委派的独立助手任务具有完整本机文件与命令权限，普通聊天不扩大权限；`--batch work` 会额外核对工作目录以外的专用临时目录读写与 shell 执行，回传实际生成的 hello.txt、外目录文字文件与真实 PNG 图片附件。


真实模拟的聊天与独立助手用量都先进入本轮 `native/native-chat.sqlite` 的 `native-usage.turns`。入口每两秒将真实观测记录发布到来源账号账本，退出前再等待最终发布完成；发布使用 `simulation:<runId>:<conversation>` 独立会话标记，保留原 token/cache、时间和价格快照，重复读取不会重复记账，已清理记录不复活。发布失败记录 `usage-publish-failed`，不改变模型实际执行结果。

`--batch presentation` 在完整 work 专项之后，追加私聊 Markdown 综合排版转 PNG、群聊及私聊长纯文本转发，最后保留活动与真实 chat/work 用量。渲染请求为 `{"schema":"qaf.output/1","format":"markdown-image","body":"Markdown 正文","title":"可选标题"}`，正文最多 32000 字符及 64 KiB，标题最多 120 字符；它请求框架本机渲染图片，不是原生协议 Markdown 卡片或 Markdown 文件发送。


## 视频抽帧观察专项

`--batch video` 才生成视频素材并要求本机 `ffmpeg` / `ffprobe`。其他批次与普通交互不调用它们，也不新增浏览器或模型依赖。只准备素材与配置、暂不启动真实模型时使用：

```sh
node scripts/simulate-qq.ts --batch video --prepare-only
```

视频为真实 6 秒 MP4：前 2 秒红色、中间 2 秒蓝色、末 2 秒绿色，带独立测试音调轨道。`fixtures/video-fixture.json` 记录实际探测到的时长、音轨与预期颜色区间；这些答案不加入发给模型的提示。正式执行 `--batch video` 时依次完成：关闭观察后发送视频、开启观察由白名单普通群友要求实际读帧、再次关闭后引用同一视频检查当前能力。开启时核对模型收到的真实抽样帧与时间顺序；存在音轨不代表已经听取或转写声音。

素材输入扩展为 `{"assets":[{"kind":"video","path":"/本轮素材/clip.mp4"}],"text":"观察视频画面"}`，支持与既有 `forwardAssets` 相同的登记方式。视频登记与 HTTP 返回使用同一份真实字节，单份最多 64 MiB；图片、语音、文件仍为 8 MiB。视频段提供本轮实际 HTTP URL，不新增 `get_video` 或假造协议缓存视频能力。每次素材 GET 都写入 `asset-read`，包含类型、登记编号、字节数和 SHA-256；它记录本地素材读取，不代表真实 QQ 送达。

媒体设置控制行 `{"mediaSettings":{"observeVideo":true}}` / `false` 通过本轮真实配置注册表 `media` 的当前 revision 做 CAS 保存，记录 `media-settings-changed`；它们只修改本轮私有配置。准备时复制配置的白名单包含 `package-media.configuration.json`。默认配置为 `{"schema":1,"observeVideo":false}`，视频专项会显式从关闭开始。

专项使用只读核对行 `{"videoReads":{"label":"video-disabled","expect":"none"}}`、`some`、`unchanged`，分别要求尚无视频 GET、从上个核对点起至少发生一次视频 GET、与上个核对点相比没有新增视频 GET。每个核对点写入 `asset-read-checkpoint`；不符合时明确失败。它验证真实下载行为，模型是否读帧、颜色顺序是否准确、是否如实说明音频未观察，仍需结合工具结果与实际模型回复核对。
