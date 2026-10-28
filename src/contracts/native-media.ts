import type { FrameworkImageMediaType } from './framework-media.ts';

/** Reads original bytes from a current conversation's registered image only. */
export interface NativeImageReferenceReader {
  readImage(request: { readonly conversationId: string; readonly referenceId: string; readonly signal: AbortSignal }): Promise<{
    readonly assetId: string;
    readonly data: Uint8Array;
    readonly mediaType: FrameworkImageMediaType;
    readonly sha256: string;
    readonly expiresAt: number;
  }>;
}

export interface NativeMediaContentReader {
  read(request: { readonly kind: 'image' | 'audio' | 'file' | 'video'; readonly conversationId?: string; readonly source: { readonly file?: string; readonly url?: string; readonly id?: string; readonly busId?: number; readonly fileHash?: string };
    readonly signal: AbortSignal }): Promise<{ readonly status: 'confirmed'; readonly data: Uint8Array;
    readonly mediaType: string | null; readonly name?: string } | { readonly status: 'rejected' | 'unknown'; readonly code: string }>;
}

export interface NativeVideoObservation {
  readonly durationSeconds: number;
  readonly frames: readonly { readonly timeSeconds: number; readonly data: Uint8Array; readonly mediaType: 'image/jpeg' }[];
  readonly audioObserved: false;
  readonly hasAudio: boolean;
}

/** Receives registered video bytes only; no model-supplied location or decoder options. */
export interface NativeVideoObserver {
  observe(request: { readonly data: Uint8Array; readonly signal: AbortSignal }): Promise<NativeVideoObservation>;
}

/** Explicit host service; an absent transcriber does not imply that audio was understood. */
export interface NativeMediaTranscriber {
  transcribe(request: { readonly assetId: string; readonly conversationId: string; readonly data: Uint8Array;
    readonly mediaType: string | null; readonly signal: AbortSignal }): Promise<{ readonly text: string }>;
}
