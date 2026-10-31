# 来源、许可与致谢

## qq-bridge 参考来源

QQ Bridge Framework 是独立的 TypeScript 重建项目，设计参考了开源项目 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 的需求、接口、运维经验与故障处理。该参考关系不构成运行时依赖。

本仓库不是 qq-bridge 的官方版本、继任项目或 Git 分叉，未获得其作者背书；也不将参考项目的设计与运维成果声称为本仓库全部原创。改编或再分发 qq-bridge 材料时，适用以下上游版权声明及 MIT 许可。

2026-10-28 的群聊重设计参考了 qq-bridge 提交 `bdc6d09`：`dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 中的显式发送行为、`src/bridge.js` 中的未读唤醒合并和近期参与提示，以及 `src/local/dialogue-wake.js` 中的续聊处理。本框架通过自身的类型化收件箱、权限与输出服务实现这些思路，续聊窗口覆盖群成员，并将实际执行发言者与唤醒元数据分别保留。

## qq-bridge 的 MIT 许可原文

许可证原文保留英文，以保留上游授权及免责声明：

MIT License

Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


上游 `LICENSE` 在 MIT 正文后另有该项目的第三方及合规说明，描述的是其依赖集合，不作为本独立仓库的附加许可条款；使用或再分发 qq-bridge 本体时请查阅 [上游 LICENSE](https://github.com/Derpyu520/qq-bridge/blob/main/LICENSE)。

## 本仓库使用的组件与参考资料

### 表情语义检索

表情索引依据以下公开一手资料独立实现：

- [Capoo Vault 标注规范](https://github.com/CST-Cat/capoo-vault/blob/main/docs/spec.md)：将画面描述、情绪、动作、场景与标签分别组织，供多字段检索参考。
- [PerSRV: Personalized Sticker Retrieval with Vision-Language Model](https://arxiv.org/html/2410.21801v2)：将图像语义理解、图中文字与在线召回分别处理。框架参考语义与文字分离的思路，没有实现论文的个体偏好画像或训练模型。
- [Small Stickers, Big Meanings](https://arxiv.org/html/2506.01668v1)：讨论图像描述与真实表情查询之间的差异，以及语用理解的主观性和模型误判。框架允许开放用途、多义与空标签，不将少量情绪类别当作完整语义。
- [Selecting Stickers in Open-Domain Dialogue through Multitask Learning](https://aclanthology.org/2022.findings-acl.241/)：对话历史、情绪与表情含义需要共同理解，单一情绪匹配不能替代语境判断。
- [Elastic combined fields 文档](https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-combined-fields-query)与 [similarity 设置](https://www.elastic.co/docs/reference/elasticsearch/index-settings/similarity)：多字段加权、词频饱和与长度归一化的 BM25F/BM25 检索思路。框架使用自己的短库实现及小库平滑，不依赖 Elasticsearch。
- [Emotion and Intention Guided Multi-Modal Learning for Sticker Response Selection](https://ojs.aaai.org/index.php/AAAI/article/view/38509)：情绪与表达意图不一致会导致表情选择偏差。框架将表达意图准入与情绪、动作、文字信号分开处理，不复现该论文的训练模型。

本框架的字段权重、小库平滑、匹配阈值、小范围同义词、否定与不适用处理、重复排除、账号缓存与最终本地选择均为本项目实现；这些具体规则是工程取舍，不表述为论文结论。没有复制上述项目的源码、模型、标注数据或图片，不捆绑第三方表情素材。核对日期为 2026-10-31。

角色名称、别名、来源记录与可见外观分面同样由本框架独立建模。名称归一化用于本地检索，不代表取得第三方角色目录或识别服务。当前没有接入外部识图、反向图片搜索或网络角色数据库；索引中的“网页依据”只标记实际核对后保存的受限来源记录，不声称自动联网验证。

QQ 收藏接口依据 NapCat 的 [CustomFace 动作实现](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/action/extends/CustomFace.ts) 核对：读取明细、添加、删除与修改备注为不同动作，读取结果不提供账号总容量。实际支持范围由当前协议端决定。

### 页面虚拟化

列表与表情瀑布流使用 [TanStack Virtual](https://tanstack.com/virtual/latest/docs/api/virtualizer) 提供的动态尺寸测量、滚动区域与多列虚拟化能力。该依赖使用 MIT 许可；框架负责卡片内容、账号隔离、图片请求与有界缓存，不捆绑第三方图片素材。

### Markdown 图片排版

框架使用 [markdown-it](https://github.com/markdown-it/markdown-it) 解析 Markdown、[Takumi](https://github.com/kane50613/takumi) 完成本机排版和图像渲染、[highlight.js](https://github.com/highlightjs/highlight.js) 提供静态语法高亮、[MathJax](https://github.com/mathjax/MathJax) 处理数学公式、[sharp](https://github.com/lovell/sharp) 完成 PNG 分页。这些依赖保留各自发行包中的许可与声明；此集成不捆绑无头浏览器。

选型时参考过 [mdshot](https://github.com/pi0/mdshot) 的 Markdown 截图方案，实现未嵌入其源码。中文字体的再分发许可见下文。

### 视频观察

内置视频观察器调用独立安装的 [FFmpeg/FFprobe](https://github.com/FFmpeg/FFmpeg)，使用其探测元数据与抽帧接口。本仓库未嵌入或再分发 FFmpeg 源码及二进制。安装的 FFmpeg 发行版保留自身许可，具体取决于编译选项；请查阅其附带说明和 [上游许可](https://github.com/FFmpeg/FFmpeg/blob/master/LICENSE.md)。

### 随附的文泉驿微米黑字体

Markdown 图片渲染使用未经修改的文泉驿微米黑 0.2.0-beta 字体集合，依字体内嵌许可记录按 Apache License 2.0 再分发。数字化数据版权 © 2007 Google Corporation；版权 © 2008–2009 WenQuanYi Board of Trustees 和 Qianqian Fang。集合包含 WenQuanYi Micro Hei 及 WenQuanYi Micro Hei Mono。

字体、完整许可、原作者及上游声明位于 [assets/fonts](https://github.com/sophisticate9008/qq-bridge-framework/blob/v1.0/assets/fonts/README.md)。字体独立适用其自身许可，框架的 MIT 许可不替代它。

### OneBot 空间接口参考

共享空间适配器依据以下项目公开的线格式接口独立实现，没有嵌入它们的客户端或网页认证实现：

- [OneBot v11 标准 API](https://github.com/botuniverse/onebot-11/blob/master/api/public.md)：空间操作属于标准以外的扩展。
- NapCat 的 [发布接口](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/action/extends/SendQzoneMsg.ts) 与 [删除接口](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/action/extends/DeleteQzoneMsg.ts)。
- [NapCat v4.18.14 发布记录](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.14)：引入发布、图片上传及删除。
- SnowLuma 的 [发布参考](https://snowluma.github.io/zh/docs/api/qzone/send_qzone_msg)、[删除参考](https://snowluma.github.io/zh/docs/api/qzone/delete_qzone_msg) 与 [动作定义](https://github.com/SnowLuma/SnowLuma/blob/main/packages/onebot/src/actions/qzone.ts)。

接口核对日期为 2026-10-27；实际可用性仍由已安装网关版本及已启用扩展决定。

### 模型元数据参考

提供方元数据读取器参考 [DeepSeek 模型目录](https://api-docs.deepseek.com/api/list-models/) 及 [Chat Completions 推理参数](https://api-docs.deepseek.com/api/create-chat-completion/)，核对日期为 2026-10-28。文档涉及的 `off` 到 `none` 映射仅用于 DeepSeek 官方 OpenAI 兼容端点；其他提供方必须显式声明映射。

### 控制台组件样式

控制台基于 [shadcn/ui](https://github.com/shadcn-ui/ui) 的组件约定与 Base UI。`web/shadcn.css` 原样保留 npm 包 `shadcn@4.22.1` 的 `dist/tailwind.css`，SHA-256 为 `4c371f7a1ff5d219ae2f7ff28bd256b4346fd546fe46fbae22092e57db2f0fae`；随附 [MIT 许可](https://github.com/sophisticate9008/qq-bridge-framework/blob/v1.0/assets/licenses/shadcn-MIT.txt) 保留原作者授权。框架构建直接使用这份样式，不安装 shadcn CLI 及其传递依赖。

### DSH 接入

DSH 与官方 SDK 来自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。桥接插件当前核对的是 SDK `0.2.1-rc.2` 与 Cordis `4.0.5`，实际接入条件见 [DSH 文档](https://github.com/sophisticate9008/qq-bridge-framework/blob/v1.0/docs/DSH.md)。

本框架源码按 [LICENSE](https://github.com/sophisticate9008/qq-bridge-framework/blob/v1.0/LICENSE) 中的 MIT 许可分发。依赖及独立取得的协议网关、智能体运行时、模型和服务继续适用各自的许可与使用条款。本文不授予第三方软件的额外权利，也不表示与腾讯、QQ、DeepSeek、SnowLuma 或 qq-bridge 作者存在隶属或背书关系。
