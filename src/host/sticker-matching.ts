import { stickerContainsMeaning, stickerSemanticConcepts, type StickerAnnotation } from './sticker-semantics.ts'

export interface StickerMatchCandidate {
  readonly id: string
  readonly name?: string
  readonly annotation: StickerAnnotation
}
export interface StickerMatchOptions {
  readonly intent: string
  readonly context: readonly string[]
  readonly candidates: readonly StickerMatchCandidate[]
  readonly recentlyUsed: readonly string[]
}
interface IndexedField { readonly text: string; readonly weight: number; readonly terms: ReadonlyMap<string, number> }
interface IndexedCandidate { readonly candidate: StickerMatchCandidate; readonly fields: readonly IndexedField[] }
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const normalize = (value: string): string => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
// Request scaffolding must not make two unrelated stickers look relevant.
const stopWords = new Set(['一个', '一张', '一下', '一些', '这个', '那个', '表情', '表情包', '图片', '配图', '发送', '发图', '来个', '给我', '我们', '你们',
  '他们', '她们', '自己', '现在', '当前', '这次', '刚才', '可以', '适合', '时候', '语气', '表达', '回应', '回复', '对方', '主人', '朋友', '角色',
  'sticker', 'image', 'send', 'please', 'the', 'a', 'an', 'this', 'that', 'with', 'for', 'to', 'me', 'you', 'and', 'of'])
function terms(value: string): ReadonlyMap<string, number> {
  const source = normalize(value), result = new Map<string, number>()
  for (const part of segmenter.segment(source)) {
    if (!part.isWordLike || part.segment.length < 2 || stopWords.has(part.segment) || !stickerContainsMeaning(source, part.segment)) continue
    const key = `word:${part.segment}`
    result.set(key, Math.min(2, (result.get(key) ?? 0) + 1))
  }
  for (const concept of stickerSemanticConcepts(source)) result.set(`concept:${concept}`, 1)
  return result
}
// Only reusable image metadata is cached; query and conversation text stay out of this cache.
const metadataTerms = new Map<string, ReadonlyMap<string, number>>()
function indexedTerms(value: string): ReadonlyMap<string, number> {
  const existing = metadataTerms.get(value)
  if (existing) return existing
  const indexed = terms(value)
  if (metadataTerms.size >= 2048) metadataTerms.delete(metadataTerms.keys().next().value!)
  metadataTerms.set(value, indexed)
  return indexed
}
function fields(candidate: StickerMatchCandidate): readonly IndexedField[] {
  const annotation = candidate.annotation, facets = annotation.facets
  const values: readonly (readonly [string, number])[] = [
    [candidate.name ?? '', 0.6], [annotation.description, 1], [annotation.tags.join(' / '), 2.8],
    [(facets?.emotions ?? []).join(' / '), 3.2], [(facets?.actions ?? []).join(' / '), 3.4],
    [(facets?.intents ?? []).join(' / '), 4.8], [(facets?.scenes ?? []).join(' / '), 1.4], [facets?.visibleText ?? '', 2.6],
  ]
  return values.map(([value, weight]) => ({ text: value, weight, terms: indexedTerms(value) }))
}
const has = (value: string, words: readonly string[]): boolean => words.some(word => stickerContainsMeaning(value, word))
const seriousWords = ['认真', '严肃', '安慰', '难过', '委屈', '道歉', '生病', '去世', '丧亲', '失业', '分手', '抑郁', '痛苦', '害怕', '崩溃',
  '伤害', 'comfort', 'grief', 'sorry', 'serious', 'sad']
const hostileWords = ['侮辱', '辱骂', '骂人', '威胁', '恐吓', '嘲讽', '嘲笑', '挑衅', '调侃', '恶意', '贬低', '笨蛋', '傻逼', '傻瓜', '白痴',
  '去死', '弄死', '电死', '打死', '滚开', '闭嘴', 'insult', 'threat', 'mock', 'taunt', 'tease', 'banter', 'idiot', 'stupid', 'kill']
