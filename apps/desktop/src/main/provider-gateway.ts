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
import {
  InvalidOperationError,
  JobError,
  NotFoundError,
  type ImageProvider,
  type VisionProvider,
} from '@assetforge/core';
import { PROVIDER_NOT_FOUND, wrongKind, type ProviderEntry } from './provider-entry.js';
import type { ProviderStore } from './provider-store.js';

// One adapter per provider entry (vision for `ollama` and `openai`, image for `venice`), dropped when that entry
// changes. Kept free of Electron imports.

/** What every adapter is built with. */
interface AdapterOptions {
  /** The entry's base URL. */
  baseUrl: string;
  /** The entry's timeout. */
  timeoutMs: number;
  /** The entry's key, bound to its origin. */
  apiKey: () => string | null;
  /** Logs a failure by its code and status. */
  onFailure: (code: JobErrorCode, status: number | null) => void;
}

/** What `createVeniceImage` accepts; typed structurally so this file names no concrete image adapter. */
export type ImageAdapterFactory = (options: AdapterOptions) => ImageProvider;

/**
 * What `createOllamaVision` and `createOpenAiVision` accept; typed structurally like `ImageAdapterFactory`.
 * `structuredOutput` is passed to an `openai` entry's factory only.
 */
export type VisionAdapterFactory = (
  options: AdapterOptions & { requestOptions: VisionRequestOptions; structuredOutput?: boolean },
) => VisionProvider;

/** The adapters of the provider entries and their model lists. */
export interface ProviderGateway {
  /**
   * The vision adapter of a vision entry; null for no id, an id that names no entry, or an image entry.
   *
   * @param id the entry
   * @returns the adapter or null
   */
  vision(id: string | null): VisionProvider | null;
  /**
   * The image adapter of an image entry; null for no id, an id that names no entry, or a vision entry.
   *
   * @param id the entry
   * @returns the adapter or null
   */
  image(id: string | null): ImageProvider | null;
  /**
   * The vision entry's models, cached per entry until it changes or `refresh` is true. Failures are not cached.
   *
   * @param id the entry
   * @param refresh true to ask the provider again
   * @param signal ends the request
   * @returns the models or the failure code
   */
  models(id: string, refresh: boolean, signal: AbortSignal): Promise<ListModelsResult>;
  /**
   * The image entry's edit models, cached like `models`.
   *
   * @param id the entry
   * @param refresh true to ask the provider again
   * @param signal ends the request
   * @returns the models or the failure code
   */
  imageModels(id: string, refresh: boolean, signal: AbortSignal): Promise<ListImageModelsResult>;
}

/** What the provider gateway is built with. */
export interface ProviderGatewayOptions {
  /** The provider entries. */
  store: ProviderStore;
  /** The vision adapter factory per vision kind. */
  createVision: Record<VisionKind, VisionAdapterFactory>;
  /** The image adapter factory. */
  createImage: ImageAdapterFactory;
  /** Takes the failure lines. */
  log: (line: string) => void;
}

/** A model list as cached. */
type ListResult<T> = { ok: true; models: T[] } | { ok: false; code: JobErrorCode };

/**
 * The request options an adapter of the entry is built with; stored extra parameters that do not parse count as none.
 *
 * @param entry the vision entry
 * @returns the request options
 */
function requestOptionsOf(entry: ProviderEntry & { kind: VisionKind }): VisionRequestOptions {
  const { temperature, thinking, maxTokens, extra } = entry.options!;
  const parsed = parseExtraParameters(extra, entry.kind);
  return { temperature, thinking, maxTokens, extra: parsed.ok ? parsed.value : {} };
}

/**
 * Creates the gateway; every change of an entry drops its adapters and cached lists.
 *
 * @param options what the gateway is built with
 * @returns the gateway
 */
export function createProviderGateway(options: ProviderGatewayOptions): ProviderGateway {
  const adapters = new ProviderAdapters(options);
  options.store.onChange((id) => adapters.drop(id));
  return {
    vision: (id) => adapters.vision(id),
    image: (id) => adapters.image(id),
    models: (id, refresh, signal) => adapters.models(id, refresh, signal),
    imageModels: (id, refresh, signal) => adapters.imageModels(id, refresh, signal),
  };
}

/** The adapters and model lists per entry. */
class ProviderAdapters {
  private readonly visionAdapters = new Map<string, VisionProvider>();
  private readonly imageAdapters = new Map<string, ImageProvider>();
  private readonly cachedModels = new Map<string, ListModelsResult>();
  private readonly cachedImageModels = new Map<string, ListImageModelsResult>();
  /** Raised on every change of an entry, so a list requested before the change is not cached after it. */
  private readonly generations = new Map<string, number>();

  /** @param options what the gateway is built with */
  constructor(private readonly options: ProviderGatewayOptions) {}

  /**
   * Drops everything held for an entry that changed.
   *
   * @param id the entry
   */
  drop(id: string): void {
    this.visionAdapters.delete(id);
    this.imageAdapters.delete(id);
    this.cachedModels.delete(id);
    this.cachedImageModels.delete(id);
    this.generations.set(id, this.generation(id) + 1);
  }

