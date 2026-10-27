/** Account-bound host port. The caller checks current policy and resolves media before invoking it. */
export type QzoneVisibility =
  | { readonly kind: 'public' | 'friends' | 'self' }
  | { readonly kind: 'allow' | 'deny'; readonly userIds: readonly string[] };

export type QzoneAction = 'publish' | 'delete';
export type QzoneResult<Value> = { readonly status: 'confirmed'; readonly data: Value }
  | { readonly status: 'rejected' | 'unknown'; readonly code: string };

export interface QzonePublishRequest {
  readonly content: string;
  /** Trusted host-resolved sources, never arbitrary model-supplied paths or URLs. */
  readonly images?: readonly string[];
  /** Explicit visibility prevents a provider's public default from being applied accidentally. */
  readonly visibility: QzoneVisibility;
  readonly signal: AbortSignal;
}

export interface QzonePort {
  /** Configured supported actions, not an assertion of login status or authorization. */
  describe(): { readonly actions: readonly QzoneAction[] };
  publish(request: QzonePublishRequest): Promise<QzoneResult<{ readonly postId: string; readonly publishedAt: number | null }>>;
  delete(request: { readonly postId: string; readonly signal: AbortSignal }): Promise<QzoneResult<null>>;
}
