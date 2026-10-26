/* Offline design only. All entities, model metadata and records below are demonstration data. */
(function () {
  'use strict';
  const H = UI.esc;
  const B = UI.button;
  const badge = UI.badge;
  const state = {
    persona: 0, plan: 0, provider: 0, model: 0, work: 0,
    values: Object.create(null), saved: Object.create(null), dirty: Object.create(null),
    personas: [
      { name: '演示 · 海岸伙伴', sub: '日常聊天', identity: '这是离线设计稿中的示例人设。\n\n以耐心的伙伴身份参与日常交流，认真理解对方的语境和需求。\n\n身份与关系边界清楚，不把推测说成已知事实。', style: '自然、简洁，优先回应当前话题。\n\n表达关心时使用具体的语言。需要解释时分段说明，不堆砌口号。\n\n不确定的内容明确说明。' },
      { name: '演示 · 技术协作', sub: '技术讨论', identity: '离线示例：协助梳理技术问题的协作伙伴。\n根据用户提供的信息解释问题与解决步骤。', style: '先给结论，再给必要依据。\n代码与普通解释分开组织，避免重复。' },
      { name: '演示 · 简洁助理', sub: '尚未关联方案', identity: '离线示例：帮助整理信息和日常计划。', style: '用短句和清晰的列表表达，保持礼貌。' }
    ],
    plans: [
      { name: '演示 · 日常聊天', sub: '聊天模型 A · 海岸伙伴', active: true },
      { name: '演示 · 技术讨论', sub: '聊天模型 B · 技术协作', active: false },
      { name: '演示 · 备用方案', sub: '聊天模型 C · 简洁助理', active: false }
    ],
    providers: [
      { name: '演示 · 聊天服务', api: 'OpenAI Chat Completions', enabled: true, secret: true },
      { name: '演示 · 备用服务', api: 'Anthropic Messages', enabled: false, secret: false },
      { name: '演示 · 助手服务', api: 'OpenAI Responses', enabled: true, secret: true }
    ],
    models: [
      { name: '演示 · 聊天模型 A', id: 'demo-chat-a', used: '日常聊天方案' },
      { name: '演示 · 聊天模型 B', id: 'demo-chat-b', used: '技术讨论方案' },
      { name: '演示 · 聊天模型 C', id: 'demo-chat-c', used: '备用方案' },
      { name: '演示 · 助手模型', id: 'demo-assistant', used: '后台助手' },
      { name: '演示 · 备用模型', id: 'demo-alternate', used: '无引用' },
      { name: '演示 · 归档选择', id: 'demo-spare', used: '无引用' }
    ]
  };
  const open = (text, id, kind = '') => B(text, 'data-action="editorOpen" data-editor-dialog="' + id + '"', kind);
  const demo = (text, message, kind = 'ghost') => B(text, 'data-demo="' + H(message) + '"', kind);
  const action = (text, name, attrs = '', kind = '') => B(text, 'data-action="' + name + '" ' + attrs, kind);
  const value = (key, fallback) => Object.prototype.hasOwnProperty.call(state.values, key) ? state.values[key] : fallback;
  const bind = (html, key) => html.replace(/<(input|textarea|select)\b/, '<$1 data-editor-bind="' + H(key) + '"');
  const field = (key, label, fallback = '', options = {}) => bind(UI.field(label, value(key, fallback), Object.assign({}, options, { disabled: options.disabled || UI.state === 'loading' || UI.state === 'unknown' })), key);
  const area = (key, label, fallback, rows = 9) => bind(UI.area(label, value(key, fallback), rows), key).replace('<textarea', '<textarea' + ((UI.state === 'loading' || UI.state === 'unknown') ? ' disabled' : ''));
  const select = (key, label, choices, options = {}) => {
    const chosen = value(key, choices[0]);
    return bind(UI.select(label, [chosen].concat(choices.filter(item => item !== chosen)), Object.assign({}, options, { disabled: options.disabled || UI.state === 'loading' || UI.state === 'unknown' })), key);
  };
  const check = (key, label, on = false) => bind(UI.check(label, value(key, on)), key);
  const footer = html => '<div class="footer">' + html + '</div>';
  const panelFooter = (panel, actions) => panel.replace(/<\/section>$/, footer(actions) + '</section>');
  const info = rows => '<dl class="info">' + rows.map(row => '<dt>' + H(row[0]) + '</dt><dd>' + row[1] + '</dd>').join('') + '</dl>';
  const register = (id, title, sub, render, extra = {}) => { UI.dialogs[id] = Object.assign({ title, sub, render }, extra); };
  const prefix = kind => kind + '.' + state[kind] + '.';
  const creating = kind => document.querySelector('dialog[open][data-dialog="editor-' + kind + '-new"]') !== null;
  const modeBanner = () => {
    if (UI.state === 'loading') return '<div class="strip state-banner" role="status">加载中示例：目录与状态尚未取得，编辑和保存暂不可用。下方为上次演示快照。</div>';
    if (UI.state === 'error') return '<div class="strip bad state-banner" role="alert">读取失败示例：保留演示快照和未保存草稿。请先重新读取，不能把读取失败视为空目录。</div>';
    if (UI.state === 'unknown') return '<div class="strip warn state-banner" role="alert">保存结果未知示例：草稿已保留，新的保存暂时锁定。请核对原操作，不重复提交。</div>' + '<div class="actions" style="margin-bottom:8px">' + open('核对原操作', 'editor-recovery') + '</div>';
    return '';
  };
  const locked = () => UI.state === 'unknown' || UI.state === 'loading';
  const save = (kind, text) => action(text, 'editorSaveDraft', 'data-editor-kind="' + kind + '"' + (locked() ? ' disabled' : ''), 'primary');
  const reset = kind => action('撤销更改', 'editorResetDraft', 'data-editor-kind="' + kind + '"', 'ghost');
  const status = kind => '<span class="muted push" data-editor-dirty="' + kind + '">' + (state.dirty[kind] ? '未保存演示草稿' : '演示草稿已载入') + '</span>';
  function master(kind, entries, sub, addDialog) {
    return '<div class="panel"><div class="panelhead"><h2>' + H(sub) + '</h2>' + open('＋ 新建', addDialog, 'ghost') + '</div><div class="masterlist">' + entries.map((item, index) => '<button type="button" class="' + (state[kind] === index ? 'active' : '') + '" data-action="editorPick" data-editor-kind="' + kind + '" data-editor-index="' + index + '"><span class="letter">' + H(String(index + 1).padStart(2, '0')) + '</span><span class="copy"><strong>' + H(item.name) + '</strong><span class="muted">' + H(item.sub || (item.enabled ? '已启用' : '未启用')) + '</span></span></button>').join('') + '</div>' + footer('<span class="muted">' + entries.length + ' 项演示数据</span>') + '</div>';
  }
  function selectedPersona() { return state.personas[state.persona]; }
  function selectedPlan() { return state.plans[state.plan]; }
  function selectedProvider() { return state.providers[state.provider]; }
  function personaEditor() {
    const p = selectedPersona(); const k = prefix('persona');
    const body = '<div class="stack"><div class="formgrid">' + field(k + 'name', '人设名称', p.name) + field(k + 'nicknames', '呼叫昵称', '示例伙伴，示例昵称', { tip: '用逗号分隔，最多 16 个。人设名称本身也可用于呼叫。' }) + '</div><div class="row small muted">' + badge(state.persona === 0 ? '当前方案正在使用' : '可供方案选择', state.persona === 0 ? 'good' : 'neutral') + '<span>唤醒设置保存后即时生效</span><span class="push">' + open('唤醒与续聊', 'editor-persona-wake') + '</span></div><div class="editorgrid">' + area(k + 'identity', '身份定义', p.identity, 13) + area(k + 'style', '表达风格', p.style, 13) + '</div><div class="strip">身份与表达分开编辑；模型、能力与权限在各自设置中维护。</div></div>';
    return panelFooter(UI.panel(H(p.name), body, badge('人设草稿', 'neutral')), save('persona', '保存人设') + (UI.state === 'unknown' ? open('核对原应用', 'editor-apply-recovery') : open('应用已保存人设', 'editor-persona-apply')) + open('应用详情', 'editor-application-details', 'ghost') + status('persona') + open('删除', 'editor-persona-delete', 'danger'));
  }
  UI.pages.persona = { title: '人设与唤醒', sub: '离线演示 · 身份与表达双栏编辑，低频设置按需打开', render: () => modeBanner() + '<div class="masterdetail">' + master('persona', state.personas, '人设目录', 'editor-persona-new') + '<div class="stack">' + personaEditor() + '<div class="summaryline small"><span class="muted">需要新的完整角色草稿？</span>' + open('使用内置小鲸鱼', 'editor-persona-template', 'ghost') + '<span class="muted">只创建草稿，保存后再在方案中选择。</span></div></div></div>' };
  function planEditor() {
    const p = selectedPlan(); const k = prefix('plan');
    const basic = '<div class="formgrid three">' + field(k + 'name', '方案名称', p.name) + field(k + 'description', '用途说明', '离线演示聊天方案') + select(k + 'persona', '关联人设', state.personas.map(item => item.name)) + '</div>';
    const models = '<div class="flatgroup"><div class="row between"><h3>模型与回复</h3><div class="row">' + open('就地选择或添加模型', 'editor-plan-model-picker') + B('管理人设', 'data-page="persona"', 'ghost') + '</div></div><div class="formgrid three" style="margin-top:6px">' + select(k + 'provider', '模型服务', state.providers.map(item => item.name)) + select(k + 'model', '聊天模型', state.models.slice(0, 3).map(item => item.name)) + select(k + 'effort', '思考档位', ['演示档位：中', '演示档位：低', '演示档位：高'], { tip: '真实界面仅列出所选模型实际声明的档位。此处档位为离线示例。' }) + '</div><div class="row small muted" style="margin-top:5px"><span>支持情况、模型容量均为演示元数据</span>' + demo('重新读取支持情况', '展示读取模型支持情况的入口；不会请求真实模型') + open('上下文容量', 'editor-plan-context') + '</div></div>';
    const instructions = '<div class="flatgroup">' + area(k + 'instructions', '方案指令', '离线示例：\n\n围绕当前会话的实际话题组织回复。优先直接回答问题，需要解释时提供具体步骤。\n\n角色身份与表达风格使用所关联的人设。', 9) + '</div>';
    return '<div class="panel"><div class="panelhead"><h2>' + H(p.name) + '</h2><div class="row">' + badge(p.active ? '当前启用方案' : '尚未启用', p.active ? 'good' : 'neutral') + '</div></div><div class="panelbody">' + basic + '</div>' + models + instructions + footer(action('保存方案', 'editorSaveDraft', 'data-editor-kind="plan"' + (locked() ? ' disabled' : '')) + (UI.state === 'unknown' ? open('核对并继续', 'editor-apply-recovery', 'primary') : open('更新聊天', 'editor-plan-apply', 'primary')) + UI.tip('更新聊天会保存并启用当前方案，再应用。保存方案只保存草稿，不改变运行状态。') + open('应用详情', 'editor-application-details', 'ghost') + open('高级应用设置', 'editor-plan-advanced', 'ghost') + status('plan') + open('删除', 'editor-plan-delete', 'danger')) + '</div>';
  }
  function assistant() {
    const full = value('assistant.mode', '聊天＋助手') === '聊天＋助手';
    return UI.panel('后台助手', '<div class="stack"><div class="formgrid">' + select('assistant.mode', '聊天模式', ['聊天＋助手', '仅聊天']) + (full ? field('assistant.nickname', '助手昵称', '演示 · 工作助手') + select('assistant.provider', '执行服务', state.providers.map(item => item.name)) + select('assistant.model', '执行模型', ['演示 · 助手模型', '演示 · 备用模型']) : '') + '</div>' + (full ? '<div class="strip">独立处理由主人在 QQ 中委派的工作，问题和结果回到所属会话。</div>' : '<div class="strip">仅聊天模式保留助手的模型选择，暂停接收新的后台工作。</div>') + '<div class="actions">' + open('助手设置与启用', 'editor-assistant-settings') + open('助手状态', 'editor-assistant-details', 'ghost') + status('assistant') + '</div></div>', badge(full ? '已启用（示例）' : '仅聊天（示例）', full ? 'good' : 'neutral'));
  }
  const works = [
    ['演示群聊 A', '已完成', '演示结果：已整理讨论要点', '已确认回传', '10:42'],
    ['演示私聊 B', '处理中', '尚无已确认结果', '等待结果', '10:39'],
    ['演示群聊 A', '结果未知', '等待核对原执行', '尚未确认', '10:31']
  ];
  function workRecords() {
    return UI.panel('独立工作记录', '<div class="row" style="margin-bottom:7px"><input aria-label="筛选演示工作记录" data-filter="editor-work-table" placeholder="筛选所属会话、结果摘要" style="max-width:250px">' + demo('刷新', '工作记录刷新入口，仅展示离线记录') + '<span class="muted small push">发起、追加、停止和模型提问均在所属 QQ 会话进行</span></div><div id="editor-work-table">' + UI.table(['所属会话', '状态', '结果摘要', '回传', '创建时间', '操作'], works.map((item, index) => [item[0], badge(item[1], index === 0 ? 'good' : index === 2 ? 'warn' : 'neutral'), item[2], '<span class="muted">' + item[3] + '</span>', item[4], action('详情', 'editorWorkDetail', 'data-editor-index="' + index + '"', 'link')])) + '</div><div class="actions" style="margin-top:7px">' + demo('下一批', '展示分页读取，当前全部为演示记录') + demo('返回首批', '回到演示记录首批') + open('读取状态示例', 'editor-work-read-states', 'ghost') + '</div>', '<span class="muted small">3 条演示记录</span>');
  }
  UI.pages.plans = { title: '聊天方案与助手', sub: '离线演示 · 保存方案与应用聊天分别呈现', render: () => modeBanner() + '<div class="masterdetail">' + master('plan', state.plans, '方案目录', 'editor-plan-new') + '<div class="stack">' + planEditor() + '<div class="summaryline small"><span class="muted">从完整示例开始</span>' + open('使用内置日常方案', 'editor-plan-template', 'ghost') + '</div>' + assistant() + workRecords() + '</div></div>' };
  function providerEditor() {
    const p = selectedProvider(); const k = prefix('provider');
    const connection = panelFooter(UI.panel(H(p.name), '<div class="stack"><div class="formgrid">' + field(k + 'name', '服务名称', p.name) + select(k + 'protocol', '接口协议', [p.api, 'OpenAI Responses', 'OpenAI Chat Completions', 'Anthropic Messages', '自定义 DSH api']) + field(k + 'url', '基础地址', 'https://api.example.invalid/v1', { wide: true, type: 'url', tip: '离线示例地址，不会发起网络请求。真实配置使用服务商提供的完整接口基础地址。' }) + field(k + 'secret', p.secret ? '替换密钥' : 'API 密钥', '', { wide: true, type: 'password', placeholder: p.secret ? '已保存 · 留空保留原密钥' : '仅在服务需要认证时填写' }) + '</div><div class="row between"><div class="checks">' + check(k + 'enabled', '在模型目录中启用', p.enabled) + (p.secret ? check(k + 'clear', '保存时清除已保存密钥') : '') + '</div>' + open('连接高级设置', 'editor-provider-advanced', 'ghost') + '</div><div class="strip">密钥只写入；留空保留原值。真实界面会在提交或离开编辑时清空尚未提交的密钥输入。</div></div>', badge(p.enabled ? '已启用（示例）' : '未启用（示例）', p.enabled ? 'good' : 'neutral')), save('provider', '保存提供方') + reset('provider') + open('使用者与引用', 'editor-provider-references') + status('provider') + open('删除服务', 'editor-provider-delete', 'danger'));
    const modelTable = UI.panel('模型目录', '<div class="row" style="margin-bottom:7px"><input aria-label="筛选演示模型目录" data-filter="editor-model-table" placeholder="搜索模型显示名称或 API 标识" style="max-width:270px"><span class="muted small push">显示名称用于选择，API 标识用于实际请求</span></div><div id="editor-model-table">' + UI.table(['模型显示名称', 'API 模型 ID', '使用者', '操作'], state.models.map((model, index) => [H(model.name), '<span class="mono">' + H(model.id) + '</span>', '<span class="muted">' + H(model.used) + '</span>', action('编辑', 'editorModelEdit', 'data-editor-index="' + index + '"', 'link') + action('删除', 'editorModelDelete', 'data-editor-index="' + index + '"', 'link')])) + '</div>', open('＋ 添加模型', 'editor-model-new'));
    return connection + modelTable;
  }
  UI.pages.providers = { title: '模型服务', sub: '离线演示 · 连接参数和模型目录集中管理', render: () => modeBanner() + '<div class="masterdetail">' + master('provider', state.providers, '模型服务目录', 'editor-provider-new') + '<div class="stack">' + providerEditor() + '</div></div>' };

  register('editor-persona-new', '新建人设', '创建新的演示草稿；不会自动启用。', () => '<div class="stack"><div class="formgrid">' + field('new-persona.name', '人设名称', '演示 · 新伙伴') + field('new-persona.nicknames', '呼叫昵称', '') + '</div><div class="editorgrid">' + area('new-persona.identity', '身份定义', '', 8) + area('new-persona.style', '表达风格', '', 8) + '</div><p data-editor-validation class="danger-text" hidden></p><div class="strip">保存人设后，再到聊天方案选择关联。</div></div>' + footer(action('创建演示草稿', 'editorCreate', 'data-editor-kind="persona"', 'primary') + open('内部标识', 'editor-persona-id', 'ghost')), { wide: true });
  register('editor-persona-template', '使用内置人设模板', '来源于现有“使用内置小鲸鱼”功能；此处正文为离线演示。', () => '<div class="stack"><div class="strip">创建新的未保存人设，已有角色内容保持。使用前可修改名称与正文。</div>' + field('template-persona.name', '人设名称', '演示 · 小鲸鱼模板') + '<div class="editorgrid">' + area('template-persona.identity', '身份定义预览', '这是内置人设创建流程的离线演示正文。', 8) + area('template-persona.style', '表达风格预览', '自然交流，围绕话题回应，保持身份与关系边界。', 8) + '</div></div>' + footer(action('填入新草稿', 'editorCreate', 'data-editor-kind="persona" data-editor-template="true"', 'primary')), { wide: true });
  register('editor-persona-wake', '唤醒与续聊', '与当前人设一起保存，保存后即时生效。', () => '<div class="stack"><div class="strip">白名单内私聊与群聊 @ 固定唤醒；人设名称和额外昵称也可用于呼叫。</div>' + field(prefix('persona') + 'nicknames', '额外昵称', '示例伙伴，示例昵称', { tip: '最多16个，不重复；逗号分隔。' }) + '<div class="checks">' + check(prefix('persona') + 'wakeReply', '引用机器人时唤醒', true) + '</div>' + field(prefix('persona') + 'continuation', '同人续聊', '90', { type: 'number', tip: '单位秒，0 表示关闭，最长 300 秒。' }) + '<p class="muted small">这些设置只影响何时参与聊天，能力与权限仍由会话白名单决定。</p></div>' + footer(save('persona', '保存人设设置')));
  register('editor-persona-id', '人设内部标识', '低频兼容参数；已有标识在创建后固定。', () => field('new-persona.id', '内部标识', creating('persona') ? 'demo-persona-new' : 'demo-persona-' + (state.persona + 1), { disabled: !creating('persona') }) + '<p class="muted small">新建时自动生成；真实界面仅允许在创建前修改。</p>' + footer(B('返回编辑', 'data-close', 'ghost')));
  register('editor-persona-apply', '应用已保存人设', '演示应用状态；只有当前启用方案引用此人设时可从这里应用。', () => '<div class="stack">' + info([['人设', H(selectedPersona().name)], ['当前方案', H(state.plans[0].name)], ['关联核对', state.persona === 0 ? badge('当前方案正在使用（示例）') : badge('当前方案未使用此人设', 'warn')]]) + '<div class="strip' + (state.persona === 0 ? '' : ' warn') + '">' + (state.persona === 0 ? '应用已保存内容，会话历史保留；通常无需重启 DSH。' : '先在聊天方案中关联并保存，再应用该方案。') + '</div>' + (state.persona === 0 ? '<p class="small muted">演示阶段：核对 → 应用 → 检查加载 → 恢复聊天。实际执行状态以真实回包为准。</p>' : '') + '</div>' + footer(state.persona === 0 ? demo('应用演示', '仅展示人设应用流程，没有写入任何运行配置', 'primary') + open('应用详情', 'editor-application-details') : B('打开聊天方案', 'data-page="plans"')));
  register('editor-persona-delete', '删除人设', '真实功能要求输入人设名称；仍被方案使用时阻止删除。', () => {
    const used = state.persona < 2;
    return '<div class="stack">' + info([['对象', H(selectedPersona().name)], ['影响', '从人设目录移除该项，不能撤销；模型服务与会话历史保留。']]) + (used ? '<div class="strip warn" role="alert">当前演示人设仍被聊天方案引用，暂不能删除。请先更换方案关联。</div>' : '<div class="strip warn">这项演示人设没有关联方案，可以预览确认操作。</div>') + '<label class="setting"><span>输入名称</span><input data-editor-confirm="editor-persona-delete-submit" data-expected="' + H(selectedPersona().name) + '" ' + (used ? 'disabled' : '') + ' placeholder="' + H(selectedPersona().name) + '"></label></div>' + footer(B('取消', 'data-close', 'ghost') + B('确认删除人设', 'id="editor-persona-delete-submit" disabled data-demo="已展示删除确认；演示数据与真实人设均不会删除"', 'danger') + B('调整方案关联', 'data-page="plans"', 'ghost'));
  });
  register('editor-plan-new', '新建聊天方案', '先登记模型与人设，再创建方案；保存与启用是两个状态。', () => '<div class="stack"><div class="formgrid">' + field('new-plan.name', '方案名称', '演示 · 新聊天方案') + select('new-plan.persona', '关联人设', state.personas.map(item => item.name)) + select('new-plan.provider', '模型服务', state.providers.map(item => item.name)) + select('new-plan.model', '聊天模型', state.models.slice(0, 3).map(item => item.name)) + '</div>' + area('new-plan.instructions', '方案指令', '', 7) + '<p data-editor-validation class="danger-text" hidden></p></div>' + footer(action('创建演示草稿', 'editorCreate', 'data-editor-kind="plan"', 'primary') + open('内部标识', 'editor-plan-id', 'ghost')), { wide: true });
  register('editor-plan-template', '使用内置日常方案', '填入新方案草稿，原有方案保持。', () => '<div class="stack">' + field('template-plan.name', '方案名称', '演示 · 内置日常方案') + '<div class="strip">模板包含方案指令与默认上下文参数。模型和人设仍需从已登记的目录明确选择。</div><p class="muted small">创建模板不会自动创建人设、调用模型或启用聊天。</p></div>' + footer(action('填入新草稿', 'editorCreate', 'data-editor-kind="plan" data-editor-template="true"', 'primary')));
  register('editor-plan-id', '方案内部标识', '用于稳定关联；真实界面只允许创建前调整。', () => field('new-plan.id', '内部标识', creating('plan') ? 'demo-plan-new' : 'demo-plan-' + (state.plan + 1), { disabled: !creating('plan') }) + footer(B('返回编辑', 'data-close', 'ghost')));
  register('editor-plan-context', '群聊与私聊上下文', '容量变更先保存方案，再明确应用；数值为演示元数据。', () => '<div class="stack"><div class="formgrid">' + field(prefix('plan') + 'groupContext', '群聊上限', '96000', { type: 'number' }) + field(prefix('plan') + 'privateContext', '私聊上限', '112000', { type: 'number' }) + '</div><div class="strip">演示模型窗口 128000 token · 最大输出 8000 token。真实建议须依据模型元数据计算。</div>' + info([['演示建议', '群聊 96000 · 私聊 112000'], ['压缩预留', '群聊 16000 · 私聊 8000 token（示例）'], ['元数据未知', '保留用户已有数值，不推测模型窗口。']]) + '</div>' + footer(action('使用演示建议', 'editorAdoptCapacity') + save('plan', '保存方案容量')));
  register('editor-plan-model-picker', '就地选择或添加模型', '保留当前方案草稿；模型目录与聊天方案分别保存。', () => '<div class="stack"><div class="formgrid">' + select('picker.provider', '模型服务', state.providers.map(item => item.name)) + '<div class="row">' + open('新建提供方', 'editor-provider-new') + open('添加模型', 'editor-model-new') + '</div></div>' + UI.table(['模型', 'API 标识（演示）', '操作'], state.models.map((model, index) => [H(model.name), '<span class="mono">' + H(model.id) + '</span>', action('用于当前方案', 'editorUseModel', 'data-editor-index="' + index + '"', 'link')])) + '<p class="small muted">选择只更新当前方案草稿，需保存方案或更新聊天后生效。</p></div>', { wide: true });
  register('editor-plan-apply', '更新聊天 · 演示进度', '真实操作会保存并启用当前方案，再提交一次应用；此页仅演示阶段。', () => '<div class="stack">' + info([['方案', H(selectedPlan().name)], ['保存与启用', badge('演示阶段', 'purple')], ['会话历史', '保留，按需要执行配置衔接']]) + '<div class="strip">演示流程：保存当前方案 → 暂停聊天 → 准备与应用 → 核对会话 → 恢复聊天。</div>' + UI.table(['阶段', '状态示例'], [['保存方案', '演示：已经确认'], ['应用配置', '演示：已受理'], ['核对加载', '演示：等待读取同一操作'], ['恢复聊天', '等待前序阶段确认']]) + '<p class="small muted">已受理并不代表聊天已恢复；等待时观察同一操作，避免提交第二次。</p></div>' + footer(demo('查看原操作进度', '仅观察演示操作，不读取真实服务') + open('核对并继续', 'editor-apply-recovery') + open('应用详情', 'editor-application-details', 'ghost')));
  register('editor-plan-advanced', '高级应用设置', '远程或自定义接入使用；普通本机接入自动识别，无需手填。', () => '<div class="stack"><div class="formgrid">' + field('deployment.profile', '配置文件', '/srv/demo-dsh/profiles/chat/cordis.patch.yml', { wide: true }) + field('deployment.credentials', '凭据文件路径', '/srv/demo-dsh/.credentials.yaml', { wide: true, tip: '只展示演示路径，不含任何凭据值。' }) + field('deployment.window', '模型总窗口', '128000', { type: 'number' }) + field('deployment.output', '最大输出', '8000', { type: 'number' }) + field('deployment.namespace', '配置命名空间', 'demo-chat') + '</div><div class="checks">' + check('deployment.reasoning', '模型支持思考档位', true) + '</div><div class="formgrid three">' + ['关闭', '低', '中', '高', '极高'].map((name, index) => field('deployment.mapping.' + index, name + '档映射', '', { placeholder: '支持时填写；不支持则留空' })).join('') + '</div>' + area('deployment.layers', '继承层路径（按加载顺序，每行一个）', '', 3) + '<div class="strip warn">路径、容量与档位映射均为静态演示，不解析配置表达式，不读本机文件。</div></div>' + footer(B('保存应用设置', 'data-save="演示手动应用设置已保留"', 'primary') + open('预览变更', 'editor-apply-preview') + open('检查是否生效', 'editor-application-details') + open('恢复原操作', 'editor-apply-recovery', 'ghost')), { wide: true });
  register('editor-apply-preview', '应用变更预览', '展示受管配置影响，非真实配置解析结果。', () => '<div class="stack">' + UI.table(['项目', '演示变更'], [['模型选择', '演示 · 聊天模型 A'], ['人设', H(selectedPersona().name)], ['上下文', '按所选方案分别设置群聊与私聊'], ['其他设置', '非托管设置保留'], ['会话历史', '需要时通过原配置衔接流程保留']]) + '<div class="strip">真实应用先核对配置来源和版本；聊天仍运行时，会提示先安全停止。</div></div>' + footer(demo('应用聊天设置（演示）', '仅演示应用入口，不写入任何文件', 'primary') + open('查看应用状态', 'editor-application-details')));
  register('editor-apply-recovery', '原应用结果核对', '未知结果不自动重放；核对只沿同一原操作进行。', () => '<div class="stack"><div class="strip warn" role="alert">演示：配置写入可能完成，加载尚未确认。新的应用暂时锁定。</div>' + info([['原操作', '<span class="mono">demo-application-01</span>'], ['可做的事', '读取原进度、核对现有配置与运行证据'], ['继续条件', '原写入证据齐全，配置版本仍匹配'], ['其他未知阶段', '继续保留阻碍，不能据此重新应用']]) + '</div>' + footer(demo('读取原操作', '展示核对原操作，不提交第二次应用') + demo('核对并继续', '只有证据满足时才能沿原操作继续；当前是离线示例', 'primary') + open('等待加载与重启', 'editor-apply-reload')));
  register('editor-apply-reload', '等待加载与本机维护', '仅等待加载或原维护未结束时提供；普通更新通常无需重启。', () => '<div class="stack"><div class="strip warn">演示：已确认写入，正在等待 DSH 重新加载。</div><p>受管本机实例可暂停聊天、重启指定 DSH、核验加载并恢复原聊天状态。远程或未配置管理器时提示不可用原因。</p></div>' + footer(demo('重启 DSH（演示）', '仅展示维护流程，不重启任何服务') + demo('恢复原重启', '沿同一次维护记录核对，不重复重启') + B('连接设置', 'data-page="connections"', 'ghost')));
  register('editor-application-details', '应用技术详情', '只读演示记录；配置保存、应用完成和聊天就绪分别确认。', () => info([['显示状态', badge(UI.state === 'unknown' ? '结果待核对' : '待确认加载（示例）', 'warn')], ['操作标识', '<span class="mono">demo-application-01</span>'], ['配置版本', '<span class="mono">演示版本 · 非真实 revision</span>'], ['阶段', '示例：核对 DSH 加载'], ['结果依据', '仅展示阶段信息；没有发起实际模型请求'], ['异常说明', '写入未知、等待加载与观察失败分别显示，不推断成功']]) + footer(open('核对与恢复', 'editor-apply-recovery') + open('等待加载', 'editor-apply-reload', 'ghost')), { drawer: true });
  register('editor-plan-delete', '删除聊天方案', '启用中、聊天未停止、存在未保存更改或目录版本变化时不能删除。', () => '<div class="stack">' + info([['对象', H(selectedPlan().name)], ['影响', '仅移除此方案；人设、模型服务与会话历史保留。']]) + '<div class="strip warn" role="alert">' + (selectedPlan().active ? '当前方案正在启用，请先选择其他方案启用并保存。' : '演示聊天仍在运行，请先到连接设置停止并重新核对。') + '</div>' + UI.check('已确认没有仍需保留的引用') + '</div>' + footer(B('取消', 'data-close', 'ghost') + B('确认删除方案', 'disabled', 'danger') + B('前往连接设置', 'data-page="connections"')));
  register('editor-assistant-settings', '聊天模式与后台助手', '执行模型、昵称和思考等级独立于聊天模型保存。', () => '<div class="stack"><div class="formgrid">' + select('assistant.mode', '聊天模式', ['聊天＋助手', '仅聊天']) + field('assistant.nickname', '助手昵称', '演示 · 工作助手') + select('assistant.provider', '执行服务', state.providers.map(item => item.name)) + select('assistant.model', '执行模型', ['演示 · 助手模型', '演示 · 备用模型']) + select('assistant.effort', '思考等级', ['使用模型默认', '演示档位：中', '演示档位：高']) + '</div><div class="row">' + demo('刷新等级', '展示读取实际模型支持档位的入口，当前无网络') + UI.tip('只列出执行模型支持的等级；未知时保留已保存值，或使用模型默认。') + '</div><div class="strip">保存“聊天＋助手”后自动配置并核验助手目标；本机需要重新加载时自动维护并恢复原聊天状态。</div><p class="small muted">保存“仅聊天”停止接收新工作，仍保留助手的模型选择。工作操作与提问继续在所属 QQ 会话进行。</p></div>' + footer(save('assistant', '保存并启用') + open('启用状态', 'editor-assistant-details')));
  register('editor-assistant-details', '助手加载与可用性', '保存成功和实际可执行状态分别显示。', () => '<div class="stack">' + info([['配置模式', H(value('assistant.mode', '聊天＋助手'))], ['执行模型', '演示 · 助手服务 / 助手模型'], ['配置状态', badge('已保存（演示）')], ['实际可用性', badge(UI.state === 'unknown' ? '未确认' : '演示：已核对加载', UI.state === 'unknown' ? 'warn' : 'good')], ['支持档位', '仅离线示例；真实支持情况由模型元数据确定'], ['缺失时处理', '显示具体原因，保留草稿，读取原结果后再允许新的保存']]) + '</div>' + footer(demo('重新读取', '仅演示重新读取助手状态') + open('未知结果恢复', 'editor-recovery')), { drawer: true });
  register('editor-work-details', '独立工作详情', '只读查看已确认结果、迟到结果与回传回执。', () => {
    const item = works[state.work];
    return '<div class="stack">' + info([['所属会话', H(item[0])], ['工作状态', badge(item[1], state.work === 2 ? 'warn' : state.work === 0 ? 'good' : 'neutral')], ['回传', H(item[3])], ['工作标识', '<span class="mono">demo-work-' + (state.work + 1) + '</span>'], ['创建 / 期限', '演示时间 10:42 / 10:44']]) + (state.work === 2 ? '<div class="strip warn">原执行结果尚未核实；网页不提供重新执行、停止或恢复工作入口，请回所属 QQ 会话处理。</div>' : '') + UI.tabs('editor-work-detail-tabs', ['执行结果', '迟到结果', '回传回执'], [state.work === 0 ? '<p>演示已确认结果：讨论要点已整理。此处只展示结构与排版，不含真实会话内容。</p>' : '<div class="strip">尚无已确认的执行结果。</div>', '<div class="strip">迟到结果单独记录，不自动替代已核对结果。当前演示没有迟到结果。</div>', info([['结果标识', '<span class="mono">demo-result-01</span>'], ['QQ 消息回执', state.work === 0 ? '演示：已取得确认回执' : '尚未取得'], ['文件上传回执', '本条演示未上传文件'], ['执行错误', state.work === 2 ? '结果待核对（示例）' : '无'], ['回传错误', '没有已确认的错误记录']])]) + '</div>' + footer(demo('刷新详情', '只读工作详情刷新入口，零网络'));
  }, { drawer: true });
  register('editor-work-read-states', '工作记录读取状态', '加载、空列表和失败状态分别展示。', () => UI.tabs('editor-work-read-tabs', ['加载中', '空列表', '读取失败'], ['<div class="strip">正在读取工作记录…（离线状态示例）</div>', UI.empty('当前筛选下没有工作记录。'), '<div class="strip bad" role="alert">工作记录读取失败，原结果仍待核对。</div>' + open('读取错误详情', 'editor-read-error') ]));

  register('editor-provider-new', '新建模型服务', '先保存连接与模型目录，再供方案选择；不会自动启用聊天。', () => '<div class="stack"><div class="formgrid">' + field('new-provider.name', '服务名称', '演示 · 新模型服务') + select('new-provider.protocol', '接口协议', ['OpenAI Chat Completions', 'OpenAI Responses', 'Anthropic Messages', '自定义 DSH api']) + field('new-provider.url', '基础地址', 'https://api.example.invalid/v1', { wide: true, type: 'url' }) + field('new-provider.secret', 'API 密钥', '', { wide: true, type: 'password', placeholder: '离线设计稿无需输入真实密钥' }) + '</div>' + check('new-provider.enabled', '保存后在模型目录中启用', true) + '<div class="strip">内部标识自动生成；模型可在服务创建后添加。</div><p data-editor-validation class="danger-text" hidden></p></div>' + footer(action('创建演示草稿', 'editorCreate', 'data-editor-kind="provider"', 'primary') + open('内部标识', 'editor-provider-advanced', 'ghost')));
  register('editor-provider-advanced', '连接高级设置', '低频连接选项；普通服务使用 HTTPS。', () => '<div class="stack">' + (creating('provider') ? field('new-provider.id', '内部标识', 'demo-provider-new') + '<p class="small muted">新建时自动生成，仅兼容已有引用时调整；保存后固定。</p>' : '') + check(prefix('provider') + 'http', '明确允许远程 HTTP', false) + '<div class="strip warn">远程 HTTP 会明文传输 API 密钥和消息；普通配置建议使用 HTTPS。</div>' + open('技术详情', 'editor-provider-details', 'ghost') + '</div>' + footer(save('provider', '保留到当前草稿')));
  register('editor-provider-details', '模型服务技术详情', '只读演示标识，不属于日常配置字段。', () => info([['服务名称', H(selectedProvider().name)], ['内部标识', '<span class="mono">demo-provider-' + (state.provider + 1) + '</span>'], ['接口协议', H(selectedProvider().api)], ['目录版本', '离线演示版本，非真实 revision'], ['密钥', '仅展示是否已配置；不展示密钥内容']]), { drawer: true });
  function modelEditor(isNew) {
    const m = isNew ? { name: '演示 · 新模型', id: 'demo-new-model' } : state.models[state.model];
    const key = isNew ? 'new-model.' : 'model.' + state.model + '.';
    return '<div class="stack"><div class="formgrid">' + field(key + 'name', '显示名称', m.name, { tip: '用于方案选择，留空时使用 API 模型 ID。' }) + field(key + 'id', 'API 模型 ID', m.id, { tip: '按服务商要求填写，不通过显示名称推测模型能力。' }) + '</div><div class="strip">此项修改进入提供方草稿，保存提供方后才写入模型目录。</div><p data-editor-validation class="danger-text" hidden></p></div>' + footer(action(isNew ? '添加到服务草稿' : '更新服务草稿', 'editorCommitModel', 'data-editor-new="' + isNew + '"', 'primary'));
  }
  register('editor-model-new', '添加模型', '仅登记服务要求的模型标识与显示名称，不调用模型。', () => modelEditor(true));
  register('editor-model-edit', '编辑模型', '保存到当前提供方草稿，目录保存与运行应用分别处理。', () => modelEditor(false));
  register('editor-model-delete', '移除模型', '目录删除仍需保存提供方；被方案或助手引用时服务端会阻止删除。', () => '<div class="stack">' + info([['模型', H(state.models[state.model].name)], ['API 标识', '<span class="mono">' + H(state.models[state.model].id) + '</span>'], ['使用者', H(state.models[state.model].used)]]) + '<div class="strip warn">' + (state.models[state.model].used === '无引用' ? '当前离线示例没有引用，可预览移出草稿操作。' : '存在引用，先更换目标或解除助手引用，再保存并核对。') + '</div></div>' + footer(B('取消', 'data-close', 'ghost') + (state.models[state.model].used === '无引用' ? demo('从演示草稿移除', '仅展示模型移除操作，不改真实目录', 'danger') : open('查看使用者', 'editor-provider-references'))));
  register('editor-provider-references', '模型使用者', '方案与助手保留的模型选择都会限制删除；引用更改单独保存。', () => '<div class="stack"><div class="row">' + demo('重新读取引用', '展示读取方案和助手引用的入口，不请求API') + '<span class="muted small">演示引用目录</span></div>' + UI.table(['使用者', '模型', '操作'], [[H(state.plans[0].name), '演示 · 聊天模型 A', open('更换模型', 'editor-reference-plan', 'link')], [H(state.plans[1].name), '演示 · 聊天模型 B', open('更换模型', 'editor-reference-plan', 'link')], ['演示 · 后台助手（包含仅聊天时保留的选择）', '演示 · 助手模型', open('更换或解除', 'editor-reference-assistant', 'link')]]) + '<div class="strip">引用变更只保存对应方案或助手设置；删除服务与应用运行配置仍需分别操作。</div></div>', { wide: true });
  function referenceEditor(assistantReference) {
    return '<div class="stack">' + info([['使用者', assistantReference ? '演示 · 后台助手' : H(state.plans[0].name)], ['原模型', assistantReference ? '演示 · 助手模型' : '演示 · 聊天模型 A']]) + (assistantReference ? check('reference.unlink', '停用独立助手并清除其模型引用') : '') + '<div class="formgrid">' + select('reference.target', '更换到模型', ['演示 · 备用服务 / 备用模型', '演示 · 助手服务 / 助手模型']) + select('reference.effort', '新思考档位', ['请明确选择', '演示档位：中', '演示档位：高']) + '</div><div class="row">' + demo('重新读取模型支持情况', '仅展示能力核对入口，当前档位均为演示') + '</div><div class="strip warn">新模型支持情况未知时不能提交更换。真实功能需要核对当前引用与版本。</div>' + check('reference.confirm', '确认单独保存这项引用更改') + '</div>' + footer(B('保存引用更改', 'data-save="仅演示保存所选引用；没有修改提供方或运行会话"', 'primary') + B('取消', 'data-close', 'ghost'));
  }
  register('editor-reference-plan', '更换方案模型引用', '保留方案其他字段；新模型与思考档位必须明确核对。', () => referenceEditor(false));
  register('editor-reference-assistant', '更换或解除助手引用', '解除会切换为仅聊天并清除保留的模型选择。', () => referenceEditor(true));
  register('editor-provider-delete', '删除模型服务', '删除服务会一并移除其模型与已保存密钥；被引用时拒绝删除。', () => '<div class="stack">' + info([['对象', H(selectedProvider().name)], ['实际影响', '删除该提供方及其模型、密钥；会话历史保留。']]) + '<div class="strip warn" role="alert">演示：仍有聊天方案或助手保留引用，当前不能删除。</div></div>' + footer(B('取消', 'data-close', 'ghost') + B('确认删除服务', 'disabled', 'danger') + open('先处理引用', 'editor-provider-references')));
  register('editor-recovery', '保存结果核对', '冲突、忙碌或结果未知时保留草稿；不会自动重试写入。', () => '<div class="stack"><div class="strip warn">结果未知状态示例：新的保存暂时锁定，请读取已保存内容并核对原操作。</div>' + info([['保留内容', '当前浏览器的演示草稿与原操作标识'], ['先做什么', '读取已保存配置，比较原提交与当前目录'], ['核对之后', '明确解除保存限制，再开始新的保存；不重放原请求']]) + '</div>' + footer(demo('读取已保存内容', '仅展示核对读取；没有访问真实配置') + action('演示已核对，允许新的保存', 'editorReleaseUnknown', '', 'primary')));
  register('editor-read-error', '读取错误详情', '只读演示信息。', () => info([['错误', 'demo_read_unavailable'], ['影响', '没有取得新快照，旧草稿和已知状态保留'], ['下一步', '检查服务状态后重新读取；当前设计稿不连接服务']]), { drawer: true });

  UI.actions.editorOpen = button => { UI.open(button.dataset.editorDialog, { fresh: true }); };
  UI.actions.editorPick = button => {
    const kind = button.dataset.editorKind;
    if (!Object.prototype.hasOwnProperty.call(state, kind)) return;
    state[kind] = Number(button.dataset.editorIndex);
    UI.render();
  };
  UI.actions.editorSaveDraft = button => {
    const kind = button.dataset.editorKind;
    clearEditorSecrets();
    state.saved[kind] = Object.assign({}, state.values);
    state.dirty[kind] = false;
    const entries = kind === 'persona' ? state.personas : kind === 'plan' ? state.plans : kind === 'provider' ? state.providers : null;
    if (entries && value(prefix(kind) + 'name', '').trim()) entries[state[kind]].name = value(prefix(kind) + 'name', entries[state[kind]].name);
    if (button.closest('dialog') && UI.close) UI.close();
    UI.render();
    UI.notify('已保留演示草稿；没有保存真实配置或应用运行环境。');
  };
  UI.actions.editorResetDraft = button => {
    const kind = button.dataset.editorKind;
    const key = kind === 'assistant' ? 'assistant.' : prefix(kind);
    Object.keys(state.values).filter(item => item.startsWith(key)).forEach(item => { delete state.values[item]; });
    Object.keys(state.saved[kind] || {}).filter(item => item.startsWith(key)).forEach(item => { state.values[item] = state.saved[kind][item]; });
    state.dirty[kind] = false;
    UI.render();
    UI.notify('已撤销当前演示编辑；未改变真实数据。');
  };
  UI.actions.editorCreate = button => {
    if (locked()) { UI.notify('当前为加载或结果未知的演示状态，暂不创建新的草稿。'); return; }
    const kind = button.dataset.editorKind;
    const template = button.dataset.editorTemplate === 'true';
    const key = (template ? 'template-' : 'new-') + kind + '.';
    const fallback = template ? ({ persona: '演示 · 小鲸鱼模板', plan: '演示 · 内置日常方案' }[kind] || '演示 · 新模型服务') : ({ persona: '演示 · 新伙伴', plan: '演示 · 新聊天方案', provider: '演示 · 新模型服务' }[kind] || '演示 · 新项目');
    const name = String(value(key + 'name', fallback)).trim();
    if (!name) {
      const message = button.closest('.dialog')?.querySelector('[data-editor-validation]');
      if (message) { message.hidden = false; message.textContent = '名称不能为空，请填写后再创建演示草稿。'; }
      return;
    }
    const entries = kind === 'persona' ? state.personas : kind === 'plan' ? state.plans : state.providers;
    const item = kind === 'persona' ? { name, sub: '新建演示草稿', identity: value(key + 'identity', '新的离线示例身份。'), style: value(key + 'style', '自然、简洁。') }
      : kind === 'plan' ? { name, sub: '新建演示草稿', active: false }
        : { name, api: value('new-provider.protocol', 'OpenAI Chat Completions'), enabled: value('new-provider.enabled', true), secret: false };
    entries.push(item); state[kind] = entries.length - 1; state.dirty[kind] = true;
    Object.keys(state.values).filter(keyName => keyName.startsWith(key)).forEach(keyName => { state.values[prefix(kind) + keyName.slice(key.length)] = state.values[keyName]; });
    if (UI.close) UI.close();
    UI.render();
    UI.notify('新演示草稿已出现在左侧目录；没有创建真实配置。');
  };
  UI.actions.editorAdoptCapacity = () => {
    state.values[prefix('plan') + 'groupContext'] = '96000'; state.values[prefix('plan') + 'privateContext'] = '112000'; state.dirty.plan = true;
    document.querySelectorAll('[data-editor-bind]').forEach(input => { if (input.dataset.editorBind === prefix('plan') + 'groupContext') input.value = '96000'; if (input.dataset.editorBind === prefix('plan') + 'privateContext') input.value = '112000'; });
    UI.notify('只采用离线演示容量建议；真实模型容量仍需读取元数据。');
  };
  UI.actions.editorModelEdit = button => { state.model = Number(button.dataset.editorIndex); UI.open('editor-model-edit', { fresh: true }); };
  UI.actions.editorModelDelete = button => { state.model = Number(button.dataset.editorIndex); UI.open('editor-model-delete', { fresh: true }); };
  UI.actions.editorCommitModel = button => {
    if (locked()) { UI.notify('当前保存结果仍待核对，不能提交新的目录编辑。'); return; }
    const fresh = button.dataset.editorNew === 'true'; const k = fresh ? 'new-model.' : 'model.' + state.model + '.';
    const old = fresh ? { name: '演示 · 新模型', id: 'demo-new-model', used: '无引用' } : state.models[state.model];
    const next = { name: String(value(k + 'name', old.name)), id: String(value(k + 'id', old.id)), used: old.used };
    if (!next.id.trim()) { const error = button.closest('.dialog')?.querySelector('[data-editor-validation]'); if (error) { error.hidden = false; error.textContent = 'API 模型 ID 不能为空，请填写服务商要求的标识。'; } return; }
    if (fresh) state.models.push(next); else state.models[state.model] = next;
    state.dirty.provider = true;
    if (UI.close) UI.close();
    UI.render(); UI.notify('模型已更新到演示服务草稿；仍需保存提供方。');
  };
  UI.actions.editorUseModel = button => {
    if (locked()) { UI.notify('当前结果尚未确认，先核对原操作。'); return; }
    state.values[prefix('plan') + 'model'] = state.models[Number(button.dataset.editorIndex)].name; state.dirty.plan = true;
    if (UI.close) UI.close();
    UI.render(); UI.notify('已返回原演示方案草稿；没有保存或应用聊天。');
  };
  UI.actions.editorWorkDetail = button => { state.work = Number(button.dataset.editorIndex); UI.open('editor-work-details', { fresh: true }); };
  UI.actions.editorReleaseUnknown = () => { UI.state = 'normal'; const chooser = document.getElementById('state-mode'); if (chooser) chooser.value = 'normal'; if (UI.close) UI.close(); UI.render(); UI.notify('已切回正常演示状态；没有重放任何真实请求。'); };
  function clearEditorSecrets(root = document) {
    root.querySelectorAll('input[data-editor-bind$=".secret"]').forEach(input => { input.value = ''; });
  }
  document.addEventListener('click', event => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest('button');
    if (button && (button.dataset.page || button.hasAttribute('data-close') || ['editorPick', 'editorSaveDraft', 'editorCreate'].includes(button.dataset.action))) clearEditorSecrets();
  }, true);
  document.addEventListener('close', event => { if (event.target instanceof HTMLDialogElement) clearEditorSecrets(event.target); }, true);
  document.addEventListener('input', event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement || input instanceof HTMLTextAreaElement)) return;
    const key = input.dataset.editorBind;
    if (key) {
      if (!key.endsWith('.secret')) state.values[key] = input.type === 'checkbox' ? input.checked : input.value;
      const kind = key.split('.')[0];
      if (['persona', 'plan', 'provider', 'assistant'].includes(kind)) {
        state.dirty[kind] = true;
        document.querySelectorAll('[data-editor-dirty="' + kind + '"]').forEach(item => { item.textContent = '未保存演示草稿'; });
      }
    }
    if (input.dataset.editorConfirm) {
      const target = document.getElementById(input.dataset.editorConfirm);
      if (target) target.disabled = input.value !== input.dataset.expected;
    }
  });
  document.addEventListener('change', event => {
    if (event.target instanceof HTMLSelectElement && event.target.dataset.editorBind === 'assistant.mode') UI.render();
  });
}());
