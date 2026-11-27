import { readFile, stat } from 'node:fs/promises';
import { IMAGE_INPUT_MAX_BYTES } from '@assetforge/contracts';
import type { GenerationImageSource, ImageInput } from '@assetforge/core';

// Kept free of Electron imports. The image a generation sends is held in memory once, so its size is bounded:
// the original when the provider takes its type, else the lossless full-size rendition of the preview cache.

/** The part of the preview service the source needs: the cached lossless PNG rendition, or null. */
export interface FullRenditions {
  get(o: { sha256: string; sourcePath: string; size: 'full' }): Promise<string | null>;
}

const SENT_AS_IS = new Set<ImageInput['mimeType']>(['image/png', 'image/jpeg', 'image/webp']);

const isMissing = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'ENOENT';

/**
 * The file's bytes when it is at most `maxBytes` on disk, else null. Measured before it is read, so a file larger
 * than its stored size is never loaded whole; the length is checked again for a file that grew in between.
 * A file that is gone answers null when `missingIsNull`, else the error is thrown.
 */
async function readBounded(path: string, maxBytes: number, signal: AbortSignal, missingIsNull: boolean): Promise<Buffer | null> {
  try {
    if ((await stat(path)).size > maxBytes) return null;
    const data = await readFile(path, { signal });
    return data.length > maxBytes ? null : data;
  } catch (error) {
    if (missingIsNull && isMissing(error)) return null;
    throw error;
  }
}

export function createGenerationImageSource(previews: FullRenditions, o: { maxBytes?: number } = {}): GenerationImageSource {
  const maxBytes = o.maxBytes ?? IMAGE_INPUT_MAX_BYTES;
  return {
    async read(file, signal) {
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
    },
  };
}
