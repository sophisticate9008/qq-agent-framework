import { validateNativeMemoryInput, type NativeMemoryChange, type NativeMemoryEntry, type NativeMemoryInput, type NativeMemoryScope } from '../../src/contracts/native-memory.ts';

export interface MemoryDraft {
  readonly scope: NativeMemoryScope['kind']; readonly conversationId: string; readonly userId: string;
  readonly kind: NativeMemoryInput['kind']; readonly content: string; readonly tags: string;
  readonly changeExpiry: boolean; readonly permanent: boolean; readonly hours: string;
}
export function memoryDraft(entry?: NativeMemoryEntry): MemoryDraft {
  return { scope: entry?.scope.kind ?? 'group', conversationId: entry?.scope.kind !== 'global' ? entry?.scope.conversationId ?? '' : '',
    userId: entry?.scope.kind === 'user' ? entry.scope.userId : '', kind: entry?.kind ?? 'memory', content: entry?.content ?? '',
    tags: entry?.tags.join('\n') ?? '', changeExpiry: entry === undefined, permanent: entry?.expiresAt === null, hours: '24' };
}
export function memoryManagementRequest(draft: MemoryDraft, entry: NativeMemoryEntry | null, now = Date.now()) {
  const scope = entry?.scope ?? (draft.scope === 'global' ? { kind: 'global' as const }
    : draft.scope === 'group' ? { kind: 'group' as const, conversationId: draft.conversationId.trim() }
      : { kind: 'user' as const, conversationId: draft.conversationId.trim(), userId: draft.userId.trim() });
  if ((!entry || draft.changeExpiry) && !draft.permanent && (!/^\d+(?:\.\d+)?$/.test(draft.hours) || Number(draft.hours) <= 0)) throw new Error('请填写大于0的有效小时数，或明确选择长期保存。');
  const expiresAt = entry && !draft.changeExpiry ? entry.expiresAt : draft.permanent ? null : now + Number(draft.hours) * 3_600_000;
  const value = validateNativeMemoryInput({ scope, kind: draft.kind, content: draft.content.trim(),
    tags: draft.tags.split(/[\n,，]/).map(tag => tag.trim()).filter(Boolean), expiresAt });
  return entry ? { action: 'correct' as const, id: entry.id, revision: entry.revision, entry: value }
    : { action: 'create' as const, entry: value };
}
export function memoryScopeLabel(scope: NativeMemoryScope): string {
  return scope.kind === 'global' ? '全局共享' : scope.kind === 'group' ? scope.conversationId : `${scope.conversationId} · 用户 ${scope.userId}`;
}
export const memoryStateLabels: Readonly<Record<NativeMemoryEntry['status'], string>> = {
  proposed: '待QQ主人确认', confirmed: '已采用', revoked: '已撤销', expired: '已到期',
};
export const memorySourceLabels: Readonly<Record<NativeMemoryEntry['source']['kind'], string>> = {
  operator: '主人手工记录', 'owner-message': 'QQ主人消息', 'user-message': 'QQ用户消息', 'model-inference': '模型提议',
};
export const memoryChangeLabels: Readonly<Record<NativeMemoryChange['action'], string>> = {
  propose: '提出建议', create: '手工记录', confirm: 'QQ主人确认', correct: '纠正内容', revoke: '撤销内容',
};
