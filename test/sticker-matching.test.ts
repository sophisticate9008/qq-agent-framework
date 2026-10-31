import assert from 'node:assert/strict'
import test from 'node:test'
import { createStickerMatcher, rankStickerCandidates, type StickerMatchCandidate } from '../src/host/sticker-matching.ts'
import type { StickerAnnotation, StickerSemanticFacets } from '../src/host/sticker-semantics.ts'

function candidate(id: string, annotation: Partial<StickerAnnotation> = {}, facets?: Partial<StickerSemanticFacets>): StickerMatchCandidate {
  return { id, annotation: { description: '画面中的角色站在空白背景前', tags: [], avoid: '', ...annotation,
    ...(facets ? { facets: { emotions: [], actions: [], intents: [], scenes: [], visibleText: '', ...facets } } : {}) } }
}
function rank(intent: string, candidates: readonly StickerMatchCandidate[], context: readonly string[] = [], recentlyUsed: readonly string[] = []) {
  return rankStickerCandidates({ intent, candidates, context, recentlyUsed })
}
const celebrate = candidate('celebrate', { description: '笑着举起双手欢呼', tags: ['开心', '庆祝'] }, { emotions: ['开心'], actions: ['欢呼'], intents: ['庆祝'] })
const comfort = candidate('comfort', { description: '温和地伸手摸摸', tags: ['安慰', '陪伴', '摸摸'] }, { actions: ['轻拍'], intents: ['安慰'] })
const tease = candidate('tease', { description: '坏笑着指向前方，配字「笨蛋」', tags: ['调侃'], avoid: '严肃道歉、安慰时' }, { intents: ['调侃'], visibleText: '笨蛋' })
const food = candidate('food', { description: '角色举着饭碗吃饭', tags: ['吃饭', '饭碗'] }, { actions: ['吃饭'], scenes: ['饭桌'] })

