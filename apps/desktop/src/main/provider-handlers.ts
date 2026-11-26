import { ENVIRONMENT_PROVIDER_ID } from '@assetforge/contracts';
import { InvalidOperationError } from '@assetforge/core';
import type { IpcHandlers } from './ipc.js';
import type { ProviderGateway } from './provider-gateway.js';
import type { ProviderStore } from './provider-store.js';

// Kept free of Electron imports. App-level provider entries: no open workspace is needed.

const ACTIVE_JOBS = 'This provider still has active jobs; move or cancel them first';

export type ProviderHandlers = Pick<
  IpcHandlers,
  'providers:list' | 'providers:save' | 'providers:delete' | 'providers:listModels'
>;

export interface ProviderDeleteGuard {
  /** Whether the open workspace has active jobs of this provider; false without an open workspace. */
  hasActiveJobs(providerId: string): Promise<boolean>;
}

export function createProviderHandlers(
  store: ProviderStore,
  gateway: ProviderGateway,
  guard: ProviderDeleteGuard,
): ProviderHandlers {
  return {
    'providers:list': async () => store.list(),
    'providers:save': async (r) => store.save(r),
    'providers:delete': async (r) => {
      // The environment refusal and an unknown id come from the store itself.
      const entry = store.get(r.id);
      if (entry !== null && entry.id !== ENVIRONMENT_PROVIDER_ID && (await guard.hasActiveJobs(r.id))) {
        throw new InvalidOperationError(ACTIVE_JOBS);
      }
      store.delete(r.id);
      return {};
    },
    // There is no cancel channel; the adapter's own bound limits the request.
    'providers:listModels': (r) => gateway.models(r.providerId, r.refresh === true, new AbortController().signal),
  };
}
