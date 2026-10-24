# TypeScript 功能开发与挂载点

本文以当前源码为准。所有相对程序导入使用 `.ts`，编译时改写成 JavaScript 扩展名。
公共类型见 `src/core/types.ts`；数据服务见 `src/core/context.ts`；内核见 `src/core/engine.ts`。

## 一个独立功能

```ts
import type { FeatureDefinition } from '../core/types.ts';

export const exampleFeature: FeatureDefinition = {
  id: 'example',
  version: '1.0.0',
  apiVersion: 1,
  capabilities: ['messaging.send'],
  subscriptions: ['trigger.fired'],
  setup(context) {
    context.on('trigger.fired', async (execution, event) => {
      if (event.data.kind !== 'example') return;
      const receipt = await execution.send([{ type: 'text', text: '示例' }]);
      if (receipt.status === 'confirmed') execution.state.set('lastEventId', event.id);
    });
  },
};
```

宿主还必须 `engine.install(exampleFeature)` 并通过 policy 授予精确会话范围的
`messaging.send` 和有限预算。功能 manifest 声明、偏好里的 allow 字段或模型的自称均不构成授权。
示例只说明 API，不代表应启用真实主动行为。现有示例见 `src/features/`。

## 新增事件与能力，不修改核心

宿主构建引擎时可以提供显式扩展。以下为只读本地校验示例，不含真实图片调用：

```ts
import type { EngineOptions } from './src/core/engine.ts';

const extensions: Pick<EngineOptions, 'eventValidators' | 'effectAdapters'> = {
  eventValidators: {
    'artifact.ready': data => typeof data.assetId === 'string',
  },
  effectAdapters: {
    'artifact.inspect': {
      execute({ input, scope, signal }) {
        if (signal.aborted) throw new Error('cancelled');
        return { acceptable: true, conversationId: scope.conversationId, inspected: input };
      },
    },
  },
};
```

将 `extensions` 展开到显式宿主的 `createEngine` 参数中。功能 manifest 声明对应事件和能力，
处理器用 `execution.invoke('artifact.inspect', { assetId: 'fixture' })`，宿主另外授权该能力。
扩展同样经过声明检查、作用域授权、预算、暂停/撤销、排队上限、取消和脱敏结果记录。
校验器必须同步且显式返回 true；返回 false 或抛异常都会拒绝事件。宿主扩展表在引擎创建时固定。
不可同名覆盖内置事件或内置模型/发送路径；普通事件、UI 或偏好没有注册接口。

适配器只接收冻结的 JSON 输入、必要 scope 与 AbortSignal，不自动取得人设、完整配置或密钥。
真实适配器所需凭据只由宿主显式提供，不得暴露给功能 SDK、审计或管理快照。
通用能力没有自动幂等或重试：若涉及付费生成，必须先补明确的任务/预算/恢复协议。

## SDK 与生命周期

- `context` 是分离的 persona、configuration、preferences 和 provenance 快照。
- `state` 仅访问本功能和本会话；值必须是 JSON 数据，读取后需按业务类型校验。
- `generate` 只走 model.respond；`send` 只走 messaging.send；`invoke` 只走已挂载自定义能力。
- `setup` 同步；`on` 注册已声明事件；`defer` 和返回函数登记同步清理，逆序执行。
- 卸载先置 stopping 并 abort，再等待已开始执行和副作用结束，之后清理。
- 处理器应 await 每个副作用；即便遗漏，内核仍排空已经发起的 Promise，不能把拒绝的动作记成完成。
- 处理器结束后保存的 execution 不可再操作状态或发起副作用。取消是协作式，不能抢占恶意/卡死 JS。
- 不要在自己的处理器里 await 自己的 uninstall/stop，否则会等待自身排空；生命周期由宿主控制。

## 开发、验收、发布

1. 把主人需求记录为工程目标与验收，先判断哪些是固定定义、配置、偏好、状态或权限。
2. 在独立功能模块中实现，只有通用基础件缺失时才改核心；接口变更记录版本与兼容范围。
3. 先做替身单测，再用真实内核组合；覆盖拒绝、超时/未知、重复、撤销与卸载。
4. 运行 `npm run check`、`npm test`、`npm run test:built`；涉及页面再跑浏览器冒烟。
5. 把外部验收单独标注：旧/新目标会话、真实注入、序列化、网关确认各有证据，不能互相替代。
6. 功能安装和生产部署不是一次聊天推断能决定的动作；先核对当前显式授权并保留恢复资料。

当前 UI 只能手动运行隔离演示，不是代码上传、审批、任务开发或生产部署入口。
