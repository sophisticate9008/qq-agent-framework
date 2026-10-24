# QQ Agent Framework

QQ Agent Framework 是一个可组合的消息桥接与 agent 宿主框架。它把协议接入、会话、权限、功能生命周期和副作用执行拆成明确边界，便于在不修改核心调度器的情况下增加功能。

当前版本为 `0.1.0`，适合本地开发和接口验证；真实 QQ、外部 agent、持久恢复与生产运维能力应按实际部署分别验收。

## 快速开始

要求 Node.js 24.12+ 与 npm。

```sh
npm ci
npm run build
```

启动仅监听回环地址的演示管理页：

```sh
read -r -s BRIDGE_ADMIN_TOKEN
export BRIDGE_ADMIN_TOKEN
npm run demo
```

口令至少 24 个字符。启动后访问 `http://127.0.0.1:3210`；演示数据只在当前进程内有效。

运行测试：

```sh
npm test
npm run test:built
```

## 已有基础能力

- 版本化功能安装、卸载、取消、在途排空和失败隔离。
- 同会话顺序处理、跨会话并行、有限队列和协作式事件循环让出。
- 人设、配置、偏好、功能状态与权限分离。
- 按功能、会话和 capability 授权，支持有限尝试预算、暂停、过期与撤销。
- 宿主可注册事件校验器和 effect adapter；功能只通过受控 SDK 发起副作用。
- 文本、资源引用、提及和回复消息块的统一类型契约。
- SQLite 持久存储、generation 化会话注册、持久出站、有限任务队列和受审批资源目录。
- OneBot HTTP 收发适配器与可注入成熟 client 的 DSH agent adapter。
- `createBridgeHost` 组装持久 policy/state、会话、follow、任务和出站恢复。
- 本地演示 transport、model、功能包和只读管理快照。

## 使用边界

- 功能包和适配器是可信宿主代码，不是不可信代码沙箱。
- 功能声明不等于授权；外部副作用必须经过宿主 policy。
- 内核中的事件去重、审计和演示出站记录是有限的进程内状态。
- 持久组件能保存状态和标记中断结果，但不会把 `unknown` 自动重放为成功或失败。
- `confirmed`、`rejected` 与 `unknown` 必须分开处理；结果未知不能直接视为失败并盲目重发。
- 资源块只携带资源标识，不代表任意本机路径或 URL 可被访问。
- 尚未经过对应集成与故障恢复测试的适配器，不应标记为生产可用。

## 项目结构

```text
src/core/       功能 SDK、调度、上下文与权限
src/host/       宿主持久化、会话和恢复基础件
src/adapters/   外部协议与 agent 适配器
src/features/   可独立装配的功能包
src/admin/      本地管理接口
web/            演示管理页
test/           自动化测试
scripts/        构建、检查和基准脚本
docs/           公共设计与使用文档
```

## 文档

- [目标与范围](docs/GOALS.md)
- [架构](docs/ARCHITECTURE.md)
- [公共契约](docs/CONTRACTS.md)
- [扩展功能](docs/EXTENDING.md)
- [安全边界](docs/SECURITY.md)
- [性能方法](docs/PERFORMANCE.md)
- [架构决策](docs/decisions/0001-independent-engine.md)

MIT License。
