export interface NativeMediaContentReader {
  read(request: { readonly kind: 'image' | 'audio' | 'file'; readonly conversationId?: string; readonly source: { readonly file?: string; readonly id?: string; readonly busId?: number; readonly fileHash?: string };
    readonly signal: AbortSignal }): Promise<{ readonly status: 'confirmed'; readonly data: Uint8Array;
    readonly mediaType: string | null; readonly name?: string } | { readonly status: 'rejected' | 'unknown'; readonly code: string }>;
}

/** Explicit host service; an absent transcriber does not imply that audio was understood. */
export interface NativeMediaTranscriber {
  transcribe(request: { readonly assetId: string; readonly conversationId: string; readonly data: Uint8Array;
    readonly mediaType: string | null; readonly signal: AbortSignal }): Promise<{ readonly text: string }>;
}
