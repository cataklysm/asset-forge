import { ENVIRONMENT_PROVIDER_ID } from '@assetforge/contracts';
import { InvalidOperationError } from '@assetforge/core';
import type { IpcHandlers, IpcRequest, IpcResponse } from './ipc.js';
import type { ProviderGateway } from './provider-gateway.js';
import type { ProviderStore } from './provider-store.js';

// Kept free of Electron imports. App-level provider entries: no open workspace is needed.

const ACTIVE_JOBS = 'This provider still has active jobs; move or cancel them first';

/** The `providers:*` channels. */
export type ProviderHandlers = Pick<
  IpcHandlers,
  'providers:list' | 'providers:save' | 'providers:delete' | 'providers:listModels' | 'providers:listImageModels'
>;

/** Tells whether an entry may be deleted. */
export interface ProviderDeleteGuard {
  /**
   * Whether the open workspace has active jobs of this provider; false without an open workspace.
   *
   * @param providerId the entry
   * @returns true while one of its jobs is active
   */
  hasActiveJobs(providerId: string): Promise<boolean>;
}

/**
 * Builds the `providers:*` channels.
 *
 * @param store the provider entries
 * @param gateway the adapters of the entries
 * @param guard refuses deleting an entry with active jobs
 * @returns one handler per channel
 */
export function createProviderHandlers(
  store: ProviderStore,
  gateway: ProviderGateway,
  guard: ProviderDeleteGuard,
): ProviderHandlers {
  return {
    'providers:list': async () => store.list(),
    'providers:save': async (request) => store.save(request),
    'providers:delete': (request) => deleteProvider(store, guard, request),
    // There is no cancel channel; the adapter's own bound (`LIST_MODELS_TIMEOUT_MS`) limits the request.
    // An unknown id answers `not_found`, an entry of the other kind `invalid_operation` (from the gateway).
    'providers:listModels': (request) =>
      gateway.models(request.providerId, request.refresh === true, new AbortController().signal),
    'providers:listImageModels': (request) =>
      gateway.imageModels(request.providerId, request.refresh === true, new AbortController().signal),
  };
}

/**
 * Deletes an entry unless the open workspace still has active jobs of it.
 *
 * @param store the provider entries
 * @param guard tells about active jobs
 * @param request the entry
 * @returns an empty answer
 * @throws InvalidOperationError while the entry has active jobs
 */
async function deleteProvider(
  store: ProviderStore,
  guard: ProviderDeleteGuard,
  request: IpcRequest<'providers:delete'>,
): Promise<IpcResponse<'providers:delete'>> {
  // The environment refusal and an unknown id come from the store itself.
  const entry = store.get(request.id);
  if (entry !== null && entry.id !== ENVIRONMENT_PROVIDER_ID && (await guard.hasActiveJobs(request.id))) {
    throw new InvalidOperationError(ACTIVE_JOBS);
  }
  store.delete(request.id);
  return {};
}
