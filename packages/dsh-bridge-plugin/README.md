# DSH 桥接插件

为 QQ Agent Framework 提供 DSH 工具投影、来源证据、执行核对、会话兼容与独立工作通道。插件需要加载到你管理的独立 DSH 实例，不是 QQ 协议端插件。

当前版本为 **1.2.0**，匹配官方 DSH SDK **0.2.1-rc.2**、Cordis **4.0.5**，要求 Node.js **24.12.0 或更新版本**。框架继续识别历史桥接插件 `0.1.0`、`0.2.0`、`1.0.0` 的已有协议证据；请配套更新框架与插件，再按当前加载状态核对能力。

在框架仓库根目录构建安装包：

```sh
npm --prefix packages/dsh-bridge-plugin ci --ignore-scripts --no-audit --no-fund
npm --prefix packages/dsh-bridge-plugin run build
artifact_dir="$(mktemp -d)"
(cd packages/dsh-bridge-plugin && npm pack --ignore-scripts --pack-destination "$artifact_dir")
printf '安装包目录：%s\n' "$artifact_dir"
```

在独立 DSH Node 项目中安装生成的 `qq-agent-framework-dsh-bridge-plugin-1.2.0.tgz`，再通过该实例已有的 Cordis Loader 加载。npm 安装成功不表示插件已经运行。

兼容版本、完整加载示例、本机自动发现、鉴权、配置应用与未知结果核对见 [DSH 接入](https://github.com/sophisticate9008/qq-agent-framework/blob/main/docs/DSH.md)。插件不包含框架配置、凭据或会话数据。

源码许可见随包 `LICENSE`，来源与第三方许可见随包 `NOTICE.md`。
