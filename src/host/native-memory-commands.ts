import type { NativeMemoryService } from './native-memory.ts';
import type { NativeMemoryAuthority, NativeMemoryScope } from '../contracts/native-memory.ts';
import type { ControlCommandDefinition } from './control-commands.ts';
import type { InboundMessage } from './types.ts';

const replies = Object.freeze({ saved: '已保存这条记忆；它只作为资料，不改变权限。',
  confirmed: '已确认这条记忆，之后按它的范围用于会话。', revoked: '已撤销这条记忆，之后不再注入。',
  owner: '记忆的保存、确认和撤销需要主人操作。', failed: '记忆操作未完成，请查看记忆状态后再处理。' });
function command(message: Readonly<InboundMessage>) {
  if (message.isSelf || message.content.some(part => !['text', 'mention', 'reply'].includes(part.type))) return null;
  const text = message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n').trim();
  if (!message.conversationId.startsWith('private:') && !message.directed && !text.startsWith('/')) return null;
  const write = /^\/?(记住全局|记住群|记住)\s+([\s\S]{1,4000})$/.exec(text);
  if (write) return { action: write[1], value: write[2] };
  const change = /^\/?(确认记忆|撤销记忆)\s+(memory-[a-f0-9-]{36})$/.exec(text);
  return change ? { action: change[1], value: change[2] } : null;
}

/** The durable control-command dispatcher supplies normalized QQ messages and suppresses duplicate command execution. */
export function createNativeMemoryCommand(options: {
  readonly service: () => NativeMemoryService;
  readonly owner: () => string | null;
  readonly withSource: (message: Readonly<InboundMessage>, signal: AbortSignal, run: () => Promise<void>) => Promise<void>;
}): ControlCommandDefinition {
  return Object.freeze<ControlCommandDefinition>({ id: 'native-memory', replyTexts: Object.values(replies), matches: message => command(message) !== null,
    async handle({ message, signal, reply }) {
      const input = command(message);
      if (!input) return;
      if (!options.owner() || message.userId !== options.owner()) { await reply(replies.owner); return; }
      let response: string = replies.failed;
      try {
        await options.withSource(message, signal, async () => {
          const service = options.service();
          const authority: NativeMemoryAuthority = { kind: 'owner-message', conversationId: message.conversationId,
            messageId: message.id, userId: message.userId };
          if (input.action === '确认记忆' || input.action === '撤销记忆') {
            const entry = service.read(input.value);
            if (entry.scope.kind !== 'global' && entry.scope.conversationId !== message.conversationId) return;
            if (input.action === '确认记忆') { await service.confirm(entry.id, entry.revision, authority, signal); response = replies.confirmed; }
            else { await service.revoke(entry.id, entry.revision, authority, signal); response = replies.revoked; }
          } else {
            if (input.action === '记住群' && !message.conversationId.startsWith('group:')) return;
            const scope: NativeMemoryScope = input.action === '记住全局' ? { kind: 'global' }
              : input.action === '记住群' ? { kind: 'group', conversationId: message.conversationId }
                : { kind: 'user', userId: message.userId, conversationId: message.conversationId };
            await service.createConfirmed({ scope, kind: 'memory', content: input.value, tags: [], expiresAt: null }, authority, signal);
            response = replies.saved;
          }
        });
      } catch { response = replies.failed; }
      await reply(response);
    }
  });
}