test('local selection matches explicit intent, actions, OCR and bilingual synonyms', () => {
  assert.equal(rank('开心庆祝一下', [food, tease, celebrate])[0]?.id, 'celebrate')
  assert.equal(rank('温柔安慰，陪伴', [celebrate, comfort, food])[0]?.id, 'comfort')
  assert.equal(rank('meal', [celebrate, food])[0]?.id, 'food')
  const hug = candidate('hug', { tags: ['抱抱'] }, { actions: ['拥抱'] })
  assert.equal(rank('hug', [food, hug])[0]?.id, 'hug')
  const ocr = candidate('ocr', {}, { visibleText: '你礼貌吗' })
  assert.equal(rank('你礼貌吗', [food, ocr])[0]?.id, 'ocr')
  assert.equal(rank('吃饭', [food])[0]?.id, 'food')
  const fishing = candidate('fishing', { tags: ['摸鱼'] })
  assert.equal(rank('摸鱼', [fishing])[0]?.id, 'fishing', 'open vocabulary does not require a predefined emotion')
})
test('ordinary background words cannot create intent or make an unrelated sticker eligible', () => {
  assert.deepEqual(rank('发一个表情', [food, celebrate], ['刚才吃饭了', '今晚开庆祝会']), [])
  assert.deepEqual(rank('温柔安慰', [food], ['早上吃饭了']), [])
  assert.deepEqual(rank('庆祝', [food], ['开心，吃饭了']), [])
  assert.deepEqual(rank('', [celebrate], ['庆祝']), [])
  assert.deepEqual(rank('随便发一个', [celebrate, food]), [])
  assert.deepEqual(rank('蓝色', [candidate('name-only', { description: '角色站着' })].map(item => ({ ...item, name: '蓝色表情' }))), [])
  assert.deepEqual(rank('桌子', [candidate('incidental', { description: '角色身旁的桌子上有纸张' })]), [])
})
test('explicit semantic labels outrank incidental description and general contextual overlap', () => {
  const weak = candidate('weak', { description: '角色拿着庆祝用的气球', tags: ['气球'] })
  const result = rank('开心庆祝', [weak, celebrate], ['有人在聊气球'])
  assert.equal(result[0]?.id, 'celebrate')
  assert.deepEqual(rank('hug', [candidate('cute', { description: '可爱的小动物抱着饭碗', tags: ['可爱', '饭碗'] })]), [])
  assert.deepEqual(rank('开心', [food]), [])
  assert.deepEqual(rank('得意', [candidate('praise', { tags: ['夸奖'] })]), [])
})
test('negated emotions, explicit exclusions and English boundaries prevent false matches', () => {
  const sad = candidate('sad', { description: '不开心地低着头', tags: ['难过'] }, { emotions: ['难过'] })
  assert.equal(rank('不开心', [sad, celebrate])[0]?.id, 'sad')
  assert.deepEqual(rank('开心', [sad]), [])
  assert.deepEqual(rank('happy', [candidate('negated', { tags: ['not happy'] })]), [])
  const happyTease = candidate('happy-tease', { tags: ['开心', '笨蛋'] })
  assert.deepEqual(rank('开心，不要发笨蛋', [happyTease]), [])
  assert.deepEqual(rank('开心，不要调侃', [candidate('happy-banter', { tags: ['开心', '调侃'] })]), [])
  const angryRefusal = candidate('angry-refusal', { tags: ['拒绝', '生气'] })
  const calmRefusal = candidate('calm-refusal', { tags: ['拒绝', '摆手'] })
  assert.deepEqual(rank('拒绝，不生气', [angryRefusal, calmRefusal]).map(item => item.id), ['calm-refusal'])
  assert.deepEqual(rank('hi', [candidate('white', { tags: ['white'] })]), [])
})
test('serious comfort rejects teasing, insulting and threatening images even when a positive tag overlaps', () => {
  const threats = candidate('threat', { tags: ['安慰', '调侃'], description: '举起拳头，配字「电死你」' }, { visibleText: '电死你' })
  assert.deepEqual(rank('安慰', [tease, threats], ['我今天真的很难过']), [])
  const rude = candidate('rude', { tags: ['开心'], description: '大笑着指着前方', avoid: '' }, { visibleText: '笨蛋' })
  assert.deepEqual(rank('开心', [rude], ['认真道歉中']), [])
  assert.equal(rank('调侃，开玩笑', [tease])[0]?.id, 'tease', 'lighthearted explicit use remains possible')
  const calm = candidate('calm', { tags: ['安慰'], description: '温和地伸手，不是在嘲笑对方' }, { intents: ['安慰'] })
  assert.equal(rank('安慰', [calm])[0]?.id, 'calm')
})
test('avoid metadata vetoes matching circumstances and is never positive recall', () => {
  const apology = candidate('apology', { tags: ['感谢'], avoid: '严肃道歉时不适用' }, { intents: ['感谢'] })
  assert.deepEqual(rank('感谢', [apology], ['刚才在严肃道歉']), [])
  assert.deepEqual(rank('道歉', [apology]), [])
  const farewell = candidate('farewell', { tags: ['再见'], avoid: '葬礼' }, { intents: ['告别'] })
  assert.deepEqual(rank('再见', [farewell], ['他们正在参加葬礼']), [])
  assert.equal(rank('感谢', [apology], ['一起吃饭吧'])[0]?.id, 'apology')
})
test('recent repetition, duplicate entries, ties and candidate ordering remain deterministic', () => {
  const first = candidate('a', { tags: ['开心'] }), second = candidate('b', { tags: ['开心'] })
  assert.deepEqual(rank('开心', [first, second], [], ['a']).map(item => item.id), ['b'])
  assert.deepEqual(rank('开心', [first, second], [], ['a', 'b']), [])
  assert.equal(rank('开心', [first, first]).length, 1)
  assert.deepEqual(rank('开心', [second, first]), rank('开心', [first, second]))
  assert(rank('开心', [first]).every(item => Number.isFinite(item.score) && item.score > 0))
})

