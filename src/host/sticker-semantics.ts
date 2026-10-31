import type { OneBotSticker } from '../adapters/onebot-stickers.ts'
import type { JsonValue } from '../core/types.ts'
import { assert, isRecord } from '../core/values.ts'
import type { DurableStore } from './types.ts'
import { digest, json } from './data.ts'

/** Small, transparent query vocabulary. Labels describe images, never people or permissions. */
export const STICKER_EMOTIONS = Object.freeze({
  开心: ['开心', '高兴', '快乐', '大笑', '哈哈', 'happy', 'laugh', 'joy'],
  得意: ['得意', '骄傲', '嘚瑟', '傲娇', '夸奖', 'proud', 'smug'],
  亲近: ['亲近', '贴贴', '抱抱', '喜欢', '爱你', '可爱', '卖萌', 'cute', 'hug', 'love'],
  安慰: ['安慰', '摸摸', '陪伴', '心疼', 'comfort', 'pat'],
  委屈: ['委屈', '难过', '伤心', '忧郁', '不开心', '不高兴', '哭', 'sad', 'cry'],
  无语: ['无语', '嫌弃', '白眼', '扶额', '尴尬', 'speechless', 'facepalm'],
  疑惑: ['疑惑', '困惑', '疑问', '问号', '不懂', 'confused', 'question'],
  惊讶: ['惊讶', '震惊', '吃惊', 'surprise', 'shock'],
  调侃: ['调侃', '吐槽', '搞怪', '坏笑', '笨蛋', 'tease', 'funny'],
  生气: ['生气', '愤怒', '炸毛', '骂人', 'angry', 'rage'],
  问候: ['问候', '你好', '早安', '招手', 'hello', 'hi'],
  告别: ['告别', '再见', '拜拜', '晚安', 'bye', 'goodnight'],
  感谢: ['感谢', '谢谢', 'thank'],
  赞同: ['赞同', '收到', '好的', '同意', '点赞', 'agree', 'okay'],
  拒绝: ['拒绝', '不要', '不行', '摆手', 'refuse', 'reject'],
  困倦: ['困倦', '困了', '睡觉', '打哈欠', 'sleep', 'tired'],
  加油: ['加油', '冲锋', '鼓励', '庆祝', 'cheer'],
  围观: ['围观', '吃瓜', '看戏', 'popcorn'],
})
export interface StickerAnnotation {
  readonly description: string
  readonly tags: readonly string[]
  readonly avoid: string
}
const text = (value: unknown, maximum: number, empty = false): value is string => typeof value === 'string'
  && value.trim() === value && (empty || value.length > 0) && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value)
export function validateStickerAnnotation(value: unknown): StickerAnnotation {
  assert(isRecord(value) && Object.keys(value).every(key => ['description', 'tags', 'avoid'].includes(key))
    && text(value.description, 240) && Array.isArray(value.tags) && value.tags.length <= 12
    && value.tags.every(tag => text(tag, 24)) && new Set(value.tags).size === value.tags.length
    && (value.avoid === undefined || text(value.avoid, 128, true)), 'INVALID_STICKER_ANNOTATION', 'Use a short visual description, up to twelve tags and optional unsuitable contexts.')
  return { description: value.description, tags: value.tags as string[], avoid: value.avoid ?? '' }
}
export function stickerSemanticKey(selfId: string, item: OneBotSticker): string {
  return digest([selfId, item.id, item.md5?.toLowerCase() ?? item.url])
}
function containsMeaning(text: string, term: string): boolean {
  let offset = text.indexOf(term)
  while (offset !== -1) {
    const before = text.slice(Math.max(0, offset - 8), offset), after = text.slice(offset + term.length)
    const bounded = !/^[a-z]+$/.test(term) || !/[a-z]$/.test(before) && !/^[a-z]/.test(after)
    if (bounded && !/(?:(?:不|没|别|非)(?:太|很|那么)?|not\s+)$/i.test(before) && !/^(?:不起来|不了)/.test(after)) return true
    offset = text.indexOf(term, offset + 1)
  }
  return false
}
export function stickerEmotions(text: string): string[] {
  const folded = text.toLocaleLowerCase()
  return Object.entries(STICKER_EMOTIONS).filter(([, aliases]) => aliases.some(term => containsMeaning(folded, term))).map(([category]) => category)
}
export function stickerSemanticScore(query: string, name: string, annotation: StickerAnnotation | null): number {
  if (!query) return 1
  const folded = query.toLocaleLowerCase()
  const haystack = [name, annotation?.description ?? '', ...(annotation?.tags ?? [])].join(' ').toLocaleLowerCase()
  const tokens = folded.split(/[\s,，、/]+/).filter(Boolean).slice(0, 16)
  const categories = new Set(stickerEmotions(haystack))
  return (containsMeaning(haystack, folded) ? 10 : 0) + tokens.filter(token => containsMeaning(haystack, token)).length * 3
    + stickerEmotions(query).filter(category => categories.has(category)).length * 2
}

/** Per-account durable annotations are separate from short-lived, per-conversation assets. */
export function createStickerSemanticCache(store: DurableStore, selfId: string) {
  const namespace = 'native-chat.sticker-semantics'
  return Object.freeze({
    read(item: OneBotSticker): StickerAnnotation | null {
      const record = store.read(namespace, stickerSemanticKey(selfId, item))
      if (!record || !isRecord(record.value) || record.value.schema !== 1 || record.value.accountId !== selfId) return null
      try { return validateStickerAnnotation(record.value.annotation) } catch { return null }
    },
    remember(item: OneBotSticker, annotation: StickerAnnotation): void {
      const normalized = validateStickerAnnotation(annotation)
      const key = stickerSemanticKey(selfId, item), previous = store.read(namespace, key)
      store.write(namespace, key, { schema: 1, accountId: selfId, annotation: json(normalized) },
        { expectedRevision: previous?.revision ?? null, expiresAt: Date.now() + 180 * 24 * 60 * 60 * 1000 })
    },
    forget(item: OneBotSticker): void {
      const key = stickerSemanticKey(selfId, item), previous = store.read(namespace, key)
      if (previous) store.delete(namespace, key, previous.revision)
    },
    preview(items: readonly OneBotSticker[]): JsonValue {
      return items.slice(0, 8).map(item => {
        const annotation = this.read(item)
        return { name: item.name ?? null, description: annotation?.description ?? null,
          tags: [...(annotation?.tags ?? [])], avoid: annotation?.avoid ?? '', classified: annotation !== null }
      })
    },
  })
}
