import {
  isVisionKind,
  parseExtraParameters,
  purposeOf,
  type JobErrorCode,
  type ListImageModelsResult,
  type ListModelsResult,
  type ProviderPurpose,
  type VisionKind,
  type VisionRequestOptions,
} from '@assetforge/contracts';
import { InvalidOperationError, JobError, NotFoundError, type ImageProvider, type VisionProvider } from '@assetforge/core';
import { PROVIDER_NOT_FOUND, wrongKind, type ProviderEntry, type ProviderStore } from './provider-store.js';

// One adapter per provider entry (vision for `ollama` and `openai`, image for `venice`), dropped when that entry
// changes. Kept free of Electron imports.

/** What `createVeniceImage` accepts; typed structurally so this file names no concrete image adapter. */
export type ImageAdapterFactory = (o: {
  baseUrl: string;
  timeoutMs: number;
  apiKey: () => string | null;
  onFailure: (code: JobErrorCode, status: number | null) => void;
}) => ImageProvider;

/** What `createOllamaVision` and `createOpenAiVision` accept; typed structurally like `ImageAdapterFactory`. */
export type VisionAdapterFactory = (o: {
  baseUrl: string;
  timeoutMs: number;
  apiKey: () => string | null;
  onFailure: (code: JobErrorCode, status: number | null) => void;
  requestOptions: VisionRequestOptions;
}) => VisionProvider;

export interface ProviderGateway {
  /** The vision adapter of a vision entry; null for no id, an id that names no entry, or an image entry. */
  vision(id: string | null): VisionProvider | null;
  /** The image adapter of an image entry; null for no id, an id that names no entry, or a vision entry. */
  image(id: string | null): ImageProvider | null;
  /** The vision entry's models, cached per entry until it changes or `refresh` is true. Failures are not cached. */
  models(id: string, refresh: boolean, signal: AbortSignal): Promise<ListModelsResult>;
  /** The image entry's edit models, cached like `models`. */
  imageModels(id: string, refresh: boolean, signal: AbortSignal): Promise<ListImageModelsResult>;
}

/** The request options an adapter of the entry is built with; stored extra parameters that do not parse count as none. */
function requestOptionsOf(entry: ProviderEntry & { kind: VisionKind }): VisionRequestOptions {
  const { temperature, thinking, maxTokens, extra } = entry.options!;
  const parsed = parseExtraParameters(extra, entry.kind);
  return { temperature, thinking, maxTokens, extra: parsed.ok ? parsed.value : {} };
}

export function createProviderGateway(o: {
  store: ProviderStore;
  createVision: Record<VisionKind, VisionAdapterFactory>;
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

  const entryOf = (id: string | null, purpose: ProviderPurpose): ProviderEntry | null => {
    if (id === null) return null;
    const entry = o.store.get(id);
    return entry !== null && purposeOf(entry.kind) === purpose ? entry : null;
  };

  // Looking up the adapter caches before the purpose check is safe only because an entry's kind never changes
  // and every change of an entry clears both maps.
  const vision = (id: string | null): VisionProvider | null => {
    const existing = id === null ? undefined : visionAdapters.get(id);
    if (existing !== undefined) return existing;
    const entry = entryOf(id, 'vision');
    if (entry === null || !isVisionKind(entry.kind)) return null;
    const visionEntry = { ...entry, kind: entry.kind };
    const adapter = o.createVision[entry.kind]({ ...options(entry, 'Vision'), requestOptions: requestOptionsOf(visionEntry) });
    visionAdapters.set(entry.id, adapter);
    return adapter;
  };

  const image = (id: string | null): ImageProvider | null => {
    const existing = id === null ? undefined : imageAdapters.get(id);
    if (existing !== undefined) return existing;
    const entry = entryOf(id, 'image');
    if (entry === null) return null;
    const adapter = o.createImage(options(entry, 'Image'));
    imageAdapters.set(entry.id, adapter);
    return adapter;
  };

  /** The cache and generation rule shared by both lists. */
  async function cachedList<T>(
    id: string,
    purpose: ProviderPurpose,
    refresh: boolean,
    cache: Map<string, { ok: true; models: T[] } | { ok: false; code: JobErrorCode }>,
    load: () => Promise<T[]>,
  ): Promise<{ ok: true; models: T[] } | { ok: false; code: JobErrorCode }> {
    const entry = o.store.get(id);
    if (entry === null) throw new NotFoundError(PROVIDER_NOT_FOUND);
    if (purposeOf(entry.kind) !== purpose) throw new InvalidOperationError(wrongKind(purpose));
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
    models: (id, refresh, signal) => cachedList(id, 'vision', refresh, cachedModels, () => vision(id)!.listModels(signal)),
    imageModels: (id, refresh, signal) =>
      cachedList(id, 'image', refresh, cachedImageModels, () => image(id)!.listEditModels(signal)),
  };
}
