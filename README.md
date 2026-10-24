# QQ Agent Framework

独立的 TypeScript 桥接引擎原型：让工作 agent 通过功能包迭代能力，而不是把工程需求写成聊天偏好，
也不是反复侵入一个庞大的 bridge。旧 qq-bridge 仅作需求、边界和失败模式参考，本项目不复制其源码或资产。

**当前是 0.1.0 本地演示，不是已接入 QQ/DSH 的生产机器人。** 不启动真实模型、不发真实消息、不自动定时发言。
所有服务、授权、事件记录与功能状态均在内存中，退出即丢失。功能模块是可信代码，不是安全沙箱。

## 快速开始

要求 Node.js 24 或更新版本。所有手写程序源文件均为 `.ts`；`dist/` 是忽略提交的编译产物，
浏览器加载其中的 JavaScript，而不是直接执行 TypeScript。

```sh
npm ci
npm run check
npm test
```

启动管理页面前，在终端输入一个你自行生成、至少 24 字符的随机管理口令，按回车；输入不回显：

```sh
read -r -s BRIDGE_ADMIN_TOKEN
export BRIDGE_ADMIN_TOKEN
npm run demo
```

打开 `http://127.0.0.1:3210`，在页面中输入相同口令并连接。管理口令只保存在当前进程与页面内存，
不放入 URL、源码或浏览器持久存储。不要在共享终端使用生产凭据作为演示口令。
端口可通过 `PORT` 修改；只允许监听回环。停止用 Ctrl+C，不会修改或停止其他项目。

页面可查看功能、人设/配置/偏好、授权预算、演示出站和审计记录，并手动提交两类事件：
定向消息回应、提醒触发。默认且唯一允许的演示会话是 `demo:room`。

## 基础能力

- 显式安装和卸载功能；安装失败不发布处理器，清理失败阻止假装完成的重新安装。
- 同会话顺序处理，跨会话可并行；排队事件和副作用有数量上限。
- 人设、能力、行为配置、偏好、运行状态、权限六类分离；临时偏好过期不覆盖持久默认。
- 功能声明只是请求；实际副作用还需可信宿主的会话范围授权、预算及暂停/撤销检查。
- 通用事件校验器与能力适配器挂载点；新增能力不必修改内核，内置发送路径不可被同名替换。
- 出站幂等键与有限窗口内的事件去重；区分确认、明确拒绝与结果未知，未知不自动重发。
- 独立本地管理 UI；认证、同源写请求、大小限制、安全响应头和纯文本动态渲染。

这些是**内存实现的局部保证**，不是跨进程去重、持久队列、可靠热更新或真实网关送达保证。

## 目录

```text
src/core/       TypeScript 内核、类型契约、数据分层和权限
src/adapters/   无网络的演示模型与消息适配器
src/features/   独立对话与提醒功能包
src/admin/     原生 HTTP 管理接口
web/           HTML、CSS 和 TypeScript 界面源码
test/          TypeScript 离线测试与真实内核组合测试
scripts/       TypeScript 构建、检查和浏览器冒烟
docs/          目标、架构、开发契约、验收与交接
runtime/       本机验收日志和截图，不提交
dist/          编译输出，不提交
```

## 开发与验收

```sh
npm run typecheck
npm run build
npm test
npm run test:built
npm run check
```

可选浏览器验收需自行安装 Chromium，或通过 `CHROMIUM_EXECUTABLE` 指定已有浏览器：

```sh
npx playwright install chromium
npm run test:browser
```

浏览器检查只启动隔离的回环演示服务，结束即关闭。生成的管理口令不输出，截图和摘要留在
`runtime/iterations/001/`。Playwright、TypeScript 和 Node 类型仅为开发依赖；没有第三方运行时依赖。

## 文档入口

- [目标与分类原则](docs/GOALS.md)
- [架构与当前缺口](docs/ARCHITECTURE.md)
- [功能包与挂载点](docs/EXTENDING.md)
- [公共开发契约](docs/CONTRACTS.md)
- [安全与授权边界](docs/SECURITY.md)
- [本轮迭代验收](docs/iterations/001-independent-engine.md)
- [续接清单](docs/HANDOFF.md)

自身形象的早晚/饭点/季节性表达是后续**工程功能包**，不是本轮创建的聊天偏好。
其触发、有限审图重试、合格旧图兜底、语境门控和送达记录的建设顺序见架构与目标文档。
MIT 许可；不包含旧项目的人设、素材、聊天、配置或凭据。