  // Looking up the adapter caches before the purpose check is safe only because an entry's kind never changes
  // and every change of an entry clears both maps.
  /**
   * The vision adapter of a vision entry, built on first use.
   *
   * @param id the entry
   * @returns the adapter or null
   */
  vision(id: string | null): VisionProvider | null {
    const existing = id === null ? undefined : this.visionAdapters.get(id);
    if (existing !== undefined) return existing;
    const entry = this.entryOf(id, 'vision');
    if (entry === null || !isVisionKind(entry.kind)) return null;
    const visionEntry = { ...entry, kind: entry.kind };
    const adapter = this.options.createVision[entry.kind]({
      ...this.adapterOptions(entry, 'Vision'),
      requestOptions: requestOptionsOf(visionEntry),
      ...(entry.kind === 'openai' ? { structuredOutput: entry.options!.structuredOutput } : {}),
    });
    this.visionAdapters.set(entry.id, adapter);
    return adapter;
  }

  /**
   * The image adapter of an image entry, built on first use.
   *
   * @param id the entry
   * @returns the adapter or null
   */
  image(id: string | null): ImageProvider | null {
    const existing = id === null ? undefined : this.imageAdapters.get(id);
    if (existing !== undefined) return existing;
    const entry = this.entryOf(id, 'image');
    if (entry === null) return null;
    const adapter = this.options.createImage(this.adapterOptions(entry, 'Image'));
    this.imageAdapters.set(entry.id, adapter);
    return adapter;
  }

  /**
   * The vision entry's models.
   *
   * @param id the entry
   * @param refresh true to ask the provider again
   * @param signal ends the request
   * @returns the models or the failure code
   */
  models(id: string, refresh: boolean, signal: AbortSignal): Promise<ListModelsResult> {
    return this.cachedList(id, 'vision', refresh, this.cachedModels, () => this.vision(id)!.listModels(signal));
  }

  /**
   * The image entry's edit models.
   *
   * @param id the entry
   * @param refresh true to ask the provider again
   * @param signal ends the request
   * @returns the models or the failure code
   */
  imageModels(id: string, refresh: boolean, signal: AbortSignal): Promise<ListImageModelsResult> {
    return this.cachedList(id, 'image', refresh, this.cachedImageModels, () => this.image(id)!.listEditModels(signal));
  }

  /**
   * How often an entry changed.
   *
   * @param id the entry
   * @returns the count
   */
  private generation(id: string): number {
    return this.generations.get(id) ?? 0;
  }

  /**
   * The adapter options of an entry. Only the id, the code and the status are logged: never the URL, a header or a body.
   *
   * @param entry the entry
   * @param label the start of the failure line
   * @returns the options
   */
  private adapterOptions(entry: ProviderEntry, label: string): AdapterOptions {
    const { id, baseUrl } = entry;
    const { store, log } = this.options;
    return {
      baseUrl,
      timeoutMs: entry.timeoutSeconds * 1000,
      // Bound to this entry and this adapter's base URL: a stale adapter still in use after an origin
      // change, a deletion or a recreation under another id gets no key.
      apiKey: () => store.apiKeyFor(id, baseUrl),
      onFailure: (code: JobErrorCode, status: number | null) =>
        log(`${label} provider ${id} failed: ${code}${status === null ? '' : ` (HTTP ${status})`}`),
    };
  }

  /**
   * The entry with `id` when it has the purpose.
   *
   * @param id the entry
   * @param purpose the purpose it must have
   * @returns the entry or null
   */
  private entryOf(id: string | null, purpose: ProviderPurpose): ProviderEntry | null {
    if (id === null) return null;
    const entry = this.options.store.get(id);
    return entry !== null && purposeOf(entry.kind) === purpose ? entry : null;
  }

  /**
   * The cache and generation rule shared by both lists.
   *
   * @param id the entry
   * @param purpose the purpose it must have
   * @param refresh true to ask the provider again
   * @param cache the cached lists
   * @param load asks the provider
   * @returns the models or the failure code
   */
  private async cachedList<T>(
    id: string,
    purpose: ProviderPurpose,
    refresh: boolean,
    cache: Map<string, ListResult<T>>,
    load: () => Promise<T[]>,
  ): Promise<ListResult<T>> {
    const entry = this.options.store.get(id);
    if (entry === null) throw new NotFoundError(PROVIDER_NOT_FOUND);
    if (purposeOf(entry.kind) !== purpose) throw new InvalidOperationError(wrongKind(purpose));
    const hit = cache.get(id);
    if (!refresh && hit !== undefined) return hit;
    const started = this.generation(id);
    let result: { ok: true; models: T[] };
    try {
      result = { ok: true, models: await load() };
    } catch (error) {
      if (error instanceof JobError) return { ok: false, code: error.code };
      throw error;
    }
    if (started === this.generation(id)) cache.set(id, result);
    return result;
  }
}
