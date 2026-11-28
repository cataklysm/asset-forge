import type { Readable } from 'node:stream';
import type { ImageModel, ListImageModelsResult } from '@assetforge/contracts';

// The generation studio's side of the image providers: the adapter, the directory of image entries and the reader
// of the input image.

/** An image as it is sent to an image provider; held in main-process memory, never sent over IPC. */
export interface ImageInput {
  /** The encoded image. */
  data: Uint8Array;
  /** Its format. */
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
}

/**
 * An image provider (edit and upscale). Each method rejects with a `JobError` on provider failure, or with
 * the signal's reason when `signal` aborts. Implemented outside core.
 */
export interface ImageProvider {
  /**
   * The models that can edit an image.
   *
   * @param signal aborts the request
   * @returns the edit models
   */
  listEditModels(signal: AbortSignal): Promise<ImageModel[]>;
  /**
   * Edits one image after a prompt; a paid request.
   *
   * @param request the input image, the model, the resolved prompt, the aspect ratio and resolution (null: the
   *   model's default), the safe mode and the abort signal
   * @returns the result as a stream with its MIME type
   */
  editImage(request: {
    image: ImageInput;
    model: string;
    prompt: string;
    aspectRatio: string | null;
    resolution: string | null;
    safeMode: boolean;
    signal: AbortSignal;
  }): Promise<{ stream: Readable; mimeType: string }>;
  /**
   * Upscales one image; a paid request.
   *
   * @param request the input image, the scale and the abort signal
   * @returns the result as a stream with its MIME type
   */
  upscaleImage(request: {
    image: ImageInput;
    scale: 2 | 4;
    signal: AbortSignal;
  }): Promise<{ stream: Readable; mimeType: string }>;
}

/** The `venice` provider entries as use cases see them. Implemented outside core. */
export interface ImageProviderDirectory {
  /**
   * A given id: that entry, else NotFoundError, or InvalidOperationError when it is not a `venice` entry.
   * Absent: the image entry used last, else the first, else null.
   *
   * @param id the provider entry, or undefined for the default one
   * @returns the entry's id and name; null when there is no image entry at all
   */
  resolve(id: string | undefined): { id: string; name: string } | null;
  /**
   * Whether an entry exists.
   *
   * @param id the provider entry
   * @returns true when it exists
   */
  exists(id: string): boolean;
  /**
   * The adapter of an entry.
   *
   * @param id the provider entry
   * @returns the adapter; null when there is no image adapter for the id
   */
  adapter(id: string): ImageProvider | null;
  /**
   * The entry's edit models: cached, else loaded within `LIST_MODELS_TIMEOUT_MS`.
   *
   * @param id the provider entry
   * @param signal aborts the request
   * @returns the models, or why they could not be listed
   */
  models(id: string, signal: AbortSignal): Promise<ListImageModelsResult>;
  /**
   * Remembers the entry as the one used last; best effort.
   *
   * @param id the provider entry
   */
  markUsed(id: string): void;
}

/** Reads the image a generation sends. Implemented outside core. */
export interface GenerationImageSource {
  /**
   * The original when it is JPEG, PNG or WebP and at most `IMAGE_INPUT_MAX_BYTES`, else the lossless rendition
   * when it is at most that size, else null.
   *
   * @param file the source file's absolute path, MIME type, checksum and size
   * @param signal aborts the read
   * @returns the image to send; null when neither fits
   */
  read(
    file: { absolutePath: string; mimeType: string; sha256: string; sizeBytes: number },
    signal: AbortSignal,
  ): Promise<ImageInput | null>;
}
