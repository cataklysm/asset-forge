import type { JobErrorCode, ListImageModelsResult, ListModelsResult, ProviderKind } from '@assetforge/contracts';
import { InvalidOperationError, JobError, NotFoundError, type ImageProvider, type VisionProvider } from '@assetforge/core';
import type { createOllamaVision } from '@assetforge/providers';
import { PROVIDER_NOT_FOUND, wrongKind, type ProviderEntry, type ProviderStore } from './provider-store.js';

// One adapter per provider entry (vision for `ollama`, image for `venice`), dropped when that entry
// changes. Kept free of Electron imports.

/** What `createVeniceImage` accepts; typed structurally so this file names no concrete image adapter. */
export type ImageAdapterFactory = (o: {
  baseUrl: string;
  timeoutMs: number;
  apiKey: () => string | null;
  onFailure: (code: JobErrorCode, status: number | null) => void;
}) => ImageProvider;

export interface ProviderGateway {
  /** The vision adapter of an `ollama` entry; null for no id, an id that names no entry, or a `venice` entry. */
  vision(id: string | null): VisionProvider | null;
  /** The image adapter of a `venice` entry; null for no id, an id that names no entry, or an `ollama` entry. */
  image(id: string | null): ImageProvider | null;
  /** The entry's models, cached per entry until it changes or `refresh` is true. Failures are not cached. */
  models(id: string, refresh: boolean, signal: AbortSignal): Promise<ListModelsResult>;
  /** The `venice` entry's edit models, cached like `models`. */
  imageModels(id: string, refresh: boolean, signal: AbortSignal): Promise<ListImageModelsResult>;
}

export function createProviderGateway(o: {
  store: ProviderStore;
  create: typeof createOllamaVision;
  createImage: ImageAdapterFactory;
  log: (line: string) => void;
}): ProviderGateway {
  const visionAdapters = new Map<string, VisionProvider>();
  const imageAdapters = new Map<string, ImageProvider>();
  const cachedModels = new Map<string, ListModelsResult>();
  const cachedImageModels = new Map<string, ListImageModelsResult>();
  /** Raised on every change of an entry, so a list requested before the change is not cached after it. */
  const generations = new Map<string, number>();
  const generation = (id: string): number => generations.get(id) ?? 0;

  o.store.onChange((id) => {
    visionAdapters.delete(id);
    imageAdapters.delete(id);
    cachedModels.delete(id);
    cachedImageModels.delete(id);
    generations.set(id, generation(id) + 1);
  });

  /** The adapter options of an entry. Only the id, the code and the status are logged: never the URL, a header or a body. */
  const options = (entry: ProviderEntry, label: string) => {
    const { id, baseUrl } = entry;
    return {
      baseUrl,
      timeoutMs: entry.timeoutSeconds * 1000,
      // Bound to this entry and this adapter's base URL: a stale adapter still in use after an origin
      // change, a deletion or a recreation under another id gets no key.
      apiKey: () => o.store.apiKeyFor(id, baseUrl),
      onFailure: (code: JobErrorCode, status: number | null) =>
        o.log(`${label} provider ${id} failed: ${code}${status === null ? '' : ` (HTTP ${status})`}`),
    };
  };

  const entryOf = (id: string | null, kind: ProviderKind): ProviderEntry | null => {
    if (id === null) return null;
    const entry = o.store.get(id);
    return entry !== null && entry.kind === kind ? entry : null;
  };

  const vision = (id: string | null): VisionProvider | null => {
    const existing = id === null ? undefined : visionAdapters.get(id);
    if (existing !== undefined) return existing;
    const entry = entryOf(id, 'ollama');
    if (entry === null) return null;
    const adapter = o.create(options(entry, 'Vision'));
    visionAdapters.set(entry.id, adapter);
    return adapter;
  };

  const image = (id: string | null): ImageProvider | null => {
    const existing = id === null ? undefined : imageAdapters.get(id);
    if (existing !== undefined) return existing;
    const entry = entryOf(id, 'venice');
    if (entry === null) return null;
    const adapter = o.createImage(options(entry, 'Image'));
    imageAdapters.set(entry.id, adapter);
    return adapter;
  };

  /** The cache and generation rule shared by both lists. */
  async function cachedList<T>(
    id: string,
    kind: ProviderKind,
    refresh: boolean,
    cache: Map<string, { ok: true; models: T[] } | { ok: false; code: JobErrorCode }>,
    load: () => Promise<T[]>,
  ): Promise<{ ok: true; models: T[] } | { ok: false; code: JobErrorCode }> {
    const entry = o.store.get(id);
    if (entry === null) throw new NotFoundError(PROVIDER_NOT_FOUND);
    if (entry.kind !== kind) throw new InvalidOperationError(wrongKind(kind));
    const hit = cache.get(id);
    if (!refresh && hit !== undefined) return hit;
    const started = generation(id);
    let result: { ok: true; models: T[] };
    try {
      result = { ok: true, models: await load() };
    } catch (error) {
      if (error instanceof JobError) return { ok: false, code: error.code };
      throw error;
    }
    if (started === generation(id)) cache.set(id, result);
    return result;
  }

  return {
    vision,
    image,
    models: (id, refresh, signal) => cachedList(id, 'ollama', refresh, cachedModels, () => vision(id)!.listModels(signal)),
    imageModels: (id, refresh, signal) =>
      cachedList(id, 'venice', refresh, cachedImageModels, () => image(id)!.listEditModels(signal)),
  };
}
