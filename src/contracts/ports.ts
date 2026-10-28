import type { AccountScope } from './account-scope.ts';
import type { JsonObject, JsonPrimitive, JsonValue } from './data.ts';
import type { MessageContent } from './messages.ts';

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
export interface DurableIndexDefinition {
  readonly namespace: string;
  readonly field: string;
  readonly unique?: boolean;
  readonly where?: { readonly field: string; readonly equals: JsonPrimitive };
}
export interface DurableLookup {
  readonly namespace: string;
  readonly field: string;
  readonly equals: JsonPrimitive;
  readonly where?: DurableIndexDefinition['where'];
  readonly limit?: number;
}
export interface DurableNumberPage {
  readonly namespace: string;
  readonly field: string;
  readonly limit: number;
  readonly before?: { readonly value: number; readonly key: string };
}
export type DurableCasMutation =
  | { readonly kind: 'write'; readonly namespace: string; readonly key: string; readonly expectedRevision: number | null;
    readonly value: JsonValue; readonly expiresAt?: number | null }
  | { readonly kind: 'delete'; readonly namespace: string; readonly key: string; readonly expectedRevision: number }
  | { readonly kind: 'check'; readonly namespace: string; readonly key: string; readonly expectedRevision: number | null };

export interface DurableStore {
  read(namespace: string, key: string): StoredRecord | null;
  write(namespace: string, key: string, value: JsonValue, options?: WriteOptions): StoredRecord;
  delete(namespace: string, key: string, expectedRevision?: number): boolean;
  list(namespace: string, options?: { limit?: number; after?: string }): readonly StoredRecord[];
  /** A bounded all-or-nothing CAS batch; no callbacks or external actions execute inside storage. */
  compareAndSetBatch?(mutations: readonly DurableCasMutation[]): readonly (StoredRecord | null)[];
  purgeExpired(limit?: number): number;
  stats?(options?: DurableStoreStatsOptions): DurableStoreStats;
  createIndex?(definition: DurableIndexDefinition): void;
  lookup?(query: DurableLookup): readonly StoredRecord[];
  /** Descending numeric field + key pagination, independent of later record updates. */
  listByNumber?(query: DurableNumberPage): readonly StoredRecord[];
  close(): void;
}

export interface SessionBinding {
  accountScope?: Readonly<AccountScope>;
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
  accountScope?: Readonly<AccountScope>;
  id: string;
  conversationId: string;
  userId: string;
  /** Untrusted display text from this message's conversation; userId remains the identity. */
  displayName?: string;
  receivedAt: number;
  content: readonly MessageContent[];
  directed: boolean;
  isSelf: boolean;
}
