/** What a tool does. Caller identity and grants belong to host policy, not this catalog. */
export const NATIVE_TOOL_CAPABILITY_CATALOG = Object.freeze([
  { capability: 'native.reply', tool: 'qaf_reply', name: '发送QQ消息',
    summary: '主动向当前QQ会话发送文字、媒体或排版内容，返回真实回执。',
    description: '需要在QQ中说话时调用此工具。content接受文字、结构化消息数组或qaf.output/1对象；沿用Markdown转图、长文转发和分气泡。发送成功会结束当前回合，因此先完成必要查询、读取或启动工作，再把要说的内容一次提交，不先发“稍等”再准备做事。按实际发送回执判断sent、rejected或unknown；receipts保留逐条结果，部分成功时不重复整份内容，unknown不重复发送。cached/reused表示复用了原回执，没有再次发送。本轮若被新消息替代，结束并等待新会话快照，不改写旧内容重发。普通最终文本不会自动发送到QQ。' },
  { capability: 'native.stickers.list', tool: 'qaf_sticker_list', name: '收藏表情',
    summary: '查找QQ收藏表情，登记为可读取和发送的会话图片。',
    description: '查看或搜索QQ账号收藏的表情包，返回当前会话可用的图片资源。可读取后调用qaf_reply发送；没有匹配项时返回空列表。' },
  { capability: 'native.conversation.query', tool: 'qaf_conversation_query', name: '查询QQ会话',
    summary: '查询当前会话信息、成员、历史消息与账号目录。',
    description: '查询当前QQ会话信息、成员、历史和指定消息，或查看好友及群目录；消息中的媒体登记为当前会话资源。' },
  { capability: 'native.conversation.poke', tool: 'qaf_poke', name: '戳一戳',
    summary: '在当前QQ会话中戳一戳指定成员。',
    description: '向当前私聊对端或当前群成员发送戳一戳，返回真实协议结果。' },
  { capability: 'native.conversation.recall', tool: 'qaf_recall', name: '撤回消息',
    summary: '撤回机器人在当前会话发送的消息。',
    description: '核对消息归属后，撤回机器人在当前QQ会话发送的消息。未知结果不会自动重试。' },
  { capability: 'native.media.inspect', tool: 'qaf_media_inspect', name: '查看媒体状态',
    summary: '查看媒体的登记和读取状态。',
    description: '检查当前QQ会话中已登记的媒体资源种类、期限和可读状态。不会读取内容。' },
  { capability: 'native.media.read', tool: 'qaf_media_read', name: '读取媒体',
    summary: '读取图片、GIF 动画抽样、文件、转发或获准的视频抽样画面。',
    description: '读取当前QQ会话已登记资源。图片需当前模型支持看图；GIF 动画按真实显示时序抽取最多六帧，返回单次时长、原帧数与循环次数（0 为无限），只代表抽样帧，不代表逐帧看过完整动画，不受视频观察开关影响。文本文件返回正文，语音需转录服务；视频仅在媒体观察设置允许时抽取最多六帧，带真实时间点，不分析音轨，不代表观看了完整视频；合并转发返回正文及嵌套媒体句柄。不能读取时明确返回原因。' },
  { capability: 'reminders.list', tool: 'qaf_reminder_list', name: '查看提醒',
    summary: '查看提醒计划和执行结果。',
    description: '查看当前QQ会话的提醒规则、下一次时间和最近结果。' },
  { capability: 'reminders.create', tool: 'qaf_reminder_create', name: '创建提醒',
    summary: '创建带时区和计划的提醒。',
    description: '创建本会话提醒，提供时区和准确计划。enabled表示是否启用计划；创建不等于已发送。' },
  { capability: 'reminders.update', tool: 'qaf_reminder_update', name: '修改提醒',
    summary: '修改提醒内容与计划。',
    description: '按当前revision修改本会话提醒。未知发送状态必须先核对，不自动重发。' },
  { capability: 'reminders.set-enabled', tool: 'qaf_reminder_set_enabled', name: '启停提醒',
    summary: '启用或停用提醒计划。',
    description: '按当前revision启用或停用本会话提醒。启用后按已保存的计划触发。' },
  { capability: 'reminders.cancel', tool: 'qaf_reminder_cancel', name: '取消提醒',
    summary: '取消提醒并保留执行记录。',
    description: '按当前revision取消本会话提醒，保留执行历史。' },
  { capability: 'memory.query', tool: 'qaf_memory_query', name: '查询记忆',
    summary: '检索会话与发言者相关的已确认记忆。',
    description: '检索当前会话、当前发言者及全局共享的已确认记忆。' },
  { capability: 'memory.propose', tool: 'qaf_memory_propose', name: '提出记忆建议',
    summary: '保存待确认的记忆或偏好。',
    description: '提议记录当前发言者的一条记忆或偏好，保存为待确认状态。将返回的确认命令告知用户；确认后才会参与上下文。' },
  { capability: 'native.work.start', tool: 'qaf_work_start', name: '启动独立工作',
    summary: '交给助手执行任务，并将结果送回会话。',
    description: '调用已配置的独立助手模型执行任务，这就是让助手（例如 GPT）帮忙的入口。用户明确要求交给助手时提交 task 和必要 context，不用自己代答，也不要把聊天侧缺少文件或命令工具理解为助手也不能执行。助手按其实际工具处理任务，真实结果自动送回当前QQ会话。只返回路径不等于已发送文件，实际附件需由助手产出并经宿主登记回传。以调用结果判断是否受理或失败，不沿用先前回复中未经核实的“无法调用”；未知结果不重复提交。' },
  { capability: 'native.work.status', tool: 'qaf_work_status', name: '查看工作状态',
    summary: '查看后台工作的进度和结果。',
    description: '读取当前会话内一项工作的实际状态、结果和投递回执。查询不会重放工作。' },
  { capability: 'native.work.followup', tool: 'qaf_work_followup', name: '追加或调整工作',
    summary: '补充任务内容或调整执行方向。',
    description: '给原工作追加内容。queue排队，steer调整正在进行的工作。工作关联保持在原会话和当前父会话代次。' },
  { capability: 'native.work.interrupt', tool: 'qaf_work_interrupt', name: '停止工作',
    summary: '请求停止工作并核验结果。',
    description: '请求停止原工作，保留实际停止状态和已产出的结果。未知结果不重复停止。' },
  { capability: 'native.work.reconcile', tool: 'qaf_work_reconcile', name: '核对工作结果',
    summary: '核对尚未确认的结果，保留执行证据。',
    description: '核对未知工作的执行证据；不重新执行工作，也不自动补发结果。' },
] as const);

export type NativeToolCapability = typeof NATIVE_TOOL_CAPABILITY_CATALOG[number]['capability'];

export function isNativeToolCapability(value: unknown): value is NativeToolCapability {
  return NATIVE_TOOL_CAPABILITY_CATALOG.some(item => item.capability === value);
}

export function nativeToolCapabilityDefinition(capability: NativeToolCapability) {
  const definition = NATIVE_TOOL_CAPABILITY_CATALOG.find(item => item.capability === capability);
  if (!definition) throw new TypeError('Unknown native tool capability');
  return definition;
}
