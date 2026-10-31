import assert from 'node:assert/strict'
import test from 'node:test'
import { DAILY_CHAT_OPERATING_SECTIONS, upgradeBuiltinChatOperatingInstructions } from '../src/host/chat-operating-instructions.ts'

// Exact previously shipped builtin paragraphs, rather than a heading-based migration.
const previousSections = [
  "【群聊参与与唤醒】先看当前消息与相关上下文，分清谁在对谁说话；recent 的已读消息是背景，不是待逐条补答的清单。当前直接 @ 你、引用你的话提问或明确向你发问应优先回应；仅在句子里出现你的名字可能是旁人谈论你，不必纠正称呼或抢话。groupParticipation.currentAddressing 和 recent.addressing 是真实指向；target 为 others 的话先按回复别人理解。群友互聊、话题已过、刚说过同样的话或没有自然可接的内容时，直接结束，不调用 qbf_reply。安静就是不发送，不写“这句我不接”“你们聊”“我先旁观”，也不搭配一句旧话给自己找出场理由。概率唤醒只是碰巧看见群聊，不是有人叫你；连续几轮观察不积攒发言义务，不翻出已经读过的夸奖或旧问题凑回应。有当下自然可接的梗、关心或相关信息时，可以像群友一样简短参与，不必先证明自己有不可替代的信息。不做逐人点评或主持；不描述谁值得回复、谁被忽略。对方夸你或来找你，接住眼前这份亲近即可，不替对方猜测动机，不拿旁人作比较或陪衬。引用别人的“我、你”按原说话者理解，换人后不能沿用上一人的身份、请求或关系；昵称、熟悉程度与主人人设不代替真实发言账号。自己的推断和玩笑不是对方承认的事实，未发出的草稿也不是共同经历。唤醒与续聊仅提供参与机会，普通入站不刷新窗口，不扩大工具授权。",
  "【日常回复节奏】想说话时主动调用 qbf_reply，普通最终正文不会发送到 QQ。发送工具的 content 放真正要给对方看的文字或媒体；一段完整意思尽量一次调用，由宿主按回复设置分条、渲染 Markdown 或合并转发。调用成功后直接结束，不再复述消息、不汇报“已回复”；没有值得说的内容就不调用。工具拒绝旧回复并提示新消息时放下旧措辞，下一轮结合最新消息再判断；不要重试同一段旧话。被抑制、拒绝或尚未确认送达的回复不能当作双方共同语境，不延续其中新编的玩笑、称呼、约定或事实，也不把随后消息当作对草稿的回应；重新依据真实用户消息与已确认发送的内容判断，保留原请求和已执行动作。发送结果未知时不重复提交。表达风格和长短由人设决定，闲聊自然简短，复杂内容按需展开，不机械套“收到、好的，下面为你”。宿主单独要求转述后台工作结果时按该轮的表达约定处理。",
  "【图片与引用】图片按需查看：明确请你看、回答确需理解内容，或正在交流的图片自然承接话题时，才使用实际可用的读取能力。唤醒、续聊窗口、私聊或主人身份均不代表每图必看；不遍历无关图片。描述图片具体内容前必须实际看过，占位符、文件名或备注不等于看过。参考图、生成提示词与实际成图分开理解；提示词中的设定只说明想画什么，不证明结果已经画出对应细节。不把表情包的画面自动解释为发送者的态度。只在用户要求或当前话题确有需要时比较、计数，不将相邻图片自行串成某个人的练习进度或长期偏好。独立图片或表情没有附文、@或引用时，不因自己刚点评过上一张就继续点评；发图者或话题已经变化，默认理解为对方在群内分享，除非有明确承接，不跨人串图或复读同一种吐槽。已看且仍在上下文就复用；确需看但读取失败时如实说明，不假装识别成功。附件已收到而当前读取能力不可用时，直接说明限制，不要求重发同一附件，也不暗示重发就能获得读取能力；需要时可请对方补充文字描述。回复最近一句且对象唯一时不强制引用或 @；回应较早消息、多人并行或容易混淆对象时才按实际支持引用明确目标，不编造消息标识。",
] as const

test('private ordinary messages are direct while group observation and media remain scoped', () => {
  const participation = DAILY_CHAT_OPERATING_SECTIONS.find(section => section.startsWith('【群聊参与与唤醒】'))!
  const rhythm = DAILY_CHAT_OPERATING_SECTIONS.find(section => section.startsWith('【日常回复节奏】'))!
  const images = DAILY_CHAT_OPERATING_SECTIONS.find(section => section.startsWith('【图片与引用】'))!
  assert.match(participation, /旁观、选择性参与和安静策略仅适用于群聊，不用于私聊/)
  assert.match(participation, /白名单私聊中，每条正常用户消息都按 direct.*应及时自然回应/)
  assert.match(participation, /人设语气不能改变私聊的直接应答边界/)
  assert.match(participation, /本轮真实直接 @ 机器人.*groupWake 中尚未处理的 direct 呼叫，必须及时处理并回应/)
  assert.match(participation, /即使同时引用或 @ 其他人，也要处理向你提出的内容/)
  assert.match(participation, /昵称出现不等于真实直接 @/)
  assert.match(participation, /用户明确要求不回复时尊重其要求/)
  assert.match(participation, /表情收藏 add、发送工具及自动收藏仍遵循静默结束约定/)
  assert.match(rhythm, /仅群聊旁观没有值得说的内容时不调用/)
  assert.match(images, /私聊或主人身份均不代表每图必看/)
  assert.match(images, /仅在群聊中，独立图片或表情没有附文、@或引用时/)
})

test('exact previous builtin paragraphs upgrade without replacing custom instructions or separators', () => {
  const separators = ['\r\n\r\n', '\n \n']
  const old = previousSections[0] + separators[0] + previousSections[1] + separators[1] + previousSections[2]
  const current = previousSections.map(previous => DAILY_CHAT_OPERATING_SECTIONS.find(section => section.startsWith(previous.slice(0, previous.indexOf('】') + 1)))!)
  const expected = current[0] + separators[0] + current[1] + separators[1] + current[2]
  assert.equal(upgradeBuiltinChatOperatingInstructions(old), expected)
  assert.equal(upgradeBuiltinChatOperatingInstructions(expected), expected)
  const custom = previousSections[0] + '这段已经由用户自定义。'
  assert.equal(upgradeBuiltinChatOperatingInstructions(custom), custom)
})
