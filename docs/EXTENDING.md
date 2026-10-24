# 扩展功能

功能包通过 manifest 声明订阅和 capability，并在同步 `setup` 中注册处理器。

## 最小功能

```ts
import type { FeatureDefinition } from '../core/types.ts';

export const noticeFeature: FeatureDefinition = {
  id: 'notice',
  version: '1.0.0',
  apiVersion: 1,
  capabilities: ['messaging.send'],
  subscriptions: ['trigger.fired'],
  setup(context) {
    context.on('trigger.fired', async (execution, event) => {
      if (event.data.kind !== 'notice') return;
      await execution.send([{ type: 'text', text: '通知已触发' }]);
    });
  },
};
```

宿主还需要安装功能，并为该功能、目标会话和 `messaging.send` 创建有限授权。代码声明、配置字段和消息内容都不能替代授权。

## 自定义事件和 capability

宿主在创建引擎时注册扩展：

```ts
const engine = createEngine({
  transport,
  persona,
  eventValidators: {
    'asset.ready': data => typeof data.assetId === 'string',
  },
  effectAdapters: {
    'asset.inspect': {
      execute({ input, signal }) {
        if (signal.aborted) throw new Error('cancelled');
        return { accepted: true, input };
      },
    },
  },
});
```

功能必须在 manifest 中声明 `asset.ready` 和 `asset.inspect`，并通过 `execution.invoke` 调用。扩展与内置副作用一样经过输入冻结、队列上限、取消、授权和审计。

事件校验器必须同步返回 `true`。effect adapter 只得到冻结输入、最小 scope 和 `AbortSignal`；凭据、完整配置和存储句柄不会自动暴露给功能。

## 管理挂载点

宿主可把受限管理路由显式交给管理服务器：

```ts
const server = createAdminServer({
  token,
  snapshot,
  routes: createHostAdminRoutes(host),
});
```

自定义 `AdminRoute` 仅支持 `GET` / `POST` 的 `/api/...` 路径，不能覆盖内建入口。处理器接收解析后的 query、POST JSON body 和断连取消信号；认证、同源检查、请求/响应大小限制由服务器统一执行。`createHostAdminRoutes` 只读返回宿主计数及 sessions/tasks/outbox/replies 分页元数据，不提供权限变更或原始消息内容。

## Agent 消息筛选

不同 SDK 的 `assistant/message` 可能包含中间工作文本，并不天然等于 turn 完成或可公开回复。宿主可配置同步 `selectAgentMessage(event, binding)`，读取事件原始 `data` 后返回允许发送的消息块，或以 `null` 跳过出站和发送预算；未配置时保留普通 relay。具体筛选策略由 operator 按外部协议定义，不应把旧业务人格或工具隐藏规则硬编码进框架。

## 资源消息

功能发送图片、音频或文件时只提交已经登记的 `assetId`。功能不应传递任意绝对路径、读取资源内容或猜测 transport 支持情况。资源目录与 transport 负责解析、类型校验、大小限制和生命周期。

## 生命周期规则

- `setup` 和清理函数保持同步；异步准备工作放在宿主装配阶段完成。
- 处理器应 `await` 每个副作用并处理 `confirmed`、`rejected`、`unknown`。
- 收到 `signal.aborted` 后尽快停止本地工作，但不要假定外部动作已撤销。
- 处理器返回后不要保存并复用 `FeatureExecution`。
- 不要从自己的处理器等待自身卸载或引擎停止。
- 状态值必须是 JSON 数据，并在读取后按业务 schema 校验。

## 开发流程

1. 明确输入、输出、状态、资源、授权和失败终态。
2. 优先写独立功能；只有多个功能共同需要时才扩展宿主或核心。
3. 用替身测试功能，再用真实引擎验证授权拒绝、背压、取消、重复与卸载。
4. 外部适配器分别验证认证、序列化、限速、回执和恢复。
5. 运行：

```sh
npm run check
npm test
npm run test:built
```

管理演示页不是代码上传、授权审批或生产部署入口。
