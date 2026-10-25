import type { MessageContent } from './messages.ts';

export type NativeSilentReason = 'not-addressed' | 'already-answered' | 'no-useful-addition' | 'user-requested';
export type NativeReplyDecision = { readonly state: 'silent'; readonly reason: NativeSilentReason }
  | { readonly state: 'invalid'; readonly reason: 'invalid_reply_decision' };
/** An exact versioned final envelope is control data. Ordinary answer text keeps its existing meaning. */
export function parseNativeReplyDecision(content: readonly MessageContent[]): NativeReplyDecision | null {
  if (content.length !== 1 || content[0].type !== 'text' || content[0].text.length > 2_048) return null;
  let input: unknown;
  try { input = JSON.parse(content[0].text); } catch {
    return /^\s*\{\s*"schema"\s*:\s*"qaf\.reply\/1"/.test(content[0].text)
      ? { state: 'invalid', reason: 'invalid_reply_decision' } : null;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (value.schema !== 'qaf.reply/1') return null;
  if (Object.keys(value).length !== 3 || value.action !== 'silent'
    || !['not-addressed', 'already-answered', 'no-useful-addition', 'user-requested'].includes(String(value.reason))) {
    return { state: 'invalid', reason: 'invalid_reply_decision' };
  }
  return { state: 'silent', reason: value.reason as NativeSilentReason };
}
