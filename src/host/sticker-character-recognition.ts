import type { DurableStore } from './types.ts'
import { assert, isRecord } from '../core/values.ts'
import { digest, json } from './data.ts'
import { normalizeStickerCharacterName, stickerContainsMeaning, validateStickerAnnotation, validateStickerCharacterIdentity, type StickerAnnotation } from './sticker-semantics.ts'

const normalize = normalizeStickerCharacterName
export interface StickerCharacterRecognitionRule {
  readonly character: string
  readonly aliases: readonly string[]
  /** Visible entities, not conversational words or inferred emotions. */
  readonly entities: readonly string[]
  readonly evidence: string
}
function label(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 64 && !/[\x00-\x1f\x7f]/.test(value)
}
function validate(value: unknown): StickerCharacterRecognitionRule {
  assert(isRecord(value) && label(value.character) && Array.isArray(value.aliases) && value.aliases.length <= 8 && value.aliases.every(label)
    && Array.isArray(value.entities) && value.entities.length > 0 && value.entities.length <= 8 && value.entities.every(label)
    && typeof value.evidence === 'string' && value.evidence.trim() === value.evidence && value.evidence.length > 0 && value.evidence.length <= 160
    && !/[\x00-\x1f\x7f]/.test(value.evidence), 'STICKER_CHARACTER_RULE_INVALID', 'Use a bounded character rule and visible entities.')
  const identity = validateStickerCharacterIdentity({ character: value.character, aliases: value.aliases, source: 'model' })
  assert(new Set(value.entities.map(entity => normalizeStickerCharacterName(String(entity)))).size === value.entities.length,
    'STICKER_CHARACTER_RULE_INVALID', 'Use distinct visible entities.')
  return { character: identity.character, aliases: identity.aliases, entities: value.entities as string[], evidence: value.evidence }
}

/** Host-maintained account preferences. Models cannot create or modify these recognition rules. */
export function createStickerCharacterRecognition(store: DurableStore, accountId: string) {
  assert(accountId.length > 0, 'STICKER_CHARACTER_RULE_INVALID', 'Use an account identity.')
  const namespace = `native-chat.sticker-character-rules.${digest(accountId)}`
  function list(): readonly StickerCharacterRecognitionRule[] {
    const rows = store.list(namespace, { limit: 129 })
    assert(rows.length <= 128, 'STICKER_CHARACTER_RULE_LIMIT', 'The account character rule limit was reached.')
    return rows.map(row => {
      assert(isRecord(row.value) && row.value.schema === 1 && row.value.accountId === accountId,
        'STICKER_CHARACTER_RULE_INVALID', 'Character rules must belong to the current account.')
      return validate(row.value.rule)
    })
  }
  return Object.freeze({
    list,
    remember(input: StickerCharacterRecognitionRule): void {
      const rule = validate(input), key = digest([accountId, normalize(rule.character)])
      const prior = store.read(namespace, key)
      assert(prior || list().length < 128, 'STICKER_CHARACTER_RULE_LIMIT', 'The account character rule limit was reached.')
      store.write(namespace, key, json({ schema: 1, accountId, rule }), { expectedRevision: prior?.revision ?? null })
    },
    apply(annotation: StickerAnnotation, rules: readonly StickerCharacterRecognitionRule[] = list()): StickerAnnotation {
      if (annotation.identity && annotation.identity.source !== 'model') return annotation
      const observed = (annotation.visual?.entities ?? []).map(normalize)
      if (!observed.length) return annotation
      const matching = rules.filter(rule => rule.entities.some(entity => observed.some(value => stickerContainsMeaning(value, normalize(entity)))))
      // Conflicting account rules do not establish a character identity.
      if (matching.length !== 1) return annotation
      const rule = matching[0]!
      return validateStickerAnnotation({ ...annotation, identity: { character: rule.character, aliases: rule.aliases,
        source: 'model', evidence: `依据账号规则推断：${rule.evidence}`.slice(0, 160) } })
    },
  })
}
