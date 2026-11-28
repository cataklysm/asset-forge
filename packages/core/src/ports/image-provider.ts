import type { Readable } from 'node:stream';
import type { ImageModel, ListImageModelsResult } from '@assetforge/contracts';

/** An image as it is sent to an image provider; held in main-process memory, never sent over IPC. */
export interface ImageInput {
  data: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
}

/**
 * An image provider (edit and upscale). Each method rejects with a `JobError` on provider failure, or with
 * the signal's reason when `signal` aborts. Implemented outside core.
 */
export interface ImageProvider {
  listEditModels(signal: AbortSignal): Promise<ImageModel[]>;
  editImage(r: {
    image: ImageInput;
    model: string;
    prompt: string;
    aspectRatio: string | null;
    resolution: string | null;
    safeMode: boolean;
    signal: AbortSignal;
  }): Promise<{ stream: Readable; mimeType: string }>;
  upscaleImage(r: { image: ImageInput; scale: 2 | 4; signal: AbortSignal }): Promise<{ stream: Readable; mimeType: string }>;
}

/** The `venice` provider entries as use cases see them. Implemented outside core. */
export interface ImageProviderDirectory {
  /**
   * A given id: that entry, else NotFoundError, or InvalidOperationError when it is not a `venice` entry.
   * Absent: the image entry used last, else the first, else null.
   */
  resolve(id: string | undefined): { id: string; name: string } | null;
  exists(id: string): boolean;
  adapter(id: string): ImageProvider | null;
  /** The entry's edit models: cached, else loaded within `LIST_MODELS_TIMEOUT_MS`. */
  models(id: string, signal: AbortSignal): Promise<ListImageModelsResult>;
  /** Best effort. */
  markUsed(id: string): void;
}

/** Reads the image a generation sends. Implemented outside core. */
export interface GenerationImageSource {
  /**
   * The original when it is JPEG, PNG or WebP and at most `IMAGE_INPUT_MAX_BYTES`, else the lossless rendition
   * when it is at most that size, else null.
   */
  read(
    file: { absolutePath: string; mimeType: string; sha256: string; sizeBytes: number },
    signal: AbortSignal,
  ): Promise<ImageInput | null>;
}
