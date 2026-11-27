import {
  listGenerationsForFile,
  recentGenerationPrompts,
  removeGeneration,
  retryGeneration,
  startGeneration,
  type ImageProviderDirectory,
  type WorkspaceManager,
} from '@assetforge/core';
import { purposeOf } from '@assetforge/contracts';
import { LIST_MODELS_TIMEOUT_MS } from '@assetforge/providers';
import type { IpcHandlers } from './ipc.js';
import type { JobHost } from './job-host.js';
import type { ProviderGateway } from './provider-gateway.js';
import type { ProviderStore } from './provider-store.js';

// Kept free of Electron imports. Every channel runs inside the workspace read, so without a workspace it answers
// no_workspace_open whatever the ids; the provider entry is resolved inside it too.

export type GenerationHandlers = Pick<
  IpcHandlers,
  'generations:start' | 'generations:forFile' | 'generations:retry' | 'generations:remove' | 'generations:recentPrompts'
>;

/**
 * The `venice` entries of the provider store as core sees them. A model lookup is bounded here by
 * `LIST_MODELS_TIMEOUT_MS`, because the signal core passes is never aborted.
 */
export function createImageProviderDirectory(
  store: ProviderStore,
  gateway: ProviderGateway,
  o: { timeoutMs?: number } = {},
): ImageProviderDirectory {
  const timeoutMs = o.timeoutMs ?? LIST_MODELS_TIMEOUT_MS;
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
    async models(id, signal) {
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
    },
    markUsed: (id) => store.markUsed(id),
  };
}

export function createGenerationHandlers(
  manager: WorkspaceManager,
  jobs: JobHost,
  directory: ImageProviderDirectory,
): GenerationHandlers {
  const deps = { providers: directory, control: jobs };
  return {
    'generations:start': async (r) => {
      const result = await manager.read((s) => startGeneration(s, deps, r));
      // Core wakes the scheduler; the counter tells the renderer a job appeared.
      if (result.ok) jobs.changed();
      return result;
    },
    'generations:forFile': (r) => manager.read((s) => listGenerationsForFile(s, r.fileId)),
    'generations:retry': async (r) => {
      const generation = await manager.read((s) => retryGeneration(s, deps, r.generationId));
      jobs.changed();
      return generation;
    },
    'generations:remove': async (r) => {
      await manager.read((s) => removeGeneration(s, r.generationId));
      return {};
    },
    'generations:recentPrompts': async () => ({ prompts: await manager.read((s) => recentGenerationPrompts(s)) }),
  };
}