function named(id: string, character: string, aliases: readonly string[], tags: readonly string[]): StickerMatchCandidate {
  return candidate(id, { tags, identity: { character, aliases, source: 'user' } })
}
test('plain character mentions weakly prefer matching expressions while explicit identity remains exact', () => {
  const whale = named('whale', '星河鲸', ['胖团鱼'], ['吃饭'])
  const cat = named('cat', '纸片猫', [], ['吃饭'])
  const anonymous = candidate('anonymous', { tags: ['吃饭'], visual: { colors: ['蓝色'], styles: ['卡通'], entities: ['蓝色头发'] } })
  assert.equal(rank('胖团鱼吃饭', [cat, anonymous, whale])[0]?.id, 'whale')
  assert.equal(rank('胖团鱼吃饭', [cat, anonymous, whale]).length, 3)
  assert.deepEqual(rankStickerCandidates({ intent: '吃饭', character: '胖团鱼', candidates: [cat, anonymous, whale], context: [], recentlyUsed: [] }).map(item => item.id), ['whale'])
  assert.deepEqual(rank('胖团鱼', [whale, cat]).map(item => item.id), ['whale'])
  assert.deepEqual(rank('胖团鱼抱抱', [whale, cat]), [])
  assert.deepEqual(rank('蓝色', [anonymous]).map(item => item.id), ['anonymous'])
  assert.deepEqual(rankStickerCandidates({ intent: '吃饭', character: '未知角色', candidates: [anonymous, cat], context: [], recentlyUsed: [] }), [])
})
test('account-owned index removes stale term and character postings after metadata edits and deletion', () => {
  const matcher = createStickerMatcher('test-account-a')
  const original = named('same-image', '星河鲸', ['胖团鱼'], ['吃饭'])
  const query = { intent: '胖团鱼吃饭', candidates: [original], context: [], recentlyUsed: [] }
  assert.equal(matcher.rank(query)[0]?.id, 'same-image')
  const edited = named('same-image', '纸片猫', ['小纸团'], ['抱抱'])
  assert.deepEqual(matcher.rank({ ...query, candidates: [edited] }), [])
  assert.equal(matcher.rank({ ...query, intent: '小纸团抱抱', candidates: [edited] })[0]?.id, 'same-image')
  assert.deepEqual(matcher.rank({ ...query, intent: '小纸团抱抱', candidates: [] }), [])
  matcher.clear()
  assert.deepEqual(matcher.rank({ ...query, candidates: [] }), [])
})
test('account matcher instances never share image IDs, aliases or corpus postings', () => {
  const first = createStickerMatcher('test-account-a'), second = createStickerMatcher('test-account-b')
  const options = { intent: '胖团鱼吃饭', candidates: [named('same-id', '星河鲸', ['胖团鱼'], ['吃饭'])], context: [], recentlyUsed: [] }
  assert.equal(first.rank(options)[0]?.id, 'same-id')
  assert.deepEqual(second.rank({ ...options, candidates: [named('same-id', '纸片猫', [], ['抱抱'])] }), [])
  assert.equal(first.rank(options)[0]?.id, 'same-id')
})
test('external character alias changes apply without retagging and ambiguous aliases do not guess', () => {
  const matcher = createStickerMatcher('test-account')
  const whale = named('whale', '星河鲸', [], ['吃饭'])
  const cat = named('cat', '纸片猫', [], ['吃饭'])
  const base = { intent: '吃饭', character: '胖团鱼', candidates: [whale, cat], context: [], recentlyUsed: [] }
  assert.deepEqual(matcher.rank({ ...base, characterAliases: [{ character: '星河鲸', aliases: ['胖团鱼'] }] }).map(item => item.id), ['whale'])
  assert.deepEqual(matcher.rank({ ...base, characterAliases: [{ character: '纸片猫', aliases: ['胖团鱼'] }] }).map(item => item.id), ['cat'])
  assert.deepEqual(matcher.rank({ ...base, characterAliases: [{ character: '星河鲸', aliases: ['胖团鱼'] }, { character: '纸片猫', aliases: ['胖团鱼'] }] }), [])
  assert.deepEqual(matcher.rank({ ...base, character: '未入库角色', characterAliases: [{ character: '未入库角色', aliases: [] }] }), [])
})
test('explicit negative identity excludes only that character without becoming a rejection mood', () => {
  const whale = named('whale', '星河鲸', ['胖团鱼'], ['吃饭'])
  const cat = named('cat', '纸片猫', [], ['吃饭'])
  assert.deepEqual(rank('不要胖团鱼，要纸片猫吃饭', [whale, cat]).map(item => item.id), ['cat'])
  assert.deepEqual(rank('不发胖团鱼，要纸片猫吃饭', [whale, cat]).map(item => item.id), ['cat'])
  assert.deepEqual(rank('吃饭', [whale, cat]).map(item => item.id).sort(), ['cat', 'whale'])
})

