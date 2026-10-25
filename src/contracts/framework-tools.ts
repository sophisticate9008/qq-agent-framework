import type { FrameworkToolContent } from './framework-media.ts'
import type { JsonObject, JsonValue } from './data.ts'

/** Definitions are installed by trusted packages, never supplied in model arguments. */
export interface FrameworkToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: JsonObject
  readonly featureId: string
  readonly capability: string
  readonly timeoutMs: number
}

export interface FrameworkToolCall {
  readonly id: string
  readonly sessionId: string
  readonly generation: number
  readonly requestId: string
  readonly userMessageId: string
  readonly turn: number
  readonly name: string
  readonly input: JsonValue
  readonly expiresAt: number
}

export type FrameworkToolResult =
  | { readonly status: 'confirmed'; readonly value: JsonValue; readonly content?: readonly FrameworkToolContent[] }
  | { readonly status: 'rejected' | 'unknown'; readonly code: string }

export interface FrameworkToolProjection {
  readonly sessionId: string
  readonly leaseId: string
  readonly generation: number
  readonly tools: readonly FrameworkToolDefinition[]
}

export interface FrameworkToolPendingCall {
  readonly ticket: string
  readonly leaseId: string
  readonly call: FrameworkToolCall
}
