/** Optional extension service. Generation returns actual bytes and never sends them implicitly. */
export interface ImageGenerationService {
  generate(request: {
    readonly idempotencyKey: string
    readonly prompt: string
    readonly subject?: 'custom' | 'self'
    readonly signal: AbortSignal
  }): Promise<{ readonly data: Uint8Array; readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; readonly sha256: string }>
}