test('ordinary identity preference never blocks a better expression or rescues an unsuitable candidate', () => {
  const favourite = named('favourite', '星河鲸', ['胖团鱼'], ['吃饭'])
  assert.deepEqual(rank('胖团鱼，安慰', [favourite, comfort]).map(item => item.id), ['comfort'])
  const preferredHappy = named('preferred-happy', '星河鲸', ['胖团鱼'], ['开心'])
  const plain = rank('开心庆祝', [preferredHappy, celebrate])
  const mentioned = rank('胖团鱼，开心庆祝', [preferredHappy, celebrate])
  assert.equal(mentioned[0]?.id, 'celebrate')
  const plainScore = plain.find(item => item.id === preferredHappy.id)?.score ?? 0
  const preferredScore = mentioned.find(item => item.id === preferredHappy.id)?.score ?? 0
  assert(preferredScore > plainScore && preferredScore <= plainScore + 0.201)
  assert.deepEqual(rank('胖团鱼，安慰', [favourite]), [])
})
test('explicit character constraints and conservative named requests do not substitute other characters', () => {
  const favourite = named('favourite', '星河鲸', ['胖团鱼'], ['吃饭'])
  const base = { intent: '安慰', character: '胖团鱼', candidates: [favourite, comfort], context: [], recentlyUsed: [] }
  assert.deepEqual(rankStickerCandidates(base), [])
  assert.deepEqual(rank('只要胖团鱼，安慰', [favourite, comfort]), [])
  assert.deepEqual(rank('指定角色胖团鱼，吃饭', [favourite, food]).map(item => item.id), ['favourite'])
  assert.deepEqual(rank('发胖团鱼的表情', [favourite, food]).map(item => item.id), ['favourite'])
})
test('ambiguous ordinary mentions keep expression matching available but pure identity requests do not guess', () => {
  const aliases = [{ character: '星河鲸', aliases: ['小团子'] }, { character: '纸片猫', aliases: ['小团子'] }]
  const candidates = [named('whale', '星河鲸', [], ['吃饭']), named('cat', '纸片猫', [], ['吃饭'])]
  const base = { intent: '小团子吃饭', candidates, characterAliases: aliases, context: [], recentlyUsed: [] }
  assert.equal(rankStickerCandidates(base).length, 2)
  assert.deepEqual(rankStickerCandidates({ ...base, intent: '小团子' }), [])
  assert.deepEqual(rankStickerCandidates({ ...base, character: '小团子' }), [])
})
test('identity alone adds no expression score to visual matches and names do not invent emotions', () => {
  const visual = { colors: ['蓝色'], styles: [], entities: [] }
  const favourite = candidate('favourite', { visual, identity: { character: '星河鲸', aliases: ['胖团鱼'], source: 'user' } })
  const other = candidate('other', { visual })
  const result = rank('胖团鱼，蓝色', [favourite, other])
  assert.equal(result[0]?.score, result[1]?.score)
  const awkwardName = named('awkward', '难过骑士', [], ['调侃'])
  assert.equal(rank('难过骑士，调侃', [awkwardName])[0]?.id, 'awkward')
  const collision = named('collision', '开心', [], ['吃饭'])
  assert.deepEqual(rank('开心', [collision, celebrate]).map(item => item.id), ['celebrate'])
})
