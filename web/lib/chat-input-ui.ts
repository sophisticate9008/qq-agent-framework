import { CHAT_INPUT_PACKAGE_ID, validateChatInputConfiguration, type ChatInputConfiguration } from '../../src/contracts/chat-input-configuration.ts';
import type { PackageConfigurationSnapshot } from '../../src/contracts/package-configuration.ts';
import { NATIVE_REVISION_PATTERN } from '../../src/contracts/native-revisions.ts';
import { isRecord } from './api.ts';

export interface ChatInputForm {
  readonly enabled: boolean; readonly nicknames: string; readonly wakeOnMention: boolean; readonly wakeOnReply: boolean;
  readonly continuationSeconds: string; readonly group: boolean; readonly private: boolean; readonly include: string; readonly exclude: string;
  readonly groupWakeProbabilityPercent?: string;
}
export function chatInputForm(value: ChatInputConfiguration): ChatInputForm {
  return { enabled: value.enabled, nicknames: value.nicknames.join('\n'), wakeOnMention: value.wakeOnMention, wakeOnReply: value.wakeOnReply,
    continuationSeconds: String(value.continuationMs / 1000), groupWakeProbabilityPercent: String(value.groupWakeProbabilityPercent ?? 1), group: value.scopes.group, private: value.scopes.private,
    include: value.scopes.include.join('\n'), exclude: value.scopes.exclude.join('\n') };
}
export function parseGroupWakeProbabilityPercent(value: string): number | null {
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return null;
  const probability = Number(value);
  return Number.isFinite(probability) && probability >= 0 && probability <= 100 ? probability : null;
}
export function chatInputConfiguration(form: ChatInputForm): ChatInputConfiguration | null {
  if (!/^\d+(?:\.\d{1,3})?$/.test(form.continuationSeconds)) return null;
  const probability = parseGroupWakeProbabilityPercent(form.groupWakeProbabilityPercent ?? '1');
  if (probability === null) return null;
  const lines = (value: string) => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  try {
    return validateChatInputConfiguration({ schema: 1, enabled: form.enabled, nicknames: lines(form.nicknames),
      wakeOnMention: form.wakeOnMention, wakeOnReply: form.wakeOnReply, continuationMs: Math.round(Number(form.continuationSeconds) * 1000),
      groupWakeProbabilityPercent: probability,
      scopes: { group: form.group, private: form.private, include: lines(form.include), exclude: lines(form.exclude) } });
  } catch { return null; }
}
export function parseChatInputSnapshot(value: unknown): PackageConfigurationSnapshot<ChatInputConfiguration> | null {
  const keys = ['schema', 'id', 'revision', 'schemaVersion', 'source', 'application', 'configuration'];
  if (!isRecord(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))
    || value.schema !== 1 || value.id !== CHAT_INPUT_PACKAGE_ID || typeof value.revision !== 'string' || !NATIVE_REVISION_PATTERN.test(value.revision)
    || value.schemaVersion !== 1 || value.application !== 'live' || value.source !== 'default' && value.source !== 'stored') return null;
  try { return { schema: 1, id: CHAT_INPUT_PACKAGE_ID, revision: value.revision, schemaVersion: 1, source: value.source,
    application: 'live', configuration: validateChatInputConfiguration(value.configuration) }; } catch { return null; }
}
