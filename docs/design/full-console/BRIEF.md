# 完整功能设计稿 v3（独立离线稿）

阶段记录：本稿最初仅用于设计审核。用户现已批准按本稿分工实施正式前端；设计文件仍保持离线演示用途。实施不改变后端契约与运行数据。

依据 docs/design/ui-density-preview.html 的“连接与概览”视觉与布局，使用当前真实存在的功能。示例名称/数值明确为演示，不读取真实API、不带凭据、账号或私有素材。不编造插件、模型能力、统计指标或业务开关。

## 布局

- 默认12px正文、11px辅助、27px控件；浅灰蓝底、紫色动作、绿色就绪、浅黄提醒。
- 192px侧栏，任务全名，图标+序号。窄屏遮罩/Esc/点击导航关闭。
- 概览：三张实体摘要（日常聊天、聊天引擎、后台助手）；左活动右当前聊天；底部需要关注。
- 连接：QQ与DSH实体卡＋聊天运行卡，常态为摘要和动作，编辑通过窗口；二级设置保留真实能力。
- 人设：左目录右编辑，短字段同行，身份与风格双栏，唤醒窗口，删除确认。
- 聊天方案：方案目录＋主编辑；模型、人设、档位紧凑分组，指令长文；助手卡＋工作记录。保存与应用明确区分。
- 模型：左服务目录右连接卡和模型列表，长地址密钥空间充分；模型编辑、引用更换、删除确认。
- 功能：框架内置回复矩阵 / Agent扩展页签，不伪造安装插件。
- 访问与设置：主人与白名单卡、处理期限卡并排；管理服务卡、低频设置窗口。
- 会话：顶部紧凑筛选/维护状态，主表格；检查未回复、媒体、解绑、删除与恢复窗口；QQ互动、工作记录、执行日志次页签。
- 用量：指标带，趋势＋模型费用并排，按会话/逐轮/调用页签，价格与清空窗口；区分未知数据。

## 分工接口

各代理只写指定设计JS文件，不碰业务。经典JS脚本（不是模块），共享全局 `UI`，用 `UI.pages.id={title,sub,render:()=>html}` 注册页，用 `UI.dialogs.id={title,sub,render:()=>html,wide?:true,drawer?:true}` 注册窗口。

共享函数都在 `UI`：
- `esc(text)` HTML转义
- `badge(text,tone='good')` tone good/warn/bad/neutral/purple
- `button(text,attrs='',kind='')` 返回button；attrs为原始HTML属性，kind primary/ghost/link/danger
- `field(label,value='',options={})` options type,placeholder,tip,wide；返回横向标签input；`area(label,value='',rows=8)`长文
- `select(label,values,options={})` values字符串数组，options tip/wide
- `check(label,on=false)`；`tip(text)`
- `panel(title,body,actions='',cls='')`带标题body；`entity(icon,title,sub,status,meta,summary,actions,tone='good')`
- `table(heads,rows)` heads字符串数组，rows二维HTML字符串数组
- `tabs(group,labels,contents)` tabs keepMounted，生成本地页签
- `details(label,dialogId)`；`empty(text)`

CSS可用 .stack/.grid2/.grid3/.split(1.45fr/1fr)/.masterdetail(190px/1fr)/.formgrid(2cols)/.formgrid.three/.spanall/.row/.between/.push/.muted/.small/.strong/.strip/.strip.warn/.strip.bad/.flatgroup/.actions/.footer/.chips/.chip/.listrow/.masterlist/.active/.editorgrid/.metrics/.metric/.logline/.log-alt/.tablewrap/.mono/.danger-text/.summaryline

交互属性：`data-page="id"`跳转；`data-open="id"`弹窗；`data-close`关闭；`data-save="说明"`仅保存演示草稿并toast；`data-demo="说明"`toast；`data-confirm="对象" data-impact="真实影响"`删除确认通用；`data-filter="容器id"`输入筛选；`data-select-item`目录选择（仅高亮并发UI.onSelect事件，可自行补监听）；`data-action="action"`调用UI.actions[action](button)。各代理可向UI.actions添加具名函数来实现具体模拟。动态弹窗ID可依次打开；主框架支持dialog栈，readonly drawer。

静态演示需清楚的加载/失败/未知状态；不要把“检查”伪造成真实请求结果。全局toast固定说明仅演示，零网络。

页面ID: overview (主控), connections (连接代理), security (连接代理), persona/plans/providers (编辑代理), sessions/usage/features (记录代理)。主控写框架、概览、组合离线HTML与入口说明。
