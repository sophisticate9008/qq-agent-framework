import type { MessageContent } from '../core/types.ts';

/** Classify contact signals without treating quotes, media or mentions of others as empty calls. */
export function nativeChatWakeKind(id: string, content: readonly MessageContent[], selfId?: string): 'mention' | 'poke' | null {
  if (content.some(part => part.type === 'mention' && part.userId === selfId)
    && content.every(part => part.type === 'mention' && part.userId === selfId
      || part.type === 'text' && part.text.trim() === '')) return 'mention';
  // Only the protocol adapter's notice projection represents a poke; ordinary text does not.
  if (/^onebot-notice:[a-f0-9]{64}$/.test(id) && content.length === 1
    && content[0]?.type === 'text' && content[0].text === '[拍一拍] 对方戳了戳你。') return 'poke';
  return null;
}
