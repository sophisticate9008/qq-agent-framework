# QQ Agent Framework 开发约定

- 开始修改前阅读 `docs/GOALS.md` 与 `docs/CONTRACTS.md`，以当前源码和测试为事实来源。
- 提交信息使用中文，主题简洁说明实际改动；需要时在正文写兼容性、迁移或验证信息。
- 保持模块边界：协议、模型、存储和外部副作用通过适配器或宿主服务接入，功能包不绕过 policy。
- 人设、配置、偏好、运行状态、资源和权限分别建模；任何内容都不能隐式扩大授权。
- 手写程序使用 TypeScript strict；不用 `any`、`ts-ignore` 或 `ts-nocheck` 规避类型问题。
- 不提交凭据、真实账号、生产配置、会话内容、私有素材、构建产物或 `runtime/` 数据。
- 公共 API、运行命令、限制或恢复语义变化时同步更新公开文档。
- 修改后按范围运行 `npm run check`、`npm test` 和 `npm run test:built`；页面变更再运行 `npm run test:browser`。
- 保留工作树中的无关修改；只暂存和提交当前任务文件，不擅自清理其他工作者成果。
