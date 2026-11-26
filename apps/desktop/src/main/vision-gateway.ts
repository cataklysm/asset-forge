import type { JobErrorCode, ListModelsResult } from '@assetforge/contracts';
import { JobError, type VisionProvider } from '@assetforge/core';
import type { createOllamaVision } from '@assetforge/providers';
import type { VisionSettingsStore } from './vision-settings.js';

// Builds the vision adapter from the settings in force and rebuilds it after every change.
// Kept free of Electron imports.

export interface VisionGateway {
  /** The adapter for the settings in force; null when no base URL is configured. */
  current(): VisionProvider | null;
  /** The provider's models, cached until the settings change or `refresh` is true. Failures are not cached. */
  models(refresh: boolean, signal: AbortSignal): Promise<ListModelsResult>;
}

export function createVisionGateway(o: {
  settings: VisionSettingsStore;
  create: typeof createOllamaVision;
  log: (line: string) => void;
}): VisionGateway {
  let adapter: VisionProvider | null = null;
  let cached: ListModelsResult | null = null;
  /** Raised on every change, so a list requested before a change is not cached after it. */
  let generation = 0;

  o.settings.onChange(() => {
    adapter = null;
    cached = null;
    generation++;
  });

  // Only the code and the status: never the URL, a header or a body.
  const onFailure = (code: JobErrorCode, status: number | null) =>
    o.log(status === null ? `Vision provider failed: ${code}` : `Vision provider failed: ${code} (HTTP ${status})`);

  const current = (): VisionProvider | null => {
    if (adapter !== null) return adapter;
    const baseUrl = o.settings.baseUrl();
    if (baseUrl === null) return null;
    adapter = o.create({
      baseUrl,
      timeoutMs: o.settings.timeoutMs(),
      apiKey: () => o.settings.apiKey(),
      onFailure,
    });
    return adapter;
  };

  return {
    current,
    async models(refresh, signal) {
      if (!refresh && cached !== null) return cached;
      const provider = current();
      if (provider === null) return { ok: false, code: 'provider_not_configured' };
      const started = generation;
      let result: ListModelsResult;
      try {
        result = { ok: true, models: await provider.listModels(signal) };
      } catch (error) {
        if (error instanceof JobError) return { ok: false, code: error.code };
        throw error;
      }
      if (started === generation) cached = result;
      return result;
    },
  };
}
