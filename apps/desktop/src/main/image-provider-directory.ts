import type { ImageProviderDirectory } from '@assetforge/core';
import { purposeOf } from '@assetforge/contracts';
import { LIST_MODELS_TIMEOUT_MS } from '@assetforge/providers';
import type { ProviderGateway } from './provider-gateway.js';
import type { ProviderStore } from './provider-store.js';

/** Options of the image provider directory. */
export interface ImageProviderDirectoryOptions {
  /** The bound of one model lookup; `LIST_MODELS_TIMEOUT_MS` when left out. */
  timeoutMs?: number;
}

/**
 * The `venice` entries of the provider store as core sees them. A model lookup is bounded here by
 * `LIST_MODELS_TIMEOUT_MS`, because the signal core passes is never aborted.
 *
 * @param store the provider entries
 * @param gateway the adapters of the entries
 * @param options the lookup bound
 * @returns the directory
 */
export function createImageProviderDirectory(
  store: ProviderStore,
  gateway: ProviderGateway,
  options: ImageProviderDirectoryOptions = {},
): ImageProviderDirectory {
  const timeoutMs = options.timeoutMs ?? LIST_MODELS_TIMEOUT_MS;
  return {
    resolve(id) {
      const entry = store.resolve(id, 'image');
      return entry === null ? null : { id: entry.id, name: entry.name };
    },
    exists: (id) => {
      const entry = store.get(id);
      return entry !== null && purposeOf(entry.kind) === 'image';
    },
    adapter: (id) => gateway.image(id),
    models: (id, signal) => boundedImageModels(gateway, timeoutMs, id, signal),
    markUsed: (id) => store.markUsed(id),
  };
}

/**
 * The edit models of an image entry, given up after `timeoutMs`.
 *
 * @param gateway the adapters of the entries
 * @param timeoutMs the bound of the lookup
 * @param id the entry
 * @param signal the caller's signal
 * @returns the models, or `provider_timeout` when the own bound ran out
 */
async function boundedImageModels(
  gateway: ProviderGateway,
  timeoutMs: number,
  id: string,
  signal: AbortSignal,
): ReturnType<ImageProviderDirectory['models']> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('The model list took too long')), timeoutMs);
  try {
    return await gateway.imageModels(id, false, AbortSignal.any([signal, deadline.signal]));
  } catch (error) {
    // Only the own bound becomes a code; a caller's abort stays an abort.
    if (deadline.signal.aborted && !signal.aborted) return { ok: false, code: 'provider_timeout' };
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
