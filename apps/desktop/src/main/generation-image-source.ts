import { readFile, stat } from 'node:fs/promises';
import { IMAGE_INPUT_MAX_BYTES } from '@assetforge/contracts';
import type { GenerationImageSource, ImageInput } from '@assetforge/core';

// Kept free of Electron imports. The image a generation sends is held in memory once, so its size is bounded:
// the original when the provider takes its type, else the lossless full-size rendition of the preview cache.

/** The part of the preview service the source needs: the cached lossless PNG rendition, or null. */
export interface FullRenditions {
  /**
   * @param request the file's hash and path, and the size
   * @returns the path of the cached rendition, or null
   */
  get(request: { sha256: string; sourcePath: string; size: 'full' }): Promise<string | null>;
}

/** What the generation image source is built with. */
export interface GenerationImageSourceOptions {
  /** The largest image sent; `IMAGE_INPUT_MAX_BYTES` without it. */
  maxBytes?: number;
}

/** The file a generation sends, as the core hands it over. */
type SourceFile = Parameters<GenerationImageSource['read']>[0];

const SENT_AS_IS = new Set<ImageInput['mimeType']>(['image/png', 'image/jpeg', 'image/webp']);

/**
 * Whether an error says the file is gone.
 *
 * @param error the error
 * @returns true for ENOENT
 */
const isMissing = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'ENOENT';

/**
 * The file's bytes when it is at most `maxBytes` on disk, else null. Measured before it is read, so a file larger
 * than its stored size is never loaded whole; the length is checked again for a file that grew in between.
 * A file that is gone answers null when `missingIsNull`, else the error is thrown.
 *
 * @param path the file
 * @param maxBytes the largest size read
 * @param signal ends the read
 * @param missingIsNull true to answer null for a file that is gone
 * @returns the bytes, or null
 */
async function readBounded(
  path: string,
  maxBytes: number,
  signal: AbortSignal,
  missingIsNull: boolean,
): Promise<Buffer | null> {
  try {
    if ((await stat(path)).size > maxBytes) return null;
    const data = await readFile(path, { signal });
    return data.length > maxBytes ? null : data;
  } catch (error) {
    if (missingIsNull && isMissing(error)) return null;
    throw error;
  }
}

/**
 * Creates the source of the images generations send.
 *
 * @param previews the full renditions of the preview cache
 * @param options the size limit
 * @returns the source
 */
export function createGenerationImageSource(
  previews: FullRenditions,
  options: GenerationImageSourceOptions = {},
): GenerationImageSource {
  const maxBytes = options.maxBytes ?? IMAGE_INPUT_MAX_BYTES;
  return { read: (file, signal) => readImage(previews, maxBytes, file, signal) };
}

/**
 * The image of a file: the original when its type is sent as it is and it fits, else the full rendition.
 *
 * @param previews the full renditions of the preview cache
 * @param maxBytes the largest image sent
 * @param file the file
 * @param signal ends the read
 * @returns the image, or null when it is unavailable or too large
 */
async function readImage(
  previews: FullRenditions,
  maxBytes: number,
  file: SourceFile,
  signal: AbortSignal,
): Promise<ImageInput | null> {
  signal.throwIfAborted();
  const mimeType = file.mimeType as ImageInput['mimeType'];
  if (SENT_AS_IS.has(mimeType) && file.sizeBytes <= maxBytes) {
    const data = await readBounded(file.absolutePath, maxBytes, signal, false);
    return data === null ? null : { data: new Uint8Array(data), mimeType };
  }
  const rendition = await previews.get({ sha256: file.sha256, sourcePath: file.absolutePath, size: 'full' });
  signal.throwIfAborted();
  if (rendition === null) return null;
  // The cache may evict the rendition at any time; then the file is unavailable, not an internal error.
  const data = await readBounded(rendition, maxBytes, signal, true);
  return data === null ? null : { data: new Uint8Array(data), mimeType: 'image/png' };
}
