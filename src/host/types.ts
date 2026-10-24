import type { JsonObject, JsonValue, MessageContent } from '../core/types.ts';

export interface StoredRecord {
  namespace: string;
  key: string;
  revision: number;
  updatedAt: number;
  expiresAt: number | null;
  value: JsonValue;
}

export interface WriteOptions { expectedRevision?: number | null; expiresAt?: number | null }
export interface DurableStoreStatsOptions { limit?: number; after?: string }
export interface DurableStoreNamespaceStats {
  namespace: string;
  totalRecords: number;
  expiredRecords: number;
  oldestUpdatedAt: number;
}
export interface DurableStoreStats {
  maxRecords: number;
  totalRecords: number;
  expiredRecords: number;
  remainingRecords: number;
  namespaces: readonly DurableStoreNamespaceStats[];
  next: string | null;
}
export interface DurableStore {
  read(namespace: string, key: string): StoredRecord | null;
  write(namespace: string, key: string, value: JsonValue, options?: WriteOptions): StoredRecord;
  delete(namespace: string, key: string, expectedRevision?: number): boolean;
  list(namespace: string, options?: { limit?: number; after?: string }): readonly StoredRecord[];
  purgeExpired(limit?: number): number;
  stats?(options?: DurableStoreStatsOptions): DurableStoreStats;
  close(): void;
}

export interface SessionBinding {
  conversationId: string;
  sessionId: string;
  generation: number;
}

export interface AgentEvent {
  id: string;
  sessionId: string;
  type: 'message' | 'completed' | 'failed' | 'question' | 'approval';
  content?: readonly MessageContent[];
  data?: JsonObject;
}

export interface AgentAdapter {
  createSession(request: { conversationId: string; requestId: string; signal: AbortSignal }): Promise<{ sessionId: string }>;
  submit(request: { sessionId: string; requestId: string; content: readonly MessageContent[]; signal: AbortSignal }):
    Promise<{ status: 'accepted' | 'rejected' | 'unknown' }>;
  follow(request: { sessionId: string; signal: AbortSignal; onEvent(event: AgentEvent): void | Promise<void> }):
    Promise<() => void | Promise<void>>;
  cancel?(request: { sessionId: string; signal: AbortSignal }): Promise<void>;
}

export interface InboundMessage {
  id: string;
  conversationId: string;
  userId: string;
  receivedAt: number;
  content: readonly MessageContent[];
  directed: boolean;
  isSelf: boolean;
}
