import type { JobErrorCode, ListModelsResult } from '@assetforge/contracts';
import { JobError, NotFoundError, type VisionProvider } from '@assetforge/core';
import type { createOllamaVision } from '@assetforge/providers';
import { PROVIDER_NOT_FOUND, type ProviderStore } from './provider-store.js';

// One vision adapter per provider entry, dropped when that entry changes. Kept free of Electron imports.

export interface ProviderGateway {
  /** The adapter of an entry; null for no id or an id that names no entry. */
  vision(id: string | null): VisionProvider | null;
  /** The entry's models, cached per entry until it changes or `refresh` is true. Failures are not cached. */
  models(id: string, refresh: boolean, signal: AbortSignal): Promise<ListModelsResult>;
}

export function createProviderGateway(o: {
  store: ProviderStore;
  create: typeof createOllamaVision;
  log: (line: string) => void;
}): ProviderGateway {
  const adapters = new Map<string, VisionProvider>();
  const cached = new Map<string, ListModelsResult>();
  /** Raised on every change of an entry, so a list requested before the change is not cached after it. */
  const generations = new Map<string, number>();
  const generation = (id: string): number => generations.get(id) ?? 0;

  o.store.onChange((id) => {
    adapters.delete(id);
    cached.delete(id);
    generations.set(id, generation(id) + 1);
  });

  const vision = (id: string | null): VisionProvider | null => {
    if (id === null) return null;
    const existing = adapters.get(id);
    if (existing !== undefined) return existing;
    const entry = o.store.get(id);
    if (entry === null) return null;
    const { baseUrl } = entry;
    // Only the id, the code and the status: never the URL, a header or a body.
    const onFailure = (code: JobErrorCode, status: number | null) =>
      o.log(`Vision provider ${id} failed: ${code}${status === null ? '' : ` (HTTP ${status})`}`);
    const adapter = o.create({
      baseUrl,
      timeoutMs: entry.timeoutSeconds * 1000,
      // Bound to this entry and this adapter's base URL: a stale adapter still in use after an origin
      // change, a deletion or a recreation under another id gets no key.
      apiKey: () => o.store.apiKeyFor(id, baseUrl),
      onFailure,
    });
    adapters.set(id, adapter);
    return adapter;
  };

  return {
    vision,
    async models(id, refresh, signal) {
      if (o.store.get(id) === null) throw new NotFoundError(PROVIDER_NOT_FOUND);
      const hit = cached.get(id);
      if (!refresh && hit !== undefined) return hit;
      const started = generation(id);
      const provider = vision(id)!;
      let result: ListModelsResult;
      try {
        result = { ok: true, models: await provider.listModels(signal) };
      } catch (error) {
        if (error instanceof JobError) return { ok: false, code: error.code };
        throw error;
      }
      if (started === generation(id)) cached.set(id, result);
      return result;
    },
  };
}
