import type { JsonObject, JsonValue } from './data.ts';
import type { QzoneResult } from './qzone.ts';

/** Low-level protocol operations. Availability is separate from caller authorization. */
export type QzoneToolName = 'get_qzone_msg_list' | 'get_qzone_msg_detail' | 'get_qzone_feeds'
  | 'send_qzone_msg' | 'delete_qzone_msg' | 'set_qzone_msg_right' | 'like_qzone' | 'unlike_qzone' | 'comment_qzone';
export interface QzoneToolDefinition {
  readonly name: QzoneToolName;
  readonly title: string;
  readonly description: string;
  readonly readOnly: boolean;
  readonly parameters: JsonObject;
}
export interface QzoneToolInventory {
  readonly schema: 1;
  readonly state: 'available' | 'unsupported' | 'unknown';
  readonly source: 'protocol-actions' | 'version-map' | 'none';
  readonly implementation: { readonly name: string; readonly version: string } | null;
  readonly tools: readonly QzoneToolDefinition[];
  readonly reason: string | null;
}
export interface QzoneToolPort {
  /** Last observed inventory; does not send a request. */
  describe(): QzoneToolInventory;
  /** Read-only capability discovery; never publishes, deletes, or probes write operations. */
  inspect(signal: AbortSignal): Promise<QzoneToolInventory>;
  /** Protocol names/parameters are deliberately preserved for trusted host and plugin callers. */
  execute(request: { readonly name: QzoneToolName; readonly input: JsonObject; readonly signal: AbortSignal }): Promise<QzoneResult<JsonValue>>;
}
