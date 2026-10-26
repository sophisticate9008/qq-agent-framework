(function () {
  const { esc, badge, button, field, area, check, tip, panel, entity, table, tabs, details } = UI;
  let chatState = 'running';
  let qqConnected = true;

  const open = (label, id, kind = '') => button(label, `data-open="${id}"`, kind);
  const demo = (label, text, kind = '') => button(label, `data-demo="${esc(text)}"`, kind);
  const save = (label, text) => button(label, `data-save="${esc(text)}" ${noWrite() ? 'disabled' : ''}`, 'primary');
  const footer = (message, actions) => `<div class="footer"><span class="muted grow">${message}</span>${actions}</div>`;
  const info = entries => `<dl class="info">${entries.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>`;
  const note = text => `<div class="strip">${text}</div>`;
  const warn = text => `<div class="strip warn">${text}</div>`;
  const noWrite = () => UI.state === 'unknown' || UI.state === 'loading';
  const status = () => UI.state === 'loading' ? '正在读取' : UI.state === 'unknown' ? '结果待核对' : UI.state === 'error' ? '需要处理' : chatState === 'running' ? '聊天已启用' : '聊天已停止';
  const tone = () => UI.state === 'error' ? 'bad' : UI.state === 'unknown' ? 'warn' : UI.state === 'loading' || chatState !== 'running' ? 'neutral' : 'good';

  function stateBanner(scope) {
    if (UI.state === 'loading') return `<div class="summaryline"><span class="muted">正在读取${scope}…（离线状态示例）</span>${demo('读取说明', '这里只展示加载状态，没有发送网络请求。', 'link')}</div>`;
    if (UI.state === 'error') return `<div class="strip bad row"><strong>读取失败示例</strong><span class="grow">暂时无法确认${scope}，保留已保存的设置与草稿。</span>${demo('重新读取', '仅演示重新读取入口，不把现有示例当作真实读取结果。')}${open('查看原因', 'conn-state-examples', 'link')}</div>`;
    if (UI.state === 'unknown') return `<div class="strip warn row"><strong>上次操作结果未确认</strong><span class="grow">保留草稿，暂停新的写入，先核对原操作。</span>${open('核对与恢复', scope === '连接状态' ? 'conn-runtime-recovery' : 'conn-admin-recovery')}</div>`;
    return '';
  }

  function credential(label, role) {
    return `<div class="stack" data-credential="${role}"><div class="setting"><label>${label}</label><select aria-label="${label}操作" data-credential-action><option value="keep">保留已保存凭据</option><option value="replace">输入新凭据</option><option value="clear">清除已保存凭据</option></select>${badge('已保存', 'neutral')}${tip('凭据只写入服务端，不回显；这里没有填入任何真实凭据。')}</div><div data-credential-value hidden>${field('新凭据', '', { type: 'password', placeholder: '演示不填写真实凭据' })}</div><p class="small danger-text" data-credential-warning hidden>保存后将清除这项凭据。</p></div>`;
  }

  function recoveryBody(source, external) {
    return `<div class="stack" data-recovery-scope>${warn(`${source}上次写入结果待核对，新的保存${external ? '和应用' : ''}暂时锁定。`)}
      <p>重新读取保留当前草稿，只核对已保存内容。${external ? '配置内容相等不能证明服务重启或外部操作完成。' : '读取后仍需确认原操作已经结束。'}</p>
      <div class="summaryline"><span class="muted">配置来源</span><strong>${source}</strong><span class="muted">原操作</span><span class="mono">示例操作标识</span></div>
      <p class="small muted" role="status" data-recovery-message>尚未重新读取。这是未知结果的离线示例，不会重放旧请求。</p>
      <div class="actions">${button('重新读取并核对', 'data-action="conn-review-recovery"')}${button('确认旧操作已结束，允许新操作', 'data-action="conn-release-recovery" data-recovery-release disabled')}</div>
      ${note('允许新操作只解除写入保护，不代表旧操作成功，也不会自动保存、应用或重新执行。')}
    </div>`;
  }

  UI.pages.connections = {
    title: '连接',
    sub: 'QQ 收发、聊天引擎与运行状态 · 离线示例',
    render: () => `<div class="stack">${stateBanner('连接状态')}<div class="grid3">
      ${entity('↔', 'QQ 消息连接', 'OneBot · HTTP 发送 / WebSocket 接收', UI.state === 'loading' ? '读取中' : UI.state === 'error' ? '连接待检查' : qqConnected ? 'WebSocket 已连接' : 'WebSocket 未连接', ['HTTP 发送已启用', '消息接收：WebSocket', '账号：演示已核验'], UI.state === 'error' ? '连接失败示例：核对协议服务、地址与鉴权。' : '接收 42 条 · 丢弃 0 条（示例）。协议连接与聊天启停分别管理。', `${open('编辑连接', 'conn-qq-edit')}${open('连接维护', 'conn-protocol-control')}${details('详情', 'conn-qq-details')}`, UI.state === 'error' ? 'bad' : qqConnected ? 'good' : 'neutral')}
      ${entity('◇', 'DSH 聊天引擎', '本机自动发现与鉴权', '本机连接已配置', ['连接已启用', '本机鉴权已配置'], '配置就绪与运行状态分别显示；启动聊天时核对实际连接。', `${open('自动连接本机', 'conn-dsh-discover', 'primary')}${open('手动连接', 'conn-dsh-edit')}${details('详情', 'conn-dsh-details')}`)}
      ${entity('▷', '聊天运行', '已授权的 QQ 会话', status(), ['QQ 消息：示例已连接', 'DSH：示例已就绪'], UI.state === 'unknown' ? '启停结果未确认；暂停后续操作并核对停止、排空状态。' : chatState === 'running' ? '正在处理白名单内消息；停止会保留聊天历史和发送记录。' : '聊天已停止；可检查条件后明确启动。', `${open(chatState === 'running' ? '停止聊天' : '启动聊天', 'conn-runtime-control', chatState === 'running' ? '' : 'primary')}${demo('刷新状态', '仅展示状态刷新入口，不请求服务。')}${details('详情', 'conn-runtime-details')}`, tone())}
    </div>
    <div class="summaryline"><span class="muted">相关设置</span>${button('主人与白名单', 'data-page="security"', 'link')}${button('聊天方案', 'data-page="plans"', 'link')}<span class="push muted small">${UI.state === 'normal' ? '当前没有需要处理的连接问题（示例）。' : '编辑窗口保留草稿，连接保存不会自动启动聊天。'}</span>${open('状态与恢复示例', 'conn-state-examples', 'link')}</div>
    ${UI.state === 'unknown' ? panel('需要处理', `<div class="row"><span class="grow">先前启停尚未确认，当前操作保持保护。</span>${open('核对启停结果', 'conn-runtime-recovery')}</div>`) : UI.state === 'error' ? panel('需要处理', `<div class="row"><span class="grow">QQ 连接失败示例：请核对 WebSocket 地址、协议端专用密钥和登录状态。</span>${open('编辑连接', 'conn-qq-edit')}${open('查看诊断', 'conn-qq-details', 'link')}</div>`) : ''}
    </div>`
  };

  UI.pages.security = {
    title: '访问与设置',
    sub: '主人、会话范围、处理期限与管理服务 · 离线示例',
    render: () => `<div class="stack">${stateBanner('设置状态')}<div class="grid2">
      ${panel('主人与白名单', `<div class="stack"><div class="row"><span class="muted">主人账号</span><strong>•••001（示例隐去）</strong>${tip('主人由真实 QQ 用户号确定，管理页面登录身份不会授予 QQ 主人权限。')}</div><div class="row"><strong>群聊</strong><span class="muted small">2 项</span><span class="chip">群号 •••101</span><span class="chip">群号 •••102</span></div><div class="row"><strong>私聊</strong><span class="muted small">1 项</span><span class="chip">用户号 •••201</span></div>${note('同一份白名单允许接收和回复；敏感操作核验实际主人。')}${footer('示例号码已隐去', `${open('编辑名单', 'conn-access-edit', 'primary')}${open('拒绝名单', 'conn-access-deny')}${details('规则说明', 'conn-access-details')}`)}</div>`, badge('3 项会话'))}
      ${panel('回复与超时', `<div class="stack" data-execution-scope><div class="formgrid">${field('总期限（秒）', '120', { type: 'number', attrs: 'min="0.01" max="300" step="0.01"', tip: '范围 0.01–300 秒；从收到任务起计时，进度输出不延长期限。' })}${field('并行会话', '256', { type: 'number', attrs: 'min="1" max="256"', tip: '1–256 个活动执行；完整处理参数见高级设置。' })}</div><div class="checks"><label class="check"><input type="checkbox" data-execution-cancel-toggle checked>请求停止超时任务</label><label class="check"><input type="checkbox" data-execution-notice-toggle>超时后发送提醒</label></div><div data-execution-notice-area hidden>${area('超时提醒内容', '请求已超时，结果尚未确认，未自动重复提交。', 3)}</div>${note('结果未确认时暂停该会话；其他会话继续处理，迟到结果仅留档。')}${footer('保存后重启聊天生效', `${open('高级处理设置', 'conn-execution-advanced')}${save('保存处理策略', '保存回复处理策略的离线示例；没有修改运行中的聊天。')}`)}</div>`, `${open('重新读取', 'conn-execution-read', 'link')}`)}
    </div>
    ${panel('管理服务', `<div class="stack"><div class="formgrid three">${field('监听地址', '127.0.0.1', { tip: '可填写 localhost、IPv4 或 IPv6；保存后需应用并重启。' })}${field('监听端口', '3210', { type: 'number', attrs: 'min="1" max="65535"', tip: '范围 1–65535。' })}<div class="setting"><label>应用状态</label>${badge('已保存', 'neutral')}</div></div>${footer('先保存，再应用并重启；重启后需重新登录', `${open('高级设置', 'conn-admin-advanced')}${open('应用并重启', 'conn-admin-restart')}${save('保存监听设置', '监听设置保存演示，重启需明确点击应用并重启。')}`)}</div>`, details('部署信息', 'conn-admin-files'))}
    ${UI.state === 'unknown' || UI.state === 'error' ? `<div class="summaryline"><strong>核对原操作</strong><span class="muted grow">保留原请求和草稿，核对后再继续。</span>${open('名单保存', 'conn-access-recovery', 'link')}${open('处理策略保存', 'conn-execution-recovery', 'link')}${open('管理服务操作', 'conn-admin-recovery', 'link')}</div>` : `<div class="row">${open('状态与恢复示例', 'conn-state-examples', 'link')}</div>`}
    </div>`
  };

  UI.dialogs['conn-qq-edit'] = {
    title: 'QQ 消息收发', sub: 'HTTP 发送与 WebSocket 接收分别配置；关闭保留草稿。',
    render: () => `<div class="stack"><div class="row"><strong>WebSocket 收消息</strong>${badge('已配置', 'neutral')}</div><div class="checks">${check('启用 WebSocket 收消息', true)}</div>${field('消息连接', 'ws://127.0.0.1:3001', { wide: true, tip: '本机可用 ws://，远程使用 wss://；不要在地址中放入凭据或查询参数。' })}${credential('WebSocket 密钥', 'qq-websocket')}<div class="row"><strong>HTTP 发送</strong>${tip('填写协议端 HTTP 服务地址和专用访问密钥。')}</div><div class="checks">${check('启用 HTTP 发送', true)}</div>${field('发送地址', 'http://127.0.0.1:3000', { wide: true })}${credential('HTTP API 密钥', 'qq-http')}${note('聊天停止时，保存启用设置会自动尝试连接 WebSocket；运行期间的连接变更需重启聊天生效。')}<div class="actions">${open('其他接收方式：Webhook', 'conn-webhook-edit', 'link')}${open('保存冲突与未知结果', 'conn-connection-recovery', 'link')}</div>${footer('账号在连接时自动识别；所有地址均为示例', `${demo('撤销草稿', '演示恢复已保存的 QQ 连接草稿。')}${save('保存连接配置', '仅保存示例连接草稿，不连接协议，也不启动聊天。')}`)}</div>`
  };

  UI.dialogs['conn-webhook-edit'] = {
    title: 'Webhook 接收消息', sub: '协议端主动推送的替代接收方式，与 WebSocket 二选一。',
    render: () => `<div class="stack">${warn('当前示例实例没有启动 webhook 监听。填写设置不代表监听已运行。')}<div class="checks">${check('启用 webhook 接收', false)}</div><div class="formgrid">${field('监听地址', '127.0.0.1', { tip: '只监听本机回环地址：127.0.0.1、::1 或 localhost。' })}${field('监听端口', '3211', { type: 'number', tip: '启用时为 1–65535，停用时可保留为 0。' })}${field('机器人账号', '', { placeholder: '演示不预填真实 QQ 账号', wide: true, tip: '实际使用填写 1–32 位正整数。' })}</div>${credential('签名密钥', 'qq-webhook')}${note('启用前需要设置机器人账号和签名密钥，并停用 WebSocket 接收。')}${footer('保存仍使用同一份 QQ 连接配置', save('保存连接配置', 'Webhook 连接配置保存示例；没有启动监听服务。'))}</div>`
  };

  UI.dialogs['conn-qq-details'] = {
    title: 'QQ 连接详情', sub: '连接、接收计数与最近诊断，全部为离线示例。', drawer: true,
    render: () => `<div class="stack">${info([['接收方式', 'WebSocket'], ['发送方式', 'HTTP'], ['连接状态', qqConnected ? '已连接（示例）' : '已断开（示例）'], ['机器人账号', '示例号码已隐去'], ['接收消息', '42 条（示例）'], ['丢弃消息', '0 条（示例）'], ['最近错误', UI.state === 'error' ? '协议连接失败（状态示例）' : '无（示例）'], ['配置版本', '示例版本，仅在详情展示']])}${UI.state === 'error' ? `<div class="strip bad">核对协议端服务是否运行、WebSocket 地址是否可达，以及实际登录状态。</div>${info([['诊断码', 'onebot_ws_connection_failed（示例）']])}` : note('连接恢复后，历史异常仍可保留供核对；当前状态以最新读取为准。')}${open('连接维护', 'conn-protocol-control')}</div>`
  };

  UI.dialogs['conn-protocol-control'] = {
    title: 'QQ 连接维护', sub: '手动重连或断开不会调用模型。',
    render: () => `<div class="stack" data-protocol-scope>${info([['当前连接', qqConnected ? '已连接（示例）' : '已断开（示例）'], ['聊天处理', chatState === 'running' ? '正在运行（示例）' : '已停止（示例）']])}${chatState === 'running' ? warn('先停止聊天，再手动管理 WebSocket 连接。') : note('已经停止聊天，可在启用并保存 WebSocket 后重连；手动断开会保留到下次保存、管理服务重启或启动聊天。')}<div class="actions">${open('聊天启停', 'conn-runtime-control')}${button('重新连接', 'data-action="conn-protocol-connect"')}${button('断开 WebSocket', 'data-action="conn-protocol-disconnect"')}</div><p class="small muted" data-protocol-message role="status">本窗口只演示连接维护，不访问协议端。</p></div>`
  };

  UI.dialogs['conn-dsh-edit'] = {
    title: '手动或远程 DSH 连接', sub: '本机优先自动发现，手动接入使用固定地址与专用凭据。',
    render: () => `<div class="stack"><div class="checks">${check('启用 DSH 聊天引擎连接', true)}</div>${field('服务地址', 'https://dsh.example.test', { wide: true, tip: '本机可使用 HTTP；远程使用 HTTPS，地址不含凭据、查询参数或片段。' })}${credential('引擎访问凭据', 'dsh-agent')}${note('手动设置仅在明确保存时生效；保存连接不会自动启动聊天。')}${footer('关闭保留草稿，凭据不回显', `${open('自动连接本机', 'conn-dsh-discover')}${save('保存连接配置', '保存手动 DSH 连接的离线示例，没有访问远程服务。')}`)}</div>`
  };

  UI.dialogs['conn-dsh-discover'] = {
    title: '自动连接本机 DSH', sub: '自动识别本机地址与鉴权，用户无需填写令牌或凭据路径。',
    render: () => `<div class="stack">${note('此操作保存本机连接，不启动聊天、不调用模型。已有手动设置只在明确点击后切换。')}${UI.state === 'loading' ? note('正在识别本机连接…（离线加载状态）') : UI.state === 'error' ? `<div class="strip bad">自动发现失败示例：请确认本机 DSH 可用；原有草稿保留。</div>` : UI.state === 'unknown' ? warn('自动连接保存结果待核对，不能直接再次提交。') : info([['接入方式', '本机自动发现（示例）'], ['鉴权', '本机鉴权已配置（示例）'], ['聊天启停', '单独管理']])}${footer('离线稿不会探测本机进程或读取配置', UI.state === 'unknown' ? open('读取并核对', 'conn-connection-recovery') : button('自动连接并保存', 'data-action="conn-discover-dsh"', 'primary'))}</div>`
  };

  UI.dialogs['conn-dsh-details'] = {
    title: 'DSH 连接详情', sub: '区分连接配置、实际运行状态与模型请求结果。', drawer: true,
    render: () => `<div class="stack">${info([['接入方式', '本机自动发现（示例）'], ['连接启用', '是（示例）'], ['本机鉴权', '已配置（示例）'], ['运行就绪', chatState === 'running' ? '聊天已就绪（示例）' : '尚未启动（示例）'], ['模型调用验证', '启动检查只核对连接与配置，不发送模型请求'], ['服务地址', '由本机发现获得；离线稿没有实际地址'], ['配置版本', '示例版本，仅在详情展示']])}${note('实际请求、回复与失败通过对应会话和执行记录核对。')}${button('查看会话', 'data-page="sessions"')}</div>`
  };

  UI.dialogs['conn-runtime-control'] = {
    title: '聊天启停', sub: '启动前核对账号与引擎；停止保留会话上下文和发送记录。',
    render: () => `<div class="stack" data-runtime-scope><div class="row"><strong>当前状态</strong><span data-runtime-text>${badge(status(), tone())}</span></div><div class="summaryline"><span>QQ 消息 <strong>${qqConnected ? '示例已连接' : '示例未连接'}</strong></span><span>DSH <strong>示例已配置</strong></span><span>配置 <strong>示例已保存</strong></span></div>${UI.state === 'unknown' ? warn('先前操作没有确认结果，新的启停已暂停。') : note('启动检查不会调用模型；已有设置若需应用，会在同一次启动流程中核对。')}<div class="actions">${button('启动聊天', `data-action="conn-start-chat" data-chat-start ${noWrite() || chatState === 'running' ? 'disabled' : ''}`, 'primary')}${button('停止聊天', `data-action="conn-stop-chat" data-chat-stop ${noWrite() || chatState === 'stopped' ? 'disabled' : ''}`)}${demo('刷新状态', '仅演示读取运行状态；不会重复启停。')}${open('核对与恢复', 'conn-runtime-recovery', 'link')}</div><p class="small muted">这里的状态切换只发生在设计稿内存中，没有启动或停止任何真实服务。</p></div>`
  };

  UI.dialogs['conn-runtime-details'] = {
    title: '聊天运行详情', sub: '保存、应用和运行中配置分别核对。', drawer: true,
    render: () => `<div class="stack">${info([['运行状态', status() + '（示例）'], ['聊天就绪', chatState === 'running' && UI.state === 'normal' ? '是（示例）' : '待核对（示例）'], ['已保存设置', '示例版本 A'], ['运行中设置', '示例版本 A'], ['配置变化', '无待应用变化（示例）'], ['活动操作', UI.state === 'unknown' ? '示例原操作：结果未知' : '无（示例）'], ['检查范围', '连接与配置'], ['模型请求', '启动检查不调用模型']])}${UI.state === 'unknown' ? warn('未知结果不能通过刷新页面、清理统计或重复启动来结算。') : note('更新人设和聊天方案分别在对应编辑页应用。')}${open('启停状态核对', 'conn-runtime-recovery')}</div>`
  };

  UI.dialogs['conn-runtime-recovery'] = {
    title: '核对未知启停结果', sub: '只读取原操作证据，不重复启动或停止。',
    render: () => `<div class="stack" data-runtime-recovery>${warn('先前启停结果尚未确认。恢复前需要证实聊天停止且没有待排空操作。')}${info([['原操作', '示例启停操作号'], ['停止证据', '尚未读取（示例）'], ['待排空状态', '尚未确认（示例）']])}<p data-runtime-proof class="small muted" role="status">读取状态只核对证据；证据不足时保护继续保留。</p><div class="actions">${button('读取当前停止状态', 'data-action="conn-read-runtime-proof"')}${button('恢复操作', 'data-action="conn-restore-runtime" data-runtime-restore disabled')}${details('运行详情', 'conn-runtime-details')}</div>${note('恢复只重新开放管理操作，保留会话记录；它不会重放原请求。')}</div>`
  };

  UI.dialogs['conn-access-edit'] = {
    title: '主人与消息白名单', sub: '群聊、私聊分别填写；示例不预填真实账号。',
    render: () => `<div class="stack">${field('主人账号', '', { placeholder: '实际使用填写 QQ 用户号', tip: '1–20 位数字，留空表示未指定主人。网页登录不会授予 QQ 主人身份。' })}<div class="editorgrid">${area('群聊白名单', '', 5)}${area('私聊白名单', '', 5)}</div>${note('填写纯数字号码，多个号码用逗号隔开；白名单为空时默认不接收或回复任何会话。')}<div class="actions">${open('拒绝名单', 'conn-access-deny')}${details('访问规则', 'conn-access-details')}${open('冲突与未知结果', 'conn-access-recovery', 'link')}</div>${footer('示例摘要中的号码已隐藏，编辑区不填真实号码', `${demo('撤销草稿', '恢复已保存名单的演示状态。')}${save('保存名单', '名单保存的离线演示，不授予任何真实账号权限。')}`)}</div>`
  };

  UI.dialogs['conn-access-deny'] = {
    title: '消息拒绝名单', sub: '与白名单、主人账号一起保存，不单独扩展授权。',
    render: () => `<div class="stack"><div class="editorgrid">${area('群聊拒绝名单', '', 5)}${area('私聊拒绝名单', '', 5)}</div>${warn('同一个会话不能同时出现在允许名单和拒绝名单中。')}${note('只填写对应群号或私聊用户号；编辑区没有预填真实账号。')}${footer('修改后保存同一份访问设置', save('保存访问设置', '拒绝名单保存演示，没有改变真实访问范围。'))}</div>`
  };

  UI.dialogs['conn-access-details'] = {
    title: '访问规则与状态', sub: '名单决定会话准入，主人身份单独核验。', drawer: true,
    render: () => `<div class="stack">${info([['群聊白名单', '允许对应群会话接收和回复，不额外过滤群成员'], ['私聊白名单', '只控制对应用户的私聊'], ['空白名单', '默认全部拒绝'], ['拒绝名单', '排除指定会话；与允许名单不能重叠'], ['工具使用', '按所属会话白名单开放'], ['敏感操作', '核验当前消息的实际配置主人'], ['模型提问', '发回所属 QQ 会话，由主人在 QQ 内答复'], ['网页职责', '配置、统计与只读状态'], ['配置版本', '示例版本，保留冲突核对依据']])}${note('当前设计稿没有网页工具批准或模型答复入口。')}</div>`
  };

  UI.dialogs['conn-execution-advanced'] = {
    title: '回复与超时参数', sub: '同一份处理策略，保存后重启聊天生效。',
    render: () => `<div class="stack" data-execution-scope><div class="formgrid">${field('总期限（秒）', '120', { type: 'number', attrs: 'min="0.01" max="300" step="0.01"', tip: '0.01–300 秒；包含提交与等待完整回复。' })}${field('最大并行数', '256', { type: 'number', attrs: 'min="1" max="256"', tip: '1–256 个活动执行。' })}<div data-execution-cancel-area>${field('停止等待（秒）', '5', { type: 'number', attrs: 'min="0.01" max="30" step="0.01"', tip: '0.01–30 秒；超时停止请求的确认等待期限。' })}</div><div data-execution-notice-area hidden>${field('提醒等待（秒）', '5', { type: 'number', attrs: 'min="0.01" max="30" step="0.01"', tip: '0.01–30 秒；无法确认提醒发送时不自动重发。' })}</div></div><div class="checks"><label class="check"><input type="checkbox" data-execution-cancel-toggle checked>请求停止超时任务</label><label class="check"><input type="checkbox" data-execution-notice-toggle>超时后发送提醒</label></div><div data-execution-notice-area hidden>${area('超时提醒内容', '请求已超时，结果尚未确认，未自动重复提交。', 3)}<p class="small muted">最多 8000 字符；开启提醒后不能为空。</p></div>${note('停止请求受理不代表任务已经停止。结果未知时隔离所属会话，其他会话继续；迟到终态仅留档。')}${footer('关闭窗口保留草稿', `${open('保存结果核对', 'conn-execution-recovery', 'link')}${save('保存处理策略', '处理期限、并行数与通知参数保存演示；没有重启聊天。')}`)}</div>`
  };

  UI.dialogs['conn-execution-read'] = {
    title: '重新读取处理策略', sub: '重新读取保留当前未保存草稿，并核对保存版本。',
    render: () => `<div class="stack">${note('服务读取失败时显示错误，不将未取得的数据当成默认值或已保存配置。')}<div class="actions">${demo('重新读取', '离线稿只展示读取入口，未取得任何真实配置。', 'primary')}${open('写入结果待确认', 'conn-execution-recovery')}</div></div>`
  };

  UI.dialogs['conn-admin-advanced'] = {
    title: '管理端高级设置', sub: '仅包含当前管理服务提供的配置，保存后重启生效。',
    render: () => `<div class="stack"><h3>HTTPS 反向代理</h3>${field('公开 HTTPS 来源', '', { placeholder: 'https://console.example.test', wide: true, tip: '精确 HTTPS origin，不带路径、账号、查询或尾斜杠；留空使用普通本机 HTTP。' })}<div class="row">${check('信任本机 TLS 代理', false)}${tip('仅用于本机 TLS 终止代理；公开来源与信任选项必须同时配置，后端绑定回环 IP。仅信任实际回环连接，不信任转发协议头。')}${demo('恢复继承', '演示将代理选项恢复为服务默认继承。', 'link')}</div>${footer('保存此组后另行重启管理服务', save('保存代理设置', '仅演示保存 HTTPS 代理配置，不更改任何真实监听或代理。'))}<h3>访问会话</h3>${field('有效期（毫秒）', '604800000', { type: 'number', attrs: 'min="300000" max="2592000000"', tip: '默认 7 天；范围 300000–2592000000 毫秒，最长 30 天。到期或管理服务重启后重新登录。' })}<div class="row"><span class="muted small grow">管理员凭据只用于登录验证；主动退出立即注销访问会话。</span>${demo('恢复继承', '演示恢复访问会话有效期的服务默认值。', 'link')}</div>${footer('此处不显示凭据内容', save('保存访问会话设置', '保存访问会话期限的离线演示。'))}<div class="row">${open('只读部署文件', 'conn-admin-files')}${open('保存与重启结果核对', 'conn-admin-recovery', 'link')}</div></div>`
  };

  UI.dialogs['conn-admin-files'] = {
    title: '管理服务部署信息', sub: '路径只读；这里全部使用演示路径，没有读取文件内容。', drawer: true,
    render: () => `<div class="stack">${info([['管理令牌文件', '/example/private/admin-token（示例）'], ['网关配置文件', '/example/config/gateway.json（示例）'], ['受信服务管理程序', '/example/bin/service-manager（示例）'], ['管理地址', '127.0.0.1:3210（示例）'], ['在线应用能力', '取决于实际管理服务；当前展示受管重启示例']])}${note('部署文件位置不能在网页修改，也不能通过网页传入命令参数；令牌内容不回显。')}</div>`
  };

  UI.dialogs['conn-admin-restart'] = {
    title: '应用并重启管理服务', sub: '先保存设置，再明确应用；重启会中断当前管理连接。',
    render: () => `<div class="stack">${warn('管理服务重启后需要按保存的地址重新登录；QQ 聊天上下文保留。')}${info([['将使用的监听地址', '127.0.0.1:3210（示例）'], ['未保存草稿', '请先保存或撤销，实际存在草稿时应用入口锁定'], ['在线应用能力', '服务未提供受管重启时，只保存并手动重启']])}<div class="actions">${button('确认应用并重启', `data-open="conn-admin-reconnect" ${noWrite() ? 'disabled' : ''}`, 'primary')}${open('结果未知时如何恢复', 'conn-admin-recovery', 'link')}</div></div>`
  };

  UI.dialogs['conn-admin-reconnect'] = {
    title: '管理服务重启已受理（示例）', sub: '受理不等于重启完成，按新地址重新连接后核对。',
    render: () => `<div class="stack">${badge('等待重新连接', 'warn')}${note('新页面不会自动携带当前访问令牌，请重新登录。离线稿不会打开本机管理地址。')}${info([['新地址', 'http://127.0.0.1:3210（示例）']])}<div class="actions">${demo('使用新地址重新连接', '演示新地址的重新登录入口；没有连接真实管理服务。', 'primary')}${open('无法确认结果', 'conn-admin-recovery')}</div></div>`
  };

  UI.dialogs['conn-connection-recovery'] = { title: '核对连接配置写入', sub: '冲突、忙碌和未知结果共用原配置版本核对。', render: () => recoveryBody('连接配置', false) };
  UI.dialogs['conn-access-recovery'] = { title: '核对名单保存结果', sub: '保留当前名单草稿与原保存依据。', render: () => recoveryBody('主人与白名单', false) };
  UI.dialogs['conn-execution-recovery'] = { title: '核对处理策略保存', sub: '保存未确认时暂停新的提交。', render: () => recoveryBody('回复处理策略', false) };
  UI.dialogs['conn-admin-recovery'] = { title: '核对管理端保存或重启', sub: '区分保存版本与外部服务实际结果。', render: () => recoveryBody('管理服务', true) };

  UI.dialogs['conn-state-examples'] = {
    title: '连接与设置的状态示例', sub: '这些是可切换的离线状态，不代表执行了真实检查。', wide: true,
    render: () => tabs('conn-states', ['读取中', '失败', '结果未知'], [
      `<div class="stack">${note('正在读取连接或处理策略，暂时锁定写入入口。')}${demo('重新读取', '加载状态演示，没有访问服务。')}</div>`,
      `<div class="stack"><div class="strip bad">协议服务不可达（失败示例）。设置与草稿保留。</div><div class="actions">${open('核对 QQ 地址与密钥', 'conn-qq-edit')}${open('最近诊断', 'conn-qq-details')}${button('查看模型服务', 'data-page="providers"')}</div>${table(['失败范围', '对应操作'], [['QQ 接收连接', '检查协议服务、WebSocket 地址、密钥与登录状态'], ['聊天启动', '核对实际账号、模型连接、人设方案与白名单'], ['配置保存', '保留草稿，重新读取当前配置版本']])}</div>`,
      `<div class="stack">${warn('未知结果不自动重试。保存、启停和服务重启分别核对。')}<div class="actions">${open('连接配置写入', 'conn-connection-recovery')}${open('聊天启停', 'conn-runtime-recovery')}${open('管理服务重启', 'conn-admin-recovery')}</div></div>`
    ])
  };

  function updateRuntimeWindow(buttonNode) {
    const scope = buttonNode.closest('[data-runtime-scope]');
    if (!scope) return;
    scope.querySelector('[data-runtime-text]').innerHTML = badge(status(), tone());
    scope.querySelector('[data-chat-start]').disabled = noWrite() || chatState === 'running';
    scope.querySelector('[data-chat-stop]').disabled = noWrite() || chatState === 'stopped';
  }

  Object.assign(UI.actions, {
    'conn-start-chat': function (buttonNode) {
      if (noWrite()) { UI.notify('未知结果或读取中，演示保持启停保护。'); return; }
      chatState = 'running'; qqConnected = true; UI.render(); updateRuntimeWindow(buttonNode);
      UI.notify('只把离线示例切换为聊天已启用，没有调用模型或服务。');
    },
    'conn-stop-chat': function (buttonNode) {
      if (noWrite()) { UI.notify('未知结果或读取中，演示保持启停保护。'); return; }
      chatState = 'stopped'; UI.render(); updateRuntimeWindow(buttonNode);
      UI.notify('只把离线示例切换为聊天已停止，会话示例保留。');
    },
    'conn-protocol-connect': function (buttonNode) {
      const scope = buttonNode.closest('[data-protocol-scope]');
      if (noWrite()) { UI.notify('读取中或结果未知时，演示保留连接操作保护。'); return; }
      if (chatState !== 'stopped') { UI.notify('演示前置条件：请先停止聊天，再手动连接 WebSocket。'); return; }
      qqConnected = true; UI.render();
      if (scope) scope.querySelector('[data-protocol-message]').textContent = '示例状态已切换为已连接；没有建立真实 WebSocket。';
      UI.notify('连接维护状态演示，零网络操作。');
    },
    'conn-protocol-disconnect': function (buttonNode) {
      const scope = buttonNode.closest('[data-protocol-scope]');
      if (noWrite()) { UI.notify('读取中或结果未知时，演示保留连接操作保护。'); return; }
      if (chatState !== 'stopped') { UI.notify('演示前置条件：请先停止聊天，再断开 WebSocket。'); return; }
      qqConnected = false; UI.render();
      if (scope) scope.querySelector('[data-protocol-message]').textContent = '示例状态已切换为已断开；没有断开真实连接。';
      UI.notify('连接维护状态演示，零网络操作。');
    },
    'conn-discover-dsh': function () {
      if (UI.state === 'unknown') { UI.open('conn-connection-recovery'); return; }
      if (UI.state === 'loading') { UI.notify('正在展示读取中状态，保存入口保持保护。'); return; }
      UI.notify('演示自动发现与保存本机 DSH：没有探测进程、读取凭据或调用模型。');
    },
    'conn-review-recovery': function (buttonNode) {
      const scope = buttonNode.closest('[data-recovery-scope]');
      scope.querySelector('[data-recovery-message]').textContent = '离线示例：已读取当前保存版本。草稿保留；请确认实际旧操作已结束后再允许新操作。';
      scope.querySelector('[data-recovery-release]').disabled = false;
      UI.notify('仅切换核对界面示例，没有读取真实操作结果。');
    },
    'conn-release-recovery': function (buttonNode) {
      const scope = buttonNode.closest('[data-recovery-scope]');
      scope.querySelector('[data-recovery-message]').textContent = '离线示例：已允许新的保存；原操作没有被重放，当前草稿仍未重新提交。';
      buttonNode.disabled = true;
      UI.notify('仅演示解除保护，不提交配置或重放操作。');
    },
    'conn-read-runtime-proof': function (buttonNode) {
      const scope = buttonNode.closest('[data-runtime-recovery]');
      scope.querySelector('[data-runtime-proof]').textContent = '离线证据示例：聊天已停止，待排空操作为 0。真实恢复需要读取并验证相同证据。';
      scope.querySelector('[data-runtime-restore]').disabled = false;
      UI.notify('只展示满足恢复条件的证据示例，没有查询真实服务。');
    },
    'conn-restore-runtime': function (buttonNode) {
      const scope = buttonNode.closest('[data-runtime-recovery]');
      scope.querySelector('[data-runtime-proof]').textContent = '离线示例：管理操作已恢复，历史保留；没有再次启停聊天。';
      buttonNode.disabled = true;
      UI.notify('仅演示恢复操作，没有改变任何实际运行状态。');
    }
  });

  document.addEventListener('change', function (event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    if (target.matches('[data-credential-action]')) {
      const scope = target.closest('[data-credential]');
      scope.querySelector('[data-credential-value]').hidden = target.value !== 'replace';
      scope.querySelector('[data-credential-warning]').hidden = target.value !== 'clear';
      const password = scope.querySelector('input[type="password"]');
      if (password && target.value !== 'replace') password.value = '';
    }
    if (target.matches('[data-execution-cancel-toggle]')) {
      const scope = target.closest('[data-execution-scope]');
      if (scope) scope.querySelectorAll('[data-execution-cancel-area]').forEach(node => { node.hidden = !target.checked; });
    }
    if (target.matches('[data-execution-notice-toggle]')) {
      const scope = target.closest('[data-execution-scope]');
      if (scope) scope.querySelectorAll('[data-execution-notice-area]').forEach(node => { node.hidden = !target.checked; });
    }
  });
})();
