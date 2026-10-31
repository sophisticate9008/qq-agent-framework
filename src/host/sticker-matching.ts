import { normalizeStickerCharacterName, stickerContainsMeaning, stickerSemanticConcepts, type StickerAnnotation } from './sticker-semantics.ts'

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
  /** An explicit identity requirement; a mere mention in intent is only a weak preference. */
  readonly character?: string
  readonly characterAliases?: readonly { readonly character: string; readonly aliases: readonly string[] }[]
}
interface IndexedField { readonly text: string; readonly weight: number; readonly terms: ReadonlyMap<string, number> }
interface IndexedCandidate {
  readonly fingerprint: string
  readonly candidate: StickerMatchCandidate
  readonly fields: readonly IndexedField[]
  readonly available: ReadonlySet<string>
  readonly character: string | null
}
interface CharacterNode { readonly children: Map<string, CharacterNode>; readonly characters: Set<string> }
const characterNode = (): CharacterNode => ({ children: new Map(), characters: new Set() })
const FIELD_COUNT = 11
const MAX_DOCUMENTS = 5000

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
function fields(candidate: StickerMatchCandidate, indexedTerms: (value: string) => ReadonlyMap<string, number>): readonly IndexedField[] {
  const annotation = candidate.annotation, facets = annotation.facets, visual = annotation.visual
  const values: readonly (readonly [string, number])[] = [
    [candidate.name ?? '', 0.6], [annotation.description, 1], [annotation.tags.join(' / '), 2.8],
    [(facets?.emotions ?? []).join(' / '), 3.2], [(facets?.actions ?? []).join(' / '), 3.4],
    [(facets?.intents ?? []).join(' / '), 4.8], [(facets?.scenes ?? []).join(' / '), 1.4], [facets?.visibleText ?? '', 2.6],
    [(visual?.colors ?? []).join(' / '), 2.8], [(visual?.styles ?? []).join(' / '), 2.8], [(visual?.entities ?? []).join(' / '), 2.8],
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
 * An account-owned, bounded inverted index. Metadata changes update postings and corpus statistics;
 * a request scores only IDs recalled by query postings. Explicit character requirements restrict
 * recall; ordinary mentions provide only a small tie-breaking preference after expression admission.
 * The index never stores query/context text and performs no I/O or model calls.
 */
export function createStickerMatcher(accountId: string) {
  if (!accountId.trim()) throw new Error('STICKER_MATCHER_ACCOUNT_REQUIRED')
  const documents = new Map<string, IndexedCandidate>(), postings = new Map<string, Set<string>>()
  const characterPostings = new Map<string, Set<string>>(), metadataTerms = new Map<string, ReadonlyMap<string, number>>()
  const lengths = Array<number>(FIELD_COUNT).fill(0)
  let aliasesRoot = characterNode(), aliasesFingerprint = '', aliasesDirty = true
  let registeredAliases: NonNullable<StickerMatchOptions['characterAliases']> = []
  function indexedTerms(value: string): ReadonlyMap<string, number> {
    const existing = metadataTerms.get(value)
    if (existing) return existing
    const indexed = terms(value)
    if (metadataTerms.size >= 2048) metadataTerms.delete(metadataTerms.keys().next().value!)
    metadataTerms.set(value, indexed)
    return indexed
  }
  function remove(id: string) {
    const previous = documents.get(id)
    if (!previous) return
    for (const term of previous.available) {
      const ids = postings.get(term); ids?.delete(id)
      if (!ids?.size) postings.delete(term)
    }
    if (previous.character) {
      const ids = characterPostings.get(previous.character); ids?.delete(id)
      if (!ids?.size) characterPostings.delete(previous.character)
    }
    previous.fields.forEach((field, index) => { lengths[index] = lengths[index]! - field.terms.size })
    documents.delete(id); aliasesDirty = true
  }
  function update(candidates: readonly StickerMatchCandidate[], aliases: NonNullable<StickerMatchOptions['characterAliases']> = registeredAliases) {
    const seen = new Set<string>()
    for (const candidate of candidates.slice(0, MAX_DOCUMENTS)) {
      if (!candidate.id || seen.has(candidate.id)) continue
      seen.add(candidate.id)
      // Image metadata only: no account credentials, chat context or caller state enters this fingerprint.
      const annotation = candidate.annotation
      const fingerprint = JSON.stringify([candidate.name, annotation.description, annotation.tags, annotation.avoid,
        annotation.facets, annotation.visual, annotation.identity ? [annotation.identity.character, annotation.identity.aliases] : null])
      if (documents.get(candidate.id)?.fingerprint === fingerprint) continue
      remove(candidate.id)
      const indexed = fields(candidate, indexedTerms), available = new Set(indexed.flatMap(field => [...field.terms.keys()]))
      const character = candidate.annotation.identity?.character ? normalizeStickerCharacterName(candidate.annotation.identity.character) : null
      documents.set(candidate.id, { candidate, fingerprint, fields: indexed, available, character })
      for (const term of available) {
        let ids = postings.get(term)
        if (!ids) { ids = new Set(); postings.set(term, ids) }
        ids.add(candidate.id)
      }
      if (character) {
        let ids = characterPostings.get(character)
        if (!ids) { ids = new Set(); characterPostings.set(character, ids) }
        ids.add(candidate.id)
      }
      indexed.forEach((field, index) => { lengths[index] = lengths[index]! + field.terms.size })
      aliasesDirty = true
    }
    for (const id of documents.keys()) if (!seen.has(id)) remove(id)
    const boundedAliases = aliases.slice(0, MAX_DOCUMENTS)
    registeredAliases = boundedAliases
    const fingerprint = JSON.stringify(boundedAliases.map(({ character, aliases }) => [character, aliases.slice(0, 8)]))
    if (fingerprint !== aliasesFingerprint) { aliasesFingerprint = fingerprint; aliasesDirty = true }
    if (!aliasesDirty) return
    aliasesRoot = characterNode()
    function add(character: string, alias: string) {
      const normalized = normalizeStickerCharacterName(alias)
      if (normalized.length < 2 || normalized.length > 64 || stopWords.has(normalized)) return
      let node = aliasesRoot
      for (const char of normalized.split('')) {
        let next = node.children.get(char)
        if (!next) { next = characterNode(); node.children.set(char, next) }
        node = next
      }
      node.characters.add(character)
    }
    for (const { candidate, character } of documents.values()) {
      if (!character) continue
      add(character, character)
      for (const alias of candidate.annotation.identity?.aliases ?? []) add(character, alias)
    }
    for (const record of boundedAliases) {
      const character = normalizeStickerCharacterName(record.character)
      if (!character) continue
      add(character, character)
      for (const alias of record.aliases.slice(0, 8)) add(character, alias)
    }
    aliasesDirty = false
  }
  function characters(intent: string, explicit: string | undefined) {
    const positive = new Set<string>(), required = new Set<string>(), negative = new Set<string>()
    const ranges: { start: number; end: number }[] = []
    let ambiguous = false, ambiguousRequirement = false
    for (let start = 0; start < intent.length; start += 1) {
      let node = aliasesRoot, longest: { end: number; characters: ReadonlySet<string> } | null = null
      for (let end = start; end < Math.min(intent.length, start + 64); end += 1) {
        const next = node.children.get(intent[end]!)
        if (!next) break
        node = next
        if (node.characters.size) longest = { end: end + 1, characters: node.characters }
      }
      if (!longest) continue
      const alias = intent.slice(start, longest.end), before = intent.slice(0, start), after = intent.slice(longest.end)
      if (/^[a-z ]+$/.test(alias) && (/[a-z]$/.test(before) || /^[a-z]/.test(after))) continue
      const negation = before.match(/(?:(?:不要|别|不用|不想要|不需要)(?:用|发)?|不(?:是|要|用|发)?|没|非|not\s+|without\s+)$/i)
      const constraint = before.match(/(?:只要|只用|只发|指定(?:角色)?|必须(?:是|用|发)?|就要|仅用|仅要|仅限于?)\s*[「“"']?$/i)
      const namedImageRequest = /(?:发|来|找|给我)(?:一张|一个|张|个)?\s*[「“"']?$/.test(before)
        && /^\s*[」”"']?的(?:表情|贴纸|图片)/.test(after)
      const requiredHere = !negation && (constraint !== null || namedImageRequest)
      // A character coincidentally called “开心” must not consume an ordinary emotion query.
      if (!requiredHere && !negation && alias.length <= 2 && stickerSemanticConcepts(alias).length) continue
      if (!negation && longest.characters.size > 1) {
        ambiguous = true
        if (requiredHere) ambiguousRequirement = true
      }
      for (const character of longest.characters) {
        if (negation) negative.add(character)
        else {
          if (longest.characters.size === 1) positive.add(character)
          if (requiredHere) required.add(character)
        }
      }
      const prefix = negation ?? constraint
      ranges.push({ start: prefix ? start - prefix[0].length : start, end: longest.end }); start = longest.end - 1
    }
    if (explicit?.trim()) {
      const requested = normalizeStickerCharacterName(explicit)
      let node: CharacterNode | undefined = aliasesRoot
      for (const char of requested.split('')) node = node?.children.get(char)
      required.clear(); ambiguousRequirement = false
      if (node?.characters.size === 1) required.add([...node.characters][0]!)
      else if (node?.characters.size) ambiguousRequirement = true
      else required.add(requested)
    }
    let query = intent
    for (const range of ranges.reverse()) query = query.slice(0, range.start) + ' '.repeat(range.end - range.start) + query.slice(range.end)
    return { positive, required, negative, query, ambiguous, ambiguousRequirement }
  }
  function rank(options: StickerMatchOptions): readonly { readonly id: string; readonly score: number }[] {
    const intent = normalizeStickerCharacterName(options.intent).slice(0, 480)
    if (!intent) return []
    update(options.candidates, options.characterAliases)
    const requested = characters(intent, options.character)
    if (requested.ambiguousRequirement) return []
    const query = new Map(terms(requested.query)), excluded = negatedFeatures(requested.query)
    for (const key of excluded) query.delete(key)
    const identityOnly = query.size === 0
    if (identityOnly && !requested.required.size && (requested.ambiguous || !requested.positive.size)) return []
    const context = options.context.slice(-5).map(value => normalize(value).slice(0, 500)).join(' / ')
    const contextExpression = characters(context, undefined).query
    const serious = has(`${requested.query} / ${contextExpression}`, seriousWords)
    const contextTerms = terms(contextExpression), recent = new Set(options.recentlyUsed)
    const recalled = new Set<string>()
    const constrained = requested.required.size ? requested.required : identityOnly ? requested.positive : null
    if (constrained) {
      for (const character of constrained) for (const id of characterPostings.get(character) ?? []) recalled.add(id)
      // Identity restricts the recall set; a matching action never broadens it to other characters.
      if (query.size) for (const id of recalled) {
        if (![...query.keys()].some(key => postings.get(key)?.has(id))) recalled.delete(id)
      }
    } else {
      for (const key of query.keys()) for (const id of postings.get(key) ?? []) recalled.add(id)
    }
    for (const character of requested.negative) for (const id of characterPostings.get(character) ?? []) recalled.delete(id)
    const averages = lengths.map(length => Math.max(1, length / Math.max(1, documents.size)))
    const requestedConcepts = [...query.keys()].filter(key => key.startsWith('concept:'))
    const results: { id: string; score: number }[] = []
    for (const id of recalled) {
      const indexed = documents.get(id)!
      const { candidate, fields: values, available } = indexed
      if (recent.has(id) || restrictions(candidate.annotation, requested.query, contextExpression, serious)) continue
      if ([...excluded].some(key => available.has(key))) continue
      if (requestedConcepts.length && !requestedConcepts.some(key => available.has(key))) continue
      let score = identityOnly ? 1 : 0, strongest = 0, wordMatches = 0, conceptMatch = false, expressionEvidence = false
      for (const key of query.keys()) {
        let frequency = 0, strongestField = 0
        values.forEach((field, index) => {
          const count = field.terms.get(key) ?? 0
          if (!count) return
          frequency += field.weight * count / (0.25 + 0.75 * field.terms.size / averages[index]!)
          strongestField = Math.max(strongestField, field.weight)
          if (index >= 3 && index <= 5 || index === 2 && key.startsWith('concept:')) expressionEvidence = true
        })
        if (!frequency) continue
        if (key.startsWith('concept:')) conceptMatch = true
        else wordMatches += 1
        strongest = Math.max(strongest, strongestField)
        const count = postings.get(key)?.size ?? 0
        const idf = Math.min(2, Math.max(0.75, Math.log(1 + (documents.size - count + 0.5) / (count + 0.5))))
        score += idf * frequency * 2.2 / (frequency + 1.2) * (key.startsWith('concept:') ? 1.6 : 1)
      }
      if (query.size && (strongest < 2.4 && (wordMatches < 2 || !conceptMatch) || score < 1.1)) continue
      // Identity cannot admit an otherwise unsuitable image or rescue its threshold.
      // A plain mention may only slightly prefer an already matching expression.
      if (!constrained && !requested.ambiguous && expressionEvidence && indexed.character && requested.positive.has(indexed.character)) score += 0.2
      const contextHits = [...contextTerms.keys()].filter(key => available.has(key)).length
      score += Math.min(0.3, contextHits * 0.05)
      results.push({ id, score: Math.round(score * 1000) / 1000 })
    }
    return results.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
  }
  return Object.freeze({ rank, update, clear() {
    documents.clear(); postings.clear(); characterPostings.clear(); metadataTerms.clear(); lengths.fill(0)
    aliasesRoot = characterNode(); aliasesFingerprint = ''; aliasesDirty = true; registeredAliases = []
  } })
}

/** Stateless compatibility entry point. Long-lived callers should own one matcher per account. */
export function rankStickerCandidates(options: StickerMatchOptions): readonly { readonly id: string; readonly score: number }[] {
  return createStickerMatcher('isolated-call').rank(options)
}
