import { normalizeContent } from '../core/content.ts';
import { normalizeSenderDisplayName } from '../contracts/sender-display-name.ts';
import { FrameworkError, assert, isRecord, reference, snapshot } from '../core/values.ts';
import type { MessageContent } from '../core/types.ts';
import type { DurableStore } from './types.ts';
import { digest, json, object } from './data.ts';

export interface HistoryMessage {
  id: string; actor: string; content: readonly MessageContent[]; receivedAt: number;
  /** Optional sender-controlled label, scoped to this history's conversation. */
  displayName?: string;
}
export interface HistoryEntry extends HistoryMessage { sequence: number }
interface Timeline { sequence: number; readThrough: number; droppedThrough: number; messages: HistoryEntry[] }
const namespace = 'history';

function decode(value: unknown): Timeline {
  if (value === null) return { sequence: 0, readThrough: 0, droppedThrough: 0, messages: [] };
  const data = object(value);
  assert(Number.isSafeInteger(data.sequence) && Number(data.sequence) >= 0 && Number.isSafeInteger(data.readThrough)
    && Number(data.readThrough) >= 0 && Number(data.readThrough) <= Number(data.sequence)
    && Number.isSafeInteger(data.droppedThrough) && Number(data.droppedThrough) >= 0 && Array.isArray(data.messages),
  'INVALID_STORED_DATA', 'Stored conversation history is invalid.');
  const messages = data.messages.map(message => {
    assert(isRecord(message) && reference(message.id) && reference(message.actor) && Number.isFinite(message.receivedAt)
      && Number.isSafeInteger(message.sequence), 'INVALID_STORED_DATA', 'Stored history message is invalid.');
    const displayName = normalizeSenderDisplayName(message.displayName);
    return { id: message.id, actor: message.actor, receivedAt: Number(message.receivedAt),
      ...(displayName === undefined ? {} : { displayName }),
      sequence: Number(message.sequence), content: normalizeContent(message.content) };
  });
  return { sequence: Number(data.sequence), readThrough: Number(data.readThrough), droppedThrough: Number(data.droppedThrough), messages };
}

export function createConversationHistory({ store, maxMessages = 100, maxBytes = 256 * 1024 }:
  { store: DurableStore; maxMessages?: number; maxBytes?: number }) {
  assert(Number.isSafeInteger(maxMessages) && maxMessages > 0 && maxMessages <= 1000
    && Number.isSafeInteger(maxBytes) && maxBytes >= 65536 && maxBytes <= 512 * 1024,
  'INVALID_HISTORY_OPTIONS', 'Conversation history limits are invalid.');

  function mutate(conversationId: string, apply: (timeline: Timeline) => void) {
    assert(reference(conversationId), 'INVALID_CONVERSATION', 'A conversation reference is required.');
    const key = digest(conversationId);
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = store.read(namespace, key);
      const timeline = decode(current?.value ?? null);
      apply(timeline);
      try {
        store.write(namespace, key, json(timeline), { expectedRevision: current?.revision ?? null });
        return snapshot(timeline);
      } catch (error) { if (!(error instanceof FrameworkError && error.code === 'STORE_CONFLICT')) throw error; }
    }
    throw new FrameworkError('HISTORY_BUSY', 'Conversation history is busy.');
  }

  return Object.freeze({
    append(conversationId: string, input: HistoryMessage) {
      const { displayName: providedName, ...fields } = snapshot(input);
      const displayName = normalizeSenderDisplayName(providedName);
      const message = { ...fields, ...(displayName === undefined ? {} : { displayName }), content: normalizeContent(input.content) };
      assert(reference(message.id) && reference(message.actor) && Number.isFinite(message.receivedAt),
        'INVALID_HISTORY_MESSAGE', 'A valid history message is required.');
      const result = mutate(conversationId, timeline => {
        const previous = timeline.messages.find(entry => entry.id === message.id);
        if (previous) {
          assert(previous.actor === message.actor && digest(previous.content) === digest(message.content),
            'HISTORY_CONFLICT', 'The history identity has different content.');
          return;
        }
        assert(Buffer.byteLength(JSON.stringify({ ...timeline, messages: [{ ...message, sequence: timeline.sequence + 1 }] })) <= maxBytes,
          'HISTORY_TOO_LARGE', 'A history message exceeds the retention bound.');
        timeline.messages.push({ ...message, sequence: ++timeline.sequence });
        while (timeline.messages.length > maxMessages || Buffer.byteLength(JSON.stringify(timeline)) > maxBytes) {
          const removed = timeline.messages.shift();
          assert(removed, 'HISTORY_TOO_LARGE', 'A history message exceeds the retention bound.');
          timeline.droppedThrough = removed.sequence;
        }
      });
      return result.messages.find(entry => entry.id === message.id)?.sequence ?? result.sequence;
    },
    snapshot(conversationId: string, { afterSequence, limit = Math.min(100, maxMessages) }: { afterSequence?: number; limit?: number } = {}) {
      assert(reference(conversationId) && Number.isSafeInteger(limit) && limit > 0 && limit <= maxMessages
        && (afterSequence === undefined || Number.isSafeInteger(afterSequence) && afterSequence >= 0),
      'INVALID_HISTORY_QUERY', 'A bounded history query is required.');
      const timeline = decode(store.read(namespace, digest(conversationId))?.value ?? null);
      const after = afterSequence ?? timeline.readThrough;
      const unread = timeline.messages.filter(message => message.sequence > after);
      return snapshot({ messages: unread.slice(0, limit), readThrough: timeline.readThrough, latestSequence: timeline.sequence,
        droppedThrough: timeline.droppedThrough, partial: after < timeline.droppedThrough || unread.length > limit });
    },
    markRead(conversationId: string, throughSequence: number) {
      return mutate(conversationId, timeline => {
        assert(Number.isSafeInteger(throughSequence) && throughSequence >= timeline.readThrough && throughSequence <= timeline.sequence,
          'INVALID_READ_CURSOR', 'The read cursor must be monotonic and within received history.');
        timeline.readThrough = throughSequence;
      }).readThrough;
    },
  });
}
