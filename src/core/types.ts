import type { ResolvedContext, FeatureStateScope } from './context.ts';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }
export type Clock = () => number;

export interface FrameworkEvent {
  id: string;
  type: string;
  conversationId: string;
  userId?: string;
  sessionId?: string;
  taskId?: string;
  data: JsonObject;
}

export interface TextContent { type: 'text'; text: string }
export type DeliveryReceipt = { status: 'confirmed'; messageId: string }
  | { status: 'unknown' | 'rejected' };
export interface SendRequest {
  conversationId: string;
  content: readonly TextContent[];
  idempotencyKey: string;
  signal: AbortSignal;
}
export interface TransportAdapter { send(request: SendRequest): Promise<DeliveryReceipt> | DeliveryReceipt }
export interface ModelRequest { prompt: JsonValue; signal: AbortSignal }
export interface ModelAdapter { generate(request: ModelRequest): Promise<{ text: string }> | { text: string } }
export interface EffectScope { eventId: string; conversationId: string; featureId: string; version: string }
export interface EffectRequest { input: JsonValue; scope: Readonly<EffectScope>; signal: AbortSignal }
export interface EffectAdapter { execute(request: EffectRequest): Promise<JsonValue> | JsonValue }

export interface FeatureExecution {
  readonly context: ResolvedContext;
  readonly state: FeatureStateScope;
  readonly signal: AbortSignal;
  generate(prompt: JsonValue): Promise<{ text: string }>;
  send(content: readonly TextContent[]): Promise<DeliveryReceipt>;
  invoke(capability: string, input: JsonValue): Promise<JsonValue>;
}
export type FeatureHandler = (execution: FeatureExecution, event: FrameworkEvent) => unknown | Promise<unknown>;
export interface FeatureSetup {
  readonly signal: AbortSignal;
  on(type: string, handler: FeatureHandler): void;
  defer(dispose: () => void): void;
}
export interface FeatureDefinition {
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
