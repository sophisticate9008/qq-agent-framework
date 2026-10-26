/* Offline review only: synthetic records, local drafts, no network or production state. */
(() => {
  const { esc, badge, button, field, check, tip, panel, table, tabs, empty } = UI;
  const state = {
    session: 0, execution: 0, work: 0, media: 0, interaction: 0, usageConversation: 0, turn: 0, call: 0, bucket: 0,
    fields: {}, prices: [1], nextPrice: 2, chartMetric: '费用', chartRange: '24 小时',
  };
  const open = (text, id, kind = '') => button(text, `data-open="${id}"`, kind);
  const demo = (text, message, kind = '') => button(text, `data-demo="${esc(message)}"`, kind);
  const save = (text, message, kind = 'primary') => button(text, `data-save="${esc(message)}"`, kind);
  const close = (text = '关闭') => button(text, 'data-close');
  const footer = (actions, note = '') => `<div class="footer">${note ? `<span class="muted push" style="margin-left:0;margin-right:auto">${note}</span>` : ''}${actions}</div>`;
  const info = rows => `<dl class="info">${rows.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>`;
  const note = text => `<div class="strip">${text}</div>`;
  const warning = text => `<div class="strip warn" role="status">${text}</div>`;
  const error = text => `<div class="strip bad" role="alert">${text}</div>`;
  const draftField = (key, label, value, options = {}) => `<div data-records-field="${key}"${options.wide ? ' class="spanall"' : ''}>${field(label, state.fields[key] ?? value, options)}</div>`;
  const draftSelect = (key, label, values) => {
    const current = state.fields[key] ?? values[0];
    return `<div class="setting"><label for="records-${key}">${esc(label)}</label><select id="records-${key}" data-records-input="${key}">${values.map(value => `<option${current === value ? ' selected' : ''}>${esc(value)}</option>`).join('')}</select></div>`;
  };
  const draftCheck = (key, label, initial) => `<label class="check"><input type="checkbox" data-records-input="${key}"${(state.fields[key] ?? initial) ? ' checked' : ''}>${esc(label)}</label>`;
  const confirmText = (key, phrase) => `<div class="setting"><label for="records-confirm-${key}">输入确认文字</label><input id="records-confirm-${key}" data-records-confirm="${key}" data-phrase="${esc(phrase)}" placeholder="${esc(phrase)}" autocomplete="off"></div>`;
  const confirmCheck = (key, text) => `<label class="check"><input type="checkbox" data-records-confirm="${key}">${esc(text)}</label>`;
  const guardedOpen = (text, key, target, kind = 'primary') => button(text, `disabled data-records-guard="${key}" data-open="${target}"`, kind);
  const reg = (id, title, sub, render, options = {}) => { UI.dialogs[id] = { title, sub, render, ...options }; };
  const sessionButton = (text, index, target, kind = 'link') => button(text, `data-action="records.session" data-record="${index}" data-target="${target}"`, kind);
  const selectedSession = () => sessions[state.session] ?? sessions[0];
  const sessions = Array.from({ length: 12 }, (_, index) => ({
    name: `${index % 3 === 2 ? '私聊' : '群聊'}演示 ${String.fromCharCode(65 + index)}`,
    key: `${index % 3 === 2 ? 'private' : 'group'}:${9000001 + index}`,
    identifier: String(9000001 + index), type: index % 3 === 2 ? '私聊' : '群聊',
    owner: index === 2, status: index === 1 ? '结果未确认' : index === 4 ? '处理中' : '空闲',
    pending: index === 1 ? 2 : index === 4 ? 1 : 0,
    id: `demo-session-${String.fromCharCode(97 + index)}`, generation: index === 0 ? 3 : 1,
    time: `14:${String(50 - index * 2).padStart(2, '0')}:18`,
  }));
  const executions = [
    ['14:50:18', '完成', '群聊演示 A', '完整结果已记录；已观察消息回执', 'good'],
    ['14:48:07', '未知', '群聊演示 B', '执行结果未确认，该会话后续已暂停', 'warn'],
    ['14:46:22', '处理中', '私聊演示 C', '外部请求已受理，尚在原处理期限内', 'purple'],
    ['14:44:05', '失败', '群聊演示 D', '已观察处理失败，未重放旧请求', 'bad'],
    ['14:42:33', '超时', '群聊演示 E', '停止请求已受理，停止结果仍待确认', 'warn'],
    ['14:40:51', '停止', '私聊演示 F', '已收到停止确认，原有副作用保留', 'neutral'],
    ['14:38:44', '完成', '群聊演示 G', '完整结果已记录', 'good'],
    ['14:36:09', '未受理', '群聊演示 H', '原请求未受理，没有提交第二次执行', 'neutral'],
  ];
  const work = [
    ['群聊演示 A', '执行完成', '回传已确认', '已整理示例材料并附上文件回执。', '14:21:03'],
    ['私聊演示 C', '处理中', '尚未请求回传', '尚无已确认的执行结果', '14:35:14'],
    ['群聊演示 B', '执行结果未知', '回传结果未知', '仍等待原执行证据，不自动重试', '14:40:12'],
  ];
  const interactions = [
    ['群聊演示 A', '提问', '等待主人回复', '这份材料需要按日期还是主题整理？', '15:20:00'],
    ['私聊演示 C', '工具确认', '已自动处理', '已按实际发言者身份处理外部工具确认。', '15:10:00'],
    ['群聊演示 B', '提问', '结果未知', '问题发送状态尚未确认。', '15:00:00'],
  ];
  const recordSelector = (kind, index, target, text = '详情') => button(text, `data-action="records.select" data-kind="${kind}" data-record="${index}" data-target="${target}"`, 'link');
  const sessionTable = () => `<div id="records-session-table">${table(['会话', '类型', '身份', '收件处理', '队列', '最近记录', '操作'], sessions.map((item, index) => [
    sessionButton(esc(item.name), index, 'records-session'), esc(item.type), item.owner ? badge('主人', 'purple') : '<span class="muted">普通会话</span>',
    badge(item.status, item.status === '结果未确认' ? 'warn' : item.status === '处理中' ? 'purple' : 'neutral'), String(item.pending), item.time,
    `<div class="row">${sessionButton('检查未回复', index, 'records-diagnostics')}${sessionButton('媒体', index, 'records-media')}${sessionButton('详情', index, 'records-session')}${index === 1 || index === 4 ? button('解除绑定', 'disabled title="当前有活动任务或未知执行，暂不可解除"', 'ghost') : sessionButton('解除绑定', index, 'records-unbind')}${index === 1 || index === 4 ? button('删除', 'disabled title="有未结束任务，不能删除"', 'ghost') : sessionButton('删除', index, 'records-delete', 'danger')}</div>`,
  ]))}</div>`;
  const executionRows = () => `<div class="stack" style="gap:0">${executions.map((item, index) => `<div data-search-row class="logline ${index % 2 ? 'log-alt' : ''}"><time>${item[0]}</time><span class="${item[4] === 'bad' ? 'danger-text' : item[4] === 'warn' ? 'warning-text' : item[4] === 'good' ? 'oktext' : 'muted'}">${item[1]}</span><span class="source">${item[2]}</span><span class="logtext">${item[3]}</span>${recordSelector('execution', index, 'records-execution', '⋯')}</div>`).join('')}</div>`;
  UI.pages.sessions = {
    title: '会话与执行记录', sub: '演示数据 · 会话筛选、原执行证据、QQ互动与独立工作',
    render: () => `<div class="stack">
      ${panel('会话', `<div class="row" style="margin-bottom:8px"><input aria-label="筛选会话" placeholder="筛选群聊、私聊或会话号" data-filter="records-session-table" style="max-width:260px"><span class="muted small">已加载 12 条演示绑定 · 仍有后续位置</span><span class="push">${badge('1 条结果待核对', 'warn')}</span></div>${sessionTable()}<div class="footer"><span class="muted">筛选仅作用于已加载记录</span><span class="push">${demo('继续加载会话', '演示分页：将继续观察后续会话，当前样例记录保持不变')}${demo('取消加载', '演示取消当前读取，已加载记录保留', 'ghost')}</span></div>`, `<div class="row"><span class="muted small">自动维护正常</span>${open('维护详情', 'records-maintenance', 'link')}${demo('刷新', '演示刷新会话列表；没有访问真实宿主')}${open('状态示例', 'records-load-states', 'ghost')}</div>`, 'flush')}
      ${panel('相关记录', tabs('records-session-records', ['执行日志', 'QQ互动', '独立工作'], [
        `<div class="flatgroup"><div class="row" style="margin-bottom:7px"><input aria-label="筛选执行日志" placeholder="会话、状态或已知标识" data-filter="records-execution-filter" style="max-width:240px"><span class="muted small">已读取 8 条示例</span><span class="push">${demo('重新读取日志', '演示读取原日志，未知状态保持未知')}${demo('取消读取', '演示取消读取；不会停止模型执行', 'ghost')}</span></div><div id="records-execution-filter">${executionRows()}</div><div class="row" style="margin-top:8px"><span class="muted small">已结束记录默认保留 7 天；未完成记录保留</span><span class="push">${demo('继续加载执行记录', '演示读取下一批执行记录，不修改已有执行')}</span></div></div>`,
        `<div class="flatgroup"><div class="row" style="margin-bottom:7px"><span class="muted small">提问在所属 QQ 会话回答，此处只读</span><span class="push">${demo('刷新互动记录', '演示刷新当前进程的互动观察记录')}</span></div>${table(['所属会话', '类型', '摘要', '状态', '操作'], interactions.map((item, index) => [item[0], item[1], `<span class="truncate" title="${esc(item[3])}">${item[3]}</span>`, badge(item[2], index === 2 ? 'warn' : 'neutral'), recordSelector('interaction', index, 'records-interaction')]))}</div>`,
        `<div class="flatgroup"><div class="row" style="margin-bottom:7px"><input aria-label="工作所属会话筛选" placeholder="全部，或 group:9000001" data-filter="records-work-table" style="max-width:235px">${demo('筛选', '演示按所属会话筛选工作记录')}${demo('刷新', '演示刷新原工作记录')}<span class="muted small push">工作操作在 QQ 内进行</span></div><div id="records-work-table">${table(['所属会话', '执行', '回传', '结果摘要', '创建', '操作'], work.map((item, index) => [item[0], badge(item[1], index === 2 ? 'warn' : index === 0 ? 'good' : 'purple'), `<span class="muted">${item[2]}</span>`, `<span class="truncate">${item[3]}</span>`, item[4], recordSelector('work', index, 'records-work')]))}</div><div class="row" style="margin-top:8px">${demo('返回首批工作', '演示返回首批记录')}${demo('下一批工作', '演示工作分页读取')}</div></div>`,
      ]), '', 'flush')}
    </div>`,
  };

  reg('records-session', '会话详情', '只读 · 所有标识均为演示值', () => {
    const item = selectedSession();
    return `<div class="stack"><div class="row"><strong>${item.name}</strong>${badge(item.status, item.status === '结果未确认' ? 'warn' : 'neutral')}</div>${info([['会话号', item.key], ['真实主人会话', item.owner ? '是（示例）' : '否'], ['收件队列', `${item.pending} 条待处理`], ['模型会话', item.id], ['绑定代次', `第 ${item.generation} 代`], ['绑定版本', 'demo-binding-revision'], ['观察时间', `演示日期 ${item.time}`]])}${note('这里只展示已观察到的绑定；绑定存在不证明每条消息都已回复。')}<div class="actions">${demo('复制会话标识', '正式界面复制该模型会话标识；本稿只演示入口')}${open('检查未回复', 'records-diagnostics')}${open('图片与附件', 'records-media')}${button('查看用量', 'data-page="usage"')}</div></div>`;
  }, { drawer: true });
  reg('records-diagnostics', '检查未回复', '演示检查记录 · 不会向真实会话发起检查', () => `<div class="stack"><div class="row"><strong>${selectedSession().name}</strong>${badge('需要处理', 'warn')}<span class="muted small">观察于演示时间 14:48:07</span><span class="push">${demo('重新检查', '演示重新检查；不会把未知状态变成成功')}</span></div>${warning('示例阻碍：上一轮模型执行结果尚未确认，当前会话后续任务暂停。')}<div class="listrow"><div class="grow"><strong>当前会话仍在白名单内</strong><p class="desc">授权检查与外部执行是否结束分别核对</p></div>${badge('已核对', 'good')}</div><div class="listrow"><div class="grow"><strong>外部执行仍待核实</strong><p class="desc">请先观察原执行证据，不能重发旧请求或清空上下文</p></div>${open('处理未完成任务', 'records-recovery')}</div><div class="row">${button('查看连接状态', 'data-page="connections"')}${open('图片与附件', 'records-media')}${open('检查技术详情', 'records-diagnostics-technical', 'ghost')}</div>${note('历史覆盖为部分；以上检查不能确认历史上每条消息都已回复。')}</div>`, { wide: true });
  reg('records-diagnostics-technical', '检查技术详情', '只读演示 · 原因码与容量信息', () => info([['所属会话', selectedSession().key], ['检查状态', 'blocked（示例）'], ['原因码', 'execution_unknown（演示）'], ['覆盖', '历史部分、执行证据已观察'], ['唤醒设置', '引用唤醒开启；续聊 90 秒'], ['模型容量', '示例元数据：窗口 128000，已用 18000'], ['下一步', '核对原执行，不重新提交']]), { drawer: true });
  reg('records-media', '图片、附件与引用', '只读 · 登记、下载和模型读取分别记录', () => `<div class="stack"><div class="row"><strong>${selectedSession().name}</strong><span class="push">${demo('刷新媒体记录', '演示观察媒体回执，没有下载真实文件')}</span></div>${warning('示例仅覆盖已返回的最近记录；媒体历史可能不完整。')}${table(['类型', '最近状态', '观察时间', '操作'], [
    ['图片', '已下载，尚未确认模型读取', '14:42:18', recordSelector('media', 0, 'records-media-item')],
    ['文件', '已读取内容', '14:40:05', recordSelector('media', 1, 'records-media-item')],
    ['语音', '转写服务尚未接通', '14:38:11', recordSelector('media', 2, 'records-media-item')],
    ['引用消息', '最近一次读取失败', '14:37:09', open('详情', 'records-quote', 'link')],
  ])}</div>`, { wide: true });
  reg('records-media-item', '媒体读取详情', '只读演示 · 不提供强制下载或文件路径输入', () => {
    const item = [['图片', '已下载；模型是否接收图像尚未确认', '下载已确认', 'demo-image-a'], ['文件', '已有内容读取记录', '内容读取已确认', 'demo-file-a'], ['语音', '语音转写尚未接通', '读取不可用', 'demo-audio-a']][state.media];
    return `<div class="stack">${note(item[1])}${info([['类型', item[0]], ['资源标识', item[3]], ['来源消息', 'demo-message-a'], ['收到时间', '演示日期 14:38:11'], ['临时有效至', '演示日期 15:38:11'], ['读取服务', state.media === 2 ? '尚未接通' : '可用'], ['最近读取', item[2]], ['技术原因', state.media === 2 ? 'native_media_transcriber_not_connected（示例）' : '无']])}</div>`;
  }, { drawer: true });
  reg('records-quote', '引用消息详情', '只读演示', () => `<div class="stack">${error('引用读取失败：来源范围未通过核对。')}${info([['消息标识', 'demo-quote-a'], ['观察时间', '演示日期 14:37:09'], ['原因', 'quoted_context_scope_mismatch（示例）']])}${note('没有将越界引用正文作为已读取内容提供给模型。')}</div>`, { drawer: true });
  reg('records-unbind', '解除这条会话的绑定？', '演示确认 · 实际操作只作用于所选绑定', () => `<div class="stack"><strong>${selectedSession().name}</strong>${note('下次聊天开始新对话；原模型历史、用量和操作记录保留。')}<p class="small muted">提交前核对所选模型会话、绑定版本与代次；有未完成任务时不能解除。</p>${footer(close('取消') + open('确认解除绑定', 'records-unbind-result', 'danger'))}</div>`);
  reg('records-unbind-result', '解除绑定结果示例', '离线稿不会解除任何绑定', () => `<div class="stack">${warning('演示结果：提交后连接中断，结果尚未确认。解除绑定操作已锁定，不能重复提交。')}<div class="row">${demo('关闭并刷新核对', '演示重新读取绑定；仍须以实际返回证据核对')}${open('查看版本冲突示例', 'records-load-states', 'ghost')}</div></div>`);
  reg('records-delete', '删除所选模型会话？', '演示确认 · 本机受控部署才支持此操作', () => `<div class="stack"><strong>${selectedSession().name}</strong>${warning('将删除所选模型会话历史、框架短期上下文和当前绑定。用量、QQ消息、其他会话与执行证据保留。')}<p>删除期间暂停聊天与受管模型服务，取得真实存储位置并核实文件锁，随后重启并恢复原运行意图。</p>${confirmText('delete', '删除会话')}${footer(close('取消') + guardedOpen('确认删除', 'delete', 'records-delete-progress', 'primary danger'))}</div>`);
  reg('records-delete-progress', '删除操作进度示例', '仅展示受理后的维护阶段；没有真实删除', () => `<div class="stack">${badge('演示：正在核对删除结果', 'purple')}${info([['暂停聊天', '已观察示例停止证据'], ['删除与重启', '示例已受理，尚未确认最终结果'], ['核验与恢复', '等待同一操作结果'], ['操作编号', 'demo-delete-operation-a']])}${note('关闭窗口不会提交第二次删除，也不取消已受理的维护。')}<div class="actions">${open('操作详情', 'records-delete-operation', 'ghost')}${open('查看未知结果状态', 'records-delete-unknown')}${demo('关闭并刷新', '演示关闭并观察原操作；没有真实维护')}</div></div>`);
  reg('records-delete-unknown', '删除结果待核对', '演示状态 · 保留原操作标识', () => `<div class="stack">${warning('尚未确认模型历史是否已删除，不再次提交删除。')}<div class="actions">${demo('核对并恢复', '演示核对同一删除操作；只在证实历史已删除后继续原绑定解除与恢复')}${open('操作详情', 'records-delete-operation', 'ghost')}${close('关闭并刷新')}</div></div>`);
  reg('records-delete-operation', '删除操作详情', '只读演示 · 关闭不丢操作编号', () => info([['操作编号', 'demo-delete-operation-a'], ['目标会话', selectedSession().key], ['处理阶段', 'verify（核对删除结果）'], ['结果', 'unknown（示例）'], ['恢复语义', '只核对原操作，不重复删除或重复重启']]), { drawer: true });
  reg('records-maintenance', '自动记录维护', '只读 · 后台自动执行，无手动清理按钮', () => `<div class="stack">${badge('示例：正常', 'good')}${info([['最近维护', '演示日期 14:45:00'], ['本次进程已回收', '248 条（演示）'], ['数据库记录', '4200 / 100000（演示）'], ['保留规则', '普通已结束记录默认 7 天'], ['提前回收', '单类超过 10000 条或容量达到 70%'], ['需要处理', '容量达到 85% 或维护失败']])}${note('未完成、未知记录及关联证据保留；用量账本、聊天历史和业务去重记录独立保存。')}${open('读取失败与待处理示例', 'records-load-states', 'ghost')}</div>`, { drawer: true });
  reg('records-interaction', 'QQ互动详情', '只读演示 · 答复模型问题请回到所属QQ会话', () => {
    const item = interactions[state.interaction];
    return `<div class="stack"><div class="row"><strong>${item[0]} · ${item[1]}</strong>${badge(item[2], state.interaction === 2 ? 'warn' : 'neutral')}</div><p>${item[3]}</p>${state.interaction === 0 ? panel('模型问题', '<p>这份材料需要按日期还是主题整理？</p><p class="muted small">选项：按日期 / 按主题</p>') : ''}${info([['有效期至', `演示日期 ${item[4]}`], ['互动标识', 'demo-interaction-a'], ['工具', state.interaction === 1 ? 'demo-external-tool（示例记录）' : '无']])}${note('网页没有答复或批准入口；外部工具确认按实际发言者身份自动处理。')}</div>`;
  }, { drawer: true });
  reg('records-execution', '处理记录详情', '只读演示 · 已受理、执行结束和消息送达分别核对', () => {
    const item = executions[state.execution];
    return `<div class="stack"><div class="row"><strong>${item[2]}</strong>${badge(item[1], item[4])}</div><p>${item[3]}</p>${info([['原入站期限', '120 秒（演示）'], ['协作停止', state.execution === 1 || state.execution === 4 ? '仅已受理，停止未确认' : '未发起'], ['超时提醒', '默认关闭'], ['进度事件', '3 次；不是重试次数'], ['会话后续', state.execution === 1 || state.execution === 4 ? '隔离暂停；其他会话继续' : '按当前执行证据处理'], ['迟到结果', '只记账，未作为下一条请求回复']])}<div class="actions">${open('技术标识', 'records-execution-technical', 'ghost')}${state.execution === 1 || state.execution === 4 ? open('处理未完成任务', 'records-recovery') : ''}</div></div>`;
  }, { drawer: true });
  reg('records-execution-technical', '执行技术详情', '只读演示', () => info([['执行标识', `demo-execution-${state.execution + 1}`], ['父会话', 'demo-session-a'], ['代次', '3'], ['外部状态', state.execution === 1 ? 'unknown' : '示例观察值'], ['进度关联', 'demo-event-a'], ['原始原因', state.execution === 1 ? 'execution_unknown（演示）' : '无']]), { drawer: true });
  reg('records-recovery', '执行结果与上下文恢复', '演示恢复流程 · 不重放旧请求或迟到输出', () => `<div class="stack">${warning('结果尚未确认，当前会话保持隔离。先读取原执行与恢复证据。')}<div class="row">${demo('读取原执行与恢复结果', '演示读取原执行与恢复计划，没有真实SDK请求')}${open('证据详情', 'records-recovery-evidence', 'ghost')}</div>${confirmCheck('recover', '我已核对所选执行，明确进行下面的管理操作')}<div class="row">${guardedOpen('核对执行结果', 'recover', 'records-recovery-evidence')}${guardedOpen('预览保留上下文恢复', 'recover', 'records-recovery-preview')}</div>${note('核对只观察持久证据；新会话恢复保留原上下文记录。证据不足继续隔离，不能把重置会话当作停止外部任务。')}${open('查看原恢复请求未知示例', 'records-recovery-unknown', 'ghost')}</div>`, { wide: true });
  reg('records-recovery-evidence', '原执行证据示例', '只读 · 未执行真实核对', () => `<div class="stack">${warning('示例证据不足，隔离保持。')}${info([['观察对象', '原 executionId 与原恢复计划'], ['SDK终态', '尚未取得'], ['停止确认', '尚未取得'], ['是否可释放', '否'], ['重启要求', '创建恢复地址后，需在连接页明确重启聊天']])}</div>`, { drawer: true });
  reg('records-recovery-preview', '保留上下文恢复预览', '演示预览 · 尚未创建新会话地址', () => `<div class="stack">${info([['原会话', 'demo-session-a'], ['原代次', '3'], ['恢复计划', 'demo-recovery-plan-a'], ['计划版本', 'demo-recovery-revision-a'], ['示例检查', '原上下文检查点可读取，恢复目标仍未创建']])}${warning('创建结果未知时沿原计划版本核对，不创建另一份。恢复不会重发原请求或迟到输出。')}${confirmCheck('recover-create', '确认按当前预览创建新的会话地址')}${footer(close('返回') + guardedOpen('确认创建新的会话地址', 'recover-create', 'records-recovery-unknown'))}</div>`, { wide: true });
  reg('records-recovery-unknown', '原恢复请求待核对', '演示未知状态 · 仅观察原版本', () => `<div class="stack">${warning('新会话创建结果未知；不能再次创建。')}${info([['恢复计划', 'demo-recovery-plan-a'], ['原版本', 'demo-recovery-revision-a'], ['新会话地址', '尚未核验']])}${confirmCheck('recover-original', '核对原恢复请求，保持原计划与版本不变')}<div class="row">${button('核对原恢复请求', 'disabled data-records-guard="recover-original" data-demo="演示只观察原恢复计划；证据不足保持未知"')}${demo('读取原结果', '演示观察原恢复结果，不新建第二份会话')}${button('前往连接页', 'data-page="connections"')}</div></div>`);
  reg('records-work', '独立工作详情', '只读演示 · 发起、追加、停止与恢复均在QQ中进行', () => {
    const item = work[state.work];
    return `<div class="stack"><div class="row"><strong>${item[0]}</strong>${badge(item[1], state.work === 2 ? 'warn' : state.work === 0 ? 'good' : 'purple')}</div><p class="muted small">${item[2]} · 创建于演示时间 ${item[4]}</p>${state.work === 2 ? warning('执行或回传结果未知，网页不重新执行。') : ''}${panel('已记录结果', state.work === 0 ? '<p>已整理示例材料。示例文件：材料目录.txt。</p><p class="muted small">文本与文件回执分别确认。</p>' : empty('尚无已确认执行结果'))}${panel('迟到结果', empty('当前示例没有迟到结果；如有记录，在此完整展示并注明不自动替代当前结果。'))}${info([['工作标识', `demo-work-${state.work + 1}`], ['父会话 / 子任务', 'demo-parent-a / demo-child-a'], ['期限', '演示日期 15:20:00'], ['结果 / 回传标识', 'demo-result-a / demo-delivery-a'], ['QQ消息 / 文件回执', state.work === 0 ? '示例回执已取得' : '尚未取得'], ['执行 / 回传错误', state.work === 2 ? '结果待核对（演示）' : '无']])}${demo('刷新工作详情', '演示观察同一工作记录，不发起新工作')}</div>`;
  }, { drawer: true });

  const conversations = [
    ['群聊演示 A', '36 / 54', '48.2K', '9.1K', '78.0%', 'USD 0.18', '56.3%', '演示聊天模型 A', '14:50:18'],
    ['私聊演示 C', '18 / 29', '23.1K', '6.3K', '69.2%', 'CNY 0.80', '分币种', '演示工作模型 B', '14:46:22'],
    ['群聊演示 B', '4 / 7', '未知', '未知', '未知', '未知', '未知', '演示聊天模型 A', '14:48:07'],
    ['群聊演示 D', '11 / 16', '6.2K', '1.1K', '66.8%', 'USD 0.14', '43.7%', '演示聊天模型 A', '14:44:05'],
  ];
  const conversationUsageTable = () => table(['会话', '轮 / 步', '输入', '输出', '缓存命中', '费用', '同币种占比', '模型', '最近', '操作'], conversations.map((item, index) => [
    button(item[0], `data-action="records.usageConversation" data-record="${index}"`, 'link'), ...item.slice(1), recordSelector('usageConversation', index, 'records-usage-conversation'),
  ]));
  const turnTable = () => `<div class="row" style="margin-bottom:8px"><strong>${conversations[state.usageConversation][0]}</strong><span class="muted small">最多 200 轮 · 已加载 4 轮示例</span><span class="push">${demo('加载明细', '演示读取当前所选会话的逐轮明细')}</span></div>${table(['起止时间', '轮', '步骤 / 响应事件', '输入', '缓存读取', '输出', '费用', '模型', '操作'], Array.from({ length: 4 }, (_, index) => [
    `14:${50 - index * 2}:01 — 14:${50 - index * 2}:18`, `#${36 - index}`, `${index + 1} / ${index + 2}`, index === 2 ? '未知' : '1.2K', index === 2 ? '未知' : '900', index === 2 ? '未知' : '240', index === 2 ? '未知' : 'USD 0.006', '演示聊天模型 A', recordSelector('turn', index, 'records-usage-turn'),
  ]))}`;
  const callsTable = () => table(['时间', '会话', '轮 / 步 / 重试', 'Token', '费用', '来源', '覆盖', '操作'], Array.from({ length: 6 }, (_, index) => [
    `14:${50 - index}:18`, index % 2 ? '私聊演示 C' : '群聊演示 A', `#36 / ${index + 1} / 未知`, index === 3 ? '未知' : '1.4K', index === 3 ? '未知' : index % 2 ? 'CNY 0.08' : 'USD 0.006', index % 2 ? '入账单价估算' : '提供方上报', badge(index === 3 ? '部分' : '完整', index === 3 ? 'warn' : 'neutral'), recordSelector('call', index, 'records-usage-call'),
  ]));
  // Synthetic tier tags demonstrate recorded prices, not a current provider timetable.
  const chartTiers = { peak: 'DeepSeek 高峰', off: 'DeepSeek 低谷', mixed: '峰谷混合' };
  const chartBuckets = () => {
    const count = { '24 小时': 24, '3 天': 36, '7 天': 28, '30 天': 30 }[state.chartRange];
    const hours = { '24 小时': 1, '3 天': 2, '7 天': 6, '30 天': 24 }[state.chartRange];
    const weights = Array.from({ length: count }, (_, i) => i === 13 ? null : 10 + (i * 17 + i * i * 3) % 74);
    const sum = weights.reduce((total, value) => total + (value ?? 0), 0);
    const stamp = index => {
      const hour = index * hours;
      return `${String(1 + Math.floor(hour / 24)).padStart(2, '0')}日 ${String(hour % 24).padStart(2, '0')}:00`;
    };
    return weights.map((weight, i) => ({
      time: `${stamp(i)} — ${stamp(i + 1)}`,
      label: hours < 24 ? stamp(i) : `${i + 1}日`,
      tier: ['peak', 'peak', 'off', 'off', 'mixed', 'peak'][Math.floor(i / 4) % 6],
      cost: weight === null ? null : weight / sum * .8,
      tokens: weight === null ? null : Math.round(weight / sum * 82000),
    }));
  };
  const chartValue = bucket => state.chartMetric === 'Token' ? bucket.tokens : bucket.cost;
  const chartNumber = value => value === null ? '未知' : state.chartMetric === 'Token' ? value.toLocaleString('zh-CN') : `¥${value.toFixed(3)}`;
  const usageChart = () => {
    const buckets = chartBuckets();
    const max = Math.max(...buckets.map(bucket => chartValue(bucket) ?? 0));
    const ceiling = state.chartMetric === 'Token' ? Math.ceil(max / 1000) * 1000 : Math.ceil(max / .02) * .02;
    const ticks = [1, .75, .5, .25, 0];
    const labelIndices = [0, Math.round((buckets.length - 1) / 3), Math.round((buckets.length - 1) * 2 / 3), buckets.length - 1];
    return `<div class="usage-timechart" aria-label="DeepSeek ${esc(state.chartMetric)}走势，演示数据">
      <div class="usage-axis">${ticks.map(tick => `<span>${state.chartMetric === 'Token' ? `${(ceiling * tick / 1000).toFixed(1)}K` : `¥${(ceiling * tick).toFixed(2)}`}</span>`).join('')}</div>
      <div class="usage-plot"><div class="usage-grid" aria-hidden="true">${ticks.map(() => '<i></i>').join('')}</div>
        <div class="usage-columns">${buckets.map((bucket, index) => {
          const value = chartValue(bucket);
          const description = `${bucket.time} · ${chartTiers[bucket.tier]} · ${chartNumber(value)}${state.chartMetric === 'Token' && value !== null ? ' Token' : ''}`;
          return `<button type="button" class="usage-column" data-tier="${bucket.tier}" data-action="records.select" data-kind="bucket" data-record="${index}" data-target="records-usage-bucket" data-tip="${esc(description)}" aria-label="${esc(description)}"><span style="height:${value === null ? 0 : value / ceiling * 100}%"></span>${value === null ? '<i aria-hidden="true">·</i>' : ''}</button>`;
        }).join('')}</div>
      </div><div class="usage-timeaxis">${labelIndices.map(index => `<span>${buckets[index].label}</span>`).join('')}</div>
      <div class="usage-chart-footer"><div class="usage-legend">${Object.entries(chartTiers).map(([tier, label]) => `<span data-tier="${tier}"><i></i>${label}</span>`).join('')}</div><span class="muted small">悬浮查看 · 点击详情</span></div>
    </div>`;
  };
  UI.pages.usage = {
    title: '用量与费用', sub: '全为演示记录 · 已知金额按币种分开，未知值保持未知',
    render: () => `<div class="stack"><div class="row"><span class="muted small">生成于演示时间 14:50:30</span>${check('详细数值', false)}<div class="push row"><span class="muted small">自动刷新</span><select aria-label="自动刷新频率" style="width:88px"><option>10 秒</option><option>关闭</option><option>3 秒</option><option>30 秒</option></select>${demo('刷新', '演示刷新账本、走势与调用记录')}${open('参考单价', 'records-prices')}${open('自定义单价', 'records-pricing')}${open('清空账本', 'records-clear', 'danger')}</div></div>
      <div class="metrics"><div class="metric"><span class="muted small">总 Token</span><strong>94.0K</strong><small>输入 77.5K · 输出 16.5K</small></div><div class="metric"><span class="muted small">已记录费用</span><strong style="font-size:18px">USD 0.32 · CNY 0.80</strong><small>已知金额小计 · 2 条费用未知</small></div><div class="metric"><span class="muted small">会话 / 轮次</span><strong>4 / 69</strong><small>106 个处理步骤</small></div><div class="metric"><span class="muted small">缓存命中率</span><strong>73.4%</strong><small>已知输入口径 · 2 条计数不完整</small></div></div>
      <div class="split">${panel('用量走势', `<div class="row"><strong id="records-chart-total">${state.chartMetric === 'Token' ? '窗口内已知 Token 82.0K' : 'DeepSeek · CNY 0.80'}</strong><span class="push muted small">演示数据</span></div><div id="records-usage-chart">${usageChart()}</div><div class="row" style="margin-top:6px"><span class="muted small">空缺表示未知；峰谷按记录中的计价类型区分 ${tip('峰谷颜色为演示标记，不代表当前 DeepSeek 优惠时刻表。')}</span><span class="push">${open('统计口径', 'records-usage-summary', 'link')}</span></div>`, `<div class="row"><select aria-label="走势范围" data-records-chart-range style="width:86px">${['24 小时', '3 天', '7 天', '30 天'].map(value => `<option${state.chartRange === value ? ' selected' : ''}>${value}</option>`).join('')}</select><select aria-label="走势指标" data-records-chart-metric style="width:78px">${['费用', 'Token'].map(value => `<option${state.chartMetric === value ? ' selected' : ''}>${value}</option>`).join('')}</select></div>`)}
      ${panel('模型费用 · 当前调用采样', table(['模型', '已知费用', '覆盖'], [['演示聊天模型 A', 'USD 0.018', badge('提供方上报', 'neutral')], ['演示工作模型 B', 'CNY 0.24', badge('单价估算', 'neutral')], ['演示聊天模型 A', '未知', badge('计数不完整', 'warn')]]) + '<div class="strip" style="margin-top:8px">按本次返回的调用记录采样汇总，不能当作全账本模型费用；币种不合并。</div>', open('费用记录详情', 'records-usage-call', 'link'))}</div>
      ${panel('账本明细', tabs('records-usage', ['按会话', '逐轮明细', '调用记录'], [`<div class="flatgroup">${conversationUsageTable()}</div>`, `<div class="flatgroup">${turnTable()}</div>`, `<div class="flatgroup"><p class="muted small" style="margin-bottom:8px">最近 40 条计费采样；当前显示 6 条演示数据</p>${callsTable()}</div>`]), `<div class="row">${open('统计说明', 'records-usage-summary', 'link')}${open('读取与未知状态', 'records-load-states', 'ghost')}</div>`, 'flush')}
    </div>`,
  };
  reg('records-usage-summary', '统计口径与覆盖', '只读演示 · 费用不替代模型服务账单', () => `<div class="stack">${warning('示例含 2 条计数不完整和 2 条费用未知；不是零用量。')}${info([['记录范围', '当前账号账本；会话列表最多 200 条'], ['Token', '输入包含未命中、缓存读取与写入；推理单列，不重复计入总量'], ['已知金额', 'USD 0.32、CNY 0.80 分别汇总'], ['计价来源', '提供方报告或各条记录入账时的有效单价'], ['历史', '当前单价变化不回算旧轮次'], ['时间', '原生记录为框架观察时刻；响应事件数不是重试次数'], ['采样覆盖', '逐轮保留窗口可能短于累计历史'], ['完整性', '截断、未知或未返回指标分别标明']])}${note('平均每轮、平均每步、未逐轮归属金额与完整Token缺失分项在正式记录提供时显示；缺少容量、压缩等宿主指标时保持不可用。')}</div>`, { wide: true });
  reg('records-usage-bucket', '时段明细', '只读演示', () => {
    const bucket = chartBuckets()[state.bucket] ?? chartBuckets()[0];
    return info([['时间', bucket.time], ['模型', 'DeepSeek'], ['计价类型', chartTiers[bucket.tier]], ['已知费用', bucket.cost === null ? '未知' : `CNY ${bucket.cost.toFixed(3)}`], ['Token', bucket.tokens === null ? '未知' : bucket.tokens.toLocaleString('zh-CN')], ['关联会话', '群聊演示 A、私聊演示 C']]);
  }, { drawer: true });
  reg('records-usage-conversation', '会话用量详情', '只读演示 · 合并该QQ会话关联的技术会话', () => `<div class="stack"><strong>${conversations[state.usageConversation][0]}</strong>${info([['轮 / 步', conversations[state.usageConversation][1]], ['输入 / 输出', `${conversations[state.usageConversation][2]} / ${conversations[state.usageConversation][3]}`], ['费用', conversations[state.usageConversation][5]], ['缓存命中率', conversations[state.usageConversation][4]], ['技术会话数', '2（演示）'], ['已归属 / 未逐轮归属', state.usageConversation === 2 ? '未知；不能用零补齐' : state.usageConversation === 1 ? 'CNY 0.76 / CNY 0.04（演示）' : state.usageConversation === 0 ? 'USD 0.17 / USD 0.01（演示）' : 'USD 0.13 / USD 0.01（演示）'], ['模型', conversations[state.usageConversation][7]], ['最早 / 最近记录', `演示日期 10:01:00 / ${conversations[state.usageConversation][8]}`]])}${button('查看逐轮明细', `data-action="records.usageConversation" data-record="${state.usageConversation}"`)}</div>`, { drawer: true });
  reg('records-usage-turn', '逐轮明细', '只读演示', () => `<div class="stack">${state.turn === 2 ? warning('本轮计数和费用不完整，保留未知。') : ''}${info([['所属会话', conversations[state.usageConversation][0]], ['轮标识', `demo-turn-${36 - state.turn}`], ['起止时间', '演示日期 14:50:01 — 14:50:18'], ['步骤 / 响应事件', '1 / 2'], ['缓存未命中 / 读取 / 写入', state.turn === 2 ? '未知 / 未知 / 未知' : '300 / 900 / 0'], ['输出 / 推理', state.turn === 2 ? '未知 / 未知' : '240 / 0'], ['费用', state.turn === 2 ? '未知' : 'USD 0.006（演示）'], ['Provider / 模型', '演示服务 A / 演示聊天模型 A'], ['技术会话 / 代次', 'demo-session-a / 3'], ['价档', '固定单价；无峰谷档']])}</div>`, { drawer: true });
  reg('records-usage-call', '调用计费采样', '只读演示 · 最近记录不等于累计总账', () => `<div class="stack">${info([['记录标识', `demo-call-${state.call + 1}`], ['所属会话', state.call % 2 ? '私聊演示 C' : '群聊演示 A'], ['轮 / 步 / 重试', `demo-turn-36 / ${state.call + 1} / 未知`], ['必要计数', state.call === 3 ? '缺失，保持未知' : '已提供（演示）'], ['费用 / 币种', state.call === 3 ? '未知' : state.call % 2 ? '0.08 / CNY' : '0.006 / USD'], ['费用来源', state.call % 2 ? '入账时人工单价估算' : '提供方上报'], ['入账价格版本', 'demo-price-revision-a'], ['模型会话', 'demo-session-a']])}${note('调用记录只观察入账证据；不会从此处重试模型调用或重算历史费用。')}</div>`, { drawer: true });
  reg('records-prices', '内置参考价目表', '设计演示数值 · 不是实时或官方报价', () => `<div class="stack">${note('单位：对应币种 / 百万 Token。下列值全部为演示价格。')}${table(['参考模型', '缓存命中', '输入未命中', '输出', '币种'], [['演示参考模型 A', '0.10', '0.50', '1.00', 'USD'], ['演示参考模型 B', '0.20', '1.00', '2.00', 'CNY']])}${info([['生效规则', '人工单价优先；未登记型号是否有默认参考价由当前后端声明'], ['峰谷', '仅在账本明确提供价档、倍率、时间段和节假日目录时展示'], ['缓存写入', '内置参考表可按未命中价推算；人工规则可单独配置'], ['历史', '保留各轮入账时价格和币种，不追溯回算']])}</div>`, { wide: true });
  const priceRow = key => `<div class="flatgroup" data-records-price="${key}"><div class="row" style="margin-bottom:6px"><strong>人工规则 ${key}</strong><span class="muted small">仅演示 · 金额 / 百万 Token</span><span class="push">${button('移除规则', `data-action="records.priceRemoveOpen" data-record="${key}"`, 'danger')}</span></div><div class="formgrid three">${draftSelect(`price-${key}-provider`, '提供方', ['演示服务 A', '演示服务 B'])}${draftSelect(`price-${key}-model`, '模型', ['演示聊天模型 A', '演示工作模型 B'])}${draftField(`price-${key}-currency`, '币种', 'USD', { placeholder: 'CNY / USD' })}${draftField(`price-${key}-input`, '输入未命中', '0.50', { type: 'number' })}${draftField(`price-${key}-output`, '输出', '1.00', { type: 'number' })}${draftField(`price-${key}-cacheRead`, '缓存读取', '0.10', { type: 'number' })}${draftField(`price-${key}-cacheWrite`, '缓存写入', '0.50', { type: 'number' })}</div></div>`;
  reg('records-pricing', '自定义单价', '演示草稿保留 · 关闭窗口不隐式保存', () => `<div class="stack"><div class="row"><span class="muted small">四项金额为币种 / 百万 Token；范围 0–1,000,000</span><span class="push">${button('管理提供方', 'data-page="providers"')}${open('重新读取', 'records-pricing-reload')}${open('保存恢复示例', 'records-pricing-recovery', 'ghost')}</span></div><div class="row"><span id="records-price-count" class="muted small">${state.prices.length}/256 条人工覆盖</span><span class="push">${open('恢复内置参考价', 'records-price-reset')}${button('添加单价', 'data-action="records.priceAdd"')}</span></div><div id="records-price-rows">${state.prices.map(priceRow).join('') || empty('没有人工覆盖；按当前后端声明使用内置参考价或保持未知。')}</div>${note('新增或更换对象从已登记并启用的模型目录选择；既有未登记规则保留原对象并允许编辑金额。缺少必要计数时费用未知，不同币种分别记录。')}${footer(close('关闭并保留草稿') + demo('撤销更改', '正式编辑器恢复读取时的规则；此操作只演示交互') + save('保存后续单价', '示例价格草稿已保存到离线设计状态，未修改真实账本'), '旧轮次不回算')}</div>`, { wide: true });
  reg('records-price-remove', '移除这条单价规则？', '演示草稿操作 · 保存后才影响后续计价', () => `<div class="stack"><p>人工规则 ${state.removePrice ?? 1} · 演示聊天模型</p><p class="muted small">只从当前演示草稿移除；真实规则和历史费用均不变。</p>${footer(close('取消') + button('移除规则', 'data-action="records.priceRemove"', 'danger'))}</div>`);
  reg('records-price-reset', '恢复内置参考价？', '演示草稿操作', () => `<div class="stack">${warning('清空当前人工覆盖草稿；保存后对后续估算生效，历史不回算。')}${footer(close('取消') + button('清空人工覆盖草稿', 'data-action="records.priceReset"', 'danger'))}</div>`);
  reg('records-pricing-reload', '重新读取单价？', '存在草稿时先明确确认', () => `<div class="stack"><p>重新读取将丢弃未保存的单价草稿；不会重新提交旧保存。</p>${footer(close('保留草稿') + demo('放弃草稿并重新读取', '演示从保存基线重读，未访问真实单价接口', 'danger'))}</div>`);
  reg('records-pricing-recovery', '单价保存结果待核对', '演示冲突 / 未知恢复', () => `<div class="stack">${warning('保存结果未知，保留草稿与原读取版本，新的保存已锁定。')}<div class="row">${demo('读取已保存内容', '演示读取当前价格目录；不会重试原写入')}${confirmCheck('price-reviewed', '已核对当前保存内容')}${button('允许新的保存', 'disabled data-records-guard="price-reviewed" data-demo="演示释放编辑入口，不能据此认定旧保存成功"')}</div>${info([['原版本', 'demo-price-revision-a'], ['冲突示例', '另一窗口已修改价格；不会覆盖新版本'], ['读取失败示例', '保留已知规则与草稿，不采用空目录'], ['提供方读取失败', '不能新增或更换路由，已有规则金额仍可编辑']])}</div>`);
  reg('records-clear', '清空用量账本？', '演示确认 · 无法撤销的真实影响需明确显示', () => `<div class="stack">${warning('真实操作会清空已结算用量与费用记录。未知轮次、执行证据、会话历史、单价和去重凭据保留。')}${confirmText('clear', '清空用量账本')}${footer(close('取消') + guardedOpen('确认清空', 'clear', 'records-clear-result', 'primary danger'))}</div>`);
  reg('records-clear-result', '清空请求结果示例', '仅演示 · 没有清空任何记录', () => `<div class="stack">${warning('示例：请求结果未知，可能已完成部分批次。原请求不自动重试。')}${info([['原操作', 'demo-usage-reset-a'], ['受保护未知记录', '2 条（演示）'], ['下一步', '关闭并刷新统计，核对当前账本']])}${footer(demo('关闭并刷新核对', '演示刷新当前账本，不再次提交清空'))}</div>`);

  UI.replyControls = () => `<div class="flatgroup"><div class="row between"><h3>回复方式</h3><span class="muted small">保存后对后续回复生效</span></div><div class="checks" style="margin-top:6px"><span class="row">${draftCheck('output-bubbles', '短回复分条', true)}${tip('完整短段落最多分成四条；代码与结构化文本保持完整。')}</span><span class="row">${draftCheck('output-forward', '长文合并转发', false)}${tip('超出阈值的纯文本以机器人署名合并转发；仍需当前协议支持。')}</span><span class="row">${draftCheck('output-media', '发送已登记媒体', true)}${tip('只使用当前会话的有效资源及实际协议回执。')}</span></div><div class="row" style="margin-top:5px">${open('长文设置', 'records-output-advanced', 'link')}${open('配置详情', 'records-output-details', 'link')}<span class="push">${UI.state === 'unknown' ? open('核对保存结果', 'records-output-recovery') : button('保存回复设置', `${UI.state === 'loading' ? 'disabled ' : ''}data-action="records.saveOutput"`)}</span></div></div>`;
  UI.actions['records.saveOutput'] = () => UI.notify('回复方式已在离线设计中保存；未修改正式配置，不需要应用聊天方案');

  UI.pages.features = {
    title: '功能与扩展', sub: '真实设置范围 · 当前演示场景未安装任何额外插件',
    render: () => `<div class="stack">${panel('功能', tabs('records-features', ['框架内置', 'Agent扩展'], [
      `<div class="flatgroup"><div class="row"><strong>回复方式</strong><span class="muted grow">短回复分条、长文转发和媒体发送已集中到首页。</span>${button('到首页调整', 'data-page="overview"', 'primary')}</div></div>`,
      `<div class="flatgroup"><div class="row"><h3>已接入扩展</h3><span class="push">${open('扩展运行详情', 'records-extensions')}${demo('重新读取', '演示读取扩展目录；不安装或启动插件')}</span></div>${empty('当前演示场景没有额外扩展，不填充虚构插件或工具。')}<div class="row"><span class="muted small">扩展工具：等待首次对话观察实际范围</span><span class="push">${open('工具读取详情', 'records-tools', 'link')}</span></div></div>`,
    ]), `<div class="row">${open('未知保存 / 读取失败示例', 'records-output-recovery', 'ghost')}</div>`, 'flush')}${note('人设唤醒在“人设”配置；模型提问在QQ中回复。此页不提供安装授权、逐次工具审批或旧次数限制。')}</div>`,
  };
  reg('records-output-advanced', '长文设置', '编辑演示草稿 · 返回首页后保存', () => `<div class="stack"><div class="formgrid">${draftField('output-threshold', '字符阈值', '3500', { type: 'number', tip: '500–16000；只有开启长文合并转发时使用。' })}</div>${note('三个常用开关放在首页，低频阈值在此编辑。关闭窗口保留草稿。')}${footer(close('完成并保留草稿'))}</div>`);
  reg('records-output-details', '回复配置详情', '只读演示 · 不占主页面', () => info([['设置', 'chat-output'], ['字段版本', '1'], ['配置来源', '内置默认值（演示）'], ['保存版本', 'demo-output-revision-a'], ['应用方式', 'live：后续处理读取保存值'], ['默认值', '分条开启、合并转发关闭、阈值3500、登记媒体开启'], ['权限', '会话白名单是准入边界；设置不会创建媒体或扩大权限']]), { drawer: true });
  reg('records-output-recovery', '回复设置保存与读取状态', '演示状态 · 失败不会冒充已应用', () => `<div class="stack">${warning('保存结果未知：草稿保留，不自动重复提交。')}<div class="row">${demo('读取已保存内容', '演示观察当前保存版本')}${confirmCheck('output-reviewed', '已核对保存内容')}${button('允许新的保存', 'disabled data-records-guard="output-reviewed" data-demo="演示解除保存锁；不说明旧写入是否成功"')}</div>${error('读取失败示例：当前设置不可编辑，仍展示上次草稿。')}${info([['版本冲突', '重新读取后明确采用保存内容，不能覆盖别处修改'], ['字段不兼容', '不把旧字段当默认值保存'], ['迁移条件', '只在后端明确返回迁移要求与可用版本时显示确认迁移入口'], ['错误详情', 'demo-output-read-failed（示例）']])}</div>`);
  reg('records-extensions', '扩展运行详情', '只读演示 · 打开时才读取实际摘要', () => `<div class="stack">${badge('演示场景：未配置本地扩展', 'neutral')}${note('此空状态表示场景未配置扩展，不能把读取失败误报为“没有扩展”。')}${info([['读取方式', '按需观察当前宿主摘要，不持续轮询'], ['安装 / 运行 / 授权', '分别建模，安装记录不授予权限'], ['可信扩展', '宿主进程内代码；当前场景没有扩展清单'], ['扩展设置', '只有实际贡献了公开字段的已接入扩展才显示表单'], ['字段形态', '布尔开关、范围整数、每行一项的字符串列表'], ['版本与代码指纹', '未配置时没有该记录']])}${demo('重新读取扩展摘要', '演示观察扩展状态，不安装代码')}${open('读取失败示例', 'records-load-states', 'ghost')}</div>`, { drawer: true });
  reg('records-tools', '扩展工具详情', '只读演示 · 不虚构已安装MCP工具', () => `<div class="stack">${warning('工具范围尚未观察：开始真实对话后才显示实际工具。')}${info([['当前条目', '未取得实际工具范围，不能按零个已授权工具处理'], ['后续列表', '工具名称、用途、范围；按来源分类与搜索'], ['截断 / 部分范围', '明确保留提示'], ['读取失败', '保留上次结果并提供原始原因'], ['工具授权', '当前会话白名单与实际主人身份，不在网页逐次批准']])}${demo('刷新工具清单', '演示读取已接入的工具记录，未连接真实Agent')}</div>`, { drawer: true });
  reg('records-load-states', '记录页面状态覆盖', '审核用状态示例 · 不代表本机状态', () => `<div class="stack">${note('加载中：保留已读取记录与草稿；取消只结束页面等待。')}${error('读取失败：暂时无法取得记录，提供重读入口；有旧结果时标明时间与未重新确认。')}${warning('未知：外部执行或写入没有足够证据，锁定危险重试入口，保留原操作。')}${warning('版本冲突：当前绑定或配置已变化，需关闭并重新读取核对。')}${note('部分结果：明确仍有分页位置或扫描截断；筛选仅作用于已加载记录。')}${empty('已证实为空：接口返回空列表；与读取失败、未知和未接入分别呈现。')}<div class="row">${demo('重新读取', '演示重新观察，没有真实网络请求')}${close()}</div></div>`, { wide: true });

  UI.actions['records.session'] = source => { state.session = Number(source.dataset.record) || 0; UI.open(source.dataset.target, { fresh: true }); };
  UI.actions['records.select'] = source => { state[source.dataset.kind] = Number(source.dataset.record) || 0; UI.open(source.dataset.target); };
  UI.actions['records.usageConversation'] = source => {
    state.usageConversation = Number(source.dataset.record) || 0;
    if (source.closest('dialog')) UI.close();
    UI.render();
    document.querySelector('[data-tab-group="records-usage"][data-tab="records-usage-1"]')?.click();
    UI.notify('已切换所选会话的演示逐轮记录；没有读取真实账本');
  };
  const updatePriceCount = () => { const count = document.getElementById('records-price-count'); if (count) count.textContent = `${state.prices.length}/256 条人工覆盖`; };
  UI.actions['records.priceAdd'] = () => {
    if (state.prices.length >= 256) return;
    const key = state.nextPrice++; state.prices.push(key);
    const container = document.getElementById('records-price-rows');
    if (container) { container.querySelector('.empty')?.remove(); container.insertAdjacentHTML('beforeend', priceRow(key)); }
    updatePriceCount(); UI.notify('已添加一条演示单价草稿，关闭窗口会保留');
  };
  UI.actions['records.priceRemoveOpen'] = source => { state.removePrice = Number(source.dataset.record); UI.open('records-price-remove'); };
  UI.actions['records.priceRemove'] = () => {
    state.prices = state.prices.filter(key => key !== state.removePrice);
    document.querySelector(`[data-records-price="${state.removePrice}"]`)?.remove(); updatePriceCount();
    UI.close();
    UI.notify('只移除了演示单价草稿；没有修改真实规则');
  };
  UI.actions['records.priceReset'] = () => {
    state.prices = []; const container = document.getElementById('records-price-rows');
    if (container) container.innerHTML = empty('没有人工覆盖草稿；保存后才使用内置参考价。');
    updatePriceCount(); UI.close(); UI.notify('已将演示人工覆盖草稿置空，尚未保存');
  };
  const captureDraft = event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement || input instanceof HTMLTextAreaElement)) return;
    const key = input.dataset.recordsInput || input.closest('[data-records-field]')?.dataset.recordsField;
    if (key) state.fields[key] = input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked : input.value;
    if (key === 'output-threshold') { const summary = document.getElementById('records-output-threshold-label'); if (summary) summary.textContent = input.value; }
    if (input.hasAttribute('data-records-chart-metric') || input.hasAttribute('data-records-chart-range')) {
      if (input.hasAttribute('data-records-chart-metric')) state.chartMetric = input.value;
      else state.chartRange = input.value;
      const total = document.getElementById('records-chart-total');
      const chart = document.getElementById('records-usage-chart');
      if (total) total.textContent = state.chartMetric === 'Token' ? '窗口内已知 Token 82.0K' : 'DeepSeek · CNY 0.80';
      if (chart) chart.innerHTML = usageChart();
    }
    const guard = input.dataset.recordsConfirm;
    if (guard) document.querySelectorAll(`[data-records-guard="${guard}"]`).forEach(control => { control.disabled = input.type === 'checkbox' ? !input.checked : input.value !== input.dataset.phrase; });
  };
  document.addEventListener('input', captureDraft);
  document.addEventListener('change', captureDraft);
})();
