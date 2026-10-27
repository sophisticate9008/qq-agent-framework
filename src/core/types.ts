import type { ExtensionMetadata } from '../contracts/extension-metadata.ts';
import type { AccountScope } from '../contracts/account-scope.ts';
export type { AccountScope } from '../contracts/account-scope.ts';
import type { ResolvedContext, FeatureStateScope } from './context.ts';

export * from '../contracts/data.ts';
import type { JsonObject, JsonValue } from '../contracts/data.ts';
export type Clock = () => number;

export interface FrameworkEvent {
  accountScope?: Readonly<AccountScope>;
  id: string;
  type: string;
  conversationId: string;
  userId?: string;
  sessionId?: string;
  taskId?: string;
  data: JsonObject;
}

export * from '../contracts/messages.ts';
import type { MessageContent } from '../contracts/messages.ts';
export interface PersonaScope { id: string; version: string }
export interface OutboundScope {
  accountScope?: Readonly<AccountScope>;
  persona: Readonly<PersonaScope>;
  sessionId?: string;
  generation?: number;
}
export interface MessageDeliveryReceipt { status: 'confirmed'; messageId: string; kind?: never }
export interface FileUploadReceipt { status: 'confirmed'; kind: 'file-upload'; fileId: string; name: string; messageId?: never }
export type DeliveryReceipt = MessageDeliveryReceipt | FileUploadReceipt | { status: 'unknown' | 'rejected' };
export interface SendRequest {
  conversationId: string;
  content: readonly MessageContent[];
  idempotencyKey: string;
  signal: AbortSignal;
  scope?: Readonly<OutboundScope>;
}
export interface TransportCapabilities { contentTypes: readonly MessageContent['type'][]; maxForwardNodes?: number }
export interface TransportAdapter {
  send(request: SendRequest): Promise<DeliveryReceipt> | DeliveryReceipt;
  capabilities?(): Readonly<TransportCapabilities>;
}
export interface ModelRequest { prompt: JsonValue; signal: AbortSignal }
export interface ModelAdapter { generate(request: ModelRequest): Promise<{ text: string }> | { text: string } }
export interface EffectScope {
  accountScope?: Readonly<AccountScope>;
  eventId: string;
  conversationId: string;
  featureId: string;
  version: string;
  persona?: Readonly<PersonaScope>;
  sessionId?: string;
  generation?: number;
}
export interface EffectRequest { input: JsonValue; scope: Readonly<EffectScope>; signal: AbortSignal }
export interface EffectAdapter { execute(request: EffectRequest): Promise<JsonValue> | JsonValue }

export interface FeatureExecution {
  readonly context: ResolvedContext;
  readonly state: FeatureStateScope;
  readonly signal: AbortSignal;
  generate(prompt: JsonValue): Promise<{ text: string }>;
  send(content: readonly MessageContent[]): Promise<DeliveryReceipt>;
  invoke(capability: string, input: JsonValue): Promise<JsonValue>;
}
export type FeatureHandler = (execution: FeatureExecution, event: FrameworkEvent) => unknown | Promise<unknown>;
export interface FeatureSetup {
  readonly signal: AbortSignal;
  on(type: string, handler: FeatureHandler): void;
  defer(dispose: () => void): void;
}
export interface FeatureDefinition extends ExtensionMetadata {
  id: string;
  version: string;
  apiVersion: 1;
  capabilities: readonly string[];
  subscriptions: readonly string[];
  setup(context: FeatureSetup): void | (() => void);
}
export type FeatureManifest = Omit<FeatureDefinition, 'setup'>;
export interface FeatureOutcome { featureId: string; status: 'completed' | 'failed'; errorCode?: string }
export interface EventReport { eventId: string; conversationId: string; outcomes: FeatureOutcome[] }
export interface AuditEntry {
  stage: string;
  status: string;
  eventId?: string;
  conversationId?: string;
  featureId?: string;
  version?: string;
  capability?: string;
  errorCode?: string;
}
export interface AuditRecord extends AuditEntry { sequence: number; at: number }