function negatedFeatures(intent: string): ReadonlySet<string> {
  const result = new Set<string>(), source = normalize(intent)
  for (const part of segmenter.segment(source)) {
    if (!part.isWordLike || part.segment.length < 2 || stickerContainsMeaning(source, part.segment)) continue
    for (const key of terms(part.segment).keys()) result.add(key)
  }
  for (const match of source.matchAll(/(?:不要(?:用|发)?|别(?:用|发)?|不用|避免|不想要|不需要|without\s+|no\s+)([^，。；,;.!?！？]{1,48})/g)) {
    for (const key of terms(match[1]!).keys()) result.add(key)
  }
  return result
}
function restrictions(annotation: StickerAnnotation, intent: string, context: string, serious: boolean): boolean {
  const image = [annotation.description, ...annotation.tags, ...(annotation.facets?.emotions ?? []), ...(annotation.facets?.actions ?? []),
    ...(annotation.facets?.intents ?? []), annotation.facets?.visibleText ?? ''].join(' / ')
  if (serious && has(image, hostileWords)) return true
  const avoid = normalize(annotation.avoid).replace(/(?:不适合|不适用|避免用于|不要用于|不宜|勿用于|慎用)(?:在)?/g, '')
  if (!avoid) return false
  const avoided = terms(avoid), situation = terms(`${intent} / ${context}`)
  // A shared intent/emotion concept or two lexical words is enough to reject a stated unsuitable context.
  const overlap = [...avoided.keys()].filter(key => situation.has(key))
  if (overlap.some(key => key.startsWith('concept:')) || overlap.filter(key => key.startsWith('word:')).length >= 2) return true
  // Short explicit labels such as “严肃争执” may be tokenised as one phrase on one side and two on the other.
  return [...avoided.keys()].some(key => key.startsWith('word:') && key.slice(5).length >= 2
    && stickerContainsMeaning(`${intent} / ${context}`, key.slice(5)))
}

/**
 * A small-library BM25F-style ranker with conservative admission rules.
 * This is synchronous metadata selection: no image download, model request, timer or chat notification.
 * Context may veto or slightly reorder a match, but cannot make an unrelated candidate eligible.
 */
export function rankStickerCandidates(options: StickerMatchOptions): readonly { readonly id: string; readonly score: number }[] {
  const intent = normalize(options.intent).slice(0, 480)
  if (!intent) return []
  const query = new Map(terms(intent)), excluded = negatedFeatures(intent)
  for (const key of excluded) query.delete(key)
  if (!query.size) return []
  const context = options.context.slice(-5).map(value => normalize(value).slice(0, 500)).join(' / ')
  const serious = has(`${intent} / ${context}`, seriousWords)
  const contextTerms = terms(context), recent = new Set(options.recentlyUsed), ids = new Set<string>()
  const indexed: IndexedCandidate[] = options.candidates.slice(0, 5000).filter(candidate => {
    if (!candidate.id || ids.has(candidate.id)) return false
    ids.add(candidate.id); return true
  }).map(candidate => ({ candidate, fields: fields(candidate) }))
  if (!indexed.length) return []
  const averages = Array.from({ length: 8 }, (_, index) => Math.max(1,
    indexed.reduce((total, item) => total + item.fields[index]!.terms.size, 0) / indexed.length))
  const frequencies = new Map<string, number>()
  for (const item of indexed) {
    const present = new Set(item.fields.flatMap(field => [...field.terms.keys()]))
    for (const key of query.keys()) if (present.has(key)) frequencies.set(key, (frequencies.get(key) ?? 0) + 1)
  }
  const requestedConcepts = [...query.keys()].filter(key => key.startsWith('concept:'))
  const results: { id: string; score: number }[] = []
  for (const { candidate, fields: values } of indexed) {
    if (recent.has(candidate.id) || restrictions(candidate.annotation, intent, context, serious)) continue
    const available = new Set(values.flatMap(field => [...field.terms.keys()]))
    if ([...excluded].some(key => available.has(key))) continue
    if (requestedConcepts.length && !requestedConcepts.some(key => available.has(key))) continue
    let score = 0, strongest = 0, wordMatches = 0, conceptMatch = false
    for (const key of query.keys()) {
      let frequency = 0, strongestField = 0
      values.forEach((field, index) => {
        const count = field.terms.get(key) ?? 0
        if (!count) return
        frequency += field.weight * count / (0.25 + 0.75 * field.terms.size / averages[index]!)
        strongestField = Math.max(strongestField, field.weight)
      })
      if (!frequency) continue
      if (key.startsWith('concept:')) conceptMatch = true
      else wordMatches += 1
      strongest = Math.max(strongest, strongestField)
      const count = frequencies.get(key) ?? 0
      // A floor stabilises the one- or two-image library; a cap prevents rare typos dominating small collections.
      const idf = Math.min(2, Math.max(0.75, Math.log(1 + (indexed.length - count + 0.5) / (count + 0.5))))
      score += idf * frequency * 2.2 / (frequency + 1.2) * (key.startsWith('concept:') ? 1.6 : 1)
    }
    // A lone incidental description/name word is insufficient, regardless of its corpus rarity.
    if (strongest < 2.4 && (wordMatches < 2 || !conceptMatch)) continue
    if (score < 1.1) continue
    const contextHits = [...contextTerms.keys()].filter(key => available.has(key)).length
    score += Math.min(0.3, contextHits * 0.05)
    results.push({ id: candidate.id, score: Math.round(score * 1000) / 1000 })
  }
  return results.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
}
