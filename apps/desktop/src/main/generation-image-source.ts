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

export function createGenerationImageSource(previews: FullRenditions, o: { maxBytes?: number } = {}): GenerationImageSource {
  const maxBytes = o.maxBytes ?? IMAGE_INPUT_MAX_BYTES;
  return {
    async read(file, signal) {
      signal.throwIfAborted();
      const mimeType = file.mimeType as ImageInput['mimeType'];
      if (SENT_AS_IS.has(mimeType) && file.sizeBytes <= maxBytes) {
        const data = await readFile(file.absolutePath, { signal });
        // The stored size is checked; the file itself could have grown since.
        if (data.length > maxBytes) return null;
        return { data: new Uint8Array(data), mimeType };
      }
      const rendition = await previews.get({ sha256: file.sha256, sourcePath: file.absolutePath, size: 'full' });
      signal.throwIfAborted();
      if (rendition === null) return null;
      let size: number;
      try {
        size = (await stat(rendition)).size;
      } catch {
        return null;
      }
      if (size > maxBytes) return null;
      const data = await readFile(rendition, { signal });
      return { data: new Uint8Array(data), mimeType: 'image/png' };
    },
  };
}
